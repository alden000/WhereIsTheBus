import L from "leaflet";
import { colorForService } from "./color";
import { fetchBusArrival, type BusArrivalResponse, type BusStop, type NextBus } from "./api";
import type { BusDataIndex } from "./busData";
import {
  type LatLng,
  pathLength,
  positionAtDistance,
  projectOntoPath,
  slicePathByDistance,
} from "./geo";

// Below this zoom, a viewport can span enough of Singapore to contain
// hundreds of stops and most of the route network — rendering that is
// both unreadable and slow, so the overlay only switches on once the
// user has zoomed in far enough to look at a specific area. Was 15;
// lowered to let routes show at a wider view while still cutting off
// before a viewport can span most of the island's ~5,000 stops.
const MIN_ZOOM_FOR_OVERLAY = 13;

// How far past the exact viewport edge to still show stops and poll for
// their buses. A stop just off-screen is often the very next stop for a
// bus already visible on the on-screen portion of its route, so limiting
// polling to the exact viewport would make that bus disappear right as
// it's approaching — this keeps it visible a little past the edge instead.
const VIEWPORT_PADDING = 0.3;

// The worker caches each stop's BusArrival response for 60s (KV's own
// minimum TTL) — was 30s, but that meant roughly every other poll just
// re-requested the same cached value for no fresher data, while also
// doubling how often a bad ETA/distance pairing (see MAX_BUS_SPEED_MPS
// below) could visibly kick a bus's speed. Matching the actual cache
// lifetime avoids both.
const BUS_POLL_INTERVAL_MS = 60000;

// Between refreshes, buses are animated along their route rather than
// jumping straight to the next polled position.
const ANIMATION_FPS = 10;
const ANIMATION_TICK_MS = 1000 / ANIMATION_FPS;

// A bus reported as "due" or already overdue would otherwise get an
// absurd (or infinite/NaN) speed from distance/time — floor the duration
// so dividing by it can't blow up.
const MIN_LEG_DURATION_S = 3;

// The real fix for "unrealistically fast" buses: LTA's EstimatedArrival
// and a bus's live Latitude/Longitude aren't always perfectly in sync
// (reporting lag, or the ETA reading as imminent/slightly overdue while
// the GPS fix is still a real distance out) — dividing that leftover
// distance by a tiny remaining duration produces a speed with no
// relationship to how fast a bus can actually move. Rather than trust
// distance/duration unconditionally, treat it as an upper estimate and
// clamp to Singapore's actual bus speed limit; a bus that would
// otherwise "arrive late" at this cap just gets picked up again at its
// next real reported position on the following poll.
const MAX_BUS_SPEED_MPS = 60 / 3.6; // 60 km/h

// How often an already-open popup's countdown/timestamp text refreshes.
// Independent of both the 60s data poll and the 10fps position
// animation — this only rewrites text content, so once a second is
// plenty to feel live without doing pointless work while nothing's open.
const POPUP_TICK_MS = 1000;

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

