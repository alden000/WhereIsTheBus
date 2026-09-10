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
// via a self-fetch, resuming from a cursor saved in KV.
//
// This used to be 40, sized only against the 50-subrequest cap — but the
// invocation's *own* waitUntil has a separate, harder 30s cap (see the
// note above CHAIN_FETCH_TIMEOUT_MS), and 40 sequential LTA pages plus
// the chain hand-off afterward can exceed that even when every page
// responds normally (40 pages * ~0.5-1s each is already 20-40s before
// the chain retry's own budget is added on top) — a silent kill with no
// error and no progress, indistinguishable from the chain simply not
// running at all. 10 keeps a chunk's own worst-case time small enough to
// leave real headroom for the chain hand-off within the same 30s budget.
const MAX_PAGES_PER_CHUNK = 10;

interface RefreshCursor {
  datasetIndex: number;
  skip: number;
}

// Was 15000 — tightened alongside MAX_PAGES_PER_CHUNK above for the same
// reason: a hung fetch() should abort with room left in the invocation's
// 30s waitUntil budget for the chain hand-off that follows, not consume
// nearly all of it by itself.
const FETCH_TIMEOUT_MS = 8000;

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

// IMPORTANT: ctx.waitUntil() for an HTTP-triggered Worker has a hard
// 30-SECOND cap, enforced by the platform itself, regardless of any
// timeout our own code sets — confirmed against Cloudflare's docs after
// production got stuck the same way even with a 90s internal timeout.
// (Local `wrangler dev` does not enforce this, which is why testing
// locally kept looking fine.) The old design had chunk N's waitUntil
// *await the next chunk's full processing* before considering itself
// finished — if that took anywhere near 30s (very plausible: several
// LTA pages, or several rate-limited ORS calls), the whole waitUntil,
// including whatever was mid-flight inside it, got silently killed with
// no exception for our own try/catch to see.
//
// The fix: every hop responds immediately (its *own* actual chunk of
// work runs inside its *own* waitUntil, so it gets its own fresh 30s
// budget) and only then — separately — fires the next hop. Because the
// next hop also acks immediately rather than doing its work before
// responding, the fetch() that fires it resolves in a second or two,
// not in however long a full chunk takes. So chunk N's total time
// inside its own waitUntil is just "this chunk's work" + "a quick
// handoff", comfortably under 30s, and each subsequent chunk gets its
// own clean budget the same way.
// Kept comfortably below the 30s waitUntil cap even in the worst case
// (CHAIN_MAX_ATTEMPTS attempts, every one timing out, plus a short delay
// between retries): 3 * 6s + 2 * 500ms = 19s, leaving headroom for the
// chunk's own work that runs before this is called.
const CHAIN_FETCH_TIMEOUT_MS = 6000;
const CHAIN_MAX_ATTEMPTS = 3;
const CHAIN_RETRY_DELAY_MS = 500;

// Generalized so both the bus-data refresh chain and the route-geometry
// chain (below) can reuse the same resume-by-retrying behavior: since
// each chained endpoint always resumes from whatever state is in KV,
// retrying a chain hop is exactly the same operation as the original
// attempt, so a timeout + a few retries turns transient self-fetch
// flakiness into a self-healing chain instead of a silent dead end.
async function triggerChainedRequest(env: Env, path: string, errorKvKey: string): Promise<void> {
  const continueUrl = `${SELF_URL}${path}?key=${encodeURIComponent(env.REFRESH_SECRET)}`;
  let lastFailure = "no attempts made";

  for (let attempt = 1; attempt <= CHAIN_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAIN_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(continueUrl, { signal: controller.signal });
      // CRITICAL: fetch() only rejects on network-level failures — it
      // resolves normally for any HTTP response, including a 429 or a
      // Cloudflare-edge rate-limit/challenge page. The previous version
      // didn't check this, so once the platform started throttling this
      // Worker's rapid self-chained requests, every "attempt" here
      // silently counted as success and `return`ed immediately — the
      // chain died with nothing left to trigger the next hop, and
      // because we'd already returned, the error-recording code below
      // never ran either. That's the actual cause of every "stuck at N,
      // no error" episode so far, not chunk size or ORS latency.
      if (res.ok) {
        return;
      }
      lastFailure = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      lastFailure = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < CHAIN_MAX_ATTEMPTS) {
      await sleep(CHAIN_RETRY_DELAY_MS);
    }
  }

  // Every attempt failed — leave a visible trail instead of the chain
  // just going quiet with no explanation. The state driving `path` is
  // untouched, so the next manual trigger or cron run resumes from
  // exactly here.
  await env.BUS_CACHE.put(
    errorKvKey,
    JSON.stringify({
      message: `Chain continuation to ${path} failed after ${CHAIN_MAX_ATTEMPTS} attempts: ${lastFailure}`,
      at: new Date().toISOString(),
    })
  );
}

