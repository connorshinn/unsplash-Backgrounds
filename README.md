# Unsplash backgrounds (R2-backed Cloudflare Worker)

A Cloudflare Worker that returns a random Unsplash photo for use as a wallpaper/background. Warm requests are served from R2 by the Worker; cold requests redirect (302) to Unsplash's image CDN while the next photos are stored.

> A separate, optional **CDN pilot** (redirect-only delivery, no R2) lives in its own private repository, `connorshinn/unsplash-backgrounds-cdn-pilot`. It shares only the Unsplash API-budget broker described below. This repository is the R2 production implementation.

Production example (unchanged URL format):

```
https://unsplash.connorshinn.com/?auth=true&topics=nature&w=3840&h=1910&orientation=landscape
```

## Parameters

| Parameter | Meaning |
| --- | --- |
| `auth=true` | **Required request gate. Not authentication** — anyone who knows the flag can call the Worker. Other paths return 404. |
| `topics` | Topic slugs (`nature`, `animals`, …) or IDs, comma separated. |
| `collections` | Collection IDs, comma separated. |
| `query` | Search text, passed to Unsplash as written (whitespace normalised; **not** reordered). Cannot be combined with `topics`/`collections`. |
| `orientation` | `landscape`, `portrait`, `squarish`, or `auto` (resolved from `w`/`h` *before* pool selection). |
| `w`, `h` (`width`, `height`) | Output size, 1–8000. Rendering only; not a discovery filter (except via `orientation=auto`). |
| `dpr` | Device pixel ratio, 1–3. Default **2** (unchanged). Note: DPR 2 can upscale beyond the source photo; tuning it is a separate decision. |
| `fit` | `clamp`, `clip` (default), `crop`, `scale`. |
| `enhance` | `false`/`0`/`no`/`off` disables Unsplash enhancement; anything else is on. |
| `autosize=headers` | Use `Sec-CH-Viewport-Width/Height/DPR` client hints when the browser sends them. |
| `autosize=html` | Returns a page that re-requests itself with the viewport size. Works only when navigated to as a page — scripts do not run when the URL is used as a CSS background or `<img>`. |

Invalid numeric values return 400 (they used to be forwarded). Quality `q=65`, `cs=srgb` and `auto=format` are fixed as before.

### Response headers

Photographer names are in headers only (no UI). Values that are not plain ASCII (or contain `%`) are **percent-encoded**; a companion `…-Encoding: percent` header is added. Decode with `decodeURIComponent`.

`X-Cache-Status` (`HIT`=served from R2, `MISS`=302 to Unsplash), `X-Unsplash-Photographer`, `X-Unsplash-Parameters`, `X-Image-Source-URL`, `X-Unsplash-Application` (which application discovered the photo), `X-Image-Requested-Dimensions` (the requested size; the old `X-Image-Dimensions` is gone because it could not report actual pixels), `X-Image-File-Size` (hits). On a `MISS` redirect the photographer headers are on the Worker's 302 only.

HEAD returns 200 with headers and does not rotate; other methods return 405.

## How it works

* **Selection vs rendering.** Photos are pooled per *selection* (topics/collections/query/orientation). Rendered bytes are keyed per *rendering* (w, h, dpr, fit, enhance, q, cs). A new screen size reuses the existing pool with no new discovery; it redirects once and then stores that size lazily (the served photo plus the next `MATERIALIZE_AHEAD`=6 photos).
* **Coordinator (Durable Object, `Coordinator`).** One instance owns rotation cursors, single-flight pool fill/refresh, quota reservations, the tracking-event queue and GC. Concurrent cold misses cause a single discovery. KV only holds read-mostly pool snapshots used as a fallback if the coordinator is unavailable.
* **Pools & reuse.** First fill = 30 photos (`/photos/random?count=30`). When ≤ `REFRESH_THRESHOLD` (5) unseen photos remain, one background refresh adds up to 30 more; unseen photos stay at the front, served ones are retired. If a refresh fails or is rate limited the pool keeps rotating (occasional reuse), with exponential back-off. Pools are capped at `POOL_MAX`=60.
* **R2 layout.** Objects are immutable: `v2/r/<renderKey>/<photoId>`. Nothing is overwritten or cleared. Retired objects are deleted by the GC after `GC_GRACE_MS` (15 min), delete failures are retried with back-off and their references kept. GC only deletes keys under `v2/r/`; the legacy `tinyauth-backgrounds` Worker shares the `unsplash-cache` bucket and is never touched.
* **Tracking.** A download event is queued when a photo is actually served (including the first, redirected photo), sent with the Access Key of the application that discovered it, awaited, and retried (bounded). Events are never re-attributed to the other application.

