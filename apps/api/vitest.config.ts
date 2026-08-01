import { defineConfig } from "vitest/config";

const coverageThresholds = {
  statements: 80,
  branches: 80,
  functions: 80,
  lines: 80,
};

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
      // The root runner first executes non-native packages in parallel, then
      // runs this API suite with PostgreSQL serially.  Enforcement belongs to
      // the latter run, where the integration coverage is actually present.
      thresholds: process.env["COVERAGE_ENFORCEMENT"] === "false" ? undefined : coverageThresholds,
    },
  },
});
