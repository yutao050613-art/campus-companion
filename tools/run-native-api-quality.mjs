import { runPnpm } from "./pnpm-child.mjs";

// PostgreSQL-native test files deliberately share one database.  The root
// quality gate has already completed the parallel non-native pass, so this
// second phase is serial and can enforce the API's 80% integration threshold.
if (process.env.NATIVE_POSTGRES_TESTS !== "true") {
  process.stdout.write("Skipping native API quality: NATIVE_POSTGRES_TESTS is not true.\n");
  process.exit(0);
}

process.exitCode = runPnpm(["--filter", "@campus/api", ...process.argv.slice(2)], {
  ...process.env,
  NATIVE_POSTGRES_TESTS: "true",
  COVERAGE_ENFORCEMENT: "true",
});
