import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compareDerivedFiles, type DerivedRow } from "../../scripts/gate-derived.js";

const dir = mkdtempSync(join(tmpdir(), "gate-derived-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function row(url: string, over: Partial<DerivedRow> = {}): DerivedRow {
  return {
    url, clickDepth: 1, inlinksInternal: 3, outlinksInternal: 4, outlinksExternal: 1,
    linkScoreRaw: 0.123456789, linkScore: 42, ...over,
  };
}
function write(name: string, rows: DerivedRow[]): string {
  const path = join(dir, name);
  writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return path;
}

describe("compareDerivedFiles", () => {
  const base = [row("https://a.test/1"), row("https://a.test/2"), row("https://a.test/3")];

  it("passes equal files", async () => {
    const r = await compareDerivedFiles(write("eq-a", base), write("eq-b", base));
    expect(r.total).toBe(0);
    expect(r.rows).toEqual({ a: 3, b: 3 });
  });

  it("fails a click-depth difference of one", async () => {
    const changed = [base[0]!, row("https://a.test/2", { clickDepth: 2 }), base[2]!];
    const r = await compareDerivedFiles(write("d-a", base), write("d-b", changed));
    expect(r.total).toBe(1);
    expect(r.differences[0]).toContain("clickDepth");
  });

  it("passes a raw-score difference of 1e-12 relative and fails 1e-6", async () => {
    const tiny = [row("https://a.test/1", { linkScoreRaw: 0.123456789 * (1 + 1e-12) })];
    expect((await compareDerivedFiles(write("t-a", [base[0]!]), write("t-b", tiny))).total).toBe(0);
    const big = [row("https://a.test/1", { linkScoreRaw: 0.123456789 * (1 + 1e-6) })];
    expect((await compareDerivedFiles(write("g-a", [base[0]!]), write("g-b", big))).total).toBe(1);
  });

  it("treats null as equal to null and different from a number, including 0", async () => {
    const n = [row("https://a.test/1", { linkScoreRaw: null })];
    const z = [row("https://a.test/1", { linkScoreRaw: 0 })];
    expect((await compareDerivedFiles(write("n-a", n), write("n-b", n))).total).toBe(0);
    expect((await compareDerivedFiles(write("n2-a", n), write("n2-b", z))).total).toBe(1);
    expect((await compareDerivedFiles(write("z-a", z), write("z-b", z))).total).toBe(0);
  });

  it("reports rows present in only one file and lists at most 20 differences", async () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`https://a.test/p${String(i).padStart(2, "0")}`));
    const changed = many.map((r) => ({ ...r, inlinksInternal: 99 }));
    const r = await compareDerivedFiles(write("m-a", many), write("m-b", changed));
    expect(r.total).toBe(30);
    expect(r.differences).toHaveLength(20);
    const only = await compareDerivedFiles(write("o-a", base), write("o-b", base.slice(0, 2)));
    expect(only.total).toBe(1);
    expect(only.differences[0]).toContain("only in");
  });

  it("throws on an out-of-order file rather than comparing it", async () => {
    const reversed = [...base].reverse();
    await expect(compareDerivedFiles(write("s-a", base), write("s-b", reversed))).rejects.toThrow(/sorted/);
  });
});
