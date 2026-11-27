import { loadServerEnv } from './server/loadEnv.mjs';
import { createMessageSignsApi } from './server/messageSigns.mjs';
import { createDataConnectApi } from './server/dataConnect.mjs';
import { createLiveDcReadApi } from './server/liveDc/liveReadApi.mjs';
import { createConstructionApi } from './server/construction/api.mjs';
import { createApsApi } from './server/aps/api.mjs';
import { createIfcSpatialApi } from './server/ifcSpatial/api.mjs';
import { createGmailApi } from './server/gmail/api.mjs';
import { createInterpretApi } from './server/ifcSpatial/interpret.mjs';

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

// The Construction Integration Demo's own API and SQLite database. Same-origin, same factory
// shape as the others, and entirely separate from I-595: its own tables in its own file, under
// /api/construction/*. It is deliberately NOT in readApiHandlers.mjs — that module is shared with
// the EC2 live-dc host, which has no business carrying this project.
const constructionApi = () => {
  const api = createConstructionApi();
  // Phase 8B: the OpenProject poller starts with the dev server and stops with it. `startAutoSync`
  // is a no-op unless OPENPROJECT_AUTO_SYNC_ENABLED=true, and the worker is a process-wide
  // singleton, so a reloaded module graph finds the running one instead of arming a second timer.
  const start = () => { void api.startAutoSync(); };
  return { name: 'construction-integration-api',
    configureServer(server) {
      server.middlewares.use(api.middleware);
      start();
      server.httpServer?.on('close', () => { void api.close(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use(api.middleware);
      start();
      server.httpServer?.on('close', () => { void api.close(); });
    },
  };
};

// Autodesk Platform Services sign-in (three-legged OAuth, PKCE) and the Forma project lookup,
// same-origin under /api/aps/*. APS_CLIENT_ID / APS_CLIENT_SECRET / APS_CALLBACK_URL are not
// VITE_-prefixed and the tokens live in this process, so neither ever reaches the browser bundle.
// Unconfigured, every route answers with what is missing and the rest of the app is unaffected.
// The IFC Spatial Twin's routes (/api/ifc-spatial/*) use the same APS instance, so the same session
// downloads the IFC files; converted geometry is cached under .data/ifc-spatial/ (git-ignored).
const apsApi = aps => {
  const api = { middleware: (req, res, next) => aps.middleware(req, res, () => interpret.middleware(req, res, () => ifcSpatial.middleware(req, res, () => gmail.middleware(req, res, next)))) };
  const ifcSpatial = createIfcSpatialApi({ aps });
  // Seagirt Ask the Twin: questions its rules did not understand, read by Claude (off unless SEAGIRT_ASK_LLM=on).
  // Before the IFC Spatial routes, which answer every other /api/ifc-spatial/* path.
  const interpret = createInterpretApi({});
  // Sending a report's email through the user's Gmail (server/gmail/): its own Google sign-in, independent of APS.
  const gmail = createGmailApi({ reports: ifcSpatial.reportAccess });
  return { name: 'aps-oauth-api',
    configureServer(server) { server.middlewares.use(api.middleware); },
    configurePreviewServer(server) { server.middlewares.use(api.middleware); },
  };
};

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
  // Upstream's wiring (liveEvents, askApi, historicalDc) plus this branch's constructionApi.
  // The incoming side still called liveEventsApi(liveDc) and dataConnectApi() with no argument,
  // which predates the shared clients created above; those signatures are the ones to keep.
  plugins: [cesium({ cesiumBuildRootPath, cesiumBuildPath: join(cesiumBuildRootPath, "Cesium") }), liveEventsApi(liveEvents), askApi(liveEvents, liveDc, historicalDc), snapshotApi(), messageSignsApi(), dataConnectApi(historicalDc), liveDcReadApi(liveDc), constructionApi(), apsApi(createApsApi())],
  // Port 5188 (not the default 5180) keeps this NTTA worktree isolated from a sibling session's
  // dev server sharing localhost. Disable auto-open under headless e2e.
  server: { port: 5188, open: false, strictPort: true,
    ...(ASK_SERVICE_URL ? { proxy: { '/api/i595/ask': { target: ASK_SERVICE_URL, changeOrigin: true } } } : {}) },
});
