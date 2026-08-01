import assert from "node:assert/strict";
import test from "node:test";

import { createPnpmInvocation, runPnpm } from "./pnpm-child.mjs";

test("uses the Windows command interpreter only for the Windows pnpm shim", () => {
  assert.deepEqual(
    createPnpmInvocation(["-r", "--if-present", "test"], "win32", "C:/Windows/System32/cmd.exe"),
    {
      command: "C:/Windows/System32/cmd.exe",
      args: ["/d", "/s", "/c", "pnpm -r --if-present test"],
    },
  );
});

test("executes pnpm directly on POSIX runners", () => {
  assert.deepEqual(createPnpmInvocation(["-r", "--if-present", "test"], "linux"), {
    command: "pnpm",
    args: ["-r", "--if-present", "test"],
  });
});

test("keeps child-process execution shell-free and returns the child status", () => {
  const calls = [];
  const status = runPnpm(
    ["--filter", "@campus/api", "test"],
    { CI: "true" },
    {
      platform: "darwin",
      cwd: "/tmp/campus-companion",
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 7 };
      },
    },
  );

  assert.equal(status, 7);
  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: ["--filter", "@campus/api", "test"],
      options: {
        cwd: "/tmp/campus-companion",
        env: { CI: "true" },
        shell: false,
        stdio: "inherit",
      },
    },
  ]);
});

test("rejects shell-control input before a child process is created", () => {
  assert.throws(
    () => createPnpmInvocation(["test;whoami"], "linux"),
    /unsafe pnpm argument rejected/u,
  );
});
