import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const CACHE_FILE = join(DATA_DIR, "cache.json");

const LTA_ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY;
const REFRESH_SECRET = process.env.REFRESH_SECRET;
const ORS_API_KEY = process.env.ORS_API_KEY;
// Deliberately not just "PORT" — some launchers (this repo's own preview
// tooling included) inject a generic PORT env var for the frontend's dev
// server into every child process, which would otherwise collide with
// this server's own default port.
const PORT = Number(process.env.API_PORT) || 8787;

if (!LTA_ACCOUNT_KEY) {
  console.error("Missing LTA_ACCOUNT_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ---- Persistent dataset cache (bus-stops/services/routes/route-geometry) ----
// A local JSON file standing in for the old Worker's D1-backed KV. Running
// as a single long-lived process on one machine (not many isolates fanning
// out across Cloudflare's edge) means none of that design's complexity
// actually applies here: no per-value size cap to chunk around, no need for
// a separate edge-cache layer in front of it, and no 1,000-write/day quota
// to shim around with D1 in the first place. Plain read-whole-file-into-
// memory, write-whole-file-back is enough.
function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

const datasetCache = loadCache();

function saveCache() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(datasetCache));
}

// ---- Bus arrival cache ----
// In-memory only (never written to disk): it's a 60s-fresh live snapshot,
// so nothing is lost by starting empty on every restart the way there
// would be for the slow-changing datasets above.
const arrivalCache = new Map(); // stopCode -> { data, expiresAt }
const ARRIVAL_CACHE_TTL_MS = 60_000;

// Kept from the original Worker for parity, though the reason it existed
// there (staying under Cloudflare's 50-subrequest-per-invocation cap) does
// not apply to a local Node process — there's no per-request budget here.
const MAX_STOPS_PER_BATCH = 15;

