# Simkl Calendar Sync MVP design

Issue: https://github.com/vitorhugo-dotnet/simkl-calendar/issues/1

Status: detailed specification for user review. The architecture was approved in chat; this document and the subsequent implementation plan require their own review under the requested Superpowers workflow.

## Intent and scope

Build an independent TypeScript/Hono Cloudflare Worker that connects a person's Simkl account and exposes combined, TV, anime, and movie iCalendar subscription URLs. Category and watchlist-status preferences select events. The user can immediately revoke or rotate all subscription links. Account watchlists must remain isolated. The repository starts with only README, gitignore, and an MIT license.

No cron, scheduled alarms, simkl-mcp dependency, speculative database, staging deployment, automatic PR readiness, or automatic merge. Public release remains subject to the terms review below. Implementation and fixture-based validation can proceed before that review; deployment is a separate action.

## Validated upstream contracts

Research retrieved on 2026-10-13 from current official documentation and actual CDN responses. No reference-project source will be copied.

* Calendar V2 is `{ calendar: [...], metadata: { [simkl_id]: ... } }`. Schedule rows contain numeric `simkl_id`, UTC ISO `date`, nullable `finale_type`, and an episode object for episodic content. Metadata supplies title, link, and IDs. Watchlist IDs use `ids.simkl`; metadata uses `ids.simkl_id`. Match these as the same numeric identifier, within category. No title or slug matching.
* Live samples: anime 489 rows / 138 metadata records; TV 6,304 / 1,582; movies 1,956 / 1,956. Every sampled row had corresponding metadata. Anime can contain a season field despite the documentation's usual seasonless convention: preserve it when supplied, including season zero.
* CDN files regenerate every six hours. Observed `Cache-Control: max-age=18000`, ETag and Last-Modified, with cached Age headers. Respect remaining freshness rather than assuming five hours from download. The rolling files cover approximately yesterday plus 33 days; no archive retrieval for MVP.
* Use schedule `date`, not metadata `release_date`: they differ in the live movie sample. Preserve the advertised UTC instant; do not invent a local airing timezone or treat midnight as proof of an all-day event. Accept explicitly date-only input defensively as an all-day event; malformed/missing dates are skipped.
* OAuth V2 uses `https://simkl.com/oauth2/authorize`, mandatory S256 PKCE, state and issuer checking, and `https://api.simkl.com/oauth2/token`. Request only `media:read`, validate the granted scope, use the same redirect URI on both requests. Access tokens last seven days; refresh tokens last 180 days, slide on refresh, and do not rotate. Refresh replaces the current access token immediately: one owner must serialize refresh.
* Sync starts with `/sync/activities`, then sequential initial category pulls using `/sync/all-items/{shows|anime|movies}`. Later compare list activity timestamps and fetch changed categories with `date_from` equal to the previous snapshot's `all`. Merge by category and Simkl ID. When `removed_from_list` changes, reconcile against a fresh `extended=simkl_ids_only` inventory without `date_from`. Save the pre-fetch snapshot only after the entire refresh succeeds.
* TV/anime statuses: `watching`, `plantowatch`, `hold`, `completed`, `dropped`. Movies: `plantowatch`, `completed`, `dropped`. Defaults are all categories and `watching` + `plantowatch`; watching has no effect on movies. Preferences may select an empty set, yielding a valid empty calendar.
* Required request identification: client_id, app-name, app-version, and User-Agent; bearer tokens go only to the authenticated API, never the public CDN. Current rate-limit docs specify V2 per-user quotas (500/1,000/10,000 per day for Free/PRO/VIP), 10 GET/sec, 1 POST/sec, and exempt CDN datasets. The API rules also describe client-level caps: conservatively serialize uncached API dispatch through a shared coordinator and space GETs by at least 110ms and POSTs by 1,100ms.

Sources:

* https://api.simkl.org/api-reference/calendar
* https://api.simkl.org/api-reference/oauth2-authorization-code
* https://api.simkl.org/api-reference/oauth2-tokens
* https://api.simkl.org/api-reference/oauth2-scopes
* https://api.simkl.org/guides/sync
* https://api.simkl.org/api-reference/simkl/get-activities
* https://api.simkl.org/api-reference/simkl/get-all-items
* https://api.simkl.org/resources/rate-limits
* https://api.simkl.org/conventions/headers
* https://api.simkl.org/api-rules

