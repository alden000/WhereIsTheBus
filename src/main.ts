import "./style.css";
import { createMap, enableLocate } from "./map";
import { fetchBusRoutes, fetchBusStops, fetchRouteGeometry } from "./api";
import { BusDataIndex } from "./busData";
import { attachBusOverlay } from "./overlay";

const map = createMap("map");

const locateButton = document.getElementById("locate-control");
if (locateButton) {
  enableLocate(map, locateButton);
}

// Recompute Leaflet's internal size on viewport/orientation changes so the
// map always fills the screen without leaving stale tile gaps or scrollbars.
const resizeObserver = new ResizeObserver(() => map.invalidateSize());
const appEl = document.getElementById("app");
if (appEl) {
  resizeObserver.observe(appEl);
}

const statusEl = document.getElementById("app-status");
function setStatus(text: string | null): void {
  if (!statusEl) return;
  if (text) {
    statusEl.textContent = text;
    statusEl.hidden = false;
  } else {
    statusEl.hidden = true;
  }
}

setStatus("Loading bus data…");
Promise.all([
  fetchBusStops(),
  fetchBusRoutes(),
  // Road-snapped geometry is a nice-to-have, not core functionality — if
  // it fails to load (or simply isn't backfilled yet), fall back to an
  // empty map so routes still render as straight stop-to-stop lines
  // rather than blocking the whole app.
  fetchRouteGeometry().catch(() => ({})),
])
  .then(([stops, routes, geometry]) => {
    setStatus(null);
    const index = new BusDataIndex(stops, routes, geometry);
    attachBusOverlay(map, index, statusEl);
  })
  .catch((err: Error) => {
    setStatus(`Couldn't load bus data: ${err.message}`);
  });
