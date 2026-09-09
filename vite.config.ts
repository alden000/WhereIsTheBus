import { defineConfig } from "vite";

// GitHub Pages serves project sites from https://<user>.github.io/<repo>/,
// so assets must be requested with that repo-name prefix in production.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/WhereIsTheBus/" : "/",
});
