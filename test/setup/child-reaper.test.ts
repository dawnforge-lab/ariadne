import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNoStrayServe, reapAndReport, reapChildren, registerTestChild } from "./child-reaper.js";

// A PRIVATE pid dir: reaping the suite's shared one would SIGKILL other files' children.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ariadne-reaper-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
};

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe("child reaper", () => {
  it("registerTestChild writes the pid and removes it when the child exits", async () => {
    const proc = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    registerTestChild(proc, dir);
    const file = join(dir, String(proc.pid));
    expect(existsSync(file)).toBe(true);
    await exited;
    expect(existsSync(file)).toBe(false);
  });

  it("teardown kills a registered child that is still alive", async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const pid = proc.pid as number;
    registerTestChild(proc, dir);
    expect(alive(pid)).toBe(true);
    const killed = reapChildren(dir);
    expect(killed.map((k) => k.pid)).toContain(pid);
    await waitDead(pid);
    expect(alive(pid)).toBe(false);
  });

  it("the end-of-run report throws, naming the pid, when it had to kill a child", async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const pid = proc.pid as number;
    registerTestChild(proc, dir);
    expect(() => reapAndReport(dir)).toThrow(new RegExp(`still alive at the end of the run.*${pid}`));
    await waitDead(pid);
    expect(alive(pid)).toBe(false);
  });

  it("the end-of-run report is silent when every child already exited", () => {
    expect(() => reapAndReport(dir)).not.toThrow();
  });

  it("a stray non-pid entry throws loudly", () => {
    writeFileSync(join(dir, "not-a-pid"), "");
    try {
      expect(() => reapChildren(dir)).toThrow(/not a pid/);
    } finally {
      rmSync(join(dir, "not-a-pid"));
    }
  });

  it("assertNoStrayServe throws, naming the pid, while a src/worker/serve.ts process of this checkout is alive", async () => {
    // Unregistered on purpose: the check must catch what the registry never saw.
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "src/worker/serve.ts"], { stdio: "ignore", cwd: process.cwd() });
    const pid = proc.pid as number;
    try {
      expect(() => assertNoStrayServe()).toThrow(new RegExp(`src/worker/serve.ts still alive after the suite.*${pid}`));
    } finally {
      proc.kill("SIGKILL");
      await waitDead(pid);
    }
  });

  it("assertNoStrayServe throws, naming the missing /proc, on a platform without one (never reads ENOENT as exited)", () => {
    const missing = join(dir, "no-proc-here");
    expect(() => assertNoStrayServe(missing)).toThrow(new RegExp(`${missing}/self.*cannot tell`));
  });
});
