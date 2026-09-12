import L from "leaflet";
import { colorForService } from "./color";
import { fetchBusArrival, type BusArrivalResponse, type BusStop, type NextBus } from "./api";
import type { BusDataIndex } from "./busData";
import {
  type LatLng,
  alongPathDistance,
  haversineMeters,
  isLoopPath,
  pathLength,
  positionAtDistance,
  projectOntoPath,
  projectOntoPathInRange,
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
  // Which line (or bare service number, if the line couldn't be resolved)
  // this bus belongs to — scopes cross-poll re-matching (see refreshBuses)
  // to buses on the same route, never across unrelated ones.
  groupKey: string;
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

    // A bus approaching several nearby visible stops in a row is listed
    // as "upcoming" at every one of them — not a data error, just how
    // LTA's per-stop arrivals work — so it would otherwise get one leg
    // per stop it's listed under, and needs merging into a single bus.
    //
    // Matching by raw GPS distance between sightings breaks down once
    // cache staleness enters the picture: each stop's arrival data is
    // cached independently at the edge (its own up-to-60s-old snapshot,
    // populated whenever anyone last asked), so the *same* physical bus
    // can show a noticeably different GPS fix at two different stops
    // simply because one stop's cached data is much fresher than the
    // other's — not because it actually moved off that route. At the
    // legal max (60 km/h) a bus covers up to ~1000m across one full
    // cache window, comfortably enough to break a tight straight-line
    // match: exactly what showed up as a second, wrong-ETA "ghost"
    // marker once zooming out brought a farther-along stop on the same
    // route into view (and vanished again on zooming back in, once that
    // stop dropped out of the polled set).
    //
    // Projecting each sighting onto its route's own path and comparing
    // *distance along the path* instead fixes this: two fixes for the
    // same bus, taken moments apart, land close together along the path
    // regardless of how the road curves, while a genuinely different bus
    // on the same route sits a real distance further along it. Matching
    // is scoped to one specific line (not just service number) so a
    // loop route's two directions — different paths entirely — are never
    // conflated. Straight-line distance is kept only as a fallback for
    // the rare case a line's path can't be resolved.
    //
    // Loop services need two more corrections on top of that (found from
    // a real report: service 904 near stop 47651, specifically while
    // heading through the stretch where the loop closes on itself).
    // First, a loop's own path can run close to its own earlier or later
    // self, so an unconstrained nearest-point search can snap a bus's
    // raw GPS onto the wrong pass entirely — resolved by
    // projectOntoPathInRange, anchoring the search to "no further behind
    // this stop than its ETA allows" instead of searching the whole
    // path. Second, a loop's own seam — the same physical point serving
    // as both distance-along 0 and its full length — means a bus just
    // before completing a lap and one just after starting the next sit
    // right next to each other in reality but near-maximally far apart
    // in plain distanceAlong terms; alongPathDistance accounts for that
    // by wrapping the comparison around the seam for a path detected as
    // a loop (isLoopPath: its start and end coincide).
    //
    // Between matched sightings, the one with the *soonest* ETA is
    // always the genuinely-next stop — travel time only grows further
    // along a route, so a farther-along stop's listing for the same bus
    // can never legitimately arrive sooner.
    const SAME_BUS_ALONG_PATH_METERS = (BUS_POLL_INTERVAL_MS / 1000) * MAX_BUS_SPEED_MPS;
    const SAME_BUS_RADIUS_METERS = 100;
    // Slack added on top of the ETA-implied distance when anchoring a
    // bus's position search to its reporting stop (see
    // projectOntoPathInRange below) — covers GPS imprecision and the gap
    // between "distance at the theoretical max speed" and the bus's
    // actual (usually lower) average speed.
    const PROJECTION_ANCHOR_SLACK_METERS = 500;
    interface BusSighting {
      key: string;
      etaAtMs: number;
      rawPosition: LatLng;
      distanceAlong: number | null;
    }
    const sightingsByLine = new Map<string, BusSighting[]>();
    interface PendingLeg {
      key: string;
      groupKey: string;
      serviceNo: string;
      rawPosition: LatLng;
      distanceAlong: number | null;
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

        // Resolved once per (stop, service) rather than per slot, since
        // none of it depends on which of the 3 upcoming buses is being
        // looked at.
        const lineKey = findLineKeyForStop(stopCode, service.ServiceNo);
        const path = lineKey ? index.getPathForLine(lineKey) : [];
        const hasPath = path.length >= 2;
        // Where this stop itself sits along the path — used below as an
        // anchor for each bus's own position, rather than projecting the
        // bus directly against the whole (possibly self-crossing) path.
        const stopDistanceAlong = hasPath ? projectOntoPath(stopPosition, path).distanceAlong : 0;
        const pathTotalLength = hasPath ? pathLength(path) : 0;
        const pathIsLoop = hasPath && isLoopPath(path);
        const groupKey = lineKey ?? service.ServiceNo;

        const slots: [NextBus, string][] = [
          [service.NextBus, "1"],
          [service.NextBus2, "2"],
          [service.NextBus3, "3"],
        ];
        for (const [nextBus, slot] of slots) {
          if (!nextBus || !isTrackedCoord(nextBus.Latitude, nextBus.Longitude)) continue;

          const rawPosition: LatLng = [Number(nextBus.Latitude), Number(nextBus.Longitude)];
          const key = `${stopCode}:${service.ServiceNo}:${slot}`;
          const parsedEtaAt = Date.parse(nextBus.EstimatedArrival);
          const etaAtMs = Number.isFinite(parsedEtaAt) ? parsedEtaAt : fetchedAt + MIN_LEG_DURATION_S * 1000;

          // A loop route can pass close to its own earlier or later
          // self, so projecting this bus's raw GPS against the *whole*
          // path can snap onto the wrong pass — the actual cause of the
          // 904-near-47651 case (a loop route), where the same physical
          // bus's two sightings landed far apart along the path despite
          // being close in real space. Anchoring the search to "no
          // further behind this stop than its ETA allows, plus a little
          // slack" constrains it to the one plausible stretch instead.
          const etaSecondsForAnchor = Math.max(0, (etaAtMs - fetchedAt) / 1000);
          const maxDistanceBehindStop =
            etaSecondsForAnchor * MAX_BUS_SPEED_MPS + PROJECTION_ANCHOR_SLACK_METERS;
          const distanceAlong = hasPath
            ? projectOntoPathInRange(
                rawPosition,
                path,
                Math.max(0, stopDistanceAlong - maxDistanceBehindStop),
                stopDistanceAlong + PROJECTION_ANCHOR_SLACK_METERS
              ).distanceAlong
            : null;

          const sightings = sightingsByLine.get(groupKey);
          const matched = sightings?.find((s) =>
            hasPath && s.distanceAlong !== null
              ? alongPathDistance(s.distanceAlong, distanceAlong!, pathTotalLength, pathIsLoop) <=
                SAME_BUS_ALONG_PATH_METERS
              : haversineMeters(s.rawPosition, rawPosition) <= SAME_BUS_RADIUS_METERS
          );
          if (matched) {
            if (etaAtMs >= matched.etaAtMs) continue;
            pendingLegs.delete(matched.key);
            matched.key = key;
            matched.etaAtMs = etaAtMs;
            matched.rawPosition = rawPosition;
            matched.distanceAlong = distanceAlong;
          } else if (sightings) {
            sightings.push({ key, etaAtMs, rawPosition, distanceAlong });
          } else {
            sightingsByLine.set(groupKey, [{ key, etaAtMs, rawPosition, distanceAlong }]);
          }

          pendingLegs.set(key, {
            key,
            groupKey,
            serviceNo: service.ServiceNo,
            rawPosition,
            distanceAlong,
            stopPosition,
            path: hasPath ? path : [rawPosition, stopPosition],
            etaSeconds: (etaAtMs - fetchedAt) / 1000,
            etaAtMs,
          });
        }
      }
    }

    // A bus's key (stopCode:serviceNo:slot) is only stable while the same
    // stop keeps winning the merge above — but which stops are even being
    // polled (stopsForArrival) shifts with every pan/zoom, since it's
    // bounded by the viewport. That can hand the same physical bus a
    // different key from one poll to the next despite nothing about the
    // bus itself changing, which the exact-match lookup below can't see
    // through on its own — it would tear down the old marker and spawn a
    // new one at the raw GPS fix, discarding the animated position and
    // showing up as a visible jump/flicker. Indexed here (grouped by line,
    // excluding buses whose key *did* stay stable this poll) so a leg that
    // misses the exact-match lookup gets one more chance: find an
    // still-animating bus on the same line sitting close to this leg's
    // position, and adopt it under the new key instead of discarding it.
    const unclaimedByGroup = new Map<string, [string, AnimatedBus][]>();
    for (const [oldKey, bus] of animatedBuses) {
      if (pendingLegs.has(oldKey)) continue;
      const group = unclaimedByGroup.get(bus.groupKey);
      if (group) group.push([oldKey, bus]);
      else unclaimedByGroup.set(bus.groupKey, [[oldKey, bus]]);
    }

    function findRematchCandidate(leg: PendingLeg): [string, AnimatedBus] | undefined {
      const candidates = unclaimedByGroup.get(leg.groupKey);
      if (!candidates || candidates.length === 0) return undefined;

      const hasPath = leg.path.length >= 2 && leg.distanceAlong !== null;
      const pathTotalLength = hasPath ? pathLength(leg.path) : 0;
      const pathIsLoop = hasPath && isLoopPath(leg.path);

      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const [, candidate] = candidates[i];
        const currentPos: LatLng = [candidate.marker.getLatLng().lat, candidate.marker.getLatLng().lng];
        const distance = hasPath
          ? alongPathDistance(
              projectOntoPath(currentPos, leg.path).distanceAlong,
              leg.distanceAlong!,
              pathTotalLength,
              pathIsLoop
            )
          : haversineMeters(currentPos, leg.rawPosition);
        if (distance <= SAME_BUS_ALONG_PATH_METERS && distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      if (bestIndex === -1) return undefined;
      return candidates.splice(bestIndex, 1)[0];
    }

    for (const [key, leg] of pendingLegs) {
      let existing = animatedBuses.get(key);
      if (!existing) {
        const rematch = findRematchCandidate(leg);
        if (rematch) {
          const [oldKey, bus] = rematch;
          animatedBuses.delete(oldKey);
          existing = bus;
        }
      }

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
        animatedBuses.set(key, existing);
      } else {
        const marker = L.marker(subPath[0], { icon: busIcon(leg.serviceNo) }).addTo(busesLayer);
        const bus: AnimatedBus = {
          marker,
          serviceNo: leg.serviceNo,
          groupKey: leg.groupKey,
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
