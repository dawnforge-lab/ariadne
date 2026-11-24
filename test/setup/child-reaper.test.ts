import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PID_DIR_ENV, reapChildren, registerTestChild } from "./child-reaper.js";

const pidFile = (pid: number): string => join(process.env[PID_DIR_ENV] as string, String(pid));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
};

describe("child reaper", () => {
  it("registerTestChild writes the pid and removes it when the child exits", async () => {
    const proc = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    registerTestChild(proc);
    expect(existsSync(pidFile(proc.pid as number))).toBe(true);
    await exited;
    expect(existsSync(pidFile(proc.pid as number))).toBe(false);
  });

  it("teardown kills a registered child that is still alive", async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const pid = proc.pid as number;
    registerTestChild(proc);
    expect(alive(pid)).toBe(true);
    reapChildren(process.env[PID_DIR_ENV] as string);
    const deadline = Date.now() + 2_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(alive(pid)).toBe(false);
  });
});
