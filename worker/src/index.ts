export interface Env {
  LTA_ACCOUNT_KEY: string;
  REFRESH_SECRET: string;
  BUS_CACHE: KVNamespace;
}

// Bus arrival is genuinely real-time — always proxied live.
const LIVE_ENDPOINTS: Record<string, string> = {
  "bus-arrival": "v3/BusArrival",
};

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

  if (cursor.datasetIndex >= DATASET_ORDER.length) {
    await env.BUS_CACHE.delete("refresh-cursor");
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

// Must match this Worker's own deployed URL — chunks chain by having each
// invocation call itself over HTTP so the next chunk starts with a fresh
// subrequest budget.
const SELF_URL = "https://whereisthebus-proxy.1313277.xyz";

async function runOneChunkAndChain(env: Env, ctx: ExecutionContext): Promise<{ done: boolean }> {
  const result = await runRefreshChunk(env);
  if (!result.done) {
    const continueUrl = `${SELF_URL}/cache/refresh?key=${encodeURIComponent(env.REFRESH_SECRET)}`;
    ctx.waitUntil(fetch(continueUrl).catch(() => undefined));
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
      return new Response(
        JSON.stringify({ lastUpdated, refreshInProgress: cursor !== null, cursor }),
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

    const ltaPath = LIVE_ENDPOINTS[endpoint];
    if (!ltaPath) {
      return new Response("Unknown endpoint", { status: 404, headers });
    }

    const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
    upstream.search = url.search;

    const upstreamRes = await fetch(upstream, {
      headers: { AccountKey: env.LTA_ACCOUNT_KEY, accept: "application/json" },
    });

    return new Response(await upstreamRes.text(), {
      status: upstreamRes.status,
      headers: {
        ...headers,
        "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json",
      },
    });
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
