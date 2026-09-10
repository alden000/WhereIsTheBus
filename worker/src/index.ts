export interface Env {
  LTA_ACCOUNT_KEY: string;
  REFRESH_SECRET: string;
  BUS_CACHE: KVNamespace;
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

async function fetchPage(ltaPath: string, accountKey: string, skip: number): Promise<unknown[]> {
  const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
  upstream.searchParams.set("$skip", String(skip));

  const res = await fetch(upstream, {
    headers: { AccountKey: accountKey, accept: "application/json" },
  });

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
    const continueUrl = `${SELF_URL}/cache/refresh?key=${encodeURIComponent(env.REFRESH_SECRET)}`;
    ctx.waitUntil(fetch(continueUrl).catch(() => undefined));
  } else {
    await env.BUS_CACHE.delete("refresh-last-error");
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
