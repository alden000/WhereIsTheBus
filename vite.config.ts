import { defineConfig } from "vite";

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
export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/WhereIsTheBus/" : "/",
  define: {
    __API_BASE__: JSON.stringify(apiBase),
  },
  server: {
    host: true,
    proxy: apiProxy,
    allowedHosts: ["your-tunnel-hostname.example.com"],
  },
  preview: {
    host: true,
    proxy: apiProxy,
    allowedHosts: ["your-tunnel-hostname.example.com"],
  },
});