## Components and storage

Hono handles public routes, security headers, cookies, form validation, and rendering a small server-rendered account page. Separate modules implement OAuth/API requests, V2 normalization/matching, iCalendar serialization, encryption and secret derivation. No frontend framework is necessary.

Use Durable Objects, with explicit in-object request serialization across awaits:

1. **Account object**, addressed by a server-derived account identifier, owns encrypted OAuth credentials, profile identity, preferences, session hashes and expiry, the active subscription-secret hash, and a normalized watchlist/activity snapshot with freshness/backoff timestamps. It is the sole token-refresh owner. Atomically swap complete successful sync snapshots. Revocation and feed authorization run in this object and are never authorized by an edge cache.
2. **Coordinator object**, a singleton for this app, owns short-lived OAuth transactions, shared dataset cache and refresh coalescing, and API dispatch pacing. It never persists user watchlists or OAuth tokens. OAuth transactions expire after ten minutes and are consumed once, including failed exchange attempts. The coordinator may temporarily dispatch authenticated requests but must not log or persist their credentials or responses. Cache payloads in chunks below Durable Object storage value limits, with atomically published manifests and cleanup of replaced chunks.

This is minimum persistent state needed for OAuth transactions, sessions, actual revocation, preferences, and bounded caches. KV is simpler but eventual consistency cannot guarantee immediate revocation; D1 is unnecessary for these key-addressed records. SQLite-backed Durable Objects are used as the Workers storage primitive; this is not a separate D1 database. Document Cloudflare plan availability and limits.

## Connection and account flow

Routes:

* `GET /`: product explanation, Simkl attribution, connection link.
* `GET /auth/login`: create unpredictable state and PKCE verifier; store a browser-binding hash in the expiring transaction; set HttpOnly SameSite=Lax browser-binding cookie; redirect to Simkl.
* `GET /auth/callback`: validate issuer, state, browser binding and expiration before token exchange. Consume state once; reject replay and unexpected parameters without revealing upstream payloads. Resolve stable user identity using the documented settings endpoint. Never derive account identity from a token. Persist encrypted credentials; replace/revoke old grants best-effort on reconnect. Issue a new opaque server-side session and redirect to `/account`.
* `GET /account`: authenticated page with category/status controls, four copyable subscription URLs, refresh status, rotate, revoke, disconnect, and sign-out actions.
* `POST /account/preferences`, `/account/refresh`, `/account/rotate`, `/account/revoke`, `/account/disconnect`, `/auth/logout`: enforce session, same-origin checks, and session-bound CSRF tokens. Refresh is bounded by minimum interval and backoff; repeated clicks cannot bypass it. Disconnect removes credentials, watchlists, sessions and feed authority, and attempts upstream grant revocation. Local disconnection succeeds even if upstream revocation fails; explain how to revoke in Simkl Connected Apps.
* `GET /feeds/:account/:secret/:category.ics`: category is `all`, `tv`, `anime`, or `movies`. Validate the current secret inside the account object before any feed work. Unknown account/secret/category returns the same generic 404. Invalid requests do not fetch Simkl data.
* `GET /health`: liveness only; no configuration or account disclosure.

Random session/feed secrets contain at least 256 bits. Account addresses use an HMAC of the stable Simkl identity with a lookup key. Feed URLs contain account routing ID and a random secret, never OAuth credentials. Store the feed-secret hash for authorization and an encrypted copy only to redisplay the URLs. Rotation atomically replaces both; revocation removes them. Reconnect does not silently restore revoked links; the user explicitly generates new links. Browser sessions expire after 30 days and OAuth state after ten minutes.

Use AES-GCM with random nonces and account/purpose authenticated data for stored credentials and redisplayable feed secrets. Encryption and lookup keys are distinct Cloudflare secrets. Fail safely for missing or invalid secrets. Key rotation requires an explicit migration/reconnection procedure documented in operations guidance.

