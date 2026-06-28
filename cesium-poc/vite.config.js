import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

// vite-plugin-cesium wires up CESIUM_BASE_URL + static asset copying for us.
export default defineConfig({
  plugins: [cesium()],
  server: { port: 5180, open: true },
});
