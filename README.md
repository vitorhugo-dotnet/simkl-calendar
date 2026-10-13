# Simkl Calendar Sync

A standalone TypeScript + Hono Cloudflare Worker for personalized, revocable iCalendar feeds from your Simkl watchlist and public Calendar V2 data. Independent of `simkl-mcp`.

Connect with read-only OAuth V2/PKCE, choose TV/anime/movie categories and watchlist statuses, then copy a combined feed or a category feed into a calendar client. Rotate or revoke links from the account page. No cron, D1 database, or background polling is configured.

**Subscriptions ship disabled.** Before enabling them, complete the [release usage review](docs/release-review.md). Public calendar APIs are documented for app use; permission to replace VIP feeds or refresh watchlists through unattended calendar subscriptions has not been confirmed.

## Local development

Requires Node 22+ and npm, plus a Simkl **AUTH V2 server application** registration.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Fill the four values in .dev.vars; never commit it.
npm run dev
```

Generate two independent encryption/lookup keys using `openssl rand -base64 32`, inserting them into `.dev.vars` rather than sharing terminal output or logs. Register `http://localhost/auth/callback` for development (Simkl ignores loopback ports at authorization); the Worker sends exactly `http://localhost:8787/auth/callback` on both authorization and exchange. Use the same host throughout; `127.0.0.1` and `localhost` are different registrations. Copyable links use `APP_ORIGIN`, never a request's Host header.

Open `http://localhost:8787`, choose **Connect Simkl**, and approve `media:read`. The account page exposes filters, four subscription URLs, rotation, revocation, refresh, sign-out, and disconnection. For a locally approved usage test, set `SUBSCRIPTIONS_APPROVED` to `"true"` in Wrangler configuration. Otherwise authenticated feed requests return 503; invalid links return 404 regardless of the flag.

```sh
npm run check       # formatting, lint, strict TypeScript, Workers tests, dry-run build
npm run format      # apply formatting
npm run typecheck
npm test
npm run build       # bundles only; does not deploy
```

Tests run in the real Workers/Durable Object runtime with synthetic private responses and small observed public fixtures. No live OAuth credentials are used by CI. Vitest 3 and its compatible Workers pool are pinned in the lockfile; the pool package is deprecated in favor of the newer Cloudflare plugin, and a future toolchain upgrade should migrate both together.

## Subscribe

1. Connect your Simkl account and save category/status preferences.
2. Copy **Combined**, **TV**, **Anime**, or **Movies** from the account page.
3. Google Calendar: **Other calendars → + → From URL**. Paste the HTTPS URL. Use **From URL**, not file import, to receive later updates.
4. Apple Calendar: **File → New Calendar Subscription**. Outlook: **Add calendar → Subscribe from web**. Other clients must support HTTPS iCalendar subscriptions.

Production URLs must be reachable by the calendar provider; localhost cannot be subscribed to by Google Calendar. Anyone holding a subscription URL can read that calendar. Revocation blocks subsequent requests immediately; it cannot erase already downloaded copies. Rotate URLs and replace the subscription in each client after accidental sharing.

TV/anime statuses: Watching, Plan to watch, On hold, Completed, Dropped. Movies: Plan to watch, Completed, Dropped. Defaults select every category plus Watching and Plan to watch. Empty selections yield an empty calendar. Combined and separate feeds honor the same preferences; subscribing to both can display duplicate events in some clients.

## Refresh and calendar semantics

* On-demand watchlist checks are bounded to 30 minutes per account; the refresh button honors the same bound. Activities gate deltas; deletions are reconciled separately. No unconditional timer runs.
* Public datasets have independent shared caches, honoring CDN max-age/Age, with a five-hour freshness cap/default. Official generation cadence is six hours.
* On transient failures, last-good data is usable for at most 24 hours after successful validation. Required sources without usable data return 503 rather than a successful partial calendar. Rate-limit cooldowns persist; OAuth authorization loss closes feed access.
* Google and other calendar providers choose their own refresh schedules. This Worker cannot force immediate client refreshes. Private responses are never stored in a shared HTTP cache.
* The rolling datasets cover approximately yesterday plus 33 days; they are not historical archives. Schedule timestamps are emitted in UTC, including movies. Explicit date-only input becomes an all-day event; missing/invalid dates are skipped. Unknown durations are omitted.
* Stable UIDs use category/Simkl ID/episode identity, not title or schedule date. A date change retains UID. Conflicting duplicates choose the latest schedule instant, then a deterministic tie-breaker. Removed events disappear from later complete snapshots; no fabricated cancellation records.

See [upstream contracts and sources](docs/upstream-contracts.md), [deployment and operations](docs/operations.md), and [release review](docs/release-review.md). Repository source is MIT licensed. No reference-project source was copied.
