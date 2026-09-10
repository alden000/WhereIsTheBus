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

// LTA caps these list endpoints at 500 records per call; walk $skip until a
// short page signals the end.
async function fetchAllPages(ltaPath: string, accountKey: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let skip = 0;

  for (;;) {
    const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
    upstream.searchParams.set("$skip", String(skip));

    const res = await fetch(upstream, {
      headers: { AccountKey: accountKey, accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`${ltaPath} failed at $skip=${skip}: HTTP ${res.status}`);
    }

    const page = (await res.json()) as { value: unknown[] };
    results.push(...page.value);

    if (page.value.length < PAGE_SIZE) {
      return results;
    }
    skip += PAGE_SIZE;
  }
}

async function refreshCache(env: Env): Promise<void> {
  for (const [cacheKey, ltaPath] of Object.entries(CACHED_DATASETS)) {
    const records = await fetchAllPages(ltaPath, env.LTA_ACCOUNT_KEY);
    await env.BUS_CACHE.put(cacheKey, JSON.stringify(records));
  }
  await env.BUS_CACHE.put("last-updated", new Date().toISOString());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        await refreshCache(env);
        return new Response("Cache refreshed", { status: 200, headers });
      } catch (err) {
        return new Response(`Refresh failed: ${(err as Error).message}`, {
          status: 502,
          headers,
        });
      }
    }

    if (endpoint === "cache/status") {
      const lastUpdated = await env.BUS_CACHE.get("last-updated");
      return new Response(JSON.stringify({ lastUpdated }), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
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
  // (03:00 SGT) daily.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshCache(env));
  },
};
