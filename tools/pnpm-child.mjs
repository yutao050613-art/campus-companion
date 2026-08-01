import { spawnSync } from "node:child_process";

const safeArgument = /^[A-Za-z0-9@/.,_:=+-]+$/u;

export function createPnpmInvocation(
  args,
  platform = process.platform,
  comSpec = process.env.ComSpec,
) {
  if (!args.every((argument) => safeArgument.test(argument))) {
    throw new Error("unsafe pnpm argument rejected");
  }

  if (platform === "win32") {
    return {
      command: comSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", ["pnpm", ...args].join(" ")],
    };
  }

  return { command: "pnpm", args: [...args] };
}

/**
 * Execute pnpm without Node's `shell: true` fallback. Windows needs cmd.exe
 * for its .cmd shim; POSIX runners execute pnpm directly. Arguments are
 * allowlisted before they enter either child-process invocation.
 */
export function runPnpm(args, environment, options = {}) {
  const invocation = createPnpmInvocation(
    args,
    options.platform ?? process.platform,
    options.comSpec ?? process.env.ComSpec,
  );
  const result = (options.spawn ?? spawnSync)(invocation.command, invocation.args, {
    cwd: options.cwd ?? process.cwd(),
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}
