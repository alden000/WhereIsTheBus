# LTA DataMall proxy (Cloudflare Worker)

Holds your LTA DataMall `AccountKey` as a server-side secret and forwards
requests to `datamall2.mytransport.sg`, so the key never appears in the
frontend's JavaScript bundle or in this repo.

Two kinds of endpoint:

- **`bus-arrival`** — real-time, but cached per bus stop for 60 seconds
  (KV's minimum TTL) instead of hitting LTA on every request. Takes a
  `BusStopCode` query param, comma-separated for a batch (max 15 stops per
  call — see below), and returns `{ "<stopCode>": {...LTA response...}, ... }`.
  There's deliberately no cron for this: with ~5,000 bus stops and no bulk
  "all arrivals" endpoint, blindly polling everything on a schedule would
  need ~100 LTA calls per cycle and blow past KV's 1,000-writes/day free
  cap in well under an hour. Instead the frontend requests only the stops
  currently visible on the map, and each one is cached the moment it's
  first asked for.
- **Cached datasets** — `bus-stops`, `bus-services`, `bus-routes`. This
  reference data barely changes, so it's pulled into Cloudflare KV once a
  day by a cron trigger and served from there — the frontend never causes
  an LTA call for these.

### Why bus-arrival batches are capped at 15 stops

Worst case (every requested stop is a cache miss) costs 3 subrequests each:
a KV read, the LTA fetch, and a KV write. 15 stops × 3 = 45, safely under
the Workers Free plan's 50-subrequest-per-invocation cap (see below) even
if every stop in the batch misses at once.

Plus two maintenance endpoints:

- `cache/status` — returns
  `{ "lastUpdated": <ISO timestamp or null>, "refreshInProgress": bool, "cursor": {...} or null }`.
- `cache/refresh?key=<REFRESH_SECRET>` — manually kicks off the same pull the
  cron does. Useful the first time (don't wait for 3am) or after changing
  which datasets are cached. Gated by a secret so the public can't use it
  to hammer your LTA quota.

### Why this pulls in chunks, not one shot

The Workers **Free plan caps a single invocation at 50 subrequests**
(fetch calls + KV operations combined). LTA caps each dataset at 500
records per call, and `BusRoutes` alone runs to roughly 26,000 records —
~52 calls just for that one dataset, already over the limit before
`BusStops`, `BusServices`, or any KV writes are counted.

So `cache/refresh` (and the cron) do at most `MAX_PAGES_PER_CHUNK` (40)
pages of one dataset, save how far they got in KV (`refresh-cursor` /
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

## One-time setup

### If you deploy via `wrangler` (CLI)

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY     # your real LTA key
npx wrangler secret put REFRESH_SECRET      # any random string you pick
npx wrangler kv namespace create BUS_CACHE  # prints an id
```

Paste the printed id into `wrangler.toml`'s `[[kv_namespaces]]` block
(replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`), then:

```bash
npx wrangler deploy
```

The cron trigger (`[triggers]` in `wrangler.toml`, `0 19 * * *` UTC = 03:00
Singapore time) is picked up automatically on deploy.

### If you deploy via the Cloudflare dashboard

1. **KV namespace**: dashboard → **Storage & Databases** → **KV** → **Create
   namespace** (e.g. `whereisthebus-bus-cache`).
2. **Bind it**: your Worker → **Settings** → **Bindings** → **Add binding**
   → KV Namespace → variable name `BUS_CACHE` → select the namespace you
   just created → **Save and deploy**.
3. **Add the refresh secret**: **Settings** → **Variables and Secrets** →
   **Add** → type **Secret** → name `REFRESH_SECRET` → value: any random
   string you choose → **Save and deploy**.
4. **Cron trigger**: **Settings** → **Triggers** → **Cron Triggers** → **Add
   Cron Trigger** → expression `0 19 * * *` (03:00 Singapore time) → **Add**.
5. **Code**: paste the latest `src/index.ts` contents (converted to plain JS
   — see below) into **Edit code**, **Save and deploy**.

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

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in LTA_ACCOUNT_KEY and REFRESH_SECRET
npm run dev                       # runs at http://localhost:8787, with local KV
```

`.dev.vars` is gitignored — never commit it.

## Redeploying

Any time you change `src/index.ts`, run:

```bash
npx wrangler deploy
```
