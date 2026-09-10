import L from "leaflet";
import { colorForService } from "./color";
import { fetchBusArrival, type NextBus } from "./api";
import type { BusDataIndex } from "./busData";

// Below this zoom, a viewport can span enough of Singapore to contain
// hundreds of stops and most of the route network — rendering that is
// both unreadable and slow, so the overlay only switches on once the
// user has zoomed in far enough to look at a specific area. Was 15;
// lowered to let routes show at a wider view while still cutting off
// before a viewport can span most of the island's ~5,000 stops.
const MIN_ZOOM_FOR_OVERLAY = 13;

// LTA's own BusArrival feed updates every 20s; the worker caches each
// stop's response for 60s (KV's own minimum TTL), so polling faster than
// that just re-requests the same cached value. 30s keeps positions
// reasonably fresh without hammering the worker on every visible stop.
const BUS_POLL_INTERVAL_MS = 30000;

export interface BusOverlayHandle {
  // Restricts rendering to one service number ("100", say) or clears the
  // filter back to "everything touching a visible stop" when null.
  setServiceFilter(serviceNo: string | null): void;
}

function isTrackedCoord(lat: string, lon: string): boolean {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && la !== 0 && lo !== 0;
}

// A pill-shaped label matching the route's color, with the service
// number in the middle — same visual language as the colored route
// lines, just for the moving vehicle instead of the fixed path.
function busIcon(serviceNo: string): L.DivIcon {
  return L.divIcon({
    className: "bus-icon",
    html: `<div class="bus-icon-pill" style="background:${colorForService(serviceNo)}">${serviceNo}</div>`,
    iconSize: undefined,
    iconAnchor: [0, 0],
  });
}

export function attachBusOverlay(
  map: L.Map,
  index: BusDataIndex,
  hintEl: HTMLElement | null,
  onVisibleServicesChange?: (services: string[]) => void
): BusOverlayHandle {
  const routesLayer = L.layerGroup().addTo(map);
  const stopsLayer = L.layerGroup().addTo(map);
  const busesLayer = L.layerGroup().addTo(map);

  let serviceFilter: string | null = null;
  // The stops currently being drawn — also what bus positions are polled
  // for, so the two stay in sync whether or not a filter is active.
  let stopsForArrival: string[] = [];

  function setHint(text: string | null): void {
    if (!hintEl) return;
    if (text) {
      hintEl.textContent = text;
      hintEl.hidden = false;
    } else {
      hintEl.hidden = true;
    }
  }

  function render(): void {
    routesLayer.clearLayers();
    stopsLayer.clearLayers();
    stopsForArrival = [];

    if (map.getZoom() < MIN_ZOOM_FOR_OVERLAY) {
      setHint("Zoom in to see bus stops and routes");
      onVisibleServicesChange?.([]);
      return;
    }

    const visibleStops = index.getStopsInBounds(map.getBounds());
    if (visibleStops.length === 0) {
      setHint("No bus stops in view");
      onVisibleServicesChange?.([]);
      return;
    }
    setHint(null);

    const lineKeys = index.getRouteLineKeysForStops(
      visibleStops.map((stop) => stop.BusStopCode)
    );

    const visibleServices = new Set<string>();
    const stopCodesForFilter = new Set<string>();

    for (const key of lineKeys) {
      const line = index.getRouteLine(key);
      if (!line) continue;
      visibleServices.add(line.serviceNo);

      if (serviceFilter !== null && line.serviceNo !== serviceFilter) continue;
      for (const code of line.stopCodes) stopCodesForFilter.add(code);

      // Prefer the road-snapped geometry; fall back to straight
      // stop-to-stop segments for any line the backend hasn't
      // generated geometry for yet.
      const latlngs: L.LatLngTuple[] =
        index.getGeometryForLine(key) ??
        line.stopCodes
          .map((code) => index.getStop(code))
          .filter((stop): stop is NonNullable<typeof stop> => stop !== undefined)
          .map((stop): L.LatLngTuple => [stop.Latitude, stop.Longitude]);

      if (latlngs.length < 2) continue;

      L.polyline(latlngs, {
        color: colorForService(line.serviceNo),
        weight: 3,
        opacity: 0.85,
        lineJoin: "round",
      }).addTo(routesLayer);
    }

    onVisibleServicesChange?.([...visibleServices].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));

    const stopsToShow =
      serviceFilter === null
        ? visibleStops
        : visibleStops.filter((stop) => stopCodesForFilter.has(stop.BusStopCode));

    for (const stop of stopsToShow) {
      L.circleMarker([stop.Latitude, stop.Longitude], {
        radius: 4,
        weight: 1.5,
        color: "#e8ebf0",
        fillColor: "#2b2f36",
        fillOpacity: 1,
      })
        .bindTooltip(`${stop.Description || stop.RoadName} (${stop.BusStopCode})`)
        .addTo(stopsLayer);
    }

    stopsForArrival = stopsToShow.map((stop) => stop.BusStopCode);
  }

  async function refreshBuses(): Promise<void> {
    if (stopsForArrival.length === 0) {
      busesLayer.clearLayers();
      return;
    }

    let arrivals;
    try {
      arrivals = await fetchBusArrival(stopsForArrival);
    } catch {
      // Live positions are a nice-to-have on top of the static overlay —
      // leave whatever was last drawn rather than clearing it on a
      // transient fetch failure.
      return;
    }

    // Dedupe by physical bus (same service, same live position) since a
    // bus approaching several nearby visible stops would otherwise appear
    // once per stop it's listed under.
    const seen = new Set<string>();
    const markers: L.Marker[] = [];

    for (const stopCode of stopsForArrival) {
      const services = arrivals[stopCode]?.Services ?? [];
      for (const service of services) {
        if (serviceFilter !== null && service.ServiceNo !== serviceFilter) continue;

        for (const nextBus of [service.NextBus, service.NextBus2, service.NextBus3] as NextBus[]) {
          if (!nextBus || !isTrackedCoord(nextBus.Latitude, nextBus.Longitude)) continue;

          const lat = Number(nextBus.Latitude);
          const lon = Number(nextBus.Longitude);
          const key = `${service.ServiceNo}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          markers.push(
            L.marker([lat, lon], { icon: busIcon(service.ServiceNo) }).bindTooltip(
              `Bus ${service.ServiceNo} (${service.Operator})`
            )
          );
        }
      }
    }

    busesLayer.clearLayers();
    for (const marker of markers) marker.addTo(busesLayer);
  }

  map.on("moveend zoomend", () => {
    render();
    void refreshBuses();
  });
  render();
  void refreshBuses();
  setInterval(() => void refreshBuses(), BUS_POLL_INTERVAL_MS);

  return {
    setServiceFilter(serviceNo: string | null) {
      serviceFilter = serviceNo;
      render();
      void refreshBuses();
    },
  };
}
