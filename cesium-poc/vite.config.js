import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
// base: override via POC_BASE_PATH for GitHub Pages sub-path deploys (e.g. "/acs-demo/twin/").
// Defaults to "/" so local dev (npm start) and the Playwright e2e suite are unaffected.
export default defineConfig({
  base: process.env.POC_BASE_PATH || "/",
  plugins: [cesium()],
  server: { port: 5180, open: true },
});
