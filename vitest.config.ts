import { defineConfig } from "vitest/config";

// Pure-logic unit tests (placement geometry + risk scoring). Node environment — no DOM/auth/model.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
