import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

const ENV_PREFIX = "IMJS_";

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    // For GitHub Pages project sites the app is served under /<repo>/. The deploy workflow
    // sets IMJS_BASE_PATH=/acs-demo/. Local dev leaves it unset -> "/".
    base: process.env.IMJS_BASE_PATH || "/",
    build: {
      chunkSizeWarningLimit: 8000, // Increase chunk size warning limit to avoid warnings for large chunks
    },
    plugins: [
      react(),
      // Wires CESIUM_BASE_URL + copies Cesium's static assets (Workers/Assets/Widgets), same as
      // cesium-poc. rebuildCesium is REQUIRED here (unlike cesium-poc): the default mode injects
      // a synchronous <script src="cesium/Cesium.js"> into index.html — every tab would pay the
      // full Cesium download up front. Rebuilding routes cesium through Rollup instead, so it
      // lands in the lazy-loaded A′ CesiumView chunk and tabs A–D pay no bundle cost.
      cesium({ rebuildCesium: true }),
      viteStaticCopy({
        targets: [
          {
            // copy assets from `@itwin` dependencies
            src: "./node_modules/**/@itwin/*/lib/public/*",
            dest: ".",
          },
        ],
      }),
    ],
    server: {
      port: 3000,
      strictPort: true,
      open: true
    },
    resolve: {
      alias: [
        {
          // Resolve SASS tilde imports.
          find: /^~(.*)$/,
          replacement: "$1",
        },
      ],
    },
    envPrefix: ENV_PREFIX
  };
});