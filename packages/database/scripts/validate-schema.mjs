import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prismaEntrypoint = require.resolve("prisma/build/index.js");
const validationEnvironment = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://schema_validation:non_secret@127.0.0.1:5432/schema_validation?schema=public",
};

const result = spawnSync(process.execPath, [prismaEntrypoint, "validate"], {
  cwd: new URL("..", import.meta.url),
  env: validationEnvironment,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
