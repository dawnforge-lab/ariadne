import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

describe("docker-entrypoint.sh success path", () => {
  const bin = mkdtempSync(join(tmpdir(), "ariadne-fake-node-"));
  writeFileSync(join(bin, "node"), '#!/bin/sh\necho "node $*"\n');
  chmodSync(join(bin, "node"), 0o755);
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  it.each([
    ["api", "src/api/serve.ts"],
    ["worker", "src/worker/serve.ts"],
    ["migrate", "src/db/migrate.ts"],
  ])("%s execs node with the cap, tsx and %s", (command, file) => {
    const ran = spawnSync("sh", ["docker-entrypoint.sh", command], {
      cwd: ROOT,
      env: { PATH: `${bin}:${process.env["PATH"]}`, ARIADNE_HEAP_MB: "384" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(`node --max-old-space-size=384 --import tsx ${file}`);
  });
});