// Runs exactly one chunk's worth of work and, if there's more to do,
// hands off to the next hop — entirely within the *calling* invocation's
// own waitUntil budget. Never throws: every failure is recorded to KV
// so cache/status can see it, since nothing else ever reads this
// function's outcome once it's running detached in the background.
async function processRefreshChunk(env: Env): Promise<void> {
  let result: { done: boolean };
  try {
    result = await runRefreshChunk(env);
  } catch (err) {
    await env.BUS_CACHE.put(
      "refresh-last-error",
      JSON.stringify({ message: (err as Error).message, at: new Date().toISOString() })
    );
    return;
  }
  if (!result.done) {
    await triggerChainedRequest(env, "/cache/refresh", "refresh-last-error");
  } else {
    await env.BUS_CACHE.delete("refresh-last-error");
    // bus-routes just finished (re)pulling — check whether any line's stop
    // sequence actually changed and, if so, (re)generate just those.
    await triggerChainedRequest(env, "/geometry/refresh", "geometry-last-error");
  }
}

// ---- Road-snapped route geometry (OpenRouteService) ----
//
// LTA's BusRoutes only gives stop order, not road geometry, so a straight
// line between consecutive stops cuts corners. This pulls a real
// road-following path through each service+direction's stops once, and
// caches it in KV *indefinitely* — re-fetched only when that line's stop
// sequence actually changes (detected by comparing a cheap signature),
// never on a blind schedule. It piggybacks on the daily bus-routes
// refresh (see processRefreshChunk above) rather than having its own cron.

const ORS_PROFILE = "driving-car";
// OpenRouteService's free-tier Directions endpoint caps waypoints per
// request; longer routes are split into overlapping windows and stitched.
const ORS_MAX_WAYPOINTS = 50;
// Free tier allows ~40 requests/minute; spacing calls out keeps us under
// that without needing a smarter token-bucket scheme.
const ORS_CALL_DELAY_MS = 1600;

// Fixing the "wait for the next chunk's full response" bug (see the note
// above processRefreshChunk) wasn't the whole story: a chunk's *own*
// processing still has to fit inside the invocation's 30s waitUntil cap,
// and real OpenRouteService calls turned out to be far slower than the
// near-instant mock server used to develop this — even 3 lines/chunk
// kept getting silently killed mid-chunk (no error, no progress). Two
// changes address the actual worst case: one line per chunk (so at most
// a couple of ORS calls are ever in flight per invocation), and a
// tighter per-call timeout than the shared LTA one, so a genuinely slow
// ORS response gets aborted as a normal, retriable error well before the
// platform's 30s cutoff would silently kill everything.
const MAX_LINES_PER_GEOMETRY_CHUNK = 1;
const ORS_FETCH_TIMEOUT_MS = 8000;

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
    const timeout = setTimeout(() => controller.abort(), ORS_FETCH_TIMEOUT_MS);
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
        throw new Error(`ORS request timed out after ${ORS_FETCH_TIMEOUT_MS}ms`);
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

interface QueuedLine {
  key: string;
  serviceNo: string;
  stopCodes: string[];
}

