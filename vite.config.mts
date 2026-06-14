import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import react from "@vitejs/plugin-react";

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