import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

function entrypoint(command: string, heap: string | undefined) {
  const env: Record<string, string | undefined> = { PATH: process.env["PATH"] };
  if (heap !== undefined) env["ARIADNE_HEAP_MB"] = heap;
  return spawnSync("sh", ["docker-entrypoint.sh", command], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
}

describe("docker-entrypoint.sh heap cap", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    ["abc", "abc"],
    ["0", "0"],
  ])("ARIADNE_HEAP_MB=%j exits 64 before any node starts", (heap, shown) => {
    for (const command of ["api", "worker", "migrate"]) {
      const ran = entrypoint(command, heap);
      expect(ran.status).toBe(64);
      expect(ran.stderr).toContain(`ariadne: ARIADNE_HEAP_MB must be a positive whole number (MB), got '${shown}'`);
    }
  });

  it("still names an unknown command, with a valid cap", () => {
    const ran = entrypoint("bogus", "384");
    expect(ran.status).toBe(64);
    expect(ran.stderr).toContain("ariadne: unknown command 'bogus'");
  });
});
