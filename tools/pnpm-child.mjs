import { spawnSync } from "node:child_process";

const safeArgument = /^[A-Za-z0-9@/.,_:=+-]+$/u;

/**
 * Execute pnpm without Node's `shell: true` fallback for Windows .cmd files.
 * Arguments are deliberately allowlisted before they are placed in cmd.exe's
 * command string, so this helper cannot turn a test selector into shell input.
 */
export function runPnpm(args, environment) {
  if (!args.every((argument) => safeArgument.test(argument))) {
    throw new Error("unsafe pnpm argument rejected");
  }
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", ["pnpm", ...args].join(" ")],
    {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: "inherit",
    },
  );
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}
