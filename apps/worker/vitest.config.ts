import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native PostgreSQL suites share an intentionally small test database.  Keep
    // files serial while each suite still issues its own explicit race requests.
    fileParallelism: process.env["NATIVE_POSTGRES_TESTS"] !== "true",
  },
});
