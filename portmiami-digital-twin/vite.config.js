import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createLiveTrafficApi } from './server/portmiami/api.mjs';

// Same wiring as the ACS project: vite-plugin-cesium copies Cesium's Workers/Assets/Widgets out of
// the installed package and sets CESIUM_BASE_URL. Resolved through createRequire so it finds THIS
// project's own cesium, not a hoisted one.
const cesiumBuildRootPath = join(dirname(createRequire(import.meta.url).resolve('cesium/package.json')), 'Build');

/**
 * FL511 is never called from the browser. Mounting the live-traffic API inside the dev server keeps
 * the page same-origin, and keeps ONE poller serving every viewer instead of one per open tab. The
 * service is created on the first request, so `npm run dev` contacts FL511 only once the Live
 * Traffic layer asks for data. `server/index.mjs` mounts the identical handlers for production.
 */
const liveTraffic = createLiveTrafficApi();

const liveTrafficPlugin = {
  name: 'portmiami-live-traffic-api',
  configureServer(server) { server.middlewares.use(liveTraffic.middleware); },
  configurePreviewServer(server) { server.middlewares.use(liveTraffic.middleware); },
};

export default defineConfig({
  plugins: [
    react(),
    cesium({ cesiumBuildRootPath, cesiumBuildPath: join(cesiumBuildRootPath, 'Cesium') }),
    liveTrafficPlugin,
  ],
  build: { target: 'esnext' },
  // 5200, because the ACS dev server owns 5188 and the repository root owns 5180. strictPort so a
  // clash fails loudly instead of silently moving the app to another port mid-demo.
  server: { port: 5200, open: false, strictPort: true },
});
