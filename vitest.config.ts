import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-prime-agent",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
    silent: "passed-only",
    setupFiles: ["./vitest.setup.ts"],
  },
});
