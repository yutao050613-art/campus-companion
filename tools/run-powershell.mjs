#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const scriptArguments = process.argv.slice(2);

if (scriptArguments.length === 0) {
  console.error("A PowerShell script path is required.");
  process.exit(2);
}

const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellArguments = ["-NoLogo", "-NoProfile", "-NonInteractive"];

if (process.platform === "win32") {
  powerShellArguments.push("-ExecutionPolicy", "Bypass");
}

powerShellArguments.push("-File", ...scriptArguments);

const result = spawnSync(executable, powerShellArguments, {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Unable to start ${executable}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
