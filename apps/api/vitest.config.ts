import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native suites deliberately share one PostgreSQL database. Their own tests retain
    // request-level races, but separate test files must not concurrently truncate each
    // other's fixtures when NATIVE_POSTGRES_TESTS is enabled in CI.
    fileParallelism: process.env.NATIVE_POSTGRES_TESTS !== "true",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
