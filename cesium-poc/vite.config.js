import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
export default defineConfig({
  plugins: [cesium()],
  // Port 5188 (not the default 5180) keeps this NTTA worktree isolated from a sibling session's
  // dev server sharing localhost. Disable auto-open under headless e2e.
  server: { port: 5188, open: false, strictPort: true },
});
