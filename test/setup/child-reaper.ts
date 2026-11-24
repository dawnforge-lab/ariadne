/**
 * Vitest `globalSetup`: no process a test spawns outlives the run.
 *
 * Setup makes a temp dir and hands it to every test worker through
 * `ARIADNE_TEST_PID_DIR`. A test that spawns a long-lived child calls
 * `registerTestChild`, which writes `<pid>` into that dir and removes it when
 * the child exits. Teardown kills every pid still listed and still alive, so a
 * test that times out, throws before its `kill`, or whose worker is killed
 * cannot leave a `src/worker/serve.ts` behind.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PID_DIR_ENV = "ARIADNE_TEST_PID_DIR";

function pidDir(): string {
  const dir = process.env[PID_DIR_ENV];
  if (dir === undefined || dir === "") {
    throw new Error(`${PID_DIR_ENV} is not set: test/setup/child-reaper.ts must be vitest's globalSetup (vitest.config.ts)`);
  }
  return dir;
}

/** Record a test-spawned child so teardown can kill it if the test does not. */
export function registerTestChild(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) throw new Error("registerTestChild: the child has no pid (it failed to spawn)");
  const file = join(pidDir(), String(pid));
  writeFileSync(file, String(pid));
  proc.once("exit", () => rmSync(file, { force: true }));
}

/** SIGKILL every pid listed in `dir` that is still alive. Returns the pids killed. */
export function reapChildren(dir: string): number[] {
  const killed: number[] = [];
  for (const name of readdirSync(dir)) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${dir}: unexpected entry "${name}" (not a pid)`);
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  return killed;
}

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "ariadne-test-pids-"));
  process.env[PID_DIR_ENV] = dir;
  return () => {
    const killed = reapChildren(dir);
    rmSync(dir, { recursive: true, force: true });
    if (killed.length > 0) {
      console.error(`child-reaper: killed ${killed.length} test child(ren) a test left running: ${killed.join(", ")}`);
    }
  };
}
