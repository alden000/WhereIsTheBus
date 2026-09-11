# LTA DataMall proxy (Cloudflare Worker)

Holds your LTA DataMall `AccountKey` as a server-side secret and forwards
requests to `datamall2.mytransport.sg`, so the key never appears in the
frontend's JavaScript bundle or in this repo.

Two kinds of endpoint:

- **`bus-arrival`** — real-time, but cached per bus stop for 60 seconds
  instead of hitting LTA on every request. Takes a `BusStopCode` query
  param, comma-separated for a batch (max 15 stops per call — see below),
  and returns `{ "<stopCode>": {...LTA response...}, ... }`. There's
  deliberately no cron for this: with ~5,000 bus stops and no bulk "all
  arrivals" endpoint, blindly polling everything on a schedule would need
  ~100 LTA calls per cycle. Instead the frontend requests only the stops
  currently visible on the map, and each one is cached the moment it's
  first asked for.
- **Cached datasets** — `bus-stops`, `bus-services`, `bus-routes`. This
  reference data barely changes, so it's pulled once a day by a cron
  trigger and served from the cache — the frontend never causes an LTA
  call for these.

### Cache storage: D1, not KV

The cache (bus-arrival responses, the daily datasets, route geometry, and
some bookkeeping keys) lives in a small D1 table (`kv_store`), accessed
through a KV-shaped shim (`createD1KV` in `src/index.ts`) rather than an
actual KV namespace. This used to be Workers KV, but KV's Free plan caps
writes at **1,000/day** — and bus-arrival caching alone writes roughly
once per viewed stop per minute (the poll interval matches the cache
TTL), which blows past that in well under an hour of real usage. D1's
Free plan allows **100,000 writes/day and 5M reads/day** for the same
access pattern, with no other code or behavior change needed.

D1 has no built-in per-key TTL the way KV does, so `bus-arrival:<code>`
entries carry an `expires_at` timestamp column instead, checked (and
lazily deleted) on read.

### Why bus-arrival batches are capped at 15 stops

Worst case (every requested stop is a cache miss) costs 3 subrequests each:
a cache read, the LTA fetch, and a cache write — D1 queries count against
the same Workers subrequest budget as KV or a `fetch()` call did. 15
stops × 3 = 45, safely under the Workers Free plan's 50-subrequest-per-
invocation cap (see below) even if every stop in the batch misses at once.

Plus two maintenance endpoints:

- `cache/status` — returns
  `{ "lastUpdated": <ISO timestamp or null>, "refreshInProgress": bool, "cursor": {...} or null }`.
