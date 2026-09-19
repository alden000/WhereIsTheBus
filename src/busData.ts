import type L from "leaflet";
import type { BusRoute, BusStop, RouteGeometry, RouteGeometryEntry } from "./api";
import { type LatLng, type LatLngBoundsLike, crossesKnownBorderCheckpoint, pathBounds, pathIntersectsBounds } from "./geo";

// A geometry cache populated before this format existed (or not yet
// touched by a backfill run since) stores a line's value as a plain flat
// LatLng[] rather than today's { segments, source } shape. Normalizing
// once here, up front, keeps every other method dealing with one shape
// only instead of re-checking "old or new?" at each call site — the
// signature-based backfill re-fetches every such line into the new shape
// on its own, so this fallback only matters for whatever's still pending
// that pass.
function normalizeGeometry(raw: RouteGeometry): Map<string, RouteGeometryEntry> {
  const normalized = new Map<string, RouteGeometryEntry>();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      normalized.set(key, { segments: [value as unknown as LatLng[]], source: "ors" });
    } else if (value && Array.isArray((value as RouteGeometryEntry).segments)) {
      normalized.set(key, value);
    }
  }
  return normalized;
}

export interface RouteLine {
  key: string;
  serviceNo: string;
  stopCodes: string[];
}

// Precomputes the lookups the map needs on every viewport change:
// which stops fall in view, and which service+direction lines pass
// through them. Building this once at load time (rather than scanning
// the raw ~27k route rows per pan/zoom) keeps updates on move cheap.
export class BusDataIndex {
  private readonly stopsByCode = new Map<string, BusStop>();
  private readonly routeLines = new Map<string, RouteLine>();
  private readonly stopToRouteLineKeys = new Map<string, Set<string>>();
  private readonly geometry: Map<string, RouteGeometryEntry>;
  // Both resolved lazily and cached forever: neither a line's path(s) nor
  // its bounding box changes over the life of one loaded dataset, so
  // there's no reason to rebuild either on every pan/zoom.
  private readonly pathCache = new Map<string, LatLng[]>();
  private readonly drawSegmentsCache = new Map<string, LatLng[][]>();
  private readonly pathBoundsCache = new Map<string, LatLngBoundsLike | null>();

  constructor(stops: BusStop[], routes: BusRoute[], geometry: RouteGeometry = {}) {
    this.geometry = normalizeGeometry(geometry);
    for (const stop of stops) {
      this.stopsByCode.set(stop.BusStopCode, stop);
    }

    const grouped = new Map<string, BusRoute[]>();
    for (const route of routes) {
      const key = `${route.ServiceNo}|${route.Direction}`;
      const group = grouped.get(key);
      if (group) {
        group.push(route);
      } else {
        grouped.set(key, [route]);
      }
    }

    for (const [key, entries] of grouped) {
      entries.sort((a, b) => a.StopSequence - b.StopSequence);
      const stopCodes = entries.map((entry) => entry.BusStopCode);
      this.routeLines.set(key, { key, serviceNo: entries[0].ServiceNo, stopCodes });

      for (const code of stopCodes) {
        const existing = this.stopToRouteLineKeys.get(code);
        if (existing) {
          existing.add(key);
        } else {
          this.stopToRouteLineKeys.set(code, new Set([key]));
        }
      }
    }
  }

  getStopsInBounds(bounds: L.LatLngBounds): BusStop[] {
    const result: BusStop[] = [];
    for (const stop of this.stopsByCode.values()) {
      if (bounds.contains([stop.Latitude, stop.Longitude])) {
        result.push(stop);
      }
    }
    return result;
  }

  getRouteLineKeysForStops(stopCodes: Iterable<string>): Set<string> {
    const keys = new Set<string>();
    for (const code of stopCodes) {
      const lineKeys = this.stopToRouteLineKeys.get(code);
      if (lineKeys) {
        for (const key of lineKeys) {
          keys.add(key);
        }
      }
    }
    return keys;
  }

