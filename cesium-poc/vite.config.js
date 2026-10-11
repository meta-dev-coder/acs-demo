import { loadServerEnv } from './server/loadEnv.mjs';
import { createMessageSignsApi } from './server/messageSigns.mjs';
import { createDataConnectApi } from './server/dataConnect.mjs';
import { createLiveDcReadApi } from './server/liveDc/liveReadApi.mjs';

// Before any plugin reads process.env: Vite only exposes VITE_-prefixed variables, and the
// server-side credentials are deliberately not prefixed, so nothing else would load them. The EC2 web
// build (tools/build-live-dc-bundle.mjs) passes its own clean environment and skips the .env files.
if (!process.env.LIVE_DC_WEB_BUILD) loadServerEnv();
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createLiveEventsApi, createSnapshotApi } from "./server/api.mjs";

const cesiumBuildRootPath = join(dirname(createRequire(import.meta.url).resolve("cesium/package.json")), "Build");

// FL511 is never called from the browser. Mounting the live-events API inside the dev server keeps
// it same-origin for `npm start` and the e2e suite without a second process; deployments that serve
// the map statically run the identical handler from server/index.mjs instead.
const liveEventsApi = api => ({
  name: "i595-live-events-api",
  configureServer(server) {
    server.middlewares.use(api.middleware);
    server.httpServer?.on("close", () => { void api.stop(); });
  },
  configurePreviewServer(server) { server.middlewares.use(api.middleware); },
});

// Ask the Twin, same-origin and streaming, with the orchestrator the EC2 service runs. Dev only: the
// key comes from ANTHROPIC_API_KEY in .env.local (or ASK_TWIN_REPLAY for recorded answers), never a
// VITE_ variable, so it cannot reach the browser bundle. Imported lazily: a build never loads it, and
// a Node without node:sqlite (< 22.5) still runs the map, with a note instead of the route.
const ASK_SERVICE_URL = String(process.env.ASK_TWIN_SERVICE_URL ?? '').trim();
const askApi = (liveEvents, liveDc, historical) => ({
  name: "i595-ask-the-twin-api",
  async configureServer(server) {
    // ASK_TWIN_SERVICE_URL hands the route to a separately running `npm run ask:serve` (the process
    // EC2 will run), proxied by server.proxy below, so the service is verified with the real map.
    if (ASK_SERVICE_URL) {
      console.log(`ask-the-twin (local): proxied to ${ASK_SERVICE_URL}`);
      return;
    }
    try {
      const { createLocalAsk } = await import("./server/ask/localAsk.mjs");
      const ask = createLocalAsk({
        // The events the map shows: the DataConnect Live Events class when configured, else FL511 direct.
        getLiveEvents: async () => (await liveEvents.dataConnectEvents().catch(() => null)) ?? liveEvents.fl511Events().catch(() => null),
        // The same DataConnect read clients the map uses keep the twin store current (read-only).
        liveDc, historical,
      });
      server.middlewares.use(ask.middleware);
      // The browser only asks this route when VITE_ASK_THE_TWIN_API is unset; a leftover value in .env
      // silently sends every question to the deployed service instead.
      const remote = String(process.env.VITE_ASK_THE_TWIN_API ?? '').trim();
      if (remote) console.warn(`ask-the-twin (local): VITE_ASK_THE_TWIN_API=${remote} is set, so the page asks that service, not this one. Remove it from .env to use the local orchestrator.`);
    } catch (error) {
      console.warn(`ask-the-twin (local): not mounted (${error.message}). It needs Node >= 22.5 for node:sqlite.`);
    }
  },
});

// FL511 message sign markers and details stay same-origin.
const messageSignsApi = () => {
  const api = createMessageSignsApi();
  return { name: 'i595-message-signs-api',
    configureServer(server) { server.middlewares.use(api.middleware); },
    configurePreviewServer(server) { server.middlewares.use(api.middleware); },
  };
};

// DataConnect, same-origin. The credentials and the token stay on this side: DC_* variables are
// deliberately NOT VITE_-prefixed, so they are never compiled into the browser bundle.
const dataConnectApi = api => {
  return { name: 'i595-dataconnect-api',
    configureServer(server) { server.middlewares.use(api.middleware); },
    configurePreviewServer(server) { server.middlewares.use(api.middleware); },
  };
};

// Live DataConnect classes, read-only and same-origin (LIVE_DC_READ_BASE_URL; unset = not configured).
const liveDcReadApi = api => ({ name: 'i595-live-dc-read-api',
  configureServer(server) { server.middlewares.use(api.middleware); },
  configurePreviewServer(server) { server.middlewares.use(api.middleware); },
});

// CCTV snapshot proxy — pipes DIVAS JPEG bytes through same-origin to avoid CORS issues.
const snapshotApi = () => {
  const api = createSnapshotApi();
  return {
    name: "i595-snapshot-api",
    configureServer(server) { server.middlewares.use(api.middleware); },
    configurePreviewServer(server) { server.middlewares.use(api.middleware); },
  };
};

// One read proxy serves both /api/live-dc/* and ?source=dataconnect, as in server/index.mjs.
const liveDc = createLiveDcReadApi();
const liveEvents = createLiveEventsApi({ liveDc });
// One historical DataConnect client (one token) for the /api/dataconnect proxy and the twin store refresh.
const historicalDc = createDataConnectApi();

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
export default defineConfig({
  // Under GitHub Pages the toll twin is served from a sub-path (/acs-demo/twin/). The deploy
  // workflow sets CESIUM_BASE_PATH (POC_BASE_PATH kept as an alias for older scripts); local dev
  // leaves both unset → "/" so npm start and the Playwright e2e suite are unaffected. All runtime
  // asset URLs resolve against import.meta.env.BASE_URL so data/ and models/ load under either base.
  base: process.env.CESIUM_BASE_PATH || process.env.POC_BASE_PATH || "/",
  build: { target: 'esnext' },
  // The Asset Explorer is a React island inside an otherwise framework-free app. esbuild's
  // automatic runtime is enough for it — no fast-refresh plugin, so the rest of the app's plain
  // HMR is untouched.
  esbuild: { jsx: 'automatic' },
  plugins: [cesium({ cesiumBuildRootPath, cesiumBuildPath: join(cesiumBuildRootPath, "Cesium") }), liveEventsApi(liveEvents), askApi(liveEvents, liveDc, historicalDc), snapshotApi(), messageSignsApi(), dataConnectApi(historicalDc), liveDcReadApi(liveDc)],
  // Port 5188 (not the default 5180) keeps this NTTA worktree isolated from a sibling session's
  // dev server sharing localhost. Disable auto-open under headless e2e.
  server: { port: 5188, open: false, strictPort: true,
    ...(ASK_SERVICE_URL ? { proxy: { '/api/i595/ask': { target: ASK_SERVICE_URL, changeOrigin: true } } } : {}) },
});
