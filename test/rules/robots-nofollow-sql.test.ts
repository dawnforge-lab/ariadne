/**
 * SAYS_NOFOLLOW (SQL) against the JS reading `robotsTokens` gives
 * (`nofollow` or `none` as a whole token), and SAYS_NOINDEX (SQL) against
 * `saysNoindex` (JS: the substring `noindex`, or `none` as a whole token), over
 * one corpus of directive strings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { robotsTokens, SAYS_NOFOLLOW, SAYS_NOINDEX, saysNoindex } from "../../src/rules/helpers.js";

const CORPUS: (string | null)[] = [
  null, "", "   ", "index", "nofollow", "NoFollow", "none", "NONE", "index, nofollow", "noindex nofollow",
  "noindex, follow", "nofollowing", "nonevent", "xnofollow", "nofollow2", "none,", ",none",
  "googlebot: nofollow", "googlebot:nofollow", "googlebot: none", "bingbot:noindex, nofollow",
  "max-image-preview:none", "max-image-preview: none", "index, follow, max-image-preview:none",
  "max-image-preview:none, nofollow", "max-image-preview: none none", "MAX-IMAGE-PREVIEW:NONE",
  "max-snippet:-1, max-video-preview:-1", "max-snippet: 50, nofollow", "max-video-preview:none",
  "max-image-preview:large", "noimageindex", "unavailable_after: 25 Jun 2010 15:00:00 PST",
  "unavailable_after: 2025-01-01T10:00:00Z, nofollow", "all", "follow", "noarchive,none",
  "noindex", "NOINDEX, follow", "max-snippet: none", "max-image-preview: none, noindex",
  "MAX-IMAGE-PREVIEW : NONE", "googlebot:none, max-image-preview: none", "max-image-preview: none, none",
];

describe("SAYS_NOFOLLOW parity with robotsTokens", () => {
  let db: Db;
  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });
  afterAll(async () => closeDb(db));

  it("agrees on every string, and the corpus has both answers", async () => {
    const rows = CORPUS.map((v, i) => sql`(${i}::int, ${v}::text)`);
    const res = await db.execute<{ i: number; says: boolean }>(
      sql`select v.i, ${sql.raw(SAYS_NOFOLLOW("v.c"))} as says from (values ${sql.join(rows, sql`, `)}) v(i, c)`,
    );
    const got = new Map(res.rows.map((r) => [Number(r.i), r.says]));
    let yes = 0;
    CORPUS.forEach((v, i) => {
      const js = robotsTokens(v).some((t) => t === "nofollow" || t === "none");
      if (js) yes += 1;
      expect(got.get(i), JSON.stringify(v)).toBe(js);
    });
    expect(yes).toBeGreaterThan(5);
    expect(yes).toBeLessThan(CORPUS.length - 5);
  });
});

describe("SAYS_NOINDEX parity with saysNoindex", () => {
  let db: Db;
  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });
  afterAll(async () => closeDb(db));

  it("agrees on every string; `none` is a whole token as robotsTokens reads it", async () => {
    const rows = CORPUS.map((v, i) => sql`(${i}::int, ${v}::text)`);
    const res = await db.execute<{ i: number; says: boolean }>(
      sql`select v.i, ${sql.raw(SAYS_NOINDEX("v.c"))} as says from (values ${sql.join(rows, sql`, `)}) v(i, c)`,
    );
    const got = new Map(res.rows.map((r) => [Number(r.i), r.says]));
    let yes = 0;
    CORPUS.forEach((v, i) => {
      const js = saysNoindex(v);
      expect(js, JSON.stringify(v)).toBe(/noindex/i.test(v ?? "") || robotsTokens(v).includes("none"));
      if (js) yes += 1;
      expect(got.get(i), JSON.stringify(v)).toBe(js);
    });
    expect(yes).toBeGreaterThan(5);
    expect(yes).toBeLessThan(CORPUS.length - 5);
  });
});
