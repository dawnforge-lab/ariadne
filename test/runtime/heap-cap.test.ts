import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { assertHeapCap, HEAP_CAP_ENV, parseHeapCapMb, YOUNG_GENERATION_ALLOWANCE_MB } from "../../src/runtime/heap-cap.js";

const MIB = 1024 * 1024;
const ROOT = join(import.meta.dirname, "../..");

describe("parseHeapCapMb", () => {
  it.each([[undefined], [""], ["384MB"], ["0"], ["-1"], [" 384"], ["3.5"]])("throws on %j, naming ARIADNE_HEAP_MB", (raw) => {
    expect(() => parseHeapCapMb(raw)).toThrow(HEAP_CAP_ENV);
  });

  it("quotes a malformed value, truncated to 40 characters", () => {
    expect(() => parseHeapCapMb("x".repeat(60))).toThrow(JSON.stringify("x".repeat(40)));
  });

  it("returns a plain positive integer", () => {
    expect(parseHeapCapMb("384")).toBe(384);
  });
});

describe("assertHeapCap", () => {
  const env = { [HEAP_CAP_ENV]: "384" };

  it("passes when the limit is the cap plus the young generation, and returns the cap", () => {
    expect(assertHeapCap(env, 432 * MIB)).toBe(384);
  });

  it("throws on V8's default limit, telling the operator the flag", () => {
    expect(() => assertHeapCap(env, 4144 * MIB)).toThrow("--max-old-space-size=384");
  });

  it("throws on a limit below the cap", () => {
    expect(() => assertHeapCap(env, 300 * MIB)).toThrow(/V8 heap limit is 300 MB/);
  });

  it("throws at exactly cap + the allowance", () => {
    expect(() => assertHeapCap(env, (384 + YOUNG_GENERATION_ALLOWANCE_MB) * MIB)).toThrow(HEAP_CAP_ENV);
  });

  it("throws when the variable is unset", () => {
    expect(() => assertHeapCap({}, 432 * MIB)).toThrow(HEAP_CAP_ENV);
  });
});

describe("assertHeapCap against the real V8", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ariadne-heap-cap-"));
  const probe = join(scratch, "probe.ts");
  writeFileSync(
    probe,
    `import { assertHeapCap } from ${JSON.stringify(join(ROOT, "src/runtime/heap-cap.ts"))};\nconsole.log(assertHeapCap());\n`,
  );
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const run = (flags: string[]) =>
    spawnSync(process.execPath, [...flags, "--import", "tsx", probe], {
      cwd: ROOT,
      env: { PATH: process.env["PATH"], [HEAP_CAP_ENV]: "200" },
      encoding: "utf8",
    });

  it("exits 0 when started with the flag", () => {
    const ran = run(["--max-old-space-size=200"]);
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("200");
  });

  it("exits non-zero, with the message on stderr, without the flag", () => {
    const ran = run([]);
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("--max-old-space-size=200");
  });
});
