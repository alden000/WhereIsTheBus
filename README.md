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

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Project layout

- `src/map.ts` — map creation, bounds/zoom limits, geolocation "locate me" control
- `src/main.ts` — app entry point, wires the map into the page
- `src/style.css` — fullscreen/responsive layout (100dvh, no scroll), header, controls