// "3m 45s" — used for a single bus's own popup, where there's room (and
// reason) to be precise about exactly when it's expected.
function formatEtaDetailed(etaSeconds: number): string {
  const total = Math.max(0, Math.round(etaSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${seconds}s`;
}

// "30s" / "3m" / "Due" — used in a bus stop's multi-service table, where
// three ETAs per row need to stay short enough to line up cleanly.
function formatEtaShort(etaSeconds: number): string {
  if (etaSeconds <= 5) return "Due";
  if (etaSeconds < 60) return `${Math.round(etaSeconds)}s`;
  return `${Math.round(etaSeconds / 60)}m`;
}

function formatSecondsAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds <= 1 ? "just now" : `${seconds}s ago`;
}

// One physical bus's animation state: a short path segment from wherever
// it was last reported to the stop it's heading for, walked at a
// constant speed derived from LTA's own ETA and that segment's length.
interface AnimatedBus {
  marker: L.Marker;
  serviceNo: string;
  path: LatLng[];
  totalDistance: number;
  traveledDistance: number;
  speedMetersPerSecond: number;
  // Absolute timestamps rather than durations, so the popup can always
  // recompute "time left" / "how long ago" live from Date.now() without
  // compounding rounding error across repeated re-renders.
  etaAtMs: number;
  lastUpdatedMs: number;
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

function busPopupHtml(bus: AnimatedBus): string {
  const etaSeconds = (bus.etaAtMs - Date.now()) / 1000;
  return `
    <div class="bus-popup">
      <div class="bus-popup-title" style="color:${colorForService(bus.serviceNo)}">Bus ${bus.serviceNo}</div>
      <div class="bus-popup-row">ETA: <strong>${etaSeconds <= 0 ? "Due" : formatEtaDetailed(etaSeconds)}</strong></div>
      <div class="bus-popup-row bus-popup-muted">Updated ${formatSecondsAgo(Date.now() - bus.lastUpdatedMs)}</div>
    </div>
  `;
}

function stopPopupHtml(stop: BusStop, arrival: BusArrivalResponse | undefined): string {
  const services = arrival?.Services ?? [];
  const rows = services.length
    ? services
        .map((service) => {
          const etaCells = ([service.NextBus, service.NextBus2, service.NextBus3] as NextBus[])
            .map((nextBus) => {
              if (!nextBus?.EstimatedArrival) return "–";
              const etaSeconds = (Date.parse(nextBus.EstimatedArrival) - Date.now()) / 1000;
              return Number.isFinite(etaSeconds) ? formatEtaShort(etaSeconds) : "–";
            })
            .map((text) => `<td class="stop-popup-eta">${text}</td>`)
            .join("");
          return `<tr><td class="stop-popup-service" style="color:${colorForService(service.ServiceNo)}">${service.ServiceNo}</td>${etaCells}</tr>`;
        })
        .join("")
    : `<tr><td class="stop-popup-empty" colspan="4">No live arrivals</td></tr>`;

  return `
    <div class="stop-popup">
      <div class="stop-popup-title">Stop ${stop.BusStopCode}</div>
      <div class="stop-popup-subtitle">${stop.Description || stop.RoadName}</div>
      <table class="stop-popup-table">${rows}</table>
    </div>
  `;
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
  // Keyed by "<stopCode>:<serviceNo>:<slot>" (slot = which of a service's
  // next 3 buses at that stop) — the closest thing to a stable per-bus
  // identity LTA's API offers, since it exposes no vehicle ID. Persists
  // across refreshes so a bus already mid-animation keeps its own marker
  // (and just gets a new leg to animate along) instead of being torn
  // down and recreated every 30s.
  const animatedBuses = new Map<string, AnimatedBus>();
  // Rebuilt on every render() (stop markers themselves are too, via
  // stopsLayer.clearLayers()) — lets refreshBuses() and the popup ticker
  // find and update a given stop's already-open popup without having to
  // re-query the map.
  const stopMarkers = new Map<string, L.CircleMarker>();
  // The latest arrival response actually fetched for each stop — kept
  // around (separately from the animated buses, which only cover buses
  // with a trackable live position) so a stop's popup can show all 3
  // upcoming buses per service even for ones LTA hasn't started
  // reporting a GPS fix for yet, and so the popup ticker can recompute
  // ETA countdowns live between polls.
  const stopArrivals = new Map<string, BusArrivalResponse>();

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
    stopMarkers.clear();
    stopsForArrival = [];

    if (map.getZoom() < MIN_ZOOM_FOR_OVERLAY) {
      setHint("Zoom in to see bus stops and routes");
      onVisibleServicesChange?.([]);
      return;
    }

    // Route visibility is judged against the exact on-screen area — a
    // route counts as visible the moment any part of its line is
    // actually on screen, not just when one of its stops happens to be.
    // Stops (and, via stopsForArrival below, live bus lookups) use a
    // padded version instead: a stop just past the edge is still worth
    // showing and worth polling, since a bus heading for it is often
    // already visible on the portion of its route that's on screen.
    const strictBounds = map.getBounds();
    const lineKeys = index.getRouteLineKeysIntersectingBounds(strictBounds);
    const visibleStops = index.getStopsInBounds(strictBounds.pad(VIEWPORT_PADDING));

    if (lineKeys.size === 0 && visibleStops.length === 0) {
      setHint("No bus stops in view");
      onVisibleServicesChange?.([]);
      return;
    }
    setHint(null);

    const visibleServices = new Set<string>();
    const stopCodesForFilter = new Set<string>();

    for (const key of lineKeys) {
      const line = index.getRouteLine(key);
      if (!line) continue;
      visibleServices.add(line.serviceNo);

      if (serviceFilter !== null && line.serviceNo !== serviceFilter) continue;
      for (const code of line.stopCodes) stopCodesForFilter.add(code);

      const latlngs = index.getPathForLine(key);
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
      const marker = L.circleMarker([stop.Latitude, stop.Longitude], {
        radius: 4,
        weight: 1.5,
        color: "#e8ebf0",
        fillColor: "#2b2f36",
        fillOpacity: 1,
      })
        .bindTooltip(`${stop.Description || stop.RoadName} (${stop.BusStopCode})`)
        // Placeholder content — whatever arrival data is already cached
        // for this stop from a previous refresh (possibly none yet,
        // right after panning to a stop never seen before), replaced
        // with fresh data as soon as the next refreshBuses() lands.
        .bindPopup(stopPopupHtml(stop, stopArrivals.get(stop.BusStopCode)))
        .addTo(stopsLayer);
      stopMarkers.set(stop.BusStopCode, marker);
    }

    stopsForArrival = stopsToShow.map((stop) => stop.BusStopCode);
  }

  // A stop can be served by two lines with the same service number (the
  // two directions of a loop route) — pick whichever of that service's
  // lines actually includes this stop, since that's the one whose
  // geometry the bus reported as arriving *here* is really following.
  function findLineKeyForStop(stopCode: string, serviceNo: string): string | undefined {
    for (const key of index.getRouteLineKeysForStops([stopCode])) {
      const line = index.getRouteLine(key);
      if (line?.serviceNo === serviceNo) return key;
    }
    return undefined;
  }

  async function refreshBuses(): Promise<void> {
    if (stopsForArrival.length === 0) {
      for (const bus of animatedBuses.values()) bus.marker.remove();
      animatedBuses.clear();
      return;
    }

    let arrivals;
    try {
      arrivals = await fetchBusArrival(stopsForArrival);
    } catch {
      // Live positions are a nice-to-have on top of the static overlay —
      // leave whatever was last drawn (and animating) rather than
      // clearing it on a transient fetch failure.
      return;
    }

    const fetchedAt = Date.now();

    // Keep each visible stop's arrival table current — separate from the
    // per-bus animation state below, since this also covers services LTA
    // hasn't reported a live GPS fix for yet, and feeds any already-open
    // stop popup its fresh numbers straight away rather than waiting for
    // the 1s popup ticker.
    for (const stopCode of stopsForArrival) {
      const response = arrivals[stopCode];
      if (!response) continue;
      stopArrivals.set(stopCode, response);
      const marker = stopMarkers.get(stopCode);
      const stop = index.getStop(stopCode);
      if (marker && stop) marker.setPopupContent(stopPopupHtml(stop, response));
    }

    // A bus approaching several nearby visible stops in a row would
    // otherwise get one leg per stop it's listed under — keep only the
    // leg for the stop it's actually closest to (i.e. genuinely next).
    const closestLegForBus = new Map<string, { key: string; distance: number }>();
    interface PendingLeg {
      key: string;
      serviceNo: string;
      rawPosition: LatLng;
      stopPosition: LatLng;
      path: LatLng[];
      etaSeconds: number;
      etaAtMs: number;
    }
    const pendingLegs = new Map<string, PendingLeg>();

    for (const stopCode of stopsForArrival) {
      const stop = index.getStop(stopCode);
      if (!stop) continue;
      const stopPosition: LatLng = [stop.Latitude, stop.Longitude];
      const services = arrivals[stopCode]?.Services ?? [];

      for (const service of services) {
        if (serviceFilter !== null && service.ServiceNo !== serviceFilter) continue;

        const slots: [NextBus, string][] = [
          [service.NextBus, "1"],
          [service.NextBus2, "2"],
          [service.NextBus3, "3"],
        ];
        for (const [nextBus, slot] of slots) {
          if (!nextBus || !isTrackedCoord(nextBus.Latitude, nextBus.Longitude)) continue;

          const rawPosition: LatLng = [Number(nextBus.Latitude), Number(nextBus.Longitude)];
          const busId = `${service.ServiceNo}:${rawPosition[0].toFixed(4)}:${rawPosition[1].toFixed(4)}`;
          const distance = Math.hypot(
            rawPosition[0] - stopPosition[0],
            rawPosition[1] - stopPosition[1]
          );
          const existing = closestLegForBus.get(busId);
          const key = `${stopCode}:${service.ServiceNo}:${slot}`;
          if (existing && existing.distance <= distance) continue;
          if (existing) pendingLegs.delete(existing.key);
          closestLegForBus.set(busId, { key, distance });

          const lineKey = findLineKeyForStop(stopCode, service.ServiceNo);
          const path = lineKey ? index.getPathForLine(lineKey) : [];
          const parsedEtaAt = Date.parse(nextBus.EstimatedArrival);
          const etaAtMs = Number.isFinite(parsedEtaAt) ? parsedEtaAt : fetchedAt + MIN_LEG_DURATION_S * 1000;
          pendingLegs.set(key, {
            key,
            serviceNo: service.ServiceNo,
            rawPosition,
            stopPosition,
            path: path.length >= 2 ? path : [rawPosition, stopPosition],
            etaSeconds: (etaAtMs - fetchedAt) / 1000,
            etaAtMs,
          });
        }
      }
    }

    for (const [key, leg] of pendingLegs) {
      const existing = animatedBuses.get(key);
      // A bus already animating picks up its new leg from wherever it's
      // currently *visually* sitting on the map, not the freshly polled
      // raw GPS fix — otherwise every refresh (including ones triggered
      // by panning or zooming, which also call this) snaps it backward
      // to that raw position, discarding however far it had already
      // animated since the last poll. A brand-new bus has no visual
      // position to preserve, so it starts from where LTA reports it.
      const startPosition: LatLng = existing
        ? [existing.marker.getLatLng().lat, existing.marker.getLatLng().lng]
        : leg.rawPosition;

      const busProjection = projectOntoPath(startPosition, leg.path);
      const stopProjection = projectOntoPath(leg.stopPosition, leg.path);
      const subPath = slicePathByDistance(leg.path, busProjection.distanceAlong, stopProjection.distanceAlong);
      const totalDistance = pathLength(subPath);
      const durationSeconds = Math.max(leg.etaSeconds, MIN_LEG_DURATION_S);
      const speedMetersPerSecond = Math.min(totalDistance / durationSeconds, MAX_BUS_SPEED_MPS);

      if (existing) {
        existing.path = subPath;
        existing.totalDistance = totalDistance;
        existing.traveledDistance = 0;
        existing.speedMetersPerSecond = speedMetersPerSecond;
        existing.etaAtMs = leg.etaAtMs;
        existing.lastUpdatedMs = fetchedAt;
        existing.marker.setPopupContent(busPopupHtml(existing));
      } else {
        const marker = L.marker(subPath[0], { icon: busIcon(leg.serviceNo) }).addTo(busesLayer);
        const bus: AnimatedBus = {
          marker,
          serviceNo: leg.serviceNo,
          path: subPath,
          totalDistance,
          traveledDistance: 0,
          speedMetersPerSecond,
          etaAtMs: leg.etaAtMs,
          lastUpdatedMs: fetchedAt,
        };
        marker.bindPopup(busPopupHtml(bus));
        animatedBuses.set(key, bus);
      }
    }

    // Drop buses no longer reported at all (arrived, gone out of
    // service, or the stop that was tracking them scrolled out of view).
    for (const [key, bus] of animatedBuses) {
      if (!pendingLegs.has(key)) {
        bus.marker.remove();
        animatedBuses.delete(key);
      }
    }
  }

  // A backgrounded/minimized tab still fires its intervals, which used to
  // mean polling LTA (and writing a KV cache entry) every 60s for a page
  // nobody's looking at — the actual driver of the backend's write quota,
  // since a stop stays "in view" from the map's perspective the whole
  // time the tab sits in the background. Stop entirely while hidden and
  // just refresh once immediately on return, instead of idly ticking on
  // a schedule the whole time.
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => void refreshBuses(), BUS_POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      // Whatever's cached could be well out of date after however long
      // the tab was hidden — catch up right away rather than waiting up
      // to another full BUS_POLL_INTERVAL_MS for the next tick.
      void refreshBuses();
      startPolling();
    }
  });

  map.on("moveend zoomend", () => {
    render();
    void refreshBuses();
  });
  render();
  void refreshBuses();
  if (!document.hidden) startPolling();

  // Advances every animating bus a little further along its current leg,
  // independent of the 30s data refresh — this is what actually produces
  // the smooth motion between two real LTA-reported positions.
  setInterval(() => {
    for (const bus of animatedBuses.values()) {
      bus.traveledDistance = Math.min(
        bus.totalDistance,
        bus.traveledDistance + bus.speedMetersPerSecond * (ANIMATION_TICK_MS / 1000)
      );
      const [lat, lng] = positionAtDistance(bus.path, bus.traveledDistance);
      bus.marker.setLatLng([lat, lng]);
    }
  }, ANIMATION_TICK_MS);

  // Rewrites the text of whichever popups are currently open so the ETA
  // countdown and "updated Ns ago" timestamp keep ticking between polls,
  // without needing a fresh fetch. Closed popups aren't touched (no rush —
  // they'll get today's data as soon as they're reopened via
  // getPopup().getContent(), called lazily inside setPopupContent).
  setInterval(() => {
    for (const bus of animatedBuses.values()) {
      if (bus.marker.isPopupOpen()) bus.marker.setPopupContent(busPopupHtml(bus));
    }
    for (const [stopCode, marker] of stopMarkers) {
      if (!marker.isPopupOpen()) continue;
      const stop = index.getStop(stopCode);
      if (stop) marker.setPopupContent(stopPopupHtml(stop, stopArrivals.get(stopCode)));
    }
  }, POPUP_TICK_MS);

  return {
    setServiceFilter(serviceNo: string | null) {
      serviceFilter = serviceNo;
      render();
      void refreshBuses();
    },
  };
}