## Caching and failures

Public datasets are cached globally by category, independently of any user's watchlist. Fetch only enabled/requested categories. Validate the root envelope before replacing a good cached dataset; tolerate individual bad rows. Conditional GET uses ETag/Last-Modified; correctly handle 304. Default freshness is five hours when headers are absent, honor max-age minus Age with a conservative bound, and retain last-good data for at most 24 hours from successful validation. Deduplicate concurrent refreshes.

Per-account watchlist freshness is 30 minutes. On expiry, call activities and fetch only actual membership changes; retain a durable snapshot across Worker restarts. Unchanged activities renew freshness without a library pull. Stage all deltas/deletion inventories and commit atomically after every necessary call succeeds. Do not advance snapshot on partial failure. Stale watchlists may be served for at most 24 hours after successful validation for transient errors; authentication loss clears feed access until reconnection rather than serving indefinitely.

Use request timeouts and bounded retries on idempotent upstream reads. Interpret rate-limit error bodies: burst limits receive brief backoff; daily exhaustion honors Retry-After and suppresses further calls until reset. OAuth code exchange is never blindly retried. Serialize refresh and retry an authenticated read at most once after refreshing on 401. Persist backoff to survive restarts. No cron, alarms, or periodic polling.

Successful feed responses use `text/calendar; charset=utf-8`, safe attachment filename, and `Cache-Control: private, no-store`; private feed bodies never enter shared HTTP caches. Optional ETag comparison happens only after live secret validation and current preference evaluation. An in-flight authorized response cannot be recalled by revocation, and calendar clients may keep previously downloaded events; subsequent server requests fail immediately.

An empty watchlist or a disabled category produces a valid empty calendar. Failed required datasets without usable stale data return generic 503 + Retry-After, not a misleading successful empty/partial calendar that could erase events in clients. Valid available stale data is acceptable within the bounds above. Account UI reports degraded freshness without disclosing private upstream error bodies.

## Event contract

Normalize IDs as positive safe integers and join only by category + Simkl ID. Use metadata and episode titles with watchlist-title fallback. Do not add speculative external-ID or title matching: every observed schedule row has a stable Simkl ID. Whitelist HTTPS Simkl URLs for emitted links; construct numeric-ID fallback links if needed.

For TV/anime, UID identity is category, Simkl ID, supplied season (distinct from missing season), and episode number. For movie release, identity is category + Simkl ID + release kind; the MVP dataset has one release kind. Dates and titles never enter the UID, so rescheduling keeps identity. Deduplicate equivalent identities deterministically; select the latest valid schedule instant for conflicting rows and document the policy. Episode one can be labelled a premiere; preserve finale badges from finale_type. Anime movie entries without episode data can use release identity when metadata identifies a movie; reject malformed episodic rows lacking identity rather than invent episode numbers.

Emit RFC 5545 VCALENDAR/VEVENT with VERSION, PRODID, CALSCALE, UID, DTSTAMP, DTSTART, SUMMARY, DESCRIPTION and URL. DTEND uses positive episode runtime minutes where present; unknown runtime omits DTEND rather than inventing a duration. Movie releases use the schedule UTC instant with no assumed duration. Defensive date-only events use VALUE=DATE and exclusive next-day DTEND. Include deterministic LAST-MODIFIED/DTSTAMP from source/cache validation state so unchanged inputs are reproducible; no wall-clock timestamp per request. Fold lines at 75 UTF-8 octets without splitting code points, escape text backslashes/commas/semicolons/newlines, strip inappropriate control characters, and use CRLF. Stable-sort output. Invalid dates never serialize. Omitted or disappeared entries are removed from subsequent complete snapshots; do not fabricate cancellation records.

## Privacy and operational controls

No request-logging middleware, token/body dumps, or user-specific URL logging. Disable Worker invocation logs and tracing that capture request paths, and document any Cloudflare account-level logs that must also be disabled/redacted: application logging alone cannot protect feed path secrets. Set Referrer-Policy no-referrer, restrictive CSP, X-Content-Type-Options, and no-store on account/auth pages. Escape HTML and avoid third-party assets/scripts. All production cookies are Secure and HttpOnly. Local development explicitly permits HTTP only at loopback origins.

