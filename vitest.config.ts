import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-prime-agent",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    silent: "passed-only",
    setupFiles: ["./vitest.setup.ts"],
  },
});