async function getArrivalForStop(stopCode) {
  const cached = arrivalCache.get(stopCode);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const upstream = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  upstream.searchParams.set("BusStopCode", stopCode);

  const res = await fetch(upstream, {
    headers: { AccountKey: LTA_ACCOUNT_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`BusArrival failed for ${stopCode}: HTTP ${res.status}`);
  }

  const data = await res.json();
  arrivalCache.set(stopCode, { data, expiresAt: Date.now() + ARRIVAL_CACHE_TTL_MS });
  return data;
}

// ---- Reference dataset refresh (bus-stops, bus-services, bus-routes) ----
const CACHED_DATASETS = {
  "bus-stops": "BusStops",
  "bus-services": "BusServices",
  "bus-routes": "BusRoutes",
};
const PAGE_SIZE = 500;
const FETCH_TIMEOUT_MS = 8000;

const refreshState = {
  inProgress: false,
  lastUpdated: datasetCache["last-updated"] ?? null,
  lastError: datasetCache["refresh-last-error"] ?? null,
};

async function fetchPage(ltaPath, skip) {
  const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
  upstream.searchParams.set("$skip", String(skip));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(upstream, {
      headers: { AccountKey: LTA_ACCOUNT_KEY, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${ltaPath} timed out after ${FETCH_TIMEOUT_MS}ms at $skip=${skip}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`${ltaPath} failed at $skip=${skip}: HTTP ${res.status}`);
  }
  const page = await res.json();
  return page.value;
}

// LTA caps each dataset page at 500 records (BusRoutes alone runs to
// ~26,000), so this loop just pages straight through with $skip. The
// original Worker had to break this into chunks and resume across
// invocations to stay under Cloudflare's per-invocation subrequest cap —
// a plain Node process has no such limit, so it can just await the whole
// thing in one call.
async function fetchAllPages(ltaPath) {
  const records = [];
  let skip = 0;
  for (;;) {
    const page = await fetchPage(ltaPath, skip);
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return records;
}

async function refreshDatasets() {
  if (refreshState.inProgress) return;
  refreshState.inProgress = true;
  try {
    for (const [cacheKey, ltaPath] of Object.entries(CACHED_DATASETS)) {
      datasetCache[cacheKey] = await fetchAllPages(ltaPath);
    }
    datasetCache["last-updated"] = new Date().toISOString();
    delete datasetCache["refresh-last-error"];
    refreshState.lastUpdated = datasetCache["last-updated"];
    refreshState.lastError = null;
    saveCache();
    // Same "piggyback" relationship as the original Worker: a fresh
    // bus-routes pull is the only thing that can change which lines need
    // new geometry, so kick off a geometry check right after — fire and
    // forget, since it can legitimately take a long time on a first backfill.
    void refreshGeometry();
  } catch (err) {
    refreshState.lastError = { message: err.message, at: new Date().toISOString() };
    datasetCache["refresh-last-error"] = refreshState.lastError;
    saveCache();
  } finally {
    refreshState.inProgress = false;
  }
}

// ---- Road-snapped route geometry (OpenRouteService) ----
const ORS_PROFILE = "driving-car";
const ORS_MAX_WAYPOINTS = 50;
const ORS_CALL_DELAY_MS = 1600; // stays under ORS free tier's ~40 req/min
const ORS_FETCH_TIMEOUT_MS = 8000;

const geometryState = {
  inProgress: false,
  lastUpdated: datasetCache["geometry-last-updated"] ?? null,
  progress: null,
  lastError: datasetCache["geometry-last-error"] ?? null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRouteLines(routes) {
  const grouped = new Map();
  for (const route of routes) {
    const key = `${route.ServiceNo}|${route.Direction}`;
    const group = grouped.get(key);
    if (group) group.push(route);
    else grouped.set(key, [route]);
  }

  const lines = new Map();
  for (const [key, entries] of grouped) {
    entries.sort((a, b) => a.StopSequence - b.StopSequence);
    lines.set(key, {
      serviceNo: entries[0].ServiceNo,
      stopCodes: entries.map((entry) => entry.BusStopCode),
    });
  }
  return lines;
}

function routeSignature(stopCodes) {
  return stopCodes.join(",");
}

// Splits into overlapping windows (sharing one boundary point each) so the
// stitched-together geometry has no gap at the split point.
function windowWaypoints(points, maxSize) {
  if (points.length <= maxSize) return [points];

  const windows = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + maxSize, points.length);
    windows.push(points.slice(start, end));
    if (end === points.length) break;
    start = end - 1;
  }
  return windows;
}

async function fetchRoadGeometry(stopCoords) {
  const windows = windowWaypoints(stopCoords, ORS_MAX_WAYPOINTS);
  const fullGeometry = [];

  for (let i = 0; i < windows.length; i++) {
    const coordinates = windows[i].map(([lat, lng]) => [lng, lat]);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ORS_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`https://api.heigit.org/openrouteservice/v2/directions/${ORS_PROFILE}/geojson`, {
        method: "POST",
        headers: { Authorization: ORS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ coordinates, geometry_simplify: false }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
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

    const data = await res.json();
    const segment = data.features[0]?.geometry.coordinates ?? [];
    const latLngSegment = segment.map(([lng, lat]) => [lat, lng]);

    fullGeometry.push(...(i > 0 ? latLngSegment.slice(1) : latLngSegment));

    if (i < windows.length - 1) await sleep(ORS_CALL_DELAY_MS);
  }

  return fullGeometry;
}

// Same idea as refreshDatasets: no per-invocation subrequest budget to
// chunk around, so this just loops straight through every changed line
// (still pacing ORS calls ~1.6s apart) until the whole queue is done. A
// full first-time backfill of a few hundred lines can take a while in
// wall-clock time; /geometry/status reports progress while it runs.
async function refreshGeometry() {
  if (!ORS_API_KEY) return; // optional feature — skip quietly if not configured
  if (geometryState.inProgress) return;

  const routes = datasetCache["bus-routes"];
  const stops = datasetCache["bus-stops"];
  if (!routes || !stops) return;

  geometryState.inProgress = true;
  try {
    const stopsByCode = new Map(stops.map((stop) => [stop.BusStopCode, stop]));
    const lines = buildRouteLines(routes);
    const signatures = datasetCache["route-geometry-signatures"] ?? {};
    const geometry = datasetCache["route-geometry"] ?? {};

    const queue = [];
    for (const [key, line] of lines) {
      if (signatures[key] !== routeSignature(line.stopCodes)) {
        queue.push({ key, ...line });
      }
    }
    geometryState.progress = { done: 0, total: queue.length };

    for (let i = 0; i < queue.length; i++) {
      const line = queue[i];
      const coords = line.stopCodes
        .map((code) => stopsByCode.get(code))
        .filter((stop) => stop !== undefined)
        .map((stop) => [stop.Latitude, stop.Longitude]);

      if (coords.length >= 2) {
        geometry[line.key] = await fetchRoadGeometry(coords);
        signatures[line.key] = routeSignature(line.stopCodes);
        datasetCache["route-geometry"] = geometry;
        datasetCache["route-geometry-signatures"] = signatures;
        saveCache();
      }

      geometryState.progress = { done: i + 1, total: queue.length };
      if (i < queue.length - 1) await sleep(ORS_CALL_DELAY_MS);
    }

    datasetCache["geometry-last-updated"] = new Date().toISOString();
    delete datasetCache["geometry-last-error"];
    geometryState.lastUpdated = datasetCache["geometry-last-updated"];
    geometryState.lastError = null;
    saveCache();
  } catch (err) {
    geometryState.lastError = { message: err.message, at: new Date().toISOString() };
    datasetCache["geometry-last-error"] = geometryState.lastError;
    saveCache();
  } finally {
    geometryState.inProgress = false;
    geometryState.progress = null;
  }
}

// ---- HTTP server ----
// CORS is wide open (GET-only, no cookies, nothing per-user) since this
// runs on a LAN for personal use — the only thing worth gating behind a
// secret is the refresh endpoints, same as the original Worker.
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    return sendText(res, 405, "Method not allowed");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const endpoint = url.pathname.replace(/^\/+/, "");

  try {
    if (endpoint === "cache/refresh") {
      if (url.searchParams.get("key") !== REFRESH_SECRET) return sendText(res, 403, "Forbidden");
      await refreshDatasets();
      return sendJson(res, 200, { done: true, lastUpdated: refreshState.lastUpdated, lastError: refreshState.lastError });
    }

    if (endpoint === "cache/status") {
      return sendJson(res, 200, {
        lastUpdated: refreshState.lastUpdated,
        refreshInProgress: refreshState.inProgress,
        lastError: refreshState.lastError,
      });
    }

    if (endpoint in CACHED_DATASETS) {
      const cached = datasetCache[endpoint];
      if (!cached) return sendText(res, 503, "Cache not populated yet — trigger /cache/refresh first");
      return sendJson(res, 200, cached);
    }

    if (endpoint === "geometry/refresh") {
      if (url.searchParams.get("key") !== REFRESH_SECRET) return sendText(res, 403, "Forbidden");
      void refreshGeometry();
      return sendJson(res, 202, { started: true, alreadyInProgress: geometryState.inProgress });
    }

    if (endpoint === "geometry/status") {
      return sendJson(res, 200, geometryState);
    }

    if (endpoint === "route-geometry") {
      // Empty object rather than 503: a partially-backfilled geometry cache
      // is still useful — the frontend falls back to straight stop-to-stop
      // lines for whichever keys aren't present yet.
      return sendJson(res, 200, datasetCache["route-geometry"] ?? {});
    }

    if (endpoint === "bus-arrival") {
      const raw = url.searchParams.get("BusStopCode");
      if (!raw) return sendText(res, 400, "Missing BusStopCode query parameter");

      const stopCodes = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
      if (stopCodes.length === 0) return sendText(res, 400, "Missing BusStopCode query parameter");
      if (stopCodes.length > MAX_STOPS_PER_BATCH) {
        return sendText(res, 400, `Too many stops requested (max ${MAX_STOPS_PER_BATCH})`);
      }

      const entries = await Promise.all(
        stopCodes.map(async (code) => [code, await getArrivalForStop(code)])
      );
      return sendJson(res, 200, Object.fromEntries(entries));
    }

    return sendText(res, 404, "Unknown endpoint");
  } catch (err) {
    return sendText(res, 502, `Request failed: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`whereisthebus local API server listening on http://localhost:${PORT}`);
  if (!ORS_API_KEY) {
    console.log("ORS_API_KEY not set — route geometry backfill is disabled (routes still work as straight lines).");
  }
});

// ---- Daily refresh timer (replaces the Worker's cron trigger) ----
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(() => void refreshDatasets(), REFRESH_INTERVAL_MS);

// A fresh checkout has an empty cache — refresh right away instead of
// leaving every dataset endpoint 503ing until the next daily tick or a
// manual call.
if (!datasetCache["bus-stops"]) void refreshDatasets();