## Two Unsplash applications and failover

Primary (`UNSPLASH_ACCESS_KEY`, app `813645`) and secondary (`UNSPLASH_SECONDARY_ACCESS_KEY`, app `1116485`) are tracked independently: limit and remaining (from `X-Ratelimit-*`), in-flight reservations, cooldown (honours `Retry-After`, otherwise 5→60 min back-off with one probe), and invalid-credential state (401/non-quota 403 ≠ exhaustion). Discovery prefers primary and switches to the secondary when primary falls to `TRACK_RESERVE` (10) remaining; it stays there until primary's window resets (no oscillation). The reserve is kept for tracking. If both are unavailable, cached photos keep being served and new fills return 503 with the real `Retry-After`. Rotating a key resets that application's saved health automatically (fingerprint-based) after the next deploy.

### Pilot broker

`PilotBroker` (a `WorkerEntrypoint`) is the only cross-project dependency. The pilot's service binding fixes its identity to `pilot`; it can only run bounded discovery (≤30 photos) and owner-validated tracking, never rotation or cache operations. The pilot gets `PILOT_HOURLY_ALLOWANCE` (default **5** API calls/hour across both keys, including tracking) and may only use an application that still has more than `PILOT_PROD_RESERVE` (15) remaining; production is never limited by pilot activity. Contract version: `BROKER_API_VERSION = 1` (additive changes only; roll back the pilot before rolling production back to a pre-broker version).

## Configuration

Installation values are in `wrangler.toml`; reusable defaults and every tunable are in `src/config.js` (override via `[vars]`).

| Resource | Binding |
| --- | --- |
| R2 `unsplash-cache` | `UNSPLASH_CACHE` |
| KV `UNSPLASH_CACHE_METADATA_V2` | `UNSPLASH_CACHE_METADATA` (pool snapshots `v2:snap:*`; legacy entries age out) |
| Durable Object | `COORDINATOR` (`Coordinator`, SQLite) |
| Secrets | `UNSPLASH_ACCESS_KEY`, `UNSPLASH_SECONDARY_ACCESS_KEY`, optional `ADMIN_TOKEN` |
| Cron | `*/10 * * * *` (drain events, resume refreshes, GC) and `0 2 * * *` (also retire pools idle > 14 days, clean legacy KV entries) |

`GET /__status` with `Authorization: Bearer $ADMIN_TOKEN` returns quota per application, pending events, pool/GC counters and effective tunables (404 without the secret). Metrics are per coordinator lifetime except quota/pool state.

> `wrangler.toml` environments **inherit `routes`**; `[env.staging]` sets `routes = []` so staging can never take over `unsplash.connorshinn.com`.

## Development

```
npm install
npm test        # node:test; mocked Unsplash/R2/KV/DO, no network
npm run check
npx wrangler dev
```

Tests cover: concurrent cold misses, partial/empty batches, failed refresh/store/delete paths, stale-refresh races, Unicode headers, key collisions and query preservation, DPR/fit/enhance/orientation round trips, unsupported methods, tracking ownership, failover (exhaustion, invalid keys, both exhausted, recovery, concurrency), and the pilot broker (allowance, reserve, identity).

### Staging

`npx wrangler deploy --env staging` deploys `tinyauth-backgrounds-v2-staging` with its own bucket (`unsplash-cache-staging`), KV namespace and coordinator state. Staging uses the real applications' quota (live checks are deliberately few).

## Deployment

Workers Builds (Git) deploys `main` to `tinyauth-backgrounds-v2` with `npx wrangler deploy`; build command `npm ci && npm test`. Manual: `npm run deploy`.

## Rollback

* Re-deploy the previous version in the dashboard or `npx wrangler rollback <version-id>`. Cached v2 objects/pools are additive, the legacy cache entries from the previous code are retained (they age out after 14 idle days) and the old code will simply refill on a miss.
* The Durable Object migration `v1` is additive; rolling code back leaves the (unused) coordinator state in place.
* Disable the CDN pilot **before** rolling production back to a version without `PilotBroker`.

## License

MIT
