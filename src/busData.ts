import type L from "leaflet";
import type { BusRoute, BusStop } from "./api";

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

  constructor(stops: BusStop[], routes: BusRoute[]) {
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
}
