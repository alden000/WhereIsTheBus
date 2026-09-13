const API_BASE = __API_BASE__;

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
  // When the backend actually fetched this from LTA (ISO8601), stamped
  // before caching so a cache hit still carries the original fetch time —
  // absent on a backend that hasn't been redeployed with this field yet.
  PolledAt?: string;
}

export type BusArrivalByStop = Record<string, BusArrivalResponse>;

// Mirrors the worker's own MAX_STOPS_PER_BATCH — requesting more than this
// in one call gets rejected with a 400, so a larger visible-stop set is
// split into parallel batches instead.
const MAX_STOPS_PER_ARRIVAL_REQUEST = 15;

// A dense area (many stops in view at once) can split into dozens of
// batches — firing all of them as one big Promise.all was hammering LTA
// with that many simultaneous requests in one instant, which showed up as
// scattered 502s under bursty polling. Capping how many batches are ever
// in flight at once spreads the same total request count out instead of
// firing it all in one spike.
const MAX_CONCURRENT_ARRIVAL_REQUESTS = 6;

async function fetchArrivalBatch(batch: string[]): Promise<BusArrivalByStop | null> {
  try {
    const res = await fetch(`${API_BASE}/bus-arrival?BusStopCode=${batch.join(",")}`);
    if (!res.ok) return null;
    return (await res.json()) as BusArrivalByStop;
  } catch {
    return null;
  }
}

export async function fetchBusArrival(stopCodes: string[]): Promise<BusArrivalByStop> {
  if (stopCodes.length === 0) return {};

  const batches: string[][] = [];
  for (let i = 0; i < stopCodes.length; i += MAX_STOPS_PER_ARRIVAL_REQUEST) {
    batches.push(stopCodes.slice(i, i + MAX_STOPS_PER_ARRIVAL_REQUEST));
  }

  const merged: BusArrivalByStop = {};
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < batches.length) {
      const batch = batches[nextIndex++];
      const result = await fetchArrivalBatch(batch);
      // A batch that failed (network error, or LTA/worker returning a
      // transient error under load) is skipped rather than discarding
      // every other batch's data — whatever it covered just keeps
      // whatever arrival info was already on screen from the last
      // successful poll, same as a full-request failure already does.
      if (result) Object.assign(merged, result);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_ARRIVAL_REQUESTS, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return merged;
}
