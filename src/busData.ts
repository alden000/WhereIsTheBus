import type L from "leaflet";
import type { BusRoute, BusStop, RouteGeometry } from "./api";
import { type LatLng, type LatLngBoundsLike, pathBounds, pathIntersectsBounds } from "./geo";

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
  private readonly geometry: RouteGeometry;
  // Both resolved lazily and cached forever: neither a line's path nor
  // its bounding box changes over the life of one loaded dataset, so
  // there's no reason to rebuild either on every pan/zoom.
  private readonly pathCache = new Map<string, LatLng[]>();
  private readonly pathBoundsCache = new Map<string, LatLngBoundsLike | null>();

  constructor(stops: BusStop[], routes: BusRoute[], geometry: RouteGeometry = {}) {
    this.geometry = geometry;
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

  // The actual path to draw/animate along for a line: road-snapped
  // geometry when available, otherwise straight stop-to-stop segments.
  // Cached since it's resolved identically by both the route-rendering
  // and bus-animation code paths, and never changes for a loaded dataset.
  getPathForLine(key: string): LatLng[] {
    const cached = this.pathCache.get(key);
    if (cached) return cached;

    const line = this.routeLines.get(key);
    const path: LatLng[] = line
      ? this.geometry[key] ??
        line.stopCodes
          .map((code) => this.stopsByCode.get(code))
          .filter((stop): stop is BusStop => stop !== undefined)
          .map((stop): LatLng => [stop.Latitude, stop.Longitude])
      : [];

    this.pathCache.set(key, path);
    return path;
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
