import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createLiveEventsApi } from "./server/api.mjs";

const cesiumBuildRootPath = join(dirname(createRequire(import.meta.url).resolve("cesium/package.json")), "Build");

// FL511 is never called from the browser. Mounting the live-events API inside the dev server keeps
// it same-origin for `npm start` and the e2e suite without a second process; deployments that serve
// the map statically run the identical handler from server/index.mjs instead.
const liveEventsApi = () => {
  const api = createLiveEventsApi();
  return {
    name: "i595-live-events-api",
    configureServer(server) {
      server.middlewares.use(api.middleware);
      server.httpServer?.on("close", () => { void api.stop(); });
    },
    configurePreviewServer(server) { server.middlewares.use(api.middleware); },
  };
};

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
export default defineConfig({
  // Under GitHub Pages the toll twin is served from a sub-path (/acs-demo/twin/). The deploy
  // workflow sets CESIUM_BASE_PATH (POC_BASE_PATH kept as an alias for older scripts); local dev
  // leaves both unset → "/" so npm start and the Playwright e2e suite are unaffected. All runtime
  // asset URLs resolve against import.meta.env.BASE_URL so data/ and models/ load under either base.
  base: process.env.CESIUM_BASE_PATH || process.env.POC_BASE_PATH || "/",
  plugins: [cesium({ cesiumBuildRootPath, cesiumBuildPath: join(cesiumBuildRootPath, "Cesium") }), liveEventsApi()],
  // Port 5188 (not the default 5180) keeps this NTTA worktree isolated from a sibling session's
  // dev server sharing localhost. Disable auto-open under headless e2e.
  server: { port: 5188, open: false, strictPort: true },
});
