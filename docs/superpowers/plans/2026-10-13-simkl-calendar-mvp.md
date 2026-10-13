# Simkl Calendar Sync MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #1 as a standalone, private, revocable Simkl calendar subscription Worker.

**Architecture:** Hono routes delegate account authority and watchlist ownership to per-account Durable Objects. A singleton coordinator owns OAuth transactions, shared public datasets and uncached API dispatch pacing. Pure modules normalize schedules, filter watchlists and generate iCalendar.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/SQLite-backed Durable Objects, Wrangler, Vitest Workers integration, Biome, ical.js as an independent test parser, npm lockfile; Node 22 or later.

**Spec:** `docs/superpowers/specs/2026-10-13-simkl-calendar-design.md` (approved in chat).

## Global Constraints

* No cron, scheduled alarms, simkl-mcp dependency, speculative database, staging deployment, automatic PR readiness, or automatic merge.
* OAuth `media:read` only; S256 PKCE, state/browser binding and issuer validation; no credentials in logs or feed URLs.
* OAuth transactions expire after ten minutes; browser sessions expire after 30 days; random secrets contain at least 256 bits.
* Watchlists are fresh for 30 minutes; stale data is usable at most 24 hours after successful validation.
* Dataset default freshness is five hours; honor max-age minus Age; last-good data is usable at most 24 hours after successful validation.
* Serialize uncached API dispatch; space GETs by at least 110ms and POSTs by 1,100ms.
* Default preferences: all categories and `watching` + `plantowatch`; movie statuses omit watching and hold.
* Match positive safe integer Simkl IDs within category; no title/slug or speculative external-ID fallback.
* Use schedule UTC dates, stable identities independent of dates/titles, CRLF and 75 UTF-8 octet folding.
* Private feed responses use `Cache-Control: private, no-store`; live account authority checks precede every response.
* Subscriptions no longer have an operator feature flag; permission still requires a documented terms review.
* PRs remain Draft/WIP; deployment only after passing same-revision main CI. External live OAuth, terms and repository protection setup must be reported honestly.

## Review Focus

1. Oversized dataset/watchlist records must survive storage value limits without publishing partial manifests (Tasks 1 and 4).
2. Equal-date conflicting rows must deduplicate identically regardless of upstream ordering (Task 2).
3. Activity payloads with unrelated settings/rating changes must not trigger full library pulls or lose membership state (Task 5).
4. Object eviction/restart must preserve revocation, cooldowns and refresh ownership (Tasks 4–6).
5. Malicious Host, HTML titles and HTTP origins must never alter canonical redirects, inject markup or weaken production cookies (Task 7).

## File map

