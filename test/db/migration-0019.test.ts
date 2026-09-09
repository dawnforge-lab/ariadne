/**
 * Migration 0019: `pages_main_simhash_band0..3` — the four band indexes
 * `content.near-duplicate` joins on.
 *
 * WHAT THIS CLOSES. Migration 0004 put four expression indexes on `simhash`,
 * one per 16-bit band, and the near-duplicate pair join was written to match
 * them: 5,000 pages in ~0.11s instead of ~2.9s as a quadratic nested loop.
 * Phase 19 (migration 0018) moved the rule onto `main_simhash`, because the
 * whole-page fingerprint on a templated site measures the header, nav and
 * footer and put 237 unrelated pairs inside the 3-bit threshold. The rule
 * moved; the indexes did not. Every band predicate then matched nothing, and
 * because Postgres will not use indexes for an OR unless EVERY branch is
 * indexable, the whole BitmapOr collapsed — silently, as a slow query rather
 * than an error. This migration puts the same four bands on `main_simhash`.
 *
 * WHY AN EXPLAIN AND NOT A COLUMN CHECK. There is nothing here for a schema
 * assertion to catch. The indexes either exist or `runMigrations` threw, and an
 * index that exists is not an index the planner uses: the whole failure mode
 * this file is about is a correct-looking index that the query's spelling does
 * not match. Postgres matches an expression index by comparing parse trees, so
 * `int8shr(x, 0)` is not the same expression as a bare `x`, and a band 0 index
 * written the obvious short way would sit in `pg_indexes` looking right while
 * the rule fell back to a sequential scan. Only the plan says which happened.
 *
 * So there are three claims, and they are deliberately separate:
 *
 *  1. THE SPELLING. The four band predicates are read OUT OF THE RULE'S OWN
 *     SOURCE and compared with the four `pg_indexes` definitions. This is the
 *     drift alarm: rename the column, drop a shift, or write `& 65535` where
 *     the index says `(main_simhash >> 0) & 65535`, and the two spellings stop
 *     matching here rather than in a gate crawl's wall clock.
 *  2. THE PLAN. Those same extracted predicates are put into a pair join over
 *     4,000 seeded rows and EXPLAINed. All four `Bitmap Index Scan`s must be in
 *     the plan, under one `BitmapOr`, and the INNER side of the join must not
 *     be a sequential scan on `pages`. Seeded rather than crawled — 0018's
 *     discipline is the right one when the claim is about what the analyzer
 *     wrote, and this claim is about what the PLANNER does, which needs a table
 *     big enough for an index to beat a scan and cares nothing about where the
 *     bytes came from.
 *  3. THE 0004 INDEXES ARE STILL THERE. `simhash` is still written, still read
 *     by `content.duplicate`'s neighbourhood and by the 0018 diagnosis, and
 *     this migration adds to those four rather than replacing them.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { CANONICALISED_ELSEWHERE } from "../../src/rules/helpers.js";
import {
  NEAR_DUPLICATE_HAMMING,
  NEAR_DUPLICATE_MIN_MAIN_WORDS,
} from "../../src/rules/query/content.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/** The four bands, in the order the four index names carry. */
const SHIFTS = [0, 16, 32, 48] as const;

/**
 * The four band predicates, lifted verbatim from the rule that runs them.
 *
 * Reading the source rather than restating it is the entire point: a copy in
 * this file would go stale exactly when the coupling broke, and a test that
 * asserts a stale copy matches the index proves nothing about the query
 * Postgres will actually be handed. The regex insists on the shape — same
 * column, same shift on both sides, same mask — so a rule that stops spelling
 * its bands this way yields fewer than four and fails below.
 */
function bandPredicatesFromRule(): string[] {
  const source = readFileSync(new URL("../../src/rules/query/content.ts", import.meta.url), "utf8");
  const found: string[] = [];
  const pattern =
    /\(([a-z])\.main_simhash >> (\d+)\)\s*& 65535 = \(([a-z])\.main_simhash >> (\d+)\)\s*& 65535/g;
  for (const match of source.matchAll(pattern)) {
    const [whole, left, shift, right, rightShift] = match;
    if (left === right) throw new Error(`band predicate joins a table to itself: ${whole}`);
    if (shift !== rightShift) throw new Error(`band predicate shifts differ: ${whole}`);
    found.push(whole.replace(/\s+/g, " "));
  }
  return found;
}

