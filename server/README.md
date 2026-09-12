# LTA DataMall proxy (local server)

A local, dependency-free Node.js stand-in for `worker/` (the Cloudflare
Worker used for the deployed GitHub Pages site). Same job — hold your LTA
DataMall `AccountKey` server-side, cache reference data and bus arrivals,
and refresh on a timer — but running entirely on your own machine, with no
Cloudflare account, D1 database, or edge cache involved.

Endpoints are the same shape as the Worker's:

- `bus-stops`, `bus-services`, `bus-routes` — reference data, refreshed
  once a day (see below) and served from a local cache the rest of the time.
- `bus-arrival?BusStopCode=<code>[,<code>...]` — live arrivals, cached per
  stop for 60 seconds (max 15 stops per call).
- `route-geometry` — road-snapped polylines per service+direction line, via
  OpenRouteService. Optional: omit `ORS_API_KEY` and routes just render as
  straight stop-to-stop lines instead.
- `cache/status`, `cache/refresh?key=<REFRESH_SECRET>` — dataset refresh
  status / manual trigger.
- `geometry/status`, `geometry/refresh?key=<REFRESH_SECRET>` — route
  geometry backfill status / manual trigger.

## Why this is simpler than `worker/`

Cloudflare Workers cap a single invocation at 50 subrequests and a D1 text
column at 2MB, which is why `worker/src/index.ts` is full of chunking,
cursors, and self-resuming logic. None of that applies to a plain Node
process running continuously on your own machine, so this version just
loops straight through a full refresh in one call and keeps datasets in a
single local JSON file (`data/cache.json`, gitignored). Bus-arrival caching
is in-memory only — it's a 60s-fresh snapshot, so there's nothing worth
persisting across restarts.

## Setup

```bash
cd server
cp .env.example .env   # fill in LTA_ACCOUNT_KEY (and optionally ORS_API_KEY)
npm run dev             # or `npm start` — runs at http://localhost:8787
```

No `npm install` needed — no dependencies. The cache starts empty and
refreshes automatically on first startup (and once every 24h after that);
`cache/status` shows progress if you don't want to wait.

This is normally started together with the frontend via the root
`npm run dev`, which runs both under one command — see the root
[README](../README.md).
