import type L from "leaflet";
import type { BusRoute, BusStop, RouteGeometry } from "./api";
import { boxesOverlap, boxOfPath, pathIntersectsBox, type LatLng, type LatLngBox } from "./geo";

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
  // Precomputed once at load time (road-snapped geometry if available, else
  // the straight stop-to-stop fallback) and cached — both what actually
  // gets drawn and what decides whether a line is on screen at all need to
  // agree on the same path, and recomputing it per line on every pan/zoom
  // would be wasted work since it never changes after construction.
  private readonly pathsByLineKey = new Map<string, LatLng[]>();
  private readonly boundsByLineKey = new Map<string, LatLngBox>();

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

    for (const [key, line] of this.routeLines) {
      const path =
        this.geometry[key] ??
        line.stopCodes
          .map((code) => this.stopsByCode.get(code))
          .filter((stop): stop is BusStop => stop !== undefined)
          .map((stop): LatLng => [stop.Latitude, stop.Longitude]);
      this.pathsByLineKey.set(key, path);
      this.boundsByLineKey.set(key, boxOfPath(path));
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

  // Road-following path for a line — falls back to straight stop-to-stop
  // segments until the backend's OpenRouteService backfill reaches it.
  getPathForLine(key: string): LatLng[] {
    return this.pathsByLineKey.get(key) ?? [];
  }

  // Lines whose path crosses the given viewport at all, fully or
  // partially — not just ones with one of their own stops inside it. A
  // route can be visibly on screen with both of its nearest stops just
  // outside the frame on either side, so restricting to stops-in-bounds
  // alone (getRouteLineKeysForStops) would otherwise drop it.
  getRouteLineKeysIntersectingBounds(box: LatLngBox): Set<string> {
    const keys = new Set<string>();
    for (const [key, lineBox] of this.boundsByLineKey) {
      if (!boxesOverlap(lineBox, box)) continue;
      const path = this.pathsByLineKey.get(key);
      if (path && pathIntersectsBox(path, box)) keys.add(key);
    }
    return keys;
  }

  getStop(code: string): BusStop | undefined {
    return this.stopsByCode.get(code);
  }
}
