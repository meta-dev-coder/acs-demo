import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
export default defineConfig({
  // Under GitHub Pages the toll twin is served from a sub-path (/acs-demo/twin/). CESIUM_BASE_PATH is
  // set by the deploy workflow; local dev leaves it unset → "/". All runtime asset URLs are resolved
  // against import.meta.env.BASE_URL so data/ and models/ load correctly under either base.
  base: process.env.CESIUM_BASE_PATH || "/",
  plugins: [cesium()],
  // Port 5188 (not the default 5180) keeps this NTTA worktree isolated from a sibling session's
  // dev server sharing localhost. Disable auto-open under headless e2e.
  server: { port: 5188, open: false, strictPort: true },
});
