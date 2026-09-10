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

// One of a service's next 3 oncoming buses at a stop. Latitude/Longitude
// are the bus's live estimated GPS position — "0.0"/"" when the bus isn't
// currently being tracked (e.g. off-road, out of service).
export interface NextBus {
  OriginCode: string;
  DestinationCode: string;
  EstimatedArrival: string;
  Monitored: number;
  Latitude: string;
  Longitude: string;
  VisitNumber: string;
  Load: string;
  Feature: string;
  Type: string;
}

export interface BusArrivalService {
  ServiceNo: string;
  Operator: string;
  NextBus: NextBus;
  NextBus2: NextBus;
  NextBus3: NextBus;
}

export interface BusArrivalResponse {
  BusStopCode: string;
  Services: BusArrivalService[];
}

export type BusArrivalByStop = Record<string, BusArrivalResponse>;

// Mirrors the worker's own MAX_STOPS_PER_BATCH — requesting more than this
// in one call gets rejected with a 400, so a larger visible-stop set is
// split into parallel batches instead.
const MAX_STOPS_PER_ARRIVAL_REQUEST = 15;

export async function fetchBusArrival(stopCodes: string[]): Promise<BusArrivalByStop> {
  if (stopCodes.length === 0) return {};

  const batches: string[][] = [];
  for (let i = 0; i < stopCodes.length; i += MAX_STOPS_PER_ARRIVAL_REQUEST) {
    batches.push(stopCodes.slice(i, i + MAX_STOPS_PER_ARRIVAL_REQUEST));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const res = await fetch(`${API_BASE}/bus-arrival?BusStopCode=${batch.join(",")}`);
      if (!res.ok) {
        throw new Error(`Failed to load bus-arrival: HTTP ${res.status}`);
      }
      return res.json() as Promise<BusArrivalByStop>;
    })
  );

  return Object.assign({}, ...results);
}
