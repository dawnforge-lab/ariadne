/**
 * Vitest `globalSetup`: no process a test spawns outlives the run, and a run
 * that leaves one behind FAILS.
 *
 * Setup makes a temp dir and hands it to every test worker through
 * `ARIADNE_TEST_PID_DIR`. A test that spawns a long-lived child calls
 * `registerTestChild`, which writes `<pid>` into that dir and removes it when
 * the child exits. Teardown kills every pid still listed and still alive, then
 * throws naming them (a child still alive at the end is a test that did not
 * clean up), then throws if any `src/worker/serve.ts` process of this checkout
 * is still alive whether or not it was registered.
 */
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PID_DIR_ENV = "ARIADNE_TEST_PID_DIR";
const SERVE_PATTERN = "src/worker/serve.ts";

export interface ReapedChild {
  pid: number;
  command: string;
}

function pidDir(): string {
  const dir = process.env[PID_DIR_ENV];
  if (dir === undefined || dir === "") {
    throw new Error(`${PID_DIR_ENV} is not set: test/setup/child-reaper.ts must be vitest's globalSetup (vitest.config.ts)`);
  }
  return dir;
}

/** The process's command line, or an explicit note that it could not be read. */
function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch (err) {
    return `(command unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
}

/**
 * Record a test-spawned child so teardown can kill it if the test does not.
 * `dir` defaults to the suite's shared pid dir; a test of the reaper itself
 * passes a private one so it never touches other files' children.
 */
export function registerTestChild(proc: ChildProcess, dir: string = pidDir()): void {
  const pid = proc.pid;
  if (pid === undefined) throw new Error("registerTestChild: the child has no pid (it failed to spawn)");
  const file = join(dir, String(pid));
  writeFileSync(file, String(pid));
  proc.once("exit", () => rmSync(file, { force: true }));
}

/** SIGKILL every pid listed in `dir` that is still alive. Returns what was killed. */
export function reapChildren(dir: string): ReapedChild[] {
  const killed: ReapedChild[] = [];
  for (const name of readdirSync(dir)) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${dir}: unexpected entry "${name}" (not a pid)`);
    const command = commandOf(pid);
    try {
      process.kill(pid, "SIGKILL");
      killed.push({ pid, command });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  return killed;
}

/** Reap `dir`, then throw if anything had to be killed. The throw is the failure of the run. */
export function reapAndReport(dir: string): void {
  const killed = reapChildren(dir);
  if (killed.length > 0) {
    throw new Error(
      `${killed.length} test child process(es) were still alive at the end of the run and were killed: ` +
        killed.map((k) => `${k.pid} [${k.command}]`).join("; "),
    );
  }
}

/** Throw if a `src/worker/serve.ts` process started from this checkout is alive (registered or not). */
export function assertNoStrayServe(): void {
  let out: string;
  try {
    out = execFileSync("pgrep", ["-f", SERVE_PATTERN], { encoding: "utf8" });
  } catch (err) {
    // pgrep exits 1 when nothing matches; any other failure is a real error.
    if ((err as { status?: number }).status === 1) return;
    throw err;
  }
  const here = process.cwd();
  const stray = out
    .split("\n")
    .filter((l) => l !== "")
    .map(Number)
    .filter((pid) => {
      try {
        return readlinkSync(`/proc/${pid}/cwd`) === here;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // exited since pgrep
        throw err;
      }
    });
  if (stray.length > 0) {
    throw new Error(`${SERVE_PATTERN} still alive after the suite: ${stray.map((pid) => `${pid} [${commandOf(pid)}]`).join("; ")}`);
  }
}

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "ariadne-test-pids-"));
  process.env[PID_DIR_ENV] = dir;
  return () => {
    try {
      reapAndReport(dir);
      assertNoStrayServe();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
