export interface Env {
  LTA_ACCOUNT_KEY: string;
  REFRESH_SECRET: string;
  ORS_API_KEY: string;
  // D1, not KV — see createD1KV below for why. Requires a one-time
  // `CREATE TABLE kv_store (...)` in this database; see worker/README.md.
  BUS_CACHE: D1Database;
}

// Everything below was originally written against KVNamespace directly.
// KV's Free plan caps writes at 1,000/day, and this app's own bus-arrival
// caching alone (one write per viewed stop roughly every 60s — see
// getArrivalForStop) blows through that in well under an hour of anyone
// actually using the map. D1's Free plan allows 100,000 writes/day and 5M
// reads/day for the same "small blobs behind a key" access pattern, so
// this shims a KV-shaped interface on top of a D1 table instead of
// rewriting every call site below.
interface KVLike {
  get<T = string>(key: string, type?: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// The Env every function below actually operates on: identical to Env
// except BUS_CACHE is the KV-shaped shim rather than the raw D1Database,
// so none of their bodies need to change, only their signatures.
type CacheEnv = Omit<Env, "BUS_CACHE"> & { BUS_CACHE: KVLike };

// D1 has no native per-key TTL like KV's `expirationTtl`, so expiry is
// tracked as a plain timestamp column and checked (and lazily swept) on
// read — a key past its expiry is treated as absent rather than actually
// deleted eagerly, since nothing here needs it gone before the next time
// something tries to read it.
//
// D1 also caps a single string/blob column at 2,000,000 bytes — unlike
// KV, which allowed values up to 25 MiB. bus-routes alone serializes to
// several MB (~26,000 records), and route-geometry only grows as more
// lines get backfilled, so both blow past that cap outright (hit in
// production as a "D1_ERROR: string or blob too big" on the very first
// post-migration refresh). Values over the threshold are transparently
// split across multiple rows keyed `${key}::00000`, `${key}::00001`, ...
// and reassembled on read — one indexed query (see chunkKeyRange below)
// fetches either the single unsplit row or every chunk, so this costs
// the same one subrequest either way and every call site above is none
// the wiser.
const D1_CHUNK_SIZE = 1_500_000;

// A range condition built from *parameters* — `key >= ?2 AND key < ?3`,
// with the concatenation done here in JS rather than as a `key LIKE ?1
// || '::%'` expression inside the SQL — is what lets D1/SQLite actually
// use the primary-key index (verified via EXPLAIN QUERY PLAN: "MULTI-
// INDEX OR" over two SEARCHes). The LIKE-with-expression form the first
// version of this shipped with, by contrast, could not be reasoned about
// at prepare time and fell back to a full `SCAN kv_store` on *every*
// get/put/delete — which is what actually burned through D1's 5M-row
// daily free-tier read quota in production, not real traffic volume.
// `key + ":;"` as the exclusive upper bound is deliberate, not `key +
// "::~"` or similar: it's `key + "::"` with the last character (":",
// 0x3A) incremented by one (";", 0x3B), the standard trick for turning
// "starts with this prefix" into an indexable half-open range — and it
// must line up with "::" specifically (not just "key" as the prefix) so
// a real key that happens to start with another key's name plus a
// different separator (e.g. "route-geometry-signatures" starting with
// "route-geometry") is never swept in by mistake.
function chunkKeyRange(key: string): [string, string] {
  return [`${key}::`, `${key}:;`];
}

function createD1KV(db: D1Database): KVLike {
  return {
    async get<T = string>(key: string, type?: "json"): Promise<T | null> {
      const [rangeStart, rangeEnd] = chunkKeyRange(key);
      const { results } = await db
        .prepare(
          "SELECT value, expires_at FROM kv_store WHERE key = ?1 OR (key >= ?2 AND key < ?3) ORDER BY key ASC"
        )
        .bind(key, rangeStart, rangeEnd)
        .all<{ value: string; expires_at: number | null }>();
      if (results.length === 0) return null;
      if (results[0].expires_at !== null && results[0].expires_at <= Date.now()) {
        await db
          .prepare("DELETE FROM kv_store WHERE key = ?1 OR (key >= ?2 AND key < ?3)")
          .bind(key, rangeStart, rangeEnd)
          .run();
        return null;
      }
      const value = results.map((row) => row.value).join("");
      return (type === "json" ? JSON.parse(value) : value) as T;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      const [rangeStart, rangeEnd] = chunkKeyRange(key);
      // Always clear out whatever shape this key held before (a single
      // row, a previous set of chunks, or nothing) so a value that
      // shrinks below the chunking threshold doesn't leave stale chunk
      // rows behind for the next get() to wrongly stitch back in.
      const statements = [
        db
          .prepare("DELETE FROM kv_store WHERE key = ?1 OR (key >= ?2 AND key < ?3)")
          .bind(key, rangeStart, rangeEnd),
      ];
      if (value.length <= D1_CHUNK_SIZE) {
        statements.push(
          db
            .prepare("INSERT INTO kv_store (key, value, expires_at) VALUES (?1, ?2, ?3)")
            .bind(key, value, expiresAt)
        );
      } else {
        for (let i = 0; i * D1_CHUNK_SIZE < value.length; i++) {
          const chunkKey = `${key}::${String(i).padStart(5, "0")}`;
          const chunk = value.slice(i * D1_CHUNK_SIZE, (i + 1) * D1_CHUNK_SIZE);
          statements.push(
            db
              .prepare("INSERT INTO kv_store (key, value, expires_at) VALUES (?1, ?2, ?3)")
              .bind(chunkKey, chunk, expiresAt)
          );
        }
      }
      await db.batch(statements);
    },
    async delete(key: string): Promise<void> {
      const [rangeStart, rangeEnd] = chunkKeyRange(key);
      await db
        .prepare("DELETE FROM kv_store WHERE key = ?1 OR (key >= ?2 AND key < ?3)")
        .bind(key, rangeStart, rangeEnd)
        .run();
    },
  };
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

// Reference data that barely changes — pulled into the cache once a day
// (see `scheduled` below) and served from there instead of hitting LTA
// per request.
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
// and reused for this long — matching both how often the frontend polls
// and LTA's own documented update frequency for this dataset (LTA DataMall
// API User Guide, section 2.1: "Update Freq: 20 seconds"). Caching any
// longer just shows a bus further behind where it actually is than
// necessary; caching any shorter re-fetches data LTA hasn't refreshed yet.
const ARRIVAL_CACHE_TTL_SECONDS = 20;

// Worst case (every requested stop is a cache miss) costs 2 subrequests
// each: the edge cache lookup and the LTA fetch. Staying under the
// Workers Free plan's 50-subrequest cap means capping the batch at 15,
// with room to spare for a request that's a mix of hits and misses.
const MAX_STOPS_PER_BATCH = 15;

// Arrival data is cached at Cloudflare's edge (the Workers Cache API)
// rather than in D1. It's a much better fit: this data is short-lived
// (60s) and shared across every viewer looking at the same stop, so with
// many concurrent public users the dominant cost was never LTA calls —
// it was every single poll from every viewer doing a D1 read (a real hit
// even on a cache *hit*, since the old code always checked D1 first) for
// every stop in view. The edge cache absorbs that fan-out for free —
// unmetered, no daily row quota — and D1 never even gets a subrequest
// for arrivals now. The key is a synthetic internal URL (never actually
// fetched) so each stop gets its own cache entry independent of which
// combination of stops happened to share a batch request.
function arrivalCacheKey(stopCode: string): Request {
  return new Request(`https://cache.internal/bus-arrival/${stopCode}`);
}

async function getArrivalForStop(
  stopCode: string,
  env: Pick<Env, "LTA_ACCOUNT_KEY">,
  ctx: ExecutionContext
): Promise<unknown> {
  const cache = caches.default;
  const cacheKey = arrivalCacheKey(stopCode);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
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
  // Cached in the background — the caller doesn't wait on the write, and
  // a request that finishes right as the isolate would otherwise be
  // recycled still gets to complete it.
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ARRIVAL_CACHE_TTL_SECONDS}`,
        },
      })
    )
  );
  return data;
}

const PAGE_SIZE = 500;

// The Workers Free plan caps a single invocation at 50 subrequests (fetch +
// D1 calls combined) — the only hard limit that actually matters here.
// runRefreshChunk below loops directly (no self-fetch, no waitUntil chain)
// until it's used up close to this many, then returns; the caller (the
// HTTP handler or the daily cron) just needs to call it again if it isn't
// done. Leaves a margin under 50 for the handful of cache reads/writes around
// the page-fetching loop itself.
const MAX_SUBREQUESTS_PER_REFRESH = 45;

interface RefreshCursor {
  datasetIndex: number;
  skip: number;
}

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

// Loops directly — no self-fetch, no waitUntil chaining — until either
// every dataset is fully pulled or the subrequest budget for this
// invocation is nearly spent, then returns. This replaced a design that
// self-chained into a fresh invocation via fetch() after every small
// batch of pages: that self-fetch turned out to be fundamentally
// unreliable in production (WAF-blocked on the custom domain, then a
// silently-accepted rate-limit response, then genuine Cloudflare-edge
// 522s, then an explicit "request loop" rejection) no matter how the
// retry logic around it was tightened — Cloudflare's platform actively
// discourages a Worker from fetching its own URL like this. Removing the
// self-fetch removes that whole class of failure: the only real
// constraint left is the Workers Free plan's 50-subrequest-per-invocation
// cap, which this counts against directly instead of guessing at a safe
// page count. Only writes a dataset's final cache entry once it's fully
// pulled, so reads always see either the previous complete dataset or
// the new one — never a partial one. If the invocation is interrupted
// (uncaught error, isolate restart) between persisting checkpoints,
// the next call just resumes from the last persisted cursor/partial —
// at most redoing a few already-fetched pages, not losing anything.
async function runRefreshChunk(env: CacheEnv): Promise<{ done: boolean }> {
  let cursor: RefreshCursor =
    (await env.BUS_CACHE.get<RefreshCursor>("refresh-cursor", "json")) ?? {
      datasetIndex: 0,
      skip: 0,
    };
  let subrequests = 1;

  // Defensive: reachable if two refreshes ever overlap (e.g. the manual
  // endpoint hit twice at once) and one sees a cursor the other already
  // advanced past the end. Still mark completion consistently rather
  // than leaving last-updated stuck null with the cursor cleared.
  if (cursor.datasetIndex >= DATASET_ORDER.length) {
    await env.BUS_CACHE.delete("refresh-cursor");
    await env.BUS_CACHE.put("last-updated", new Date().toISOString());
    return { done: true };
  }

  let partial: unknown[] = [];
  if (cursor.skip !== 0) {
    partial = (await env.BUS_CACHE.get<unknown[]>("refresh-partial", "json")) ?? [];
    subrequests++;
  }

  while (cursor.datasetIndex < DATASET_ORDER.length && subrequests < MAX_SUBREQUESTS_PER_REFRESH) {
    const cacheKey = DATASET_ORDER[cursor.datasetIndex];
    const ltaPath = CACHED_DATASETS[cacheKey];
    const records = await fetchPage(ltaPath, env.LTA_ACCOUNT_KEY, cursor.skip);
    subrequests++;
    partial.push(...records);

    if (records.length < PAGE_SIZE) {
      await env.BUS_CACHE.put(cacheKey, JSON.stringify(partial));
      subrequests++;
      cursor = { datasetIndex: cursor.datasetIndex + 1, skip: 0 };
      partial = [];
    } else {
      cursor = { datasetIndex: cursor.datasetIndex, skip: cursor.skip + PAGE_SIZE };
    }
  }

  if (cursor.datasetIndex >= DATASET_ORDER.length) {
    await env.BUS_CACHE.delete("refresh-cursor");
    await env.BUS_CACHE.delete("refresh-partial");
    await env.BUS_CACHE.put("last-updated", new Date().toISOString());
    return { done: true };
  }

  await env.BUS_CACHE.put("refresh-cursor", JSON.stringify(cursor satisfies RefreshCursor));
  if (partial.length > 0) {
    await env.BUS_CACHE.put("refresh-partial", JSON.stringify(partial));
  } else {
    await env.BUS_CACHE.delete("refresh-partial");
  }
  return { done: false };
}

// Never throws — records failures to the cache so /cache/status can see them.
async function processRefreshChunk(env: CacheEnv): Promise<{ done: boolean; error?: string }> {
  try {
    const result = await runRefreshChunk(env);
    if (result.done) {
      await env.BUS_CACHE.delete("refresh-last-error");
    }
    return result;
  } catch (err) {
    const message = (err as Error).message;
    await env.BUS_CACHE.put(
      "refresh-last-error",
      JSON.stringify({ message, at: new Date().toISOString() })
    );
    return { done: false, error: message };
  }
}

// ---- Road-snapped route geometry (OpenRouteService) ----
//
// LTA's BusRoutes only gives stop order, not road geometry, so a straight
// line between consecutive stops cuts corners. This pulls a real
// road-following path through each service+direction's stops once, and
// caches it *indefinitely* — re-fetched only when that line's stop
// sequence actually changes (detected by comparing a cheap signature),
// never on a blind schedule. Triggered the same way as the bus-data
// refresh: call the endpoint/function again until it reports done.

// api.openrouteservice.org is being retired in favor of api.heigit.org
// (same API key, same path shape, just a "/openrouteservice" segment
// added and a new host) — the old host's quota was cut to 10% on
// 2026-08-27 and it shuts off entirely on 2026-09-28. Confirmed the hard
// way: a backfill run hit "HTTP 403 Quota exceeded" on the old host far
// earlier than the free tier's normal daily limit should allow.
const ORS_PROFILE = "driving-car";
// OpenRouteService's free-tier Directions endpoint caps waypoints per
// request; longer routes are split into overlapping windows and stitched.
const ORS_MAX_WAYPOINTS = 50;
// Free tier allows ~40 requests/minute; spacing calls out keeps us under
// that without needing a smarter token-bucket scheme.
const ORS_CALL_DELAY_MS = 1600;

// Same reasoning as MAX_SUBREQUESTS_PER_REFRESH above — count real
// subrequests (each ORS call, each cache op) instead of guessing a safe
// line count per chunk. Lower than the refresh budget because each ORS
// call also pays ORS_CALL_DELAY_MS of rate-limit pacing on top of its
// own latency, so a full invocation here takes noticeably longer per
// unit of "work done" than a page of LTA data does.
const MAX_SUBREQUESTS_PER_GEOMETRY_RUN = 25;
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
      res = await fetch(`https://api.heigit.org/openrouteservice/v2/directions/${ORS_PROFILE}/geojson`, {
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

// Loops directly (see the note above runRefreshChunk for why: no more
// self-fetch chaining) until either the queue is empty or the subrequest
// budget for this invocation is nearly spent, then returns. Writes the
// combined geometry/signature blobs back once at the end rather than
// per-line, so a run that's interrupted before finishing just redoes
// whatever lines it fetched but hadn't yet persisted — a few repeated
// ORS calls, not lost data.
//
// The pending queue stores each line's full data (key, serviceNo,
// stopCodes) up front, not just its key — grouping and sorting all
// ~27,000 raw bus-routes rows to rebuild that data is real CPU work
// (the Workers Free plan caps actual JS execution at 10ms/invocation,
// separate from wall-clock time), so it's done once when the queue is
// built rather than on every run.
async function runGeometryChunk(env: CacheEnv): Promise<{ done: boolean }> {
  let subrequests = 0;
  let queue = await env.BUS_CACHE.get<QueuedLine[]>("geometry-pending-queue", "json");
  subrequests++;

  // Migration guard: an older version of this code stored the queue as
  // plain string keys. Treat that shape as stale and recompute fresh
  // rather than crashing on `.stopCodes` of a string.
  if (queue !== null && (queue.length === 0 || typeof queue[0] !== "object")) {
    queue = null;
  }

  if (queue === null) {
    const routesRaw = await env.BUS_CACHE.get<BusRoute[]>("bus-routes", "json");
    subrequests++;
    if (!routesRaw) {
      throw new Error("bus-routes cache is empty; run /cache/refresh first");
    }
    const lines = buildRouteLines(routesRaw);
    const existingSignatures =
      (await env.BUS_CACHE.get<Record<string, string>>("route-geometry-signatures", "json")) ?? {};
    subrequests++;

    queue = [];
    for (const [key, line] of lines) {
      if (existingSignatures[key] !== routeSignature(line.stopCodes)) {
        queue.push({ key, serviceNo: line.serviceNo, stopCodes: line.stopCodes });
      }
    }
    await env.BUS_CACHE.put("geometry-pending-queue", JSON.stringify(queue));
    subrequests++;
    await env.BUS_CACHE.put("geometry-refresh-index", JSON.stringify(0));
    subrequests++;
  }

  let index = (await env.BUS_CACHE.get<number>("geometry-refresh-index", "json")) ?? 0;
  subrequests++;

  if (index >= queue.length) {
    await env.BUS_CACHE.delete("geometry-pending-queue");
    await env.BUS_CACHE.delete("geometry-refresh-index");
    await env.BUS_CACHE.put("geometry-last-updated", new Date().toISOString());
    return { done: true };
  }

  const stopsRaw = await env.BUS_CACHE.get<BusStop[]>("bus-stops", "json");
  subrequests++;
  if (!stopsRaw) {
    throw new Error("bus-stops cache is empty; run /cache/refresh first");
  }
  const stopsByCode = new Map(stopsRaw.map((stop) => [stop.BusStopCode, stop]));

  const geometry =
    (await env.BUS_CACHE.get<Record<string, LatLng[]>>("route-geometry", "json")) ?? {};
  subrequests++;
  const signatures =
    (await env.BUS_CACHE.get<Record<string, string>>("route-geometry-signatures", "json")) ?? {};
  subrequests++;

  while (index < queue.length && subrequests < MAX_SUBREQUESTS_PER_GEOMETRY_RUN) {
    const line = queue[index];
    const coords: LatLng[] = line.stopCodes
      .map((code) => stopsByCode.get(code))
      .filter((stop): stop is BusStop => stop !== undefined)
      .map((stop): LatLng => [stop.Latitude, stop.Longitude]);

    if (coords.length >= 2) {
      subrequests += windowWaypoints(coords, ORS_MAX_WAYPOINTS).length;
      geometry[line.key] = await fetchRoadGeometry(coords, env.ORS_API_KEY);
      signatures[line.key] = routeSignature(line.stopCodes);

      // Only pace ourselves when an ORS call actually happened — a line
      // skipped for having fewer than 2 valid stops makes no API call,
      // so there's nothing to rate-limit against. Pacing unconditionally
      // here meant a run of skip-worthy lines (a handful of routes with
      // missing/mismatched stop data isn't unusual) could burn through
      // most of the invocation's time doing nothing at all.
      if (index + 1 < queue.length && subrequests < MAX_SUBREQUESTS_PER_GEOMETRY_RUN) {
        await sleep(ORS_CALL_DELAY_MS);
      }
    }

    index++;
  }

  await env.BUS_CACHE.put("route-geometry", JSON.stringify(geometry));
  await env.BUS_CACHE.put("route-geometry-signatures", JSON.stringify(signatures));
  await env.BUS_CACHE.put("geometry-refresh-index", JSON.stringify(index));

  return { done: false };
}

// Never throws — records failures to the cache so /geometry/status can see them.
async function processGeometryChunk(env: CacheEnv): Promise<{ done: boolean; error?: string }> {
  try {
    const result = await runGeometryChunk(env);
    if (result.done) {
      await env.BUS_CACHE.delete("geometry-last-error");
    }
    return result;
  } catch (err) {
    const message = (err as Error).message;
    await env.BUS_CACHE.put(
      "geometry-last-error",
      JSON.stringify({ message, at: new Date().toISOString() })
    );
    return { done: false, error: message };
  }
}

// This reference data changes at most once a day (the daily refresh
// cron) and route-geometry only grows monotonically between real stop-
// sequence changes, so a request for any of these has no per-caller
// variation worth preserving — a great fit for Cloudflare's edge Cache
// API in front of D1. With many concurrent public users, this is what
// keeps D1 traffic roughly flat regardless of how many people are using
// the app: almost every request gets served straight from the edge
// without ever reaching this Worker's own D1 logic at all. A day's worth
// of staleness would be one thing, but capping it well under that still
// means a same-day dataset change (rare, but the whole point of the
// daily refresh existing) shows up everywhere within the hour rather
// than needing a purge.
const DATASET_EDGE_CACHE_TTL_SECONDS = 3600;
const EDGE_CACHEABLE_ENDPOINTS = new Set([...DATASET_ORDER, "route-geometry"]);

// The Workers Cache API does *not* honor a cached response's `Vary`
// header the way a standard HTTP cache does (confirmed against
// Cloudflare's own docs, and the hard way in local testing: a request
// from a second allowed origin came back with the *first* origin's
// Access-Control-Allow-Origin value once that response was cached —
// which the browser then rejects, since it doesn't match the actual
// requesting origin). This app has two legitimate origins (the deployed
// site and local dev), so relying on Vary here would silently break
// CORS for whichever origin didn't happen to populate the cache first.
// Baking the origin into the cache key itself sidesteps the missing
// Vary support entirely — each origin gets its own cache entry with its
// own correct header, exactly matching pre-caching behavior.
function edgeCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("__origin", request.headers.get("Origin") ?? "");
  return new Request(url.toString());
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
    const cacheable = EDGE_CACHEABLE_ENDPOINTS.has(endpoint);

    const cache = caches.default;
    const cacheKey = cacheable ? edgeCacheKey(request) : null;
    if (cacheKey) {
      // A hit here means this invocation never touches D1 at all — the
      // whole point, since it's what keeps the app's real D1 load from
      // scaling with how many people are using it.
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const cacheEnv: CacheEnv = { ...env, BUS_CACHE: createD1KV(env.BUS_CACHE) };

    // D1 (like any dependency) can have a bad moment — a transient
    // throttle, a burst of concurrent requests, a brief outage — and an
    // uncaught rejection from any of the cacheEnv.BUS_CACHE calls below
    // would otherwise crash the whole invocation into Cloudflare's raw
    // "error code: 1101" page for every endpoint, arrival lookups
    // included, rather than just degrading. Wrapping the router means a
    // D1 hiccup surfaces as one clearly-labeled 503 instead of that.
    try {
      const response = await route();
      if (cacheKey && response.status === 200) {
        response.headers.set("Cache-Control", `max-age=${DATASET_EDGE_CACHE_TTL_SECONDS}`);
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    } catch (err) {
      return new Response(`Cache backend temporarily unavailable: ${(err as Error).message}`, {
        status: 503,
        headers,
      });
    }

    async function route(): Promise<Response> {
      if (endpoint === "cache/refresh") {
        if (url.searchParams.get("key") !== env.REFRESH_SECRET) {
          return new Response("Forbidden", { status: 403, headers });
        }
        // Runs synchronously and returns once this batch is done — no more
        // "queued, check status separately" 202 response, since there's no
        // background self-fetch chain left to queue behind. A single call
        // typically finishes a full daily refresh in one or two hits; if
        // `done` comes back false, just call this again to continue.
        const result = await processRefreshChunk(cacheEnv);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (endpoint === "cache/status") {
        const lastUpdated = await cacheEnv.BUS_CACHE.get("last-updated");
        const cursor = await cacheEnv.BUS_CACHE.get<RefreshCursor>("refresh-cursor", "json");
        const lastError = await cacheEnv.BUS_CACHE.get<{ message: string; at: string }>(
          "refresh-last-error",
          "json"
        );
        return new Response(
          JSON.stringify({ lastUpdated, refreshInProgress: cursor !== null, cursor, lastError }),
          { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
        );
      }

      if (endpoint in CACHED_DATASETS) {
        const cached = await cacheEnv.BUS_CACHE.get(endpoint);
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
        // Same synchronous-batch shape as /cache/refresh above — runs one
        // batch of lines (bounded by MAX_SUBREQUESTS_PER_GEOMETRY_RUN) and
        // returns; call again while `done` is false to keep going.
        const result = await processGeometryChunk(cacheEnv);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (endpoint === "geometry/status") {
        const lastUpdated = await cacheEnv.BUS_CACHE.get("geometry-last-updated");
        const queue = await cacheEnv.BUS_CACHE.get<QueuedLine[]>("geometry-pending-queue", "json");
        const index = await cacheEnv.BUS_CACHE.get<number>("geometry-refresh-index", "json");
        const lastError = await cacheEnv.BUS_CACHE.get<{ message: string; at: string }>(
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
        const cached = await cacheEnv.BUS_CACHE.get("route-geometry");
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
            stopCodes.map(async (code) => [code, await getArrivalForStop(code, env, ctx)] as const)
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
    }
  },

  // Runs at 03:00 SGT daily (see wrangler.toml `[triggers]`, or the
  // dashboard's Trigger Events tab if a cron was added there directly).
  // A refresh already in progress (or the daily trigger itself, which
  // always starts one fresh) takes priority; otherwise, whatever budget
  // this invocation has goes toward the geometry backlog instead, so a
  // bus-data refresh only in progress on paper (a leftover cursor with
  // nothing left to actually advance) can't starve geometry forever.
  // Each call processes one batch — see runRefreshChunk/runGeometryChunk
  // above — so a large backlog is worn down over consecutive days; hit
  // /cache/refresh or /geometry/refresh manually (repeatedly, until
  // `done: true`) for faster progress than the daily cadence alone.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cacheEnv: CacheEnv = { ...env, BUS_CACHE: createD1KV(env.BUS_CACHE) };
    ctx.waitUntil(
      (async () => {
        const refreshCursor = await cacheEnv.BUS_CACHE.get("refresh-cursor", "json");
        if (refreshCursor !== null || event.cron === "0 19 * * *") {
          await processRefreshChunk(cacheEnv);
          return;
        }
        const geometryQueue = await cacheEnv.BUS_CACHE.get("geometry-pending-queue", "json");
        if (geometryQueue !== null) {
          await processGeometryChunk(cacheEnv);
        }
      })()
    );
  },
};
