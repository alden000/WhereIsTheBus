export interface Env {
  LTA_ACCOUNT_KEY: string;
  REFRESH_SECRET: string;
  ORS_API_KEY: string;
  BUS_CACHE: KVNamespace;
}

interface BusStop {
  BusStopCode: string;
  Latitude: number;
  Longitude: number;
}

interface BusRoute {
  ServiceNo: string;
  Direction: number;
  StopSequence: number;
  BusStopCode: string;
}

// Reference data that barely changes — pulled into KV once a day (see
// `scheduled` below) and served from there instead of hitting LTA per request.
const CACHED_DATASETS: Record<string, string> = {
  "bus-stops": "BusStops",
  "bus-services": "BusServices",
  "bus-routes": "BusRoutes",
};
const DATASET_ORDER = Object.keys(CACHED_DATASETS);

const ALLOWED_ORIGINS = new Set([
  "https://alden000.github.io",
  "http://localhost:5173",
]);

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

// Bus arrival changes second to second, but the map only ever needs
// whatever's currently in view — not all ~5,000 stops on a blind schedule.
// So instead of a cron, each stop is cached individually on first request
// and reused for this long. 60s is also KV's minimum TTL, so this is as
// fresh as KV can be made anyway.
const ARRIVAL_CACHE_TTL_SECONDS = 60;

// Worst case (every requested stop is a cache miss) costs 3 subrequests
// each: a KV read, the LTA fetch, and a KV write. Staying under the
// Workers Free plan's 50-subrequest cap means capping the batch at 15,
// with room to spare for a request that's a mix of hits and misses.
const MAX_STOPS_PER_BATCH = 15;