// Does at most MAX_LINES_PER_GEOMETRY_CHUNK lines of work, then returns.
// Writes the combined geometry/signature blobs back once per chunk (not
// per line) to stay within KV's daily write quota over a full backfill —
// the tradeoff is that a chunk failing partway redoes that chunk's lines
// on retry, which just costs a few repeated ORS calls, not lost data.
//
// The pending queue stores each line's full data (key, serviceNo,
// stopCodes) up front, not just its key — grouping and sorting all
// ~27,000 raw bus-routes rows to rebuild that data is real CPU work
// (the Workers Free plan caps actual JS execution at 10ms/invocation,
// separate from wall-clock time), and doing it on *every* chunk instead
// of once when the queue is built was the likely cause of chunks
// silently dying mid-backfill with nothing for our own error handling
// to catch — a CPU-limit kill bypasses that entirely.
async function runGeometryChunk(env: Env): Promise<{ done: boolean }> {
  let queue = await env.BUS_CACHE.get<QueuedLine[]>("geometry-pending-queue", "json");

  // Migration guard: an older version of this code stored the queue as
  // plain string keys. Treat that shape as stale and recompute fresh
  // rather than crashing on `.stopCodes` of a string.
  if (queue !== null && (queue.length === 0 || typeof queue[0] !== "object")) {
    queue = null;
  }

  if (queue === null) {
    const routesRaw = await env.BUS_CACHE.get<BusRoute[]>("bus-routes", "json");
    if (!routesRaw) {
      throw new Error("bus-routes cache is empty; run /cache/refresh first");
    }
    const lines = buildRouteLines(routesRaw);
    const signatures =
      (await env.BUS_CACHE.get<Record<string, string>>("route-geometry-signatures", "json")) ?? {};

    queue = [];
    for (const [key, line] of lines) {
      if (signatures[key] !== routeSignature(line.stopCodes)) {
        queue.push({ key, serviceNo: line.serviceNo, stopCodes: line.stopCodes });
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
    const line = queue[i];
    const coords: LatLng[] = line.stopCodes
      .map((code) => stopsByCode.get(code))
      .filter((stop): stop is BusStop => stop !== undefined)
      .map((stop): LatLng => [stop.Latitude, stop.Longitude]);

    if (coords.length >= 2) {
      geometry[line.key] = await fetchRoadGeometry(coords, env.ORS_API_KEY);
      signatures[line.key] = routeSignature(line.stopCodes);
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

// Same "do this chunk, then hand off" shape as processRefreshChunk —
// never throws, since it runs detached inside the caller's waitUntil.
async function processGeometryChunk(env: Env): Promise<void> {
  let result: { done: boolean };
  try {
    result = await runGeometryChunk(env);
  } catch (err) {
    await env.BUS_CACHE.put(
      "geometry-last-error",
      JSON.stringify({ message: (err as Error).message, at: new Date().toISOString() })
    );
    return;
  }
  if (!result.done) {
    await triggerChainedRequest(env, "/geometry/refresh", "geometry-last-error");
  } else {
    await env.BUS_CACHE.delete("geometry-last-error");
  }
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
      // Ack immediately and do the actual chunk in the background: this
      // invocation's own waitUntil only needs to cover its own chunk, not
      // wait for the whole remaining chain, which is what let a chunk's
      // processing time eat into (and exceed) the 30s waitUntil cap.
      ctx.waitUntil(processRefreshChunk(env));
      return new Response("Refresh chunk queued — check /cache/status for progress", {
        status: 202,
        headers,
      });
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
      ctx.waitUntil(processGeometryChunk(env));
      return new Response("Geometry refresh chunk queued — check /geometry/status for progress", {
        status: 202,
        headers,
      });
    }

    if (endpoint === "geometry/status") {
      const lastUpdated = await env.BUS_CACHE.get("geometry-last-updated");
      const queue = await env.BUS_CACHE.get<QueuedLine[]>("geometry-pending-queue", "json");
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

  // Two cron schedules share this handler — see wrangler.toml
  // `[triggers]` (or the dashboard's Trigger Events tab, since this
  // Worker is deployed by pasting code rather than `wrangler deploy`):
  //
  // - "0 19 * * *" (03:00 SGT daily): starts the full daily refresh from
  //   scratch, same as before.
  // - "* * * * *" (every minute): a safety net, NOT a fast path. The
  //   self-fetch chain in triggerChainedRequest is the fast path — when
  //   it works, an in-progress refresh advances continuously without
  //   waiting for this. But that self-fetch has repeatedly proven
  //   unreliable in production (WAF-blocked custom-domain requests, then
  //   silently-accepted rate-limit responses, now genuine Cloudflare-edge
  //   522s) — a link that can die makes the whole background job die
  //   with it, however good the retry logic. This tick doesn't depend on
  //   that link at all: it's invoked directly by Cloudflare's scheduler,
  //   no HTTP self-fetch involved, so it can't be blocked or rate-limited
  //   the same way. If a refresh or geometry backfill is mid-flight, it
  //   just resumes exactly one more chunk from whatever's in KV. Once
  //   nothing is in progress, it's a no-op three subrequests per minute.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 19 * * *") {
      ctx.waitUntil(processRefreshChunk(env));
      return;
    }
    // Both checked independently, not "refresh first, geometry only if
    // refresh is idle" — an orphaned/stuck refresh-cursor (e.g. left over
    // from an old manual /cache/refresh that never finished) would
    // otherwise starve geometry forever: every tick would keep retrying
    // the stuck refresh and never even look at the geometry queue.
    ctx.waitUntil(
      (async () => {
        const refreshCursor = await env.BUS_CACHE.get("refresh-cursor", "json");
        if (refreshCursor !== null) {
          await processRefreshChunk(env);
        }
      })()
    );
    ctx.waitUntil(
      (async () => {
        const geometryQueue = await env.BUS_CACHE.get("geometry-pending-queue", "json");
        if (geometryQueue !== null) {
          await processGeometryChunk(env);
        }
      })()
    );
  },
};
