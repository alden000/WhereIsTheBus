import "./style.css";
import { createMap, enableLocate } from "./map";
import { fetchBusRoutes, fetchBusStops, fetchRouteGeometry } from "./api";
import { BusDataIndex } from "./busData";
import { attachBusOverlay } from "./overlay";

const map = createMap("map");

const locateButton = document.getElementById("locate-control");
const locateControl = locateButton ? enableLocate(map, locateButton) : null;
if (locateControl) {
  // Center and zoom in on the user's own position as soon as the map is
  // up, without waiting for bus data — silent on denial/failure, since
  // this is us being helpful on load, not something the user asked for
  // this particular time the way clicking the button would be.
  locateControl.locateSilently();
}

const followToggle = document.getElementById("follow-toggle") as HTMLInputElement | null;
if (followToggle && locateControl) {
  followToggle.disabled = false;
  followToggle.addEventListener("change", () => {
    if (followToggle.checked) {
      locateControl.setFollowMode(true, (message) => {
        // A mid-session failure (most commonly permission revoked) stops
        // following on the map.ts side already — reflect that back into
        // the checkbox itself rather than leaving it checked but inert.
        followToggle.checked = false;
        alert(message);
      });
    } else {
      locateControl.setFollowMode(false);
    }
  });
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

const serviceSelect = document.getElementById("service-select") as HTMLSelectElement | null;

// Set once attachBusOverlay resolves below — updateServiceOptions is
// passed to it as a callback and can run (e.g. on a zoom/pan that starts
// before data even finishes loading isn't possible, but this keeps the
// two independent of load order regardless) before that assignment lands.
let overlayHandle: ReturnType<typeof attachBusOverlay> | null = null;

// Repopulates the dropdown with whatever service numbers are currently
// touching a visible stop. Rebuilding the option list on every viewport
// change (rather than diffing) is simple and cheap enough at this size —
// there are at most a few dozen services in view at once, never the
// ~800-service full network.
function updateServiceOptions(services: string[]): void {
  if (!serviceSelect) return;
  const previousValue = serviceSelect.value;

  serviceSelect.replaceChildren(new Option("All services", ""));
  for (const serviceNo of services) {
    serviceSelect.appendChild(new Option(serviceNo, serviceNo));
  }

  // Keep the current selection if it's still in view; otherwise the
  // filter falls back to "All services". Setting .value here is a plain
  // DOM assignment — it does NOT fire the 'change' listener below — so a
  // fallback to "" has to also clear the overlay's own filter explicitly,
  // or the map keeps filtering to a service the dropdown no longer shows
  // as selected (found live: zoom out below the overlay's minimum zoom,
  // which reports no visible services at all, then zoom back in — the
  // dropdown reads "All services" but the map is still limited to
  // whichever service was picked before).
  const stillVisible = services.includes(previousValue);
  serviceSelect.value = stillVisible ? previousValue : "";
  if (!stillVisible && previousValue !== "") {
    overlayHandle?.setServiceFilter(null);
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
    const overlay = attachBusOverlay(map, index, statusEl, updateServiceOptions);
    overlayHandle = overlay;

    if (serviceSelect) {
      serviceSelect.disabled = false;
      serviceSelect.addEventListener("change", () => {
        overlay.setServiceFilter(serviceSelect.value || null);
      });
    }
  })
  .catch((err: Error) => {
    setStatus(`Couldn't load bus data: ${err.message}`);
  });