async function getArrivalForStop(stopCode: string, env: Env): Promise<unknown> {
  const cacheKey = `bus-arrival:${stopCode}`;
  const cached = await env.BUS_CACHE.get(cacheKey, "json");
  if (cached) {
    return cached;
  }

  const upstream = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  upstream.searchParams.set("BusStopCode", stopCode);

  const res = await fetch(upstream, {
    headers: { AccountKey: env.LTA_ACCOUNT_KEY, accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`BusArrival failed for ${stopCode}: HTTP ${res.status}`);
  }

  const data = await res.json();
  await env.BUS_CACHE.put(cacheKey, JSON.stringify(data), {
    expirationTtl: ARRIVAL_CACHE_TTL_SECONDS,
  });
  return data;
}

const PAGE_SIZE = 500;

// The Workers Free plan caps a single invocation at 50 subrequests (fetch +
// KV calls combined). BusRoutes alone needs ~52 pages, so one invocation
// can never pull a whole dataset — each chunk does up to this many pages,
// then chains into a fresh invocation (with a fresh 50-subrequest budget)
// via a self-fetch, resuming from a cursor saved in KV. Overhead per chunk
// is at most ~6 subrequests (2 KV reads, 2 KV writes, the chain fetch), so
// 40 leaves a safe margin under 50.
const MAX_PAGES_PER_CHUNK = 40;

interface RefreshCursor {
  datasetIndex: number;
  skip: number;
}

// A hung fetch() (LTA never responding, or a dropped connection that
// never surfaces as an error) would otherwise stall the whole chain
// forever with nothing to catch or log — an explicit timeout turns that
// into a normal, visible, catchable failure instead.
const FETCH_TIMEOUT_MS = 15000;

async function fetchPage(ltaPath: string, accountKey: string, skip: number): Promise<unknown[]> {
  const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
  upstream.searchParams.set("$skip", String(skip));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { AccountKey: accountKey, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`${ltaPath} timed out after ${FETCH_TIMEOUT_MS}ms at $skip=${skip}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`${ltaPath} failed at $skip=${skip}: HTTP ${res.status}`);
  }

  const page = (await res.json()) as { value: unknown[] };
  return page.value;
}

// Does at most MAX_PAGES_PER_CHUNK pages of work for whichever dataset the
// saved cursor points at, then returns. Only writes the final cache entry
// once that dataset's pages are fully pulled, so reads always see either
// the previous complete dataset or the new one — never a partial one.
async function runRefreshChunk(env: Env): Promise<{ done: boolean }> {
  const cursor: RefreshCursor =
    (await env.BUS_CACHE.get<RefreshCursor>("refresh-cursor", "json")) ?? {
      datasetIndex: 0,
      skip: 0,
    };

  // Defensive: reachable if two refresh chains ever overlap (e.g. the
  // manual endpoint hit twice at once) and one sees a cursor the other
  // already advanced past the end. Still mark completion consistently
  // rather than leaving last-updated stuck null with the cursor cleared.
  if (cursor.datasetIndex >= DATASET_ORDER.length) {
    await env.BUS_CACHE.delete("refresh-cursor");
    await env.BUS_CACHE.put("last-updated", new Date().toISOString());
    return { done: true };
  }

  const cacheKey = DATASET_ORDER[cursor.datasetIndex];
  const ltaPath = CACHED_DATASETS[cacheKey];

  const partial: unknown[] =
    cursor.skip === 0 ? [] : ((await env.BUS_CACHE.get<unknown[]>("refresh-partial", "json")) ?? []);

  let skip = cursor.skip;
  let reachedEnd = false;

  for (let i = 0; i < MAX_PAGES_PER_CHUNK; i++) {
    const records = await fetchPage(ltaPath, env.LTA_ACCOUNT_KEY, skip);
    partial.push(...records);

    if (records.length < PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    skip += PAGE_SIZE;
  }

  if (!reachedEnd) {
    await env.BUS_CACHE.put("refresh-partial", JSON.stringify(partial));
    await env.BUS_CACHE.put(
      "refresh-cursor",
      JSON.stringify({ datasetIndex: cursor.datasetIndex, skip } satisfies RefreshCursor)
    );
    return { done: false };
  }

  await env.BUS_CACHE.put(cacheKey, JSON.stringify(partial));
  await env.BUS_CACHE.delete("refresh-partial");

  const nextIndex = cursor.datasetIndex + 1;
  if (nextIndex >= DATASET_ORDER.length) {
    await env.BUS_CACHE.delete("refresh-cursor");
    await env.BUS_CACHE.put("last-updated", new Date().toISOString());
    return { done: true };
  }

  await env.BUS_CACHE.put(
    "refresh-cursor",
    JSON.stringify({ datasetIndex: nextIndex, skip: 0 } satisfies RefreshCursor)
  );
  return { done: false };
}

// Deliberately the *.workers.dev URL, not the custom domain: a custom
// domain routes through the zone's full WAF/bot-protection stack, which
// silently swallowed this Worker's own self-chaining requests (no error,
// no progress — the request never reached the Worker at all). workers.dev
// goes straight to the Workers runtime, bypassing that entirely.
const SELF_URL = "https://whereisthebus-lta-proxy.genixm.workers.dev";

// The self-chaining fetch itself has turned out to be intermittently
// flaky — it succeeded three chunk transitions in a row, then one attempt
// simply never arrived (no error, no timeout on the receiving end,
// nothing — the chain just went quiet). Since /cache/refresh always
// resumes from whatever cursor is saved in KV, retrying it is exactly
// the same operation as the original attempt, so a timeout + a few
// retries turns that flakiness into a self-healing chain instead of a
// silent dead end.
const CHAIN_FETCH_TIMEOUT_MS = 10000;
const CHAIN_MAX_ATTEMPTS = 4;

// Generalized so both the bus-data refresh chain and the route-geometry
// chain (below) can reuse the same resume-by-retrying behavior: since
// each chained endpoint always resumes from whatever state is in KV,
// retrying a chain hop is exactly the same operation as the original
// attempt, so a timeout + a few retries turns transient self-fetch
// flakiness into a self-healing chain instead of a silent dead end.
async function triggerChainedRequest(env: Env, path: string, errorKvKey: string): Promise<void> {
  const continueUrl = `${SELF_URL}${path}?key=${encodeURIComponent(env.REFRESH_SECRET)}`;

  for (let attempt = 1; attempt <= CHAIN_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAIN_FETCH_TIMEOUT_MS);
    try {
      await fetch(continueUrl, { signal: controller.signal });
      return;
    } catch {
      // Timed out or network error — try again, up to CHAIN_MAX_ATTEMPTS.
    } finally {
      clearTimeout(timeout);
    }
  }

  // Every attempt timed out or failed to even connect — leave a visible
  // trail instead of the chain just going quiet with no explanation. The
  // state driving `path` is untouched, so the next manual trigger or
  // cron run resumes from exactly here.
  await env.BUS_CACHE.put(
    errorKvKey,
    JSON.stringify({
      message: `Chain continuation to ${path} unreachable after ${CHAIN_MAX_ATTEMPTS} attempts`,
      at: new Date().toISOString(),
    })
  );
}

async function runOneChunkAndChain(env: Env, ctx: ExecutionContext): Promise<{ done: boolean }> {
  let result: { done: boolean };
  try {
    result = await runRefreshChunk(env);
  } catch (err) {
    // Chained (self-triggered) chunks run in the background — nothing reads
    // their HTTP response, so an error here would otherwise vanish
    // completely. Record it so cache/status can surface what happened.
    await env.BUS_CACHE.put(
      "refresh-last-error",
      JSON.stringify({ message: (err as Error).message, at: new Date().toISOString() })
    );
    throw err;
  }
  if (!result.done) {
    ctx.waitUntil(triggerChainedRequest(env, "/cache/refresh", "refresh-last-error"));
  } else {
    await env.BUS_CACHE.delete("refresh-last-error");
    // bus-routes just finished (re)pulling — check whether any line's stop
    // sequence actually changed and, if so, (re)generate just those.
    ctx.waitUntil(triggerChainedRequest(env, "/geometry/refresh", "geometry-last-error"));
  }
  return result;
}

// ---- Road-snapped route geometry (OpenRouteService) ----
//
// LTA's BusRoutes only gives stop order, not road geometry, so a straight
// line between consecutive stops cuts corners. This pulls a real
// road-following path through each service+direction's stops once, and
// caches it in KV *indefinitely* — re-fetched only when that line's stop
// sequence actually changes (detected by comparing a cheap signature),
// never on a blind schedule. It piggybacks on the daily bus-routes
// refresh (see runOneChunkAndChain above) rather than having its own cron.

const ORS_PROFILE = "driving-car";
// OpenRouteService's free-tier Directions endpoint caps waypoints per
// request; longer routes are split into overlapping windows and stitched.
const ORS_MAX_WAYPOINTS = 50;
// Free tier allows ~40 requests/minute; spacing calls out keeps us under
// that without needing a smarter token-bucket scheme.
const ORS_CALL_DELAY_MS = 1600;
// Each line may cost more than one ORS call (see splitting above), so this
// bounds lines-per-chunk conservatively to stay well under the Workers
// Free plan's 50-subrequest cap even if several in the batch need splitting.
const MAX_LINES_PER_GEOMETRY_CHUNK = 10;

type LatLng = [number, number];

interface RouteLine {
  serviceNo: string;
  stopCodes: string[];
}

function buildRouteLines(routes: BusRoute[]): Map<string, RouteLine> {
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

  const lines = new Map<string, RouteLine>();
  for (const [key, entries] of grouped) {
    entries.sort((a, b) => a.StopSequence - b.StopSequence);
    lines.set(key, {
      serviceNo: entries[0].ServiceNo,
      stopCodes: entries.map((entry) => entry.BusStopCode),
    });
  }
  return lines;
}

function routeSignature(stopCodes: string[]): string {
  return stopCodes.join(",");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Splits into overlapping windows (sharing one boundary point each) so
// the stitched-together geometry has no gap at the split point.
function windowWaypoints(points: LatLng[], maxSize: number): LatLng[][] {
  if (points.length <= maxSize) return [points];

  const windows: LatLng[][] = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + maxSize, points.length);
    windows.push(points.slice(start, end));
    if (end === points.length) break;
    start = end - 1;
  }
  return windows;
}

async function fetchRoadGeometry(stopCoords: LatLng[], apiKey: string): Promise<LatLng[]> {
  const windows = windowWaypoints(stopCoords, ORS_MAX_WAYPOINTS);
  const fullGeometry: LatLng[] = [];

  for (let i = 0; i < windows.length; i++) {
    const coordinates = windows[i].map(([lat, lng]) => [lng, lat]);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILE}/geojson`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ coordinates, geometry_simplify: false }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`ORS request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ORS request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      features: { geometry: { coordinates: [number, number][] } }[];
    };
    const segment = data.features[0]?.geometry.coordinates ?? [];
    const latLngSegment: LatLng[] = segment.map(([lng, lat]) => [lat, lng]);

    fullGeometry.push(...(i > 0 ? latLngSegment.slice(1) : latLngSegment));

    if (i < windows.length - 1) {
      await sleep(ORS_CALL_DELAY_MS);
    }
  }

  return fullGeometry;
}

// Does at most MAX_LINES_PER_GEOMETRY_CHUNK lines of work, then returns.
// Writes the combined geometry/signature blobs back once per chunk (not
// per line) to stay within KV's daily write quota over a full backfill —
// the tradeoff is that a chunk failing partway redoes that chunk's lines
// on retry, which just costs a few repeated ORS calls, not lost data.
async function runGeometryChunk(env: Env): Promise<{ done: boolean }> {
  let queue = await env.BUS_CACHE.get<string[]>("geometry-pending-queue", "json");
  const routesRaw = await env.BUS_CACHE.get<BusRoute[]>("bus-routes", "json");
  if (!routesRaw) {
    throw new Error("bus-routes cache is empty; run /cache/refresh first");
  }
  const lines = buildRouteLines(routesRaw);

  if (queue === null) {
    const signatures =
      (await env.BUS_CACHE.get<Record<string, string>>("route-geometry-signatures", "json")) ?? {};
    queue = [];
    for (const [key, line] of lines) {
      if (signatures[key] !== routeSignature(line.stopCodes)) {
        queue.push(key);
      }
    }
    await env.BUS_CACHE.put("geometry-pending-queue", JSON.stringify(queue));
    await env.BUS_CACHE.put("geometry-refresh-index", JSON.stringify(0));
  }

  const index = (await env.BUS_CACHE.get<number>("geometry-refresh-index", "json")) ?? 0;

  if (index >= queue.length) {
    await env.BUS_CACHE.delete("geometry-pending-queue");
    await env.BUS_CACHE.delete("geometry-refresh-index");
    await env.BUS_CACHE.put("geometry-last-updated", new Date().toISOString());
    return { done: true };
  }

  const stopsRaw = await env.BUS_CACHE.get<BusStop[]>("bus-stops", "json");
  if (!stopsRaw) {
    throw new Error("bus-stops cache is empty; run /cache/refresh first");
  }
  const stopsByCode = new Map(stopsRaw.map((stop) => [stop.BusStopCode, stop]));

  const geometry =
    (await env.BUS_CACHE.get<Record<string, LatLng[]>>("route-geometry", "json")) ?? {};
  const signatures =
    (await env.BUS_CACHE.get<Record<string, string>>("route-geometry-signatures", "json")) ?? {};

  const end = Math.min(index + MAX_LINES_PER_GEOMETRY_CHUNK, queue.length);
  for (let i = index; i < end; i++) {
    const key = queue[i];
    const line = lines.get(key);
    if (line) {
      const coords: LatLng[] = line.stopCodes
        .map((code) => stopsByCode.get(code))
        .filter((stop): stop is BusStop => stop !== undefined)
        .map((stop): LatLng => [stop.Latitude, stop.Longitude]);

      if (coords.length >= 2) {
        geometry[key] = await fetchRoadGeometry(coords, env.ORS_API_KEY);
        signatures[key] = routeSignature(line.stopCodes);
      }
    }

    if (i < end - 1) {
      await sleep(ORS_CALL_DELAY_MS);
    }
  }

  await env.BUS_CACHE.put("route-geometry", JSON.stringify(geometry));
  await env.BUS_CACHE.put("route-geometry-signatures", JSON.stringify(signatures));
  await env.BUS_CACHE.put("geometry-refresh-index", JSON.stringify(end));

  return { done: false };
}

async function runOneGeometryChunkAndChain(env: Env, ctx: ExecutionContext): Promise<{ done: boolean }> {
  let result: { done: boolean };
  try {
    result = await runGeometryChunk(env);
  } catch (err) {
    await env.BUS_CACHE.put(
      "geometry-last-error",
      JSON.stringify({ message: (err as Error).message, at: new Date().toISOString() })
    );
    throw err;
  }
  if (!result.done) {
    ctx.waitUntil(triggerChainedRequest(env, "/geometry/refresh", "geometry-last-error"));
  } else {
    await env.BUS_CACHE.delete("geometry-last-error");
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const headers = corsHeaders(request.headers.get("Origin"));

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    const url = new URL(request.url);
    const endpoint = url.pathname.replace(/^\/+/, "");

    if (endpoint === "cache/refresh") {
      if (url.searchParams.get("key") !== env.REFRESH_SECRET) {
        return new Response("Forbidden", { status: 403, headers });
      }
      try {
        const result = await runOneChunkAndChain(env, ctx);
        return new Response(
          result.done ? "Refresh complete" : "Refresh chunk complete, continuing...",
          { status: 200, headers }
        );
      } catch (err) {
        return new Response(`Refresh failed: ${(err as Error).message}`, {
          status: 502,
          headers,
        });
      }
    }

    if (endpoint === "cache/status") {
      const lastUpdated = await env.BUS_CACHE.get("last-updated");
      const cursor = await env.BUS_CACHE.get<RefreshCursor>("refresh-cursor", "json");
      const lastError = await env.BUS_CACHE.get<{ message: string; at: string }>(
        "refresh-last-error",
        "json"
      );
      return new Response(
        JSON.stringify({ lastUpdated, refreshInProgress: cursor !== null, cursor, lastError }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    if (endpoint in CACHED_DATASETS) {
      const cached = await env.BUS_CACHE.get(endpoint);
      if (!cached) {
        return new Response("Cache not populated yet — trigger /cache/refresh first", {
          status: 503,
          headers,
        });
      }
      return new Response(cached, {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (endpoint === "geometry/refresh") {
      if (url.searchParams.get("key") !== env.REFRESH_SECRET) {
        return new Response("Forbidden", { status: 403, headers });
      }
      try {
        const result = await runOneGeometryChunkAndChain(env, ctx);
        return new Response(
          result.done ? "Geometry refresh complete" : "Geometry chunk complete, continuing...",
          { status: 200, headers }
        );
      } catch (err) {
        return new Response(`Geometry refresh failed: ${(err as Error).message}`, {
          status: 502,
          headers,
        });
      }
    }

    if (endpoint === "geometry/status") {
      const lastUpdated = await env.BUS_CACHE.get("geometry-last-updated");
      const queue = await env.BUS_CACHE.get<string[]>("geometry-pending-queue", "json");
      const index = await env.BUS_CACHE.get<number>("geometry-refresh-index", "json");
      const lastError = await env.BUS_CACHE.get<{ message: string; at: string }>(
        "geometry-last-error",
        "json"
      );
      return new Response(
        JSON.stringify({
          lastUpdated,
          inProgress: queue !== null,
          progress: queue ? { done: index ?? 0, total: queue.length } : null,
          lastError,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    if (endpoint === "route-geometry") {
      const cached = await env.BUS_CACHE.get("route-geometry");
      // Empty object rather than 503: a partially-backfilled geometry
      // cache is still useful — the frontend falls back to straight
      // stop-to-stop lines for whichever keys aren't present yet.
      return new Response(cached ?? "{}", {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (endpoint === "bus-arrival") {
      const raw = url.searchParams.get("BusStopCode");
      if (!raw) {
        return new Response("Missing BusStopCode query parameter", { status: 400, headers });
      }

      const stopCodes = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
      if (stopCodes.length === 0) {
        return new Response("Missing BusStopCode query parameter", { status: 400, headers });
      }
      if (stopCodes.length > MAX_STOPS_PER_BATCH) {
        return new Response(`Too many stops requested (max ${MAX_STOPS_PER_BATCH})`, {
          status: 400,
          headers,
        });
      }

      try {
        const entries = await Promise.all(
          stopCodes.map(async (code) => [code, await getArrivalForStop(code, env)] as const)
        );
        return new Response(JSON.stringify(Object.fromEntries(entries)), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(`Bus arrival fetch failed: ${(err as Error).message}`, {
          status: 502,
          headers,
        });
      }
    }

    return new Response("Unknown endpoint", { status: 404, headers });
  },

  // Cron-triggered — see wrangler.toml `[triggers]`. Runs at 19:00 UTC
  // (03:00 SGT) daily. Does one chunk directly, then the same self-chaining
  // as the manual endpoint carries the rest to completion.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOneChunkAndChain(env, ctx).catch((err) => {
        console.error("Scheduled refresh chunk failed:", (err as Error).message);
      })
    );
  },
};
