import { runPnpm } from "./pnpm-child.mjs";

process.exitCode = runPnpm(process.argv.slice(2), {
  ...process.env,
  NATIVE_POSTGRES_TESTS: "false",
  NATIVE_REDIS_TESTS: "false",
  COVERAGE_ENFORCEMENT: "false",
});
