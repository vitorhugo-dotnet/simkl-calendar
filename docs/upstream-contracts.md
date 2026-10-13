# Upstream contract evidence

Verified 2026-10-13 using current official documentation and direct unauthenticated downloads of the three public V2 datasets. Research requests made before a client registration was available; configured Worker requests include the documented client/app identification.

| Dataset | Schedule rows | Metadata records | Missing metadata join IDs |
| --- | ---: | ---: | ---: |
| Anime | 489 | 138 | 0 |
| TV | 6,304 | 1,582 | 0 |
| Movie releases | 1,956 | 1,956 | 0 |

Root keys are `calendar` and `metadata`. Schedule rows use numeric `simkl_id`, UTC `date`, `finale_type`, and optional `episode`; metadata is keyed by string Simkl ID. Watchlist objects use `show.ids.simkl` or `movie.ids.simkl`; metadata IDs use `ids.simkl_id`. Every observed calendar item had a stable Simkl ID, so external-ID/title/slug matching is deliberately absent. Anime normally uses sequential episode numbering, but observed entries can contain seasons, including season zero. Sparse metadata is tolerated.

Actual responses advertised `max-age=18000`, Age, ETag and Last-Modified; files were last modified near 16:13 UTC. Docs specify six-hour regeneration and five-hour CDN caching. No guarantee of a particular release time is inferred from a single observation. The movie sample's schedule date and metadata release_date differed: the Worker uses schedule date, with UTC instants preserved and no inferred all-day semantics.

OAuth V2 requires S256 PKCE, `state`, issuer `https://simkl.com`, exact redirect consistency and read scope. Seven-day access tokens are refreshed by one account owner; refresh invalidates the previous access token and the 180-day sliding refresh token is nonrotating. Identity is numeric `account.id` from documented **GET `/users/settings`**, not the mutable profile name or token value.

Sync reads activities before initial sequential libraries, saves the pre-pull snapshot only on complete success, then uses changed membership activities and exact prior `all` as `date_from` when Simkl supplied a timestamp. Official `fresh_user` and `partial_user` activity examples contain null timestamps; when prior `all` is null, a changed category receives a full pull without `date_from`. `removed_from_list` needs IDs-only inventory reconciliation; it is not surfaced by deltas. Ratings/settings/playback changes alone do not trigger membership pulls. Movies omit watching/hold. Empty filtered libraries may be `{}` rather than explicit empty arrays.

V2 quota documentation gives per-user daily allowances of 500 (Free), 1,000 (PRO), 10,000 (VIP), shared across connected apps. Rate limits are 10 GET/sec and 1 POST/sec; public calendar CDN requests are exempt. The API rules also mention client-level caps; the singleton conservatively spaces all uncached dispatches by 110ms GET / 1,100ms POST. This caps throughput intentionally for MVP. Burst 429 and daily quota 429 have distinct cooldowns. No live quota or OAuth grant has been exercised in this implementation session.

Official sources:

* https://api.simkl.org/api-reference/calendar
* https://api.simkl.org/api-reference/oauth2-authorization-code
* https://api.simkl.org/api-reference/oauth2-tokens
* https://api.simkl.org/api-reference/oauth2-scopes
* https://api.simkl.org/api-reference/simkl/get-user-settings
* https://api.simkl.org/guides/sync
* https://api.simkl.org/api-reference/simkl/get-activities
* https://api.simkl.org/api-reference/simkl/get-all-items
* https://api.simkl.org/conventions/headers
* https://api.simkl.org/resources/rate-limits
* https://api.simkl.org/api-rules
* Terms link supplied by the official API schema: https://simkl.com/about/policies/terms/

The API rules permit noncommercial use and commercial revenue below USD 150/month, requiring a license at or above that threshold. Subscription/VIP scope and unattended-refresh permission remain unconfirmed. Public availability or CORS headers alone are not a license. See the release checklist.
