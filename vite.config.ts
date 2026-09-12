import { defineConfig, loadEnv } from "vite";

const LOCAL_API_SERVER = "http://localhost:8787";

// The deployed GitHub Pages build has no server of its own to proxy
// through, so it keeps talking straight to the Cloudflare Worker. A local
// checkout has no Cloudflare account at all — it proxies /api to the
// local Node server in server/ instead, so the frontend never needs to
// know the machine's LAN IP (the browser calls its own origin either way).
const apiBase = process.env.GITHUB_PAGES ? "https://whereisthebus-proxy.1313277.xyz" : "/api";

const apiProxy = {
  "/api": {
    target: LOCAL_API_SERVER,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

// GitHub Pages serves project sites from https://<user>.github.io/<repo>/,
// so assets must be requested with that repo-name prefix in production.
export default defineConfig(({ mode }) => {
  // Vite's dev-server Host header check rejects any hostname it doesn't
  // recognize, which blocks a tunnel (ngrok, Cloudflare Tunnel, etc.)
  // pointed at this local server unless that exact hostname is allowed.
  // Read from .env.local (gitignored, personal to whoever runs this
  // locally) rather than hardcoding a specific tunnel hostname into
  // tracked source — set TUNNEL_HOST there if you're using one.
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = env.TUNNEL_HOST ? [env.TUNNEL_HOST] : undefined;

  return {
    base: process.env.GITHUB_PAGES ? "/WhereIsTheBus/" : "/",
    define: {
      __API_BASE__: JSON.stringify(apiBase),
    },
    server: {
      host: true,
      proxy: apiProxy,
      allowedHosts,
    },
    preview: {
      host: true,
      proxy: apiProxy,
      allowedHosts,
    },
  };
});
