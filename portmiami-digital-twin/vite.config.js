import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Same wiring as the ACS project: vite-plugin-cesium copies Cesium's Workers/Assets/Widgets out of
// the installed package and sets CESIUM_BASE_URL. Resolved through createRequire so it finds THIS
// project's own cesium, not a hoisted one.
const cesiumBuildRootPath = join(dirname(createRequire(import.meta.url).resolve('cesium/package.json')), 'Build');

export default defineConfig({
  plugins: [
    react(),
    cesium({ cesiumBuildRootPath, cesiumBuildPath: join(cesiumBuildRootPath, 'Cesium') }),
  ],
  build: { target: 'esnext' },
  // 5200, because the ACS dev server owns 5188 and the repository root owns 5180. strictPort so a
  // clash fails loudly instead of silently moving the app to another port mid-demo.
  server: { port: 5200, open: false, strictPort: true },
});
