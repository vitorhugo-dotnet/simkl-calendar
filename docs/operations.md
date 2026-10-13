# Deployment and operations

## Persistent state

ACCOUNT is one SQLite-backed Durable Object per HMAC-derived Simkl account address. It owns encrypted access/refresh credentials, preferences, hashed 30-day sessions, feed-secret hash plus encrypted redisplayable copy, activity/watchlist snapshots and persisted cooldowns. Explicit serialization covers authority changes and token refresh across awaits. OAuth state is one-use, browser-bound and expires after ten minutes. COORDINATOR owns encrypted transient OAuth transactions, shared category datasets, hashed-token cooldowns and conservative API pacing. It never persists private upstream responses or watchlists.

KV's eventual consistency cannot provide immediate revocation; D1 is unnecessary for these key-addressed records. SQLite-backed Durable Objects are available on Cloudflare Workers plans, subject to the account's current storage/request limits and pricing: verify those before hosting. The first migration is `v1` with `new_sqlite_classes`. Cache/snapshot values are chunked below 64 KiB with atomic manifests. Do not remove applied migrations or rename bindings/classes casually. Singleton API dispatch is intentionally a scale bottleneck; this is an MVP, not a high-throughput hosting design.

User API responses are limited to 20 MiB and CDN datasets to 10 MiB, with 15-second upstream timeouts. Limits fail safely rather than publishing partial snapshots. Session and OAuth expiry is checked at use time; expired OAuth transactions are cleaned opportunistically at new login, without alarms. Sign-out removes that browser session but leaves subscribed calendars working. Disconnect deletes local authority, tokens, preferences and watchlists even if remote grant revocation fails; users can revoke the app in Simkl Connected Apps. Storage deletion is logical and does not promise removal from any provider backup history.

## Configuration

| Name | Location | Purpose |
| --- | --- | --- |
| `SIMKL_CLIENT_ID` | Cloudflare secret / local `.dev.vars` | OAuth server app registration; transmitted as required public app identifier |
| `SIMKL_CLIENT_SECRET` | Cloudflare secret / local `.dev.vars` | Confidential OAuth client credential |
| `TOKEN_ENCRYPTION_KEY` | Cloudflare secret / local `.dev.vars` | Independent 32-byte base64 AES-GCM key |
| `ACCOUNT_LOOKUP_KEY` | Cloudflare secret / local `.dev.vars` | Independent 32-byte base64 HMAC key |
| `APP_ORIGIN` | GitHub production environment variable | Canonical HTTPS origin without path/query/credentials |
| `SUBSCRIPTIONS_APPROVED` | GitHub production environment variable | `true` only after recorded usage review; otherwise `false` |
| `APP_NAME`, `APP_VERSION` | Nonsecret Wrangler vars | Required upstream identification |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Account-scoped deployment token |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Intended Cloudflare account |

`wrangler.jsonc` defaults to loopback development origin and disabled subscriptions. The deploy workflow requires a valid production APP_ORIGIN and writes a generated config with environment values supplied through process variables, avoiding shell interpolation. If APP_ORIGIN is not configured, the workflow reports a notice and skips deployment; configure it in the production environment to enable deploys. Runtime OAuth/encryption/lookup credentials are provisioned independently; GitHub's deployment job does not need those values or place them in bundles. Do not pass runtime secrets using CLI arguments or print them to CI logs.

## Bootstrap