/**
 * A `pg_indexes` definition reduced to the spelling the rule uses. Postgres
 * prints the mask as `(65535)::bigint` because the column is a bigint and the
 * literal is an int; that cast is the planner's own bookkeeping and not a
 * difference in the expression, so it is normalised away and nothing else is.
 */
function normaliseIndexDef(def: string): string {
  return def.replace(/\(65535\)::bigint/g, "65535").replace(/\s+/g, " ");
}

const CRAWL_ID = "crawl_0019_band_plan";
/**
 * Enough rows that an index can beat a scan. 4,000 is a real site's order of
 * magnitude and runs in well under a second; the planner is asked a question
 * about 4,000 rows, not about 8.
 */
const SEEDED = 4_000;

let db: Db;

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  await db.delete(crawls).where(eq(crawls.id, CRAWL_ID));
  await db.execute(sql`
    insert into crawls (id, site_url, config_jsonb, ruleset_version)
    values (${CRAWL_ID}, 'https://bands.example', '{}'::jsonb, '0.0.0')`);
  // One statement, because 4,000 round trips would be a memory-contract joke
  // and a slow test. The fingerprints are random over the full signed 64-bit
  // range, built from two 32-bit halves so all four bands are independently
  // spread — `random()` alone carries 52 bits and would leave the low band
  // clumped, which is the one case where an index looks worse than it is.
  await db.execute(sql`
    insert into pages (id, crawl_id, url, url_normalised, fetch_class, status_code,
                       is_indexable, depth, discovered_via, content_hash,
                       main_simhash, main_word_count, word_count)
    select 'p_0019_' || g, ${CRAWL_ID},
           'https://bands.example/' || g, 'https://bands.example/' || g,
           'ok', 200, true, 2, 'link', md5(g::text),
           (((random() * 4294967295)::bigint << 32) | (random() * 4294967295)::bigint)
             * (case when random() < 0.5 then -1 else 1 end),
           ${NEAR_DUPLICATE_MIN_MAIN_WORDS + 250}, 900
    from generate_series(1, ${SEEDED}) g`);
  // An expression index has NO statistics until the table is analyzed, and the
  // planner does not choose a plan it cannot cost. This is the same ANALYZE the
  // rule's docblock tells a 50k gate crawl to run before the rules; here it is
  // what makes the plan below a statement about the index rather than about a
  // table Postgres has never looked at.
  await db.execute(sql`analyze pages`);
}, 120_000);

afterAll(async () => {
  await db.delete(crawls).where(eq(crawls.id, CRAWL_ID));
  await closeDb(db);
});

/** The band-index definitions as Postgres holds them, keyed by index name. */
async function bandIndexDefs(prefix: string): Promise<Map<string, string>> {
  const result = await db.execute<{ indexname: string; indexdef: string }>(sql`
    select indexname, indexdef from pg_indexes
    where tablename = 'pages' and indexname like ${`${prefix}%`}
    order by indexname`);
  return new Map(result.rows.map((r) => [r.indexname, r.indexdef]));
}

