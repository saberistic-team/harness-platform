import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@harness/events": fileURLToPath(
        new URL("../../packages/events/src/index.ts", import.meta.url),
      ),
      "@harness/policy": fileURLToPath(
        new URL("../../packages/policy/src/index.ts", import.meta.url),
      ),
      "@harness/sdk": fileURLToPath(
        new URL("../../packages/sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