Use a configured canonical APP_ORIGIN for redirects and subscription links, never an arbitrary Host header. Browser account access never accepts feed credentials as sessions. Preferences, sessions and revocation cannot be changed through feed URLs. Minimize stored settings and watchlist fields. Provide account deletion/disconnection guidance and explain bearer-link sharing risks in the product.

## Verification and delivery

Use the Workers Vitest integration for real Durable Object routing/storage plus pure tests for parsers and iCalendar. Parse generated output with an independent iCalendar parser. Fixtures derive from small observed public records with provenance; OAuth/private responses are synthetic fixtures aligned with current docs. No live credentials are needed in CI.

Required cases: matching/category/status filters; movie status differences; season zero/missing seasons; repeated/rescheduled events and deterministic UIDs; UTF-8 folding and escaping; timed/all-day/invalid dates; sparse metadata; empty watchlists; malformed root/row responses; 304/fresh/stale/expired caching; partial-sync rollback; removed-item reconciliation; 429/burst/quota behavior; OAuth state/issuer/binding/replay; scope and token failures; refresh serialization; CSRF; session expiry; revoked/rotated links; unauthorized requests avoiding upstream work; cross-user isolation; reconnect/disconnect; simultaneous feed/revoke requests.

Commit package lockfile. Package scripts support local development, formatting/linting, strict typecheck, tests and Wrangler production dry-run build. CI at `.github/workflows/ci.yml` runs all gates on every pull_request (including drafts) and push to main. Deploy workflow runs only after successful main-push CI via workflow_run, verifies the triggering revision is still main's head, checks out that exact revision and deploys using cloudflare/wrangler-action@v4. A manual dispatch, if included, reruns all gates before deploy. Workflow permissions are minimal; production concurrency serializes releases. Draft PRs never deploy.

Runtime secrets: SIMKL_CLIENT_ID, SIMKL_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY, ACCOUNT_LOOKUP_KEY. Nonsecret configuration: APP_ORIGIN, app name/version and approved subscription-use flag. Bind ACCOUNT and COORDINATOR Durable Objects with initial migrations. GitHub deployment secrets: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Document minimum account-scoped permissions, runtime secret bootstrap, migrations, local secrets ignored by git, OAuth redirect registration, Google Calendar URL subscription, other clients, refresh limitations, key changes, Wrangler rollback and CI reruns.

Required branch protection is repository configuration, not merely workflow YAML. Document and attempt configuration only when repository access permits; report unverifiable external setup explicitly. Any PR remains Draft/WIP until manual review. No production deployment is part of implementation without appropriate configured credentials and release approval.

## Terms and release decision

Official API rules allow noncommercial/personal use and commercial revenue below USD 150/month; at or above that threshold a commercial license is required. Calendar docs explicitly describe combining public calendar files and cached synced watchlists to power app calendars. Neither retrieved page explicitly authorizes replacement of VIP subscription feeds, nor resolves whether autonomous calendar-client refreshes meet the active-user-interaction rule.

Before enabling subscriptions in a public deployment, the maintainer must review the current API/CDN terms and confirm this particular subscription use with Simkl if necessary. Record the evidence, date and approved scope in release documentation. Default the subscription-use configuration flag to false; OAuth/account setup and fixture tests remain usable, and feed requests return a clear unavailable response until approved. This flag records an operator's reviewed decision; it does not itself constitute permission. Do not advertise this as bypassing VIP, or use any VIP-only endpoint. If approval is denied, keep subscription delivery disabled and adjust scope before release.

## Acceptance

With configured OAuth and approved subscription use, a connected user can select categories/statuses, copy four feeds, import matching upcoming entries into a compatible calendar, rotate/revoke links, and disconnect. Refreshes are bounded, upstream failures cannot cross user boundaries, rescheduled episodes retain identity, all automated gates pass, and production deploys only reviewed main revisions after same-revision CI success. Real OAuth/calendar-client smoke testing and terms/branch-protection configuration are recorded separately from fixture-based automated verification.