describe("0019 — the main_simhash band indexes", () => {
  it("creates the four bands, one index per 16-bit slice", async () => {
    const defs = await bandIndexDefs("pages_main_simhash_band");
    expect([...defs.keys()]).toEqual([
      "pages_main_simhash_band0",
      "pages_main_simhash_band1",
      "pages_main_simhash_band2",
      "pages_main_simhash_band3",
    ]);
    for (const [name, def] of defs) {
      // `crawl_id` leads every one of them: the rule's join is inside a single
      // crawl, and a band index that did not start there would be an index over
      // every crawl the database holds.
      expect(normaliseIndexDef(def)).toContain("btree (crawl_id, ");
    }
  });

  it("spells the four expressions exactly as the rule spells its predicates", async () => {
    const predicates = bandPredicatesFromRule();
    // Four, in band order, or the rule has been rewritten and the sentence this
    // file asserts is no longer about it.
    expect(predicates).toHaveLength(4);
    const defs = await bandIndexDefs("pages_main_simhash_band");
    SHIFTS.forEach((shift, band) => {
      // What the rule says, reduced to the one side an index can hold.
      const expression = `(main_simhash >> ${shift}) & 65535`;
      // The rule's own text really is about this band, on both sides of it.
      const predicate = predicates[band]!;
      expect(predicate).toContain(`>> ${shift})`);
      expect(predicate.match(/main_simhash/g)).toHaveLength(2);
      // And the index Postgres holds is that expression, character for
      // character once the bigint cast on the mask is undone. THIS is the
      // assertion that fires when either side drifts.
      const def = defs.get(`pages_main_simhash_band${band}`);
      expect(def, `no index for band ${band}`).toBeDefined();
      expect(normaliseIndexDef(def!)).toContain(expression);
    });
  });

  it("puts all four bands in the plan of the rule's pair query", async () => {
    // The band clause is built from the RULE'S predicates, not from a copy, so
    // what Postgres plans here is the disjunction the rule will hand it.
    const bands = bandPredicatesFromRule();
    expect(bands).toHaveLength(4);
    const bandClause = bands.join("\n or ");
    // The rest of the pair join, in the rule's shape: the auditable cohort on
    // both sides, the canonical exclusion on both sides, the null guard, the
    // main-word floor, and the exact hamming verification the bands only
    // approximate. The canonical exclusion is a string expression over four
    // columns and is indexable by nothing — which is exactly why it is here: it
    // is a filter the planner must apply AFTER the bitmap, and a query shape
    // that made it a reason to abandon the index would be the same silent
    // collapse this file exists to catch.
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
      explain
      select a.id as id_a, b.id as id_b,
             bit_count((a.main_simhash # b.main_simhash)::bit(64))::int as hamming
      from pages a
      join pages b on b.crawl_id = a.crawl_id and a.id < b.id
        and a.content_hash is distinct from b.content_hash
        and ( ${sql.raw(bandClause)} )
      where a.crawl_id = ${CRAWL_ID}
        and a.fetch_class = 'ok' and a.status_code = 200 and a.is_indexable = true
        and b.fetch_class = 'ok' and b.status_code = 200 and b.is_indexable = true
        and not ${CANONICALISED_ELSEWHERE("a")} and not ${CANONICALISED_ELSEWHERE("b")}
        and a.main_simhash is not null and b.main_simhash is not null
        and a.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
        and b.main_word_count >= ${NEAR_DUPLICATE_MIN_MAIN_WORDS}
        and bit_count((a.main_simhash # b.main_simhash)::bit(64)) <= ${NEAR_DUPLICATE_HAMMING}
      limit 501`);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");

    // Every arm indexed. One that is not takes the whole BitmapOr with it, so
    // all four are asserted rather than "at least one".
    for (const band of [0, 1, 2, 3]) {
      expect(text, `band ${band} is not an index scan:\n${text}`).toContain(
        `Bitmap Index Scan on pages_main_simhash_band${band}`,
      );
    }
    // And they are ORed together into one candidate set, which is what makes
    // the pigeonhole argument a filter rather than four separate joins.
    expect(text).toContain("BitmapOr");
    // THE INNER SIDE IS NOT A SCAN. `pages a` may legitimately be a sequential
    // scan — the rule reads every auditable page of the crawl once — but `pages
    // b` is looked up per outer row, and a sequential scan there is the
    // quadratic plan this migration exists to prevent.
    expect(text, `the inner side degraded to a scan:\n${text}`).not.toMatch(
      /Seq Scan on pages b\b/,
    );
    // The premise of the whole plan: the rows really are there.
    const [seeded] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.crawlId, CRAWL_ID));
    expect(seeded?.n).toBe(SEEDED);
  });

  it("leaves the 0004 simhash bands in place", async () => {
    // 0019 adds a second set; it does not move the first. `simhash` is still
    // written by every crawl and still the column the 0018 diagnosis is stated
    // against, so dropping its bands would be a separate decision.
    const defs = await bandIndexDefs("pages_simhash_band");
    expect([...defs.keys()]).toHaveLength(4);
    SHIFTS.forEach((shift, band) => {
      const def = defs.get(`pages_simhash_band${band}`);
      expect(def, `no 0004 index for band ${band}`).toBeDefined();
      expect(normaliseIndexDef(def!)).toContain(`(simhash >> ${shift}) & 65535`);
    });
  });

  it("cascades the seeded rows from the crawl delete", async () => {
    const count = async () => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, CRAWL_ID));
      return rows[0]?.n ?? 0;
    };
    expect(await count()).toBe(SEEDED);
    await db.delete(crawls).where(eq(crawls.id, CRAWL_ID));
    expect(await count()).toBe(0);
  });
});