* Root: `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `wrangler.jsonc`, `.dev.vars.example`, `.gitignore` — toolchain and bindings.
* `src/index.ts` — Hono app and Durable Object exports; `src/env.ts` — validated bindings/configuration.
* `src/domain.ts` — shared DTOs; `src/calendar.ts` — V2 normalization, matching and event identities; `src/ical.ts` — RFC serialization.
* `src/security.ts` — random secrets, hashes, HMAC routing and AES-GCM; `src/storage.ts` — atomic chunked records; `src/serial.ts` — per-object serialization.
* `src/simkl.ts` — identified API requests, OAuth and error handling; `src/sync.ts` — activity/delta/reconciliation algorithm.
* `src/coordinator.ts` — OAuth transactions, dataset cache and dispatch pacing; `src/account.ts` — credentials, preferences, sessions, feed authority and account refresh.
* `src/routes/auth.ts`, `src/routes/account.ts`, `src/routes/feeds.ts`, `src/views.ts` — HTTP flow and escaped server-rendered pages.
* `tests/*.test.ts`, `tests/fixtures/*`, `tests/helpers.ts` — pure tests and real Workers/Durable Object integration.
* `.github/workflows/{ci,deploy}.yml`, `README.md`, `docs/{upstream-contracts,operations,release-review}.md` — delivery, evidence and operations.

## Shared interfaces

Define and export these in `src/domain.ts` in Task 1; use these names throughout:

```ts
type Category = 'tv' | 'anime' | 'movies';
type FeedCategory = Category | 'all';
type Status = 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped';
interface Preferences { categories: Category[]; statuses: Status[] }
interface WatchItem { category: Category; id: number; status: Status; title: string }
interface ScheduleRow {
  category: Category; id: number; date: string; title: string; url: string;
  season?: number; episode?: number; episodeTitle?: string;
  runtimeMinutes?: number; finale?: 1 | 2 | 3; animeMovie?: boolean;
}
interface CalendarEvent {
  uid: string; start: string; end?: string; allDay: boolean;
  summary: string; description: string; url: string;
}
interface Dataset { rows: ScheduleRow[]; validatedAt: number; modifiedAt: number }
interface WatchSnapshot { items: WatchItem[]; activities: Activities; validatedAt: number }
interface Activities {
  all: string;
  tv_shows: Record<string, string>; anime: Record<string, string>;
  movies: Record<string, string>;
}
interface TokenGrant {
  accessToken: string; refreshToken: string; expiresAt: number; scope: string;
}
interface OAuthTransaction {
  verifier: string; bindingHash: string; expiresAt: number; redirectUri: string;
}
interface DispatchRequest {
  path: string; method: 'GET' | 'POST'; token?: string;
  query?: Record<string, string>; form?: Record<string, string>;
}
interface DispatchResult {
  status: number; body: unknown; headers: Record<string, string>;
}
```

Use milliseconds since epoch for internal timestamps. Upstream activity strings remain byte-identical for `date_from`. Internal object calls use typed Durable Object RPC; no public HTTP route exposes arbitrary dispatch/storage methods. Export `Env` with ACCOUNT/COORDINATOR namespaces and the secrets/configuration named in the spec.

### Task 1: Executable Worker foundation and safe storage

**Files:** Root toolchain files; `src/{index,env,domain,serial,storage}.ts`; `tests/{foundation,storage}.test.ts`; `tests/helpers.ts`.

**Interfaces:** Produce `validateEnv(env: Env): Config`, `Serial.run<T>(operation: () => Promise<T>): Promise<T>`, and `ChunkStore.read<T>(key: string): Promise<T | null>`, `write<T>(key: string, value: T): Promise<void>`, `remove(key: string): Promise<void>`. Config contains a validated canonical origin and subscription-use boolean. ChunkStore accepts DurableObjectStorage and writes UTF-8 bytes in chunks below 64 KiB, publishing manifests transactionally and removing old chunks.

- [ ] Create package/scripts and a minimal Workers test configuration so tests can run before product behavior exists. Scripts: `dev`, `format:check`, `lint`, `typecheck`, `test`, `build` (Wrangler deploy dry-run), `check` (all quality gates). Pin compatible installed versions and commit the generated lockfile.
- [ ] Write failing tests asserting `/health` is 200 without disclosing bindings; HTTPS canonical origin passes, non-loopback HTTP fails; missing crypto configuration fails closed; two serialized operations cannot overlap; a >256 KiB Unicode record round-trips, replacement removes old chunks, removal returns null, and failed publication leaves the previous record readable.
- [ ] Run `npm test -- tests/foundation.test.ts tests/storage.test.ts`; verify failures are missing behavior, not a broken test runtime.
- [ ] Implement the interfaces and basic health handler; add ACCOUNT/COORDINATOR SQLite migrations and disable invocation logs/traces. Ignore `.dev.vars*` except `.dev.vars.example`, build output and local Wrangler state.
- [ ] Run targeted tests, `npm run typecheck`, and `npm run build`; all must exit zero.
- [ ] Commit `chore: bootstrap Worker toolchain and atomic storage`.

### Task 2: V2 matching and deterministic calendar generation

**Files:** `src/{calendar,ical}.ts`; `tests/{calendar,ical}.test.ts`; `tests/fixtures/{tv,anime,movies}.json`; fixture provenance README.

**Interfaces:** Consume shared DTOs. Produce `normalizeDataset(category: Category, raw: unknown): ScheduleRow[]`, `normalizeWatchlist(category: Category, raw: unknown): WatchItem[]`, `selectEvents(rows: ScheduleRow[], items: WatchItem[], preferences: Preferences, feed: FeedCategory): CalendarEvent[]`, `serializeCalendar(events: CalendarEvent[], modifiedAt: number): string`.

- [ ] Write failing pure tests for category + numeric-ID matching, every status/default, empty selections, sparse metadata/title fallback, movie status rejection, malformed root versus individual rows, season zero versus missing season, anime movie release identities, invalid dates and unsafe URLs. Assert rescheduling changes DTSTART but not UID; same-date conflicting records give identical output when reversed; latest-date conflicting rows win.
- [ ] Write independent ical.js parse assertions: timed DTSTART uses UTC, positive runtime determines DTEND, unknown duration omits DTEND, date-only events end next day, movie uses schedule date, text/newlines round-trip, CRLF is used, every physical line is <=75 UTF-8 bytes, and long multibyte text is intact.
- [ ] Run `npm test -- tests/calendar.test.ts tests/ical.test.ts`; confirm missing implementations fail.
- [ ] Implement parsers defensively. Reject impossible normalized dates rather than allowing Date rollover. Use a fixed identity encoding with date/title excluded; use a deterministic canonical tie-breaker for equal-date duplicates. Safely construct numeric-ID Simkl fallback links. Use modifiedAt for DTSTAMP/LAST-MODIFIED. No per-request clock dependency.
- [ ] Run both test files and typecheck; verify reproducible bytes for identical input.
- [ ] Commit `feat: match Simkl schedules and generate valid iCalendar`.

### Task 3: Cryptography and documented Simkl client

**Files:** `src/{security,simkl}.ts`; `tests/{security,simkl}.test.ts`.

**Interfaces:** Produce `randomSecret(): string`, `hashSecret(value: string): Promise<string>`, `accountAddress(identity: string, key: string): Promise<string>`, `seal(value: unknown, key: string, context: string): Promise<string>`, `open<T>(ciphertext: string, key: string, context: string): Promise<T>`, `pkce(verifier: string): Promise<string>`. Produce `SimklClient` using injected `(request: DispatchRequest) => Promise<DispatchResult>`; methods `exchange(code, verifier, redirectUri): Promise<TokenGrant>`, `refresh(grant): Promise<TokenGrant>`, `identity(grant): Promise<string>`, `activities(grant): Promise<Activities>`, `items(grant, category, query?): Promise<unknown>`, `revoke(grant): Promise<void>`. Export structured `UpstreamError` with status, kind and retryAt, never raw token/body text in its message.

- [ ] Write failing tests asserting 256-bit randomness encoding, known PKCE vector, AES-GCM round-trip, different ciphertext per seal, tamper/wrong-context/key rejection, and deterministic secret-derived account address.
- [ ] Write client tests asserting read-only scope validation, form-encoded token exchange, stable settings identity, exact redirect_uri, required identification parameters/User-Agent, no bearer token on CDN requests, category mapping shows/anime/movies, 401 classification, and daily-versus-burst 429 backoff. Assert token exchange is dispatched once on failure and error strings contain no secret.
- [ ] Run security/client test files and confirm failures.
- [ ] Implement interfaces against the current researched contract, injectable time/fetch, <=15-second upstream request timeouts, and bounded read retries (at most one retry for transient reads); keep OAuth POST exchange nonretrying. Verify settings endpoint's stable-ID field in current docs before implementing identity extraction and record it in upstream-contracts documentation.
- [ ] Run targeted tests and typecheck.
- [ ] Commit `feat: add confidential OAuth primitives and Simkl client`.

### Task 4: Coordinator OAuth state, public cache and dispatch pacing

**Files:** `src/coordinator.ts`; `tests/coordinator.test.ts`; coordinator exports in `src/index.ts`.

**Interfaces:** Consume ChunkStore, Serial, security primitives and Dispatch DTOs. Export `Coordinator extends DurableObject<Env>` with RPC `createOAuth(state: string, transaction: OAuthTransaction): Promise<void>`, `consumeOAuth(state: string, bindingHash: string): Promise<OAuthTransaction | null>`, `dataset(category: Category): Promise<Dataset>`, `dispatch(request: DispatchRequest): Promise<DispatchResult>`.

- [ ] Write failing Workers integration tests: OAuth state expires at ten minutes, wrong binding is rejected, valid state consumes once, expired transactions are opportunistically cleaned without alarms; concurrent category refreshes fetch once; no Authorization header on CDN; Age-adjusted freshness; ETag/Last-Modified and 304; invalid root does not replace good data; 24-hour stale cutoff; >256 KiB payload survives chunked storage and object restart.
- [ ] Add pacing tests using an injected clock/wait adapter: GET dispatch starts >=110ms apart, POST >=1,100ms apart, bounded burst retries obey cooldown, daily failure persists backoff across restart, OAuth exchange does not retry. Assert no account watchlist/token fields exist in coordinator durable storage.
- [ ] Run coordinator test file and confirm failures.
- [ ] Implement expiring one-use state and globally shared per-category cache with atomic chunked publication. Coalesce fetches and persist successful validation/backoff timestamps; use strict fixed upstream URLs/path allowlist, body-size limits and generic failure messages. Serialize dispatch separately from category cache operations so pacing waits do not deadlock RPC flows.
- [ ] Run targeted tests, typecheck and build.
- [ ] Commit `feat: coordinate OAuth transactions and public dataset caching`.

### Task 5: Atomic account watchlist synchronization

**Files:** `src/sync.ts`; `tests/sync.test.ts`; synthetic activities/watchlist fixtures.

**Interfaces:** Consume SimklClient, shared DTOs and normalizeWatchlist. Produce `syncWatchlist(client: SimklClient, grant: TokenGrant, previous: WatchSnapshot | null, now: number): Promise<WatchSnapshot>`. The function returns a complete new snapshot or throws without mutating previous state.

- [ ] Write failing tests asserting activities precedes sequential initial category pulls, saved snapshot is the pre-pull snapshot, unchanged membership renews freshness without a library pull, unrelated settings/rating/playback changes do not fetch membership, category deltas use exact previous all, status moves replace old items, removal changes trigger IDs-only full inventory without date_from, and partial failure leaves previous items/activities untouched.
- [ ] Add assertions for malformed activity timestamps/categories causing safe failure rather than accidental cache clearing; empty valid library is accepted; duplicate IDs normalize deterministically; deleted IDs disappear while unrelated categories remain intact.
- [ ] Run sync tests and confirm failures.
- [ ] Implement category-by-category staged merge/reconciliation. Fetch changed category without a status segment so movement between statuses is not missed. Never persist a snapshot from failed partial results. Persist only item fields needed by feeds, not memos, ratings or episode history.
- [ ] Run sync tests and typecheck.
- [ ] Commit `feat: synchronize watchlists with deltas and deletion reconciliation`.

### Task 6: Account authority, sessions, refresh and revocation

**Files:** `src/account.ts`; `tests/account.test.ts`; account exports in `src/index.ts`.

**Interfaces:** Export `Account extends DurableObject<Env>` with RPC `connect(identity: string, grant: TokenGrant): Promise<{ session: string }>`, `view(session: string): Promise<AccountView | null>`, `mutate(session: string, csrf: string, action: AccountAction): Promise<void>`, `feed(secret: string, category: FeedCategory): Promise<{ body: string; modifiedAt: number } | null>`. Define AccountView in domain.ts with preferences, csrf, secret (nullable), freshness and connection state. Define AccountAction as discriminated preferences/refresh/rotate/revoke/disconnect/logout actions. Only authenticated view exposes decrypted redisplayable secret.

- [ ] Write failing Workers tests for 30-day hashed session expiry, session-bound CSRF, encrypted stored credentials, preferences and empty filters, secret generation/rotation/revocation, initial connection issuing feed authority, revoked authority remaining revoked after reconnect, and disconnect clearing credentials/watchlist/session/authority even if upstream revoke fails.
- [ ] Add tests asserting two account objects cannot read each other's data/sessions/secrets; invalid feed credentials cause zero upstream calls; concurrent feed/rotation requests are serialized and later old-link requests fail; object restart preserves revocation. Assert stale transient fallback stops after 24 hours, 401/failed refresh closes feed access, successful refresh retries once, parallel requests refresh once, and revoked credentials are never served from a stale snapshot.
- [ ] Add persisted minimum refresh-interval/backoff tests: repeated account-refresh actions cannot bypass 30-minute freshness or quota cooldown; successful unchanged activities do renew validation time. Test chunked large account snapshots survive restart.
- [ ] Run account tests and confirm failures.
- [ ] Implement all authority checks inside the object's serialized operations. Encrypt credentials/redisplayable secrets with account/purpose context; hash sessions/feed secret. Stage watchlist writes atomically; retain session/preference state on transient sync failure. Compose only required enabled datasets and fail complete feed generation if a required source lacks safe data. Derive stable calendar modification time from cached dataset/watchlist state, never current request time.
- [ ] Run account tests, all previous tests, typecheck and build.
- [ ] Commit `feat: own private account state and immediately revoke subscriptions`.

### Task 7: Complete browser OAuth and subscription HTTP flow

**Files:** `src/routes/{auth,account,feeds}.ts`, `src/views.ts`, modifications to `src/index.ts`; `tests/routes.test.ts`.

**Interfaces:** Consume Coordinator and Account RPCs. Export route-registration functions accepting `Hono<{ Bindings: Env }>`; views accept typed AccountView and canonical URLs, return escaped HTML. Keep account-routing/session cookie parsing private to routes.

- [ ] Write failing route tests for home/health; login PKCE/read-only authorization URL; issuer/state/browser-binding mismatch, expiry/replay, denied consent, scope/token failures; successful callback mapping stable identity to account and redirecting canonically; session-only account access; four URL display; category/status form validation; Origin + CSRF enforcement; logout/disconnect cookie clearing.
- [ ] Test hostile Host headers cannot change callback/feed URLs; hostile titles/preferences cannot inject HTML; production cookies are Secure/HttpOnly/SameSite=Lax and loopback development exceptions are explicit. Reject duplicate auth query parameters, invalid category/account/secret encodings, malformed cookies and oversized form bodies generically.
- [ ] Test valid feeds have correct content type/attachment/private no-store; invalid credentials still receive generic 404 and zero upstream calls; failed required sources return 503 with Retry-After; valid empty/disabled-category feed parses; rotating then immediately retrying old URL returns 404. No ETag optimization is needed for MVP.
- [ ] Run route tests and confirm failures.
- [ ] Implement canonical-origin redirects, escaped server-rendered controls, cryptographically bound cookie/state/session flows and generic public errors. Add CSP, no-referrer, nosniff and no-store headers. Avoid third-party assets and logging middleware. User-facing copy explains bearer-link privacy, stale data and retained client copies after revocation without exposing implementation internals.
- [ ] Run full tests, lint/format/typecheck/build and a local HTTP smoke test for root, health and unauthorized feeds.
- [ ] Commit `feat: expose account management and private calendar subscriptions`.

### Task 8: CI/CD, operational documentation and final verification

**Files:** `.github/workflows/{ci,deploy}.yml`, `README.md`, `.dev.vars.example`, `docs/{upstream-contracts,operations,release-review}.md`; any targeted regression tests identified by review.

**Interfaces:** Existing package scripts and Wrangler config. CI workflow name `CI`, required job/check name `quality`; deploy workflow consumes only successful `CI` workflow_run for a push to main in this repository, checks triggering SHA against current main head, checks out that exact SHA and uses cloudflare/wrangler-action@v4.

- [ ] Write CI workflow with npm ci, format/lint/typecheck/tests/build on every pull_request including drafts and push to main. Deploy uses minimal permissions, production environment, account-scoped GitHub secrets, serialized production concurrency and no PR triggers. Omit manual dispatch for MVP rather than adding another authorization path.
- [ ] Validate the YAML and conditions against examples: draft PR cannot deploy, failed CI cannot deploy, successful older main SHA cannot deploy after main advances, successful current main SHA can deploy. Use available actionlint for workflow syntax; if unavailable, validate YAML and report the limitation.
- [ ] Document exact setup commands, current source contracts/sample counts and fixture provenance, required origins/OAuth redirects/secrets, Durable Object migrations/chunk limits/plan requirements, disabled invocation logging and account-level log redaction, key rotation/reconnect procedures, initial deploy, subscription instructions, 30-minute/five-hour/24-hour bounds, Retry-After behavior, rollback and re-running CI.
- [ ] Add release-review checklist distinguishing public-calendar API permission from subscription/VIP permission, commercial licensing threshold, recorded Simkl confirmation, recorded terms decision, live OAuth/calendar smoke tests and branch-protection verification. Leave external facts explicitly unverified rather than claiming acceptance from fixtures.
- [ ] Inspect repository access safely. Configure required `quality` checks/branch protection only if supported, authorized and access permits; otherwise document exact maintainer steps and report it outstanding. Keep implementation delivery Draft/WIP and never deploy/merge automatically.
- [ ] Run `npm ci` then `npm run check`; require all gates to exit zero. Review diff for secrets, console/request logging, weak caches, wrong routes, generated artifacts and spec gaps. Use superpowers:verification-before-completion and superpowers:requesting-code-review for completion/review. Fix material findings and rerun affected gates.
- [ ] Commit `ci: gate main deployment and document operation and release constraints`. Finish using superpowers:finishing-a-development-branch; report verified automated behavior separately from release prerequisites and preserve Draft status for any created PR.

## Plan self-review

Coverage maps: validated schemas/events → Task 2; authentication/confidentiality → Tasks 3, 4, 6, 7; supported incremental sync → Task 5; minimal persistent state/caching/revocation/isolation → Tasks 1, 4, 6; browser preferences/feed HTTP → Task 7; tests/toolchain → all tasks; CI/CD/terms/deployment documentation → Task 8. Each task has an executable failing-test or validation step and a final checkable deliverable. The Review Focus inputs are assigned explicit tests above. Interfaces retain the same names across consumers; internal storage layouts remain implementer-owned behind the defined methods.

This is one end-to-end application plan: authentication, account state and feed generation depend on shared privacy/refresh contracts and are not independently releasable subprojects.

## Execution handoff

Await user review of this written plan and selection of native or subagent-driven execution. Recommended: native execution, because these eight tasks share security and storage interfaces and can be implemented sequentially with one independent whole-branch review. No product implementation starts before that review/selection.
