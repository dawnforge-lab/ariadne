import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import {
  EXCLUDED_REASON_PREFIX,
  matchesPattern,
  patternFamilyError,
  patternToLike,
  scopeRefusesSql,
  scopeVerdict,
} from "../../src/crawl/url-scope.js";

describe("matchesPattern", () => {
  it("anchors at both ends with * matching any run", () => {
    expect(matchesPattern("*/blog/*", "https://ex.com/blog/a")).toBe(true);
    expect(matchesPattern("*/blog/*", "https://ex.com/blogs")).toBe(false);
    expect(matchesPattern("https://ex.com/*", "https://ex.com/")).toBe(true);
    expect(matchesPattern("https://ex.com/*", "https://shop.ex.com/")).toBe(false);
    expect(matchesPattern("*", "anything")).toBe(true);
    expect(matchesPattern("*", "")).toBe(true);
    expect(matchesPattern("https://ex.com/a", "https://ex.com/a")).toBe(true);
    expect(matchesPattern("https://ex.com/a", "https://ex.com/ab")).toBe(false);
    expect(matchesPattern("a*b*c", "aXbYc")).toBe(true);
    expect(matchesPattern("a*b*c", "aXbY")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(matchesPattern("*/Blog/*", "https://ex.com/blog/a")).toBe(false);
  });

  it("runs in linear time on a pathological pattern", () => {
    const start = performance.now();
    const hit = matchesPattern("*a*a*a*a*a*a*a*a*b", "a".repeat(5000));
    expect(hit).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("scopeVerdict", () => {
  it("lets exclude win over a matching include", () => {
    const v = scopeVerdict("https://ex.com/blog/a", { exclude: ["*/blog/*"], include: ["*"] });
    expect(v).toEqual({
      admitted: false,
      reason: "crawl scope: matches exclude pattern '*/blog/*'",
    });
  });

  it("admits everything not excluded when include is empty", () => {
    expect(scopeVerdict("https://ex.com/a", { exclude: ["*/b"], include: [] })).toEqual({
      admitted: true,
    });
  });

  it("refuses a URL no include pattern matches, with the exact reason", () => {
    const v = scopeVerdict("https://ex.com/a", { exclude: [], include: ["*/blog/*"] });
    expect(v).toEqual({ admitted: false, reason: "crawl scope: matches no include pattern" });
    expect(EXCLUDED_REASON_PREFIX).toBe("crawl scope: ");
  });
});

describe("patternToLike", () => {
  it("maps * to % and escapes \\, % and _", () => {
    expect(patternToLike("a*b%c_d\\e")).toBe("a%b\\%c\\_d\\\\e");
  });
});

describe("scope SQL parity", () => {
  let db: Db;
  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  const URLS = [
    "https://ex.com/",
    "https://ex.com/blog/a",
    "https://ex.com/blogs",
    "https://shop.ex.com/",
    "https://ex.com/100%/off",
    "https://ex.com/100abc/off",
    "https://ex.com/a_b",
    "https://ex.com/aXb",
    "https://ex.com/a\\b",
    "https://ex.com/a\\\\b",
    "https://ex.com/a*b",
    "https://ex.com/Blog/a",
    "https://ex.com/p?x=1&y=2",
    "https://ex.com/p?x=1",
    "http://ex.com/",
    "",
  ];
  const PATTERNS = [
    "*",
    "*/blog/*",
    "https://ex.com/*",
    "https://ex.com/",
    "https://ex.com/100%/off",
    "https://ex.com/100*/off",
    "https://ex.com/a_b",
    "https://ex.com/a?b",
    "https://ex.com/a\\b",
    "https://ex.com/a\\*",
    "https://ex.com/a*b",
    "*%*",
    "*_*",
    "*\\*",
    "*?x=*",
    "*/Blog/*",
    "a*b*c",
    "**",
    "",
    "http*",
    "*.com/",
    "https://ex.com/p?x=1*",
  ];

  /** The URLs as a `(values …)` derived table with a text `url` column. */
  function rowsOf(urls: readonly string[]) {
    const values = sql.join(
      urls.map((u) => sql`(${u}::text)`),
      sql`, `,
    );
    return sql`(select * from (values ${values}) as v(url))`;
  }

  it("LIKE accepts exactly the URLs matchesPattern accepts, over 22 patterns and 16 URLs", async () => {
    for (const p of PATTERNS) {
      const expected = URLS.filter((u) => matchesPattern(p, u)).sort();
      const rows = await db.execute<{ url: string }>(
        sql`select url from ${rowsOf(URLS)} t
            where url like ${patternToLike(p)} escape '\\'`,
      );
      expect(rows.rows.map((r) => r.url).sort(), `pattern ${JSON.stringify(p)}`).toEqual(expected);
    }
  });

  it("scopeRefusesSql refuses exactly the URLs scopeVerdict refuses", async () => {
    const scopes = [
      { exclude: ["*/blog/*", "*%*"], include: [] },
      { exclude: ["*_*"], include: ["https://ex.com/*", "*\\*"] },
      { exclude: [], include: ["*/blog/*", "https://ex.com/a?b"] },
      { exclude: ["*\\*"], include: ["https://ex.com/*"] },
      { exclude: [], include: [] },
    ];
    for (const scope of scopes) {
      const rows = await db.execute<{ url: string }>(
        sql`select url from ${rowsOf(URLS)} t
            where ${scopeRefusesSql(sql`t.url`, scope)}`,
      );
      const expected = URLS.filter((u) => !scopeVerdict(u, scope).admitted).sort();
      expect(rows.rows.map((r) => r.url).sort(), JSON.stringify(scope)).toEqual(expected);
    }
  });
});

describe("patternFamilyError", () => {
  const site = "https://ex.com/";
  it("names the host of a pattern outside the site's family", () => {
    expect(patternFamilyError("https://typo.example/*", site)).toContain("typo.example");
  });
  it("accepts the site's own spellings and host-less patterns", () => {
    expect(patternFamilyError("https://www.ex.com/*", site)).toBeNull();
    expect(patternFamilyError("http://ex.com/a", site)).toBeNull();
    expect(patternFamilyError("*/blog/*", site)).toBeNull();
    expect(patternFamilyError("https://*.ex.com/*", site)).toBeNull();
    expect(patternFamilyError("/blog/*", site)).toBeNull();
  });
});
