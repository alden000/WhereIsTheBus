import "./style.css";
import { createMap, enableLocate } from "./map";

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
