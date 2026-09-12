# Where Is The Bus

Interactive map UI for tracking real-time public bus positions in Singapore.

## Stack

- Vite + TypeScript (no framework needed yet — kept small)
- [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles for the base map (roads + road names, pan/zoom by touch or mouse)

## Current status

This first pass is UI only: a fullscreen, responsive map (fits any phone,
tablet, or desktop viewport with no scrollbars), constrained to pan/zoom
around Singapore, plus a "locate me" button.

Bus position data (LTA DataMall `BusArrival` / `BusRoutes` APIs, authenticated
via an `AccountKey` header) and live bus markers are intentionally left out
for now and will be added in a follow-up.

## API key handling

The LTA DataMall `AccountKey` must never be embedded in this frontend — any
key shipped in client-side JavaScript is visible to anyone who opens the
site, regardless of whether the repo is public or private. Instead, a
backend keeps the key as a server-side secret and proxies only a fixed
allowlist of LTA endpoints to the frontend. There are two, and which one a
build talks to is decided at build time (see `vite.config.ts`):

- `server/` — a small dependency-free Node.js server for **local
  development**. Runs on your own machine, no Cloudflare account needed.
  See `server/README.md` for setup (you'll need your own LTA DataMall key).
- `worker/` — a Cloudflare Worker used by the **deployed GitHub Pages
  site**. See `worker/README.md` for deployment steps.

## Develop

```bash
npm install
npm run dev
```

This starts both the Vite dev server and the local API server (`server/`)
together, proxied under one origin (`vite.config.ts`'s `/api` proxy) —
first run `cd server && cp .env.example .env` and fill in your LTA
DataMall key, or `npm run dev` will fail fast with a clear error.

## Build

```bash
npm run build
npm run preview
```

## Project layout

- `src/map.ts` — map creation, bounds/zoom limits, geolocation "locate me" control
- `src/main.ts` — app entry point, wires the map into the page
- `src/api.ts` — talks to the backend via `/api` in dev, or the deployed
  Cloudflare Worker in a `GITHUB_PAGES` build
- `src/style.css` — fullscreen/responsive layout (100dvh, no scroll), header, controls
- `server/` — local Node.js backend (dev)
- `worker/` — Cloudflare Worker backend (production/GitHub Pages)