- `cache/refresh?key=<REFRESH_SECRET>` — manually kicks off the same pull the
  cron does. Useful the first time (don't wait for 3am) or after changing
  which datasets are cached. Gated by a secret so the public can't use it
  to hammer your LTA quota.

### Why this pulls in chunks, not one shot

The Workers **Free plan caps a single invocation at 50 subrequests**
(fetch calls + D1 queries combined). LTA caps each dataset at 500
records per call, and `BusRoutes` alone runs to roughly 26,000 records —
~52 calls just for that one dataset, already over the limit before
`BusStops`, `BusServices`, or any cache writes are counted.

So `cache/refresh` (and the cron) do at most `MAX_PAGES_PER_CHUNK` (40)
pages of one dataset, save how far they got in the cache (`refresh-cursor` /
`refresh-partial`), and trigger a fresh invocation of themselves over HTTP
to pick up where they left off — each new invocation gets its own 50-call
budget. A full refresh finishes in a handful of chained invocations a
couple of seconds apart; `cache/status` shows progress while it runs. A
dataset's cache entry is only overwritten once *all* of its pages are in,
so reads always see a complete previous dataset or a complete new one,
never a partial one — and a failed chunk doesn't corrupt the cursor, so
the next cron run or manual trigger just resumes from the last good
position.

`SELF_URL` near the top of `src/index.ts` must match wherever this Worker
is actually deployed — update it if you ever move it to a different
domain.

### Road-snapped route geometry (`route-geometry`)

LTA's `BusRoutes` only gives stop order, not road geometry, so a straight
line between consecutive stops cuts corners. `route-geometry` serves a
per-line (`ServiceNo|Direction`) road-following polyline generated via
[OpenRouteService](https://openrouteservice.org)'s Directions API:
`GET route-geometry` returns `{ "10|1": [[lat,lng], ...], ... }` — an
empty object if nothing has been generated yet (the frontend falls back
to straight stop-to-stop lines for any key that's missing).

This is **not** refreshed on the daily cron by itself — it piggybacks on
the bus-routes refresh instead: once `cache/refresh` finishes updating
`bus-stops`/`bus-services`/`bus-routes`, it automatically kicks off
`geometry/refresh`, which compares each line's current stop sequence
against a signature saved from the last time its geometry was generated.
Unchanged lines cost zero OpenRouteService calls; only new or changed
lines get (re)fetched and cached — perpetually, until they change again.

Maintenance endpoints, mirroring the bus-data ones:

- `geometry/status` — `{ lastUpdated, inProgress, progress: {done, total} | null, lastError }`.
- `geometry/refresh?key=<REFRESH_SECRET>` — manually kicks off a check.
  Useful for the very first backfill (don't wait for the next bus-routes
  refresh) — needs `bus-stops`/`bus-routes` already cached first.

A route longer than OpenRouteService's 50-waypoint-per-request cap is
split into overlapping windows and stitched back together, so long trunk
lines still get full geometry, just via more than one call. Calls are
spaced ~1.6s apart to stay under the free tier's ~40-requests/minute
limit; a first full backfill of a few hundred lines can take a while in
wall-clock time (chained in the background, no user-facing impact) but
costs nothing extra afterward since only genuine changes trigger new calls.

## One-time setup

### If you deploy via `wrangler` (CLI)

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY        # your real LTA key
npx wrangler secret put REFRESH_SECRET         # any random string you pick
npx wrangler secret put ORS_API_KEY            # your OpenRouteService key
npx wrangler d1 create whereisthebus-cache     # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml`'s `[[d1_databases]]`
block (replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`), then create the one
table the cache needs:

```bash
npx wrangler d1 execute whereisthebus-cache --remote --file=./schema.sql
```

and deploy:

```bash
npx wrangler deploy
```

The cron trigger (`[triggers]` in `wrangler.toml`, `0 19 * * *` UTC = 03:00
Singapore time) is picked up automatically on deploy.

### If you deploy via the Cloudflare dashboard

1. **D1 database**: dashboard → **Storage & Databases** → **D1 SQL
   Database** → **Create** (e.g. `whereisthebus-cache`).
2. **Create the table**: open the new database → **Console** tab → paste
   and run the contents of `schema.sql` (a single `CREATE TABLE`
   statement).
3. **Bind it**: your Worker → **Settings** → **Bindings** → **Add binding**
   → D1 Database → variable name `BUS_CACHE` → select the database you
   just created → **Save and deploy**.
4. **Add the secrets**: **Settings** → **Variables and Secrets** → **Add**
   → type **Secret** → name `REFRESH_SECRET` → value: any random string
   you choose → **Save and deploy**. Repeat for `ORS_API_KEY` with your
   OpenRouteService key.
5. **Cron trigger**: **Settings** → **Triggers** → **Cron Triggers** → **Add
   Cron Trigger** → expression `0 19 * * *` (03:00 Singapore time) → **Add**.
6. **Code**: paste the latest `src/index.ts` contents (converted to plain JS
   — see below) into **Edit code**, **Save and deploy**.

If you're migrating an existing deployment off KV: after adding the D1
binding, remove the old `BUS_CACHE` KV namespace binding (same variable
name can't point at two resources) and re-trigger `/cache/refresh` and
`/geometry/refresh` once, since the new D1 table starts out empty.

## First run

The cache stays empty (`cache/status` returns `lastUpdated: null`, and
`bus-stops` / `bus-services` / `bus-routes` return 503) until something
populates it. Don't wait for 3am the first time — trigger it manually:

```
https://<your-worker-url>/cache/refresh?key=<your REFRESH_SECRET>
```

Then check:

```
https://<your-worker-url>/cache/status
```

Once that's populated, trigger the first route-geometry backfill the same
way (this can take a while for a full backfill — see above — but you only
need to do this once; check progress via `geometry/status`):

```
https://<your-worker-url>/geometry/refresh?key=<your REFRESH_SECRET>
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in LTA_ACCOUNT_KEY and REFRESH_SECRET
npx wrangler d1 execute whereisthebus-cache --local --file=./schema.sql
npm run dev                       # runs at http://localhost:8787, with a local D1 database
```

`.dev.vars` is gitignored — never commit it.

## Redeploying

Any time you change `src/index.ts`, run:

```bash
npx wrangler deploy
```
