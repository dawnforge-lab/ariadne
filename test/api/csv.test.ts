/**
 * The CSV writer, the evidence flattening, and the structural memory pin.
 *
 * No database here: these are the three properties that must hold before a
 * single row is read.
 *
 *  1. **A cell can never become a formula.** The strings in these files are a
 *     crawled site's own text — titles, anchors, evidence — and the file opens
 *     in Excel on a client's desk. `=`, `+`, `-` and `@` in first position are
 *     the four prefixes a spreadsheet reads as "compute this", so every cell
 *     that starts with one is prefixed with an apostrophe. This is a test, not
 *     a hope (the phase plan's words).
 *  2. **RFC-4180 quoting is exact**, including the doubled quote and the
 *     embedded newline, and the guard runs BEFORE the quoting so a quoted cell
 *     cannot smuggle a formula past it.
 *  3. **Every view reads its rows through a keyset cursor** — the structural
 *     half of hard rule 3, asserted against the SQL each view actually builds
 *     rather than against a comment claiming it does.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  CSV_VIEWS,
  CSV_VIEW_DEFS,
  EVIDENCE_MAX_CELL,
  EVIDENCE_MAX_LEAVES,
  EVIDENCE_MAX_VALUE,
  csvCell,
  csvRecord,
  flattenEvidence,
  type CsvViewName,
} from "../../src/api/csv.js";

describe("csvCell — the injection guard", () => {
  it("prefixes the four spreadsheet formula leaders with an apostrophe", () => {
    expect(csvCell("=SUM(1+1)")).toBe("'=SUM(1+1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@import")).toBe("'@import");
  });

  it("leaves a cell that starts with anything else alone", () => {
    expect(csvCell("SUM(1+1)")).toBe("SUM(1+1)");
    expect(csvCell("https://x.example/a=b")).toBe("https://x.example/a=b");
    expect(csvCell("")).toBe("");
  });

  // THE CAMOUFLAGED VARIANT. A leading space is not a defence: readers that
  // strip whitespace from an unquoted field then evaluate what was behind it,
  // so the guard looks past the whitespace and keeps the original bytes.
  it("finds a leader hiding behind leading whitespace, and preserves the cell", () => {
    expect(csvCell(" =SUM(1+1)")).toBe("' =SUM(1+1)");
    expect(csvCell("\t@import")).toBe("'\t@import");
    // Whitespace with nothing behind it is not an attack and is left alone.
    expect(csvCell("   ")).toBe("   ");
    expect(csvCell(" hello")).toBe(" hello");
  });

  it("guards BEFORE it quotes, so a comma cannot hide a formula", () => {
    // The order matters: quote-then-guard would look at `"` and find nothing.
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
    // No comma, no quote, no newline: guarded and left unquoted, which is
    // correct RFC 4180 — an apostrophe needs no escaping of its own.
    expect(csvCell(`=cmd|' /C calc'!A0`)).toBe(`'=cmd|' /C calc'!A0`);
  });
});

describe("csvCell — RFC 4180 quoting", () => {
  it("quotes a cell containing a comma, a quote, CR or LF, and doubles the quote", () => {
    expect(csvCell("a,b")).toBe(`"a,b"`);
    expect(csvCell(`he said "hi"`)).toBe(`"he said ""hi"""`);
    expect(csvCell("one\ntwo")).toBe(`"one\ntwo"`);
    expect(csvCell("one\r\ntwo")).toBe(`"one\r\ntwo"`);
  });

  it("does not quote a cell that needs no quoting", () => {
    expect(csvCell("plain text with spaces")).toBe("plain text with spaces");
  });
});

describe("csvRecord", () => {
  it("joins with commas and terminates with CRLF", () => {
    expect(csvRecord(["a", "b"])).toBe("a,b\r\n");
  });

  it("writes an empty cell for an empty string rather than dropping the column", () => {
    expect(csvRecord(["a", "", "c"])).toBe("a,,c\r\n");
  });

  it("survives a cell holding a whole record's worth of punctuation", () => {
    expect(csvRecord([`=1,"2"\n3`, "ok"])).toBe(`"'=1,""2""\n3",ok\r\n`);
  });
});

describe("flattenEvidence", () => {
  it("drops pageUrl, which is already the url column", () => {
    expect(flattenEvidence({ pageUrl: "http://x.example/a", statusCode: 500 })).toBe(
      "statusCode=500",
    );
  });

  it("sorts keys, so the same evidence always flattens to the same cell", () => {
    expect(flattenEvidence({ b: 1, a: 2 })).toBe("a=2; b=1");
    const evidence = { z: "last", m: { b: 2, a: 1 }, a: [3, 1] };
    expect(flattenEvidence(evidence)).toBe(flattenEvidence(evidence));
  });

  it("flattens nested objects with dotted paths and arrays with indices", () => {
    expect(flattenEvidence({ truncated: { reported: 3, total: 222 } })).toBe(
      "truncated.reported=3; truncated.total=222",
    );
    expect(flattenEvidence({ sources: [{ url: "a" }, { url: "b" }] })).toBe(
      "sources[0].url=a; sources[1].url=b",
    );
  });

  it("joins an array of scalars with a pipe, in order", () => {
    expect(flattenEvidence({ chain: ["a", "b", "c"] })).toBe("chain=a|b|c");
  });

  it("spells null, an empty array and an empty object rather than dropping them", () => {
    expect(flattenEvidence({ finalStatus: null })).toBe("finalStatus=null");
    expect(flattenEvidence({ tags: [] })).toBe("tags=[]");
    expect(flattenEvidence({ meta: {} })).toBe("meta={}");
  });

  it("collapses whitespace, so one finding is always one row", () => {
    expect(flattenEvidence({ note: "a\nb\t c" })).toBe("note=a b c");
  });

  it("clips a long value and says so", () => {
    const cell = flattenEvidence({ note: "x".repeat(400) });
    expect(cell.endsWith("…")).toBe(true);
    expect(cell.length).toBe("note=".length + EVIDENCE_MAX_VALUE);
  });

  it("caps the number of leaves and counts what it dropped", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < EVIDENCE_MAX_LEAVES + 3; i += 1) wide[`k${String(i).padStart(2, "0")}`] = i;
    const cell = flattenEvidence(wide);
    expect(cell).toContain("+3 more");
    expect(cell.startsWith("k00=0; k01=1;")).toBe(true);
  });

  it("keeps the whole cell bounded", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < EVIDENCE_MAX_LEAVES; i += 1) wide[`k${i}`] = "y".repeat(EVIDENCE_MAX_VALUE);
    expect(flattenEvidence(wide).length).toBeLessThanOrEqual(EVIDENCE_MAX_CELL);
  });

  it("answers with an empty cell for evidence that held nothing but the pageUrl", () => {
    expect(flattenEvidence({ pageUrl: "http://x.example/a" })).toBe("");
  });
});

describe("the view definitions", () => {
  const dialect = new PgDialect();
  const rendered = (view: CsvViewName): string =>
    dialect.sqlToQuery(
      CSV_VIEW_DEFS[view].query("crawl_x", CSV_VIEW_DEFS[view].start, 500, "title.missing"),
    ).sql;

  it("defines exactly the seven views the surface advertises", () => {
    expect(Object.keys(CSV_VIEW_DEFS).sort()).toEqual([...CSV_VIEWS].sort());
    // Seven since P11-T4 added `resources`. The count moves with the vocabulary
    // deliberately: a view defined and never advertised, or advertised and never
    // defined, fails the line above, and a view SILENTLY DELETED fails this one.
    expect(CSV_VIEWS).toHaveLength(7);
  });

  it("gives every view a header, a keyset and a start cursor of matching arity", () => {
    for (const view of CSV_VIEWS) {
      const def = CSV_VIEW_DEFS[view];
      expect(def.header.length, `${view} has no header`).toBeGreaterThan(0);
      expect(def.keyset.length, `${view} names no keyset`).toBeGreaterThan(0);
      expect(def.start.length, `${view}'s start cursor is the wrong arity`).toBe(def.keyset.length);
    }
  });

  // THE MEMORY CONTRACT, PINNED AT THE SQL. Hard rule 3 says the links table is
  // never loaded into memory, and the anchor view is 35,145 rows on the
  // reference crawl. A view that lost its LIMIT would still pass every
  // row-content test in this repository and would read the whole table into one
  // result set; only the query text says otherwise.
  it("bounds every view's read and orders it, so a cursor can walk it", () => {
    for (const view of CSV_VIEWS) {
      const def = CSV_VIEW_DEFS[view];
      const text = rendered(view);
      expect(text, `${view} reads without a limit`).toMatch(/\blimit\b/i);
      expect(text, `${view} reads without an order`).toMatch(/\border by\b/i);

      // NOT `toContain(">")`, which a `<>` or a stray `->>` would satisfy while
      // the cursor did nothing. What is asserted is the comparison itself: a
      // ROW comparison for a compound keyset, and a comparison of the named
      // column against a parameter for a single one.
      const [first] = def.keyset;
      if (def.keyset.length > 1) {
        expect(text, `${view} has no row-comparison keyset predicate`).toMatch(/\)\s*>\s*\(/);
      } else {
        expect(text, `${view} does not compare ${String(first)} against a cursor`).toMatch(
          new RegExp(`\\b${String(first)}\\s*>\\s*\\$`),
        );
      }
      // And every column the keyset claims to be made of is really in the query.
      for (const column of def.keyset) {
        expect(text, `${view}'s keyset names ${column}, which its SQL never reads`).toContain(
          column,
        );
      }
    }
  });

  it("starts every view at a cursor no real row can equal", () => {
    for (const view of CSV_VIEWS) {
      for (const part of CSV_VIEW_DEFS[view].start) {
        // The empty string is the minimum of text ordering, so no `url`,
        // `rule_id` or `dedupe_key` sorts at or before it; the one numeric part
        // is a `position`, a non-negative index within its page, so a negative
        // start is below every row. Either way the first batch cannot skip a
        // row by starting past it.
        expect(
          part === "" || Number(part) < 0,
          `${view} starts its cursor at a value a real row could hold: '${part}'`,
        ).toBe(true);
      }
    }
  });

  it("parameterises the crawl id rather than interpolating it into the SQL", () => {
    for (const view of CSV_VIEWS) {
      const { params } = new PgDialect().sqlToQuery(
        CSV_VIEW_DEFS[view].query("crawl_x", CSV_VIEW_DEFS[view].start, 500, "title.missing"),
      );
      expect(params, `${view} does not parameterise its crawl id`).toContain("crawl_x");
      expect(rendered(view), `${view} interpolates its crawl id`).not.toContain("crawl_x");
    }
  });

  it("asks for a ruleId only where one is meaningful", () => {
    expect(CSV_VIEW_DEFS["issue_urls"].needsRuleId).toBe(true);
    for (const view of CSV_VIEWS) {
      if (view === "issue_urls") continue;
      expect(CSV_VIEW_DEFS[view].needsRuleId, `${view} asks for a ruleId`).toBe(false);
    }
  });
});
