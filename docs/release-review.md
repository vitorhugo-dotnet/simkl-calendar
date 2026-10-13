# Release review — not yet approved

Implementation and fixture-based verification do not establish permission to redistribute personalized calendars. There is no operator flag for disabling feeds: the maintainer must record this review before distributing working subscriptions. Do not advertise the integration as bypassing Simkl VIP or call VIP-only endpoints.

## Usage decision

- [ ] Review the current API rules, Calendar V2 documentation, API/CDN terms and Simkl terms at https://simkl.com/about/policies/terms/.
- [ ] Confirm whether third-party subscribable personalized feeds are permitted, including overlap with paid/VIP feeds.
- [ ] Confirm whether request-time watchlist synchronization triggered by unattended calendar clients meets Simkl's active-user-interaction rule; obtain Simkl approval if the published terms do not settle it.
- [ ] If approval is denied or scope is narrower, do not publish or distribute working feeds; adjust scope before release.
- [ ] Record reviewer/date, source links or Simkl correspondence, permitted audience/use/scale, and any restrictions. No approval has been obtained in this implementation session.
- [ ] Obtain a commercial license if revenue reaches USD 150/month, per the current API rules; recheck the threshold at release.

Record of approval: **none**. Reviewer/date/evidence: **not supplied**. Public app-calendar data use is documented; replacement of VIP subscriptions and unattended-refresh use is **unconfirmed**.

## Production checks

- [ ] Runtime secrets provisioned separately from repository/assets/GitHub build logs.
- [ ] Production HTTPS APP_ORIGIN and OAuth V2 callback registration match exactly.
- [ ] Cloudflare token scoped only to the intended account with Workers Scripts Edit and only necessary account metadata permissions; no all-account/global API key. Runtime secret bootstrap handled by an operator, not CI output.
- [ ] Invocation logs, traces and account-level path capture disabled/redacted.
- [ ] Main protection/ruleset requires CI `quality`, reviewed PRs and intended bypass restrictions; remotely unverified in this session.
- [ ] Draft PR manually reviewed/marked ready; no automatic readiness or merge.
- [ ] Real OAuth/scope/refresh flow verified; automation uses synthetic responses only.
- [ ] Real Google Calendar or another subscription client verifies UTC dates, filters and stable events; localhost tests cannot establish provider compatibility.
- [ ] Old links return 404 immediately after rotation/revocation; explain retained client copies.
- [ ] Deployment uses the same current main SHA that passed CI, and fails/skips for failed CI/PR/older SHA.
- [ ] Bootstrap/rollback and encryption/lookup key procedures reviewed for storage compatibility.

Reference-project licensing: no source from trakt-ical-feed, trakt-calendar-server or Yamtrack was copied. New repository source remains MIT. Public fixture data provenance is recorded separately; API/CDN data-use terms still apply.
