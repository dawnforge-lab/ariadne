/**
 * The threshold guard (Phase 27a T3).
 *
 * A crawl's threshold overrides take effect only if every rule reads its
 * thresholds from the run's `JudgementContext` (`judgementOr(ctx).thresholds.NAME`).
 * A rule that still imports `TITLE_MAX` from `thresholds.ts` would compile, pass
 * every default-value test, and silently ignore an override. So this fails on:
 *
 *  (a) any import of an overridable name from the thresholds module, in any
 *      import form, aliased or not (a namespace or default import of the module
 *      is refused too: it cannot be shown not to reach one);
 *  (b) any bare identifier use of an overridable name — one not preceded by `.`
 *      — outside comments, string literals and `export { … } from` re-exports.
 *
 * Property access (`….thresholds.TITLE_MAX`) is how a rule reads the context and
 * is allowed. Whole identifiers only: `TITLE_MAX` inside `TITLE_MAX_HINT` or
 * `META_TITLE_MAX` is a different name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OVERRIDABLE_THRESHOLDS } from "../../src/rules/judgement.js";

const NAMES = Object.keys(OVERRIDABLE_THRESHOLDS);
const ROOT = join(import.meta.dirname, "../../src/rules");
const DIRS = ["page", "query", "metric"];

/**
 * Blank out comments, and optionally the contents of string literals, keeping
 * every other character and all newlines so offsets and line numbers survive.
 * Template literals are kept as code: a `${NAME}` interpolation inside SQL is a
 * bare use and has to be seen.
 */
function blank(src: string, strings: boolean): string {
  let out = "";
  let i = 0;
  let template = false;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (!template && c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (!template && c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (!template && (c === '"' || c === "'")) {
      out += c;
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          out += strings ? "  " : src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += strings ? " " : src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
    } else {
      if (c === "`" && src[i - 1] !== "\\") template = !template;
      out += c;
      i++;
    }
  }
  return out;
}

const whole = (name: string): RegExp => new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, "g");
const anyWhole = (): RegExp => new RegExp(`(?<![.\\w$])(?:${NAMES.join("|")})(?![\\w$])`, "g");
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Every violation in one source text, as `line N: reason`. */
export function violations(src: string): string[] {
  const found: string[] = [];
  const keepStrings = blank(src, false);

  // (a) imports of the thresholds module.
  const importRx = /import\s+(?:type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gs;
  for (const m of keepStrings.matchAll(importRx)) {
    if (!/(?:^|\/)thresholds(?:\.js)?$/.test(m[2]!)) continue;
    const clause = m[1]!;
    const named = clause.match(/\{([^}]*)\}/s)?.[1] ?? "";
    const rest = clause.replace(/\{[^}]*\}/s, "").replace(/,/g, "").trim();
    if (rest !== "") {
      found.push(`line ${lineOf(keepStrings, m.index!)}: namespace or default import of the thresholds module`);
    }
    for (const part of named.split(",")) {
      const imported = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (NAMES.includes(imported)) {
        found.push(`line ${lineOf(keepStrings, m.index!)}: imports overridable '${imported}'`);
      }
    }
  }
  if (/import\(\s*["'][^"']*\/thresholds(?:\.js)?["']\s*\)/.test(keepStrings)) {
    found.push("dynamic import of the thresholds module");
  }

  // (b) bare identifier uses, outside comments, strings and re-exports.
  const reExport = /export\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'][^"']*["']\s*;?/gs;
  const code = blank(src, true).replace(reExport, (s) => s.replace(/[^\n]/g, " "));
  for (const m of code.matchAll(anyWhole())) {
    found.push(`line ${lineOf(code, m.index!)}: bare use of overridable '${m[0]}'`);
  }
  return found;
}

function sources(): Array<{ file: string; text: string }> {
  return DIRS.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ file: `src/rules/${d}/${f}`, text: readFileSync(join(ROOT, d, f), "utf8") })),
  );
}

describe("the threshold guard proves itself", () => {
  it("names the overridable thresholds it guards", () => {
    expect(NAMES).toHaveLength(20);
    expect(NAMES).toContain("TITLE_PX_MAX");
  });

  it.each([
    ["an aliased import", 'import { TITLE_MAX as T } from "../thresholds.js";'],
    ["a plain import", 'import { SLOW_MS, IMAGE_ALT_MAX } from "../thresholds.js";'],
    ["a type-only import", 'import type { DEEP_DEPTH } from "../thresholds";'],
    ["a multi-line import", 'import {\n  IMAGE_ALT_MAX,\n  THIN_WORDS,\n} from "../thresholds.js";'],
    ["a namespace import", 'import * as T from "../thresholds.js";'],
    ["a default import", 'import T from "../thresholds.js";'],
    ["a dynamic import", 'const t = await import("../thresholds.js");'],
    ["a bare comparison", "const slow = p.responseTimeMs > SLOW_MS;"],
    ["a bare use in SQL", "const q = sql`and p.click_depth > ${DEEP_DEPTH}`;"],
    ["a local re-export", "export { TITLE_MIN };"],
    ["a destructuring", "const { URL_MAX } = t;"],
    ["a use after a comment on the same line", "f(META_MAX); // fine"],
  ])("flags %s", (_what, src) => {
    expect(violations(src).length, src).toBeGreaterThan(0);
  });

  it.each([
    ["the intended read", "const m = judgementOr(ctx).thresholds.SLOW_MS;"],
    ["a destructured context read", "const x = j.thresholds.TITLE_PX_MAX + j.thresholds\n  .H2_MAX;"],
    ["a line comment", "// TITLE_MAX is read from the context\nconst a = 1;"],
    ["a block comment", "/** SLOW_MS\n * THIN_WORDS */\nconst a = 1;"],
    ["a string literal", 'const k: ThresholdName = "TITLE_PX_MAX";'],
    ["a longer name", "const a = TITLE_MAX_HINT + META_TITLE_MAX + THIN_WORDS_X;"],
    ["a non-overridable import", 'import { IMAGE_ALT_MAX, NEAR_DUPLICATE_HAMMING } from "../thresholds.js";'],
    ["another module's import", 'import { ThresholdName } from "../threshold-table.js";'],
    ["a single-line re-export", 'export { SLOW_MS } from "../thresholds.js";'],
    ["a multi-line re-export", 'export {\n  TITLE_MIN,\n  THIN_WORDS,\n} from "../thresholds.js";'],
    ["a re-export with an alias", 'export { THIN_WORDS as T } from "../thresholds.js";'],
  ])("allows %s", (_what, src) => {
    expect(violations(src), src).toEqual([]);
  });

  it("reports the line of the offence", () => {
    expect(violations("a;\nb;\nc(SLOW_MS);")).toEqual(["line 3: bare use of overridable 'SLOW_MS'"]);
  });
});

describe("no rule reads an overridable threshold except through the run's context", () => {
  const files = sources();

  it("scans the rule directories", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.map((f) => f.file)).toContain("src/rules/page/on-page.ts");
    expect(files.map((f) => f.file)).toContain("src/rules/metric/health-metrics.ts");
  });

  it.each(files.map((f) => [f.file, f.text] as const))("%s", (_file, text) => {
    expect(violations(text)).toEqual([]);
  });
});
