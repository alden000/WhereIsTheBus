export interface Env {
  LTA_ACCOUNT_KEY: string;
}

// Only these LTA DataMall endpoints are reachable through the proxy —
// keeps this from becoming an open passthrough to arbitrary hosts.
const ALLOWED_ENDPOINTS: Record<string, string> = {
  "bus-arrival": "v3/BusArrival",
  "bus-services": "BusServices",
  "bus-routes": "BusRoutes",
  "bus-stops": "BusStops",
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
    const ltaPath = ALLOWED_ENDPOINTS[endpoint];

    if (!ltaPath) {
      return new Response("Unknown endpoint", { status: 404, headers });
    }

    const upstream = new URL(`https://datamall2.mytransport.sg/ltaodataservice/${ltaPath}`);
    upstream.search = url.search;

    const upstreamRes = await fetch(upstream, {
      headers: {
        AccountKey: env.LTA_ACCOUNT_KEY,
        accept: "application/json",
      },
    });

    return new Response(await upstreamRes.text(), {
      status: upstreamRes.status,
      headers: {
        ...headers,
        "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json",
      },
    });
  },
};
