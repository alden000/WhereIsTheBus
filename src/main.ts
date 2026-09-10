import "./style.css";
import { createMap, enableLocate } from "./map";
import { fetchBusRoutes, fetchBusStops } from "./api";
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
Promise.all([fetchBusStops(), fetchBusRoutes()])
  .then(([stops, routes]) => {
    setStatus(null);
    const index = new BusDataIndex(stops, routes);
    attachBusOverlay(map, index, statusEl);
  })
  .catch((err: Error) => {
    setStatus(`Couldn't load bus data: ${err.message}`);
  });
