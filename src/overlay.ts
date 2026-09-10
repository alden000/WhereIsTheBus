import L from "leaflet";
import { colorForService } from "./color";
import type { BusDataIndex } from "./busData";

// Below this zoom, a viewport can span enough of Singapore to contain
// hundreds of stops and most of the route network — rendering that is
// both unreadable and slow, so the overlay only switches on once the
// user has zoomed in far enough to look at a specific area.
const MIN_ZOOM_FOR_OVERLAY = 15;

export function attachBusOverlay(map: L.Map, index: BusDataIndex, hintEl: HTMLElement | null): void {
  const routesLayer = L.layerGroup().addTo(map);
  const stopsLayer = L.layerGroup().addTo(map);

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

    if (map.getZoom() < MIN_ZOOM_FOR_OVERLAY) {
      setHint("Zoom in to see bus stops and routes");
      return;
    }

    const visibleStops = index.getStopsInBounds(map.getBounds());
    if (visibleStops.length === 0) {
      setHint("No bus stops in view");
      return;
    }
    setHint(null);

    const lineKeys = index.getRouteLineKeysForStops(
      visibleStops.map((stop) => stop.BusStopCode)
    );

    for (const key of lineKeys) {
      const line = index.getRouteLine(key);
      if (!line) continue;

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

    for (const stop of visibleStops) {
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
  }

  map.on("moveend zoomend", render);
  render();
}