  getRouteLine(key: string): RouteLine | undefined {
    return this.routeLines.get(key);
  }

  getStop(code: string): BusStop | undefined {
    return this.stopsByCode.get(code);
  }

  private straightPathForLine(line: RouteLine): LatLng[] {
    return line.stopCodes
      .map((code) => this.stopsByCode.get(code))
      .filter((stop): stop is BusStop => stop !== undefined)
      .map((stop): LatLng => [stop.Latitude, stop.Longitude]);
  }

  // An entry sourced from OpenRouteService that crosses a hop the routing
  // engine is known to get badly confused by (see crossesKnownBorderCheckpoint
  // in geo.ts — the detour it produces corrupts the majority of the
  // line's points, not just the crossing) isn't trustworthy for either
  // purpose below. LTA's own KML for the same line is real published
  // geometry, not a routing approximation, so it's trusted even for these
  // hops — this only ever distrusts the ORS fallback.
  private isTrustworthy(entry: RouteGeometryEntry, line: RouteLine): boolean {
    return entry.source === "kml" || !crossesKnownBorderCheckpoint(line.stopCodes);
  }

  // The single ordered path to animate a live bus along for a line —
  // needed because tracking a bus's live position (projecting it onto
  // the route and measuring distance travelled) only makes sense against
  // one continuous, correctly-ordered line. LTA's KML commonly arrives as
  // several disjoint pieces with no reliable order between them (see
  // RouteGeometryEntry in api.ts) — safe to draw independently, but not
  // safe to guess an order for and treat as one path — so only a
  // single-piece entry (whether from KML or the ORS fallback, which is
  // always exactly one piece) is used here; a multi-piece line instead
  // falls back to plain stop-to-stop segments for tracking purposes,
  // while still drawing its real geometry (see getDrawSegmentsForLine).
  // Cached since it never changes for a loaded dataset.
  getPathForLine(key: string): LatLng[] {
    const cached = this.pathCache.get(key);
    if (cached) return cached;

    const line = this.routeLines.get(key);
    const entry = this.geometry.get(key);
    const usable = entry && entry.segments.length === 1 && line && this.isTrustworthy(entry, line)
      ? entry.segments[0]
      : undefined;
    const path: LatLng[] = line ? usable ?? this.straightPathForLine(line) : [];

    this.pathCache.set(key, path);
    return path;
  }

  // The piece(s) to actually draw for a line — every piece of whatever
  // geometry is available, independent of whether they chain into one
  // ordered path (see getPathForLine for why that distinction matters).
  // Falls back to a single straight stop-to-stop piece when there's no
  // trustworthy geometry at all.
  getDrawSegmentsForLine(key: string): LatLng[][] {
    const cached = this.drawSegmentsCache.get(key);
    if (cached) return cached;

    const line = this.routeLines.get(key);
    const entry = this.geometry.get(key);
    const segments: LatLng[][] =
      line
        ? entry && this.isTrustworthy(entry, line)
          ? entry.segments
          : [this.straightPathForLine(line)]
        : [];

    this.drawSegmentsCache.set(key, segments);
    return segments;
  }

  // Every line whose path — not just whose stops — passes through
  // `bounds`. A route can visibly cut across a viewport while both of
  // its flanking stops sit just outside it; keying route visibility off
  // stop membership alone (the old getRouteLineKeysForStops-based
  // approach) made that route's line disappear even though part of it
  // was still plainly on screen.
  getRouteLineKeysIntersectingBounds(bounds: L.LatLngBounds): Set<string> {
    const boundsLike: LatLngBoundsLike = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };

    const keys = new Set<string>();
    for (const key of this.routeLines.keys()) {
      let bbox = this.pathBoundsCache.get(key);
      if (bbox === undefined) {
        bbox = pathBounds(this.getPathForLine(key));
        this.pathBoundsCache.set(key, bbox);
      }
      if (pathIntersectsBounds(this.getPathForLine(key), boundsLike, bbox)) {
        keys.add(key);
      }
    }
    return keys;
  }
}