1. Complete release usage review, or keep subscriptions disabled for a private connection test.
2. Create a Simkl AUTH V2 **server app**; register exact `https://YOUR_WORKER_OR_DOMAIN/auth/callback`. Verify scopes and callback origin in a real browser. Ensure outbound access to `simkl.com`, `api.simkl.com` and `data.simkl.in` where network restrictions apply. Documentation lives at `api.simkl.org`; it is not the authenticated API host.
3. Choose the Worker origin and Cloudflare account. Install with `npm ci`, run `npm run check`, and authenticate Wrangler using the intended account. Provision each runtime secret through `npx wrangler secret put NAME` or Cloudflare's dashboard. On a brand-new account, create the named Worker/secret records via the dashboard or the private initial deploy described below if secret provisioning requires an existing Worker.
4. Set the two GitHub Actions secrets and production environment variables above. Configure optional production reviewers if desired.
5. Protect main with required check **`quality`** from **CI**, require a PR and at least one review, require the branch be up to date, restrict bypasses/admin overrides as policy allows, and disable automatic merging. Workflow YAML cannot enforce branch protection. After CI has run once, select the actual reported `quality` check in Settings → Branches/Rulesets. Draft PRs run all checks but never deploy; leave them Draft until a person marks ready.
6. For a first private bootstrap outside GitHub, use a copy of Wrangler config with your canonical HTTPS APP_ORIGIN, disabled subscriptions and identical bindings/migrations; deploy that configuration to the named Worker, then provision runtime secrets. Never publish an unreviewed branch to production to test OAuth. Prefer the reviewed main CI/CD path for normal deployment.
7. Reviewed merged main changes run CI; only its successful push-triggered workflow_run can deploy the exact checked revision. Older successful revisions are skipped if main advanced. Production deployments are serialized; deployment failures surface in Actions. No preview/staging Worker is required.
8. Test real connection, filters, Google/Apple/Outlook subscription and immediate old-link rejection after rotation. Enable subscriptions only after the release review records permission. Keep invocation log capture disabled before generating real feed URLs.

Current implementation session: connected GitHub metadata reports admin permission, but no branch-protection/ruleset read/write capability is available through the connected tools and the managed HTTP policy does not allow `api.github.com`. Required checks were therefore **not configured or verified remotely**. The maintainer must perform step 5. Cloudflare production credentials and live Simkl registration were not supplied, so no production deployment/live OAuth smoke test was performed.

## Logging and secrets

Wrangler observability is disabled. Application code has no request logging or token/body/URL dumps and has a generic error handler. Keep Workers invocation logs and traces disabled; do not run `wrangler tail` on real subscription traffic. Also disable/redact any account-level Logpush, access logs, analytics exports, external proxies or debugging middleware that record request paths: paths contain bearer feed secrets. Application logging controls cannot remove provider/account-level logs. Use only aggregate counters that do not include paths, identity, tokens or private metadata.

Feed responses and account/auth pages are private/no-store with no-referrer and a restrictive CSP. Do not enable edge caching for feeds or use feed secrets as browser sessions. URL sharing grants read access until rotation/revocation. Account HMAC addresses are pseudonymous, not authorization by themselves.

## Rollback, retries and key changes

* Re-run failed CI or Deploy jobs from GitHub Actions after fixing configuration. Deploy refuses a revision that is no longer main's head; commit a reviewed fix for a newer release. Failing CI never triggers deployment.
* Inspect release history with `npx wrangler deployments list`; roll back an approved compatible version using `npx wrangler rollback VERSION_ID`. Check Durable Object migration/storage compatibility first: code rollback cannot undo incompatible storage migrations. Recheck runtime secrets/origin and feed behavior after rollback. No runtime credentials belong in the rollback command.
* Quota cooldowns and last-good caches survive object restarts. Burst/transient idempotent API reads retry at most once; OAuth code exchange never retries blindly. Dataset errors apply a one-minute cooldown; stale data stops after 24 hours. Clients receive generic 503/Retry-After when no usable data exists.
* Encryption key changes require migrating existing ciphertext while the old key is available, or disconnecting accounts with the old key then requiring reconnection. Replacing the key without migration makes old credentials/secrets unreadable. Do not lose the old key before migration/disconnection.
* Lookup key changes alter account addresses and invalidate routing. Revoke/disconnect old accounts with the old configuration, erase their authority, change the key and require reconnection/new subscription URLs. Simply replacing this key leaves old account records behind and is not a safe revocation procedure.
