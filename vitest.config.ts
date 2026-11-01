import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Network tests only run with LIVE=1 (pnpm test:live).
    exclude: process.env.LIVE === "1" ? [] : ["test/live/**"],
    typecheck: { include: ["test/**/*.test-d.ts"] },
  },
});
