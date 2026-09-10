const API_BASE = "https://whereisthebus-proxy.1313277.xyz";

export interface BusStop {
  BusStopCode: string;
  RoadName: string;
  Description: string;
  Latitude: number;
  Longitude: number;
}

export interface BusRoute {
  ServiceNo: string;
  Operator: string;
  Direction: number;
  StopSequence: number;
  BusStopCode: string;
  Distance: number;
}

// [lat, lng] pairs forming a road-following path for one service+direction
// line. Keyed by "<ServiceNo>|<Direction>" to match BusRoute grouping.
export type RouteGeometry = Record<string, [number, number][]>;

async function fetchCached<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}/${endpoint}`);
  if (!res.ok) {
    throw new Error(`Failed to load ${endpoint}: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchBusStops(): Promise<BusStop[]> {
  return fetchCached<BusStop[]>("bus-stops");
}

export function fetchBusRoutes(): Promise<BusRoute[]> {
  return fetchCached<BusRoute[]>("bus-routes");
}

export function fetchRouteGeometry(): Promise<RouteGeometry> {
  return fetchCached<RouteGeometry>("route-geometry");
}
