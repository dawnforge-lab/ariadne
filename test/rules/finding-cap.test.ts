/**
 * `findingCap` — the knob that turns a snapshot into the whole picture (P8-T4).
 *
 * The existing per-rule truncation tests (field-duplicates, link-graph,
 * redirects, robots, sitemap, url-hygiene, content, hreflang, link-targets,
 * pagination) are the DEFAULT-UNCHANGED proof and are deliberately untouched:
 * they call `rule.run(db, crawlId)` with no caps and assert 200 findings and the
 * note beside them, exactly as they did before the knob existed. What is under
 * test here is everything else the knob can do — a custom number, no cap at all,
 * the pair budget following, and the one property a run-level budget has to have
 * that a module constant would not: two concurrent runs of two different crawls
 * cannot see each other's cap.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, pages } from "../../src/db/schema.js";
import { contentRules } from "../../src/rules/query/content.js";
import {
  DEFAULT_RULE_CAPS,
  NEAR_DUPLICATE_PAIR_CAP,
  NEAR_DUPLICATE_PAIR_CEILING,
  resolveRuleCaps,
  storedFindingCap,
  URL_FINDING_CAP,
} from "../../src/rules/query/crawl-evidence.js";
import { fieldDuplicateRules } from "../../src/rules/query/field-duplicates.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import { Registry, RULESET_VERSION } from "../../src/rules/registry/registry.js";
import type { Finding, QueryRule, RuleCaps } from "../../src/rules/registry/types.js";
import { runRules } from "../../src/rules/run.js";
import { mkDiscovery } from "./mk-discovery.js";
import { CLEAN_META, mkPage } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://caps.example";

function rule(rules: QueryRule[], id: string): QueryRule {
  const found = rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule '${id}'`);
  return found;
}

describe("resolveRuleCaps", () => {
  it("gives the engine's two defaults when nobody chose", () => {
    expect(resolveRuleCaps(undefined)).toEqual({
      listing: URL_FINDING_CAP,
      nearDuplicatePairs: NEAR_DUPLICATE_PAIR_CAP,
      nearDuplicatePairCeiling: NEAR_DUPLICATE_PAIR_CEILING,
    });
    expect(DEFAULT_RULE_CAPS).toEqual(resolveRuleCaps(undefined));
  });

  it("uncaps both reporting budgets on null — the billed-audit setting", () => {
    expect(resolveRuleCaps(null)).toEqual({
      listing: null,
      nearDuplicatePairs: null,
      nearDuplicatePairCeiling: NEAR_DUPLICATE_PAIR_CEILING,
    });
  });

  // The one budget that is not the operator's to remove. It is the memory
  // contract (hard rule 6) rather than a preference: uncapped, the pair scan
  // measured 521MB RSS at 2,000 degenerate pages and exhausted a 4GB heap at
  // 20,000. No `findingCap` reaches it — not null, not a number above it.
  it("holds the near-duplicate scan ceiling at every findingCap", () => {
    for (const cap of [undefined, null, 7, NEAR_DUPLICATE_PAIR_CEILING * 10]) {
      expect(resolveRuleCaps(cap).nearDuplicatePairCeiling, String(cap)).toBe(
        NEAR_DUPLICATE_PAIR_CEILING,
      );
    }
  });

  // The documented discontinuity: a stated number is a budget for what the
  // caller will read, and it binds the pair listing too. `findingCap: 200` is
  // therefore NOT the same as omitting the field, which leaves pairs at 500.
  it("collapses both budgets onto a stated number, pairs included", () => {
    expect(resolveRuleCaps(7)).toEqual({
      listing: 7,
      nearDuplicatePairs: 7,
      nearDuplicatePairCeiling: NEAR_DUPLICATE_PAIR_CEILING,
    });
    expect(resolveRuleCaps(URL_FINDING_CAP)).not.toEqual(resolveRuleCaps(undefined));
  });
});

describe("storedFindingCap", () => {
  it("reads absent, null and a positive integer off a stored config", () => {
    expect(storedFindingCap({ maxPages: 10 }, "crawl_x")).toBeUndefined();
    expect(storedFindingCap({ findingCap: null }, "crawl_x")).toBeNull();
    expect(storedFindingCap({ findingCap: 50 }, "crawl_x")).toBe(50);
  });

  // Hard rule 7: a value we cannot read the operator's intent out of stops the
  // run rather than being judged at the default. A billed audit silently capped
  // at 200 is the exact quiet wrong answer this project forbids.
  it("refuses a stored value that is neither absent, null, nor a positive integer", () => {
    for (const bad of ["none", 0, -1, 1.5, true, []]) {
      expect(() => storedFindingCap({ findingCap: bad }, "crawl_x"), JSON.stringify(bad)).toThrow(
        /findingCap/,
      );
    }
  });
});

describe("the finding cap against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  /** A crawl row that looks finished, so `links.orphan` judges it. */
  async function newCrawl(config: Record<string, unknown> = {}): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 10_000, userAgent: "AriadneBot-test", ...config },
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 3,
    });
    createdCrawls.push(id);
    return id;
  }

  /**
   * `n` indexable 200 pages nothing links to — one orphan each — plus the seed,
   * which is exempt. Padded paths so the lexical `order by p.url` the rule
   * relies on is also numeric order, which is what lets a capped run be compared
   * with the uncapped one member by member.
   */
  async function addOrphans(crawlId: string, n: number): Promise<string[]> {
    const rows = [
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId,
        url: `${SITE}/`,
        urlNormalised: `${SITE}`,
        depth: 0,
        discoveredVia: "seed",
      }),
    ];
    const urls: string[] = [];
    for (let i = 0; i < n; i++) {
      const url = `${SITE}/o/${String(i).padStart(4, "0")}`;
      urls.push(url);
      rows.push(
        mkPage({
          id: `page_${randomUUID()}`,
          crawlId,
          url,
          urlNormalised: url,
          canonicalHtml: url,
          title: `A page about ${String(i).padStart(4, "0")}`,
          metaDescription: `${CLEAN_META} About ${String(i)}.`,
        }),
      );
    }
    await db.insert(pages).values(rows);
    return urls;
  }

  const orphans = (crawlId: string, caps?: RuleCaps): Promise<Finding[]> =>
    rule(linkGraphRules, "links.orphan").run(db, crawlId, caps);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("lists the stated number and counts the rest exactly", async () => {
    const crawlId = await newCrawl();
    const urls = await addOrphans(crawlId, 12);

    const found = await orphans(crawlId, resolveRuleCaps(5));
    expect(found).toHaveLength(5);
    expect(found.map((f) => f.pageUrl)).toEqual(urls.slice(0, 5));
    // The mechanism is untouched: the note lands on the LAST finding and the
    // total behind it is exact, whatever the cap was.
    expect(found[4]!.evidence["truncated"]).toEqual({ reported: 5, total: 12 });
    for (const f of found.slice(0, 4)) expect(f.evidence["truncated"]).toBeUndefined();
  });

  it("lists everything and writes no note when the cap is null", async () => {
    const crawlId = await newCrawl();
    const urls = await addOrphans(crawlId, 12);

    const found = await orphans(crawlId, resolveRuleCaps(null));
    expect(found.map((f) => f.pageUrl)).toEqual(urls);
    // The absence of the note is the claim: nothing was truncated, so there is
    // nothing to say about a remainder. A reader takes the list as the whole of
    // it precisely because no finding carries a `truncated` key.
    for (const f of found) expect(f.evidence["truncated"]).toBeUndefined();
  });

  it("orders an uncapped listing the same way a capped one is cut", async () => {
    const crawlId = await newCrawl();
    await addOrphans(crawlId, 12);

    const capped = await orphans(crawlId, resolveRuleCaps(4));
    const uncapped = await orphans(crawlId, resolveRuleCaps(null));
    // A capped listing is a PREFIX of the uncapped one, which is what makes the
    // cap a budget rather than a sample: raising it never re-shuffles what the
    // client already saw.
    expect(uncapped.slice(0, 4).map((f) => f.pageUrl)).toEqual(capped.map((f) => f.pageUrl));
  });

  it("caps the number of duplicate GROUPS, never the URLs quoted inside one", async () => {
    const crawlId = await newCrawl();
    // One title shared by 25 pages: one group, far more members than the
    // twenty-URL sample. The ruling under test is that `findingCap: null` gives
    // MORE FINDINGS, never fatter ones — the count carries the magnitude.
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const url = `${SITE}/dup/${String(i).padStart(4, "0")}`;
      rows.push(
        mkPage({
          id: `page_${randomUUID()}`,
          crawlId,
          url,
          urlNormalised: url,
          canonicalHtml: url,
          title: "One title on twenty-five pages",
        }),
      );
    }
    await db.insert(pages).values(rows);

    const found = await rule(fieldDuplicateRules, "title.duplicate").run(
      db,
      crawlId,
      resolveRuleCaps(null),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence["count"]).toBe(25);
    expect(found[0]!.evidence["pages"]).toHaveLength(20);
  });

  /**
   * The near-duplicate pair budget follows the same knob.
   *
   * Four pages whose simhashes are one bit apart in a rising chain: every pair
   * among them is inside `NEAR_DUPLICATE_HAMMING` (3 bits) except the widest,
   * which is exactly 3 — so all six pairs qualify. Distinct content hashes, so
   * `content.exact-duplicate` owns none of them.
   */
  async function addNearDuplicates(crawlId: string): Promise<void> {
    const bits = [0n, 1n, 3n, 7n];
    await db.insert(pages).values(
      bits.map((mask, i) => {
        const url = `${SITE}/n/${String(i).padStart(4, "0")}`;
        return mkPage({
          id: `page_${randomUUID()}`,
          crawlId,
          url,
          urlNormalised: url,
          canonicalHtml: url,
          contentHash: `hash-${String(i)}`,
          simhash: BigInt.asIntN(64, mask),
        });
      }),
    );
  }

  it("stops the pair listing at the stated cap and says it is a lower bound", async () => {
    const crawlId = await newCrawl();
    await addNearDuplicates(crawlId);

    const found = await rule(contentRules, "content.near-duplicate").run(
      db,
      crawlId,
      resolveRuleCaps(2),
    );
    expect(found).toHaveLength(2);
    // `atLeast`, not `total`: counting every pair means running the whole
    // quadratic join, which is what the cap exists to avoid.
    expect(found[1]!.evidence["truncated"]).toEqual({ reported: 2, atLeast: 3 });
  });

  it("lists every pair and writes no note when the cap is null and the scan fits", async () => {
    const crawlId = await newCrawl();
    await addNearDuplicates(crawlId);

    const found = await rule(contentRules, "content.near-duplicate").run(
      db,
      crawlId,
      resolveRuleCaps(null),
    );
    // Six unordered pairs out of four pages, all within three bits.
    expect(found).toHaveLength(6);
    for (const f of found) expect(f.evidence["truncated"]).toBeUndefined();
    // Distinct pairs, not the same pair six times.
    expect(new Set(found.map((f) => f.dedupeKey)).size).toBe(6);
  });

  /**
   * THE CEILING, AGAINST THE PRODUCTION CONSTANT.
   *
   * No override seam and no shrunken test value: 450 pages sharing one simhash
   * are C(450,2) = 101,025 pairs, all at hamming 0 and therefore all inside
   * `NEAR_DUPLICATE_HAMMING`, which clears the real 100,000 ceiling with 1,025
   * to spare. Distinct `content_hash` per page, so `content.exact-duplicate`
   * owns none of them and every pair reaches this rule. The join itself measures
   * ~40ms; the cost is building the findings, which is the point — that is the
   * allocation the ceiling exists to bound.
   *
   * The assertion is the ROW COUNT plus the note, which is the ceiling's
   * observable consequence: the rule holds 100,000 findings rather than 101,025,
   * and it says out loud that it stopped. At the measured ~500 bytes a finding
   * that is ~50MB, inside the 512MB contract; asserting bytes here would be
   * asserting the GC's schedule, so the bound is asserted as the count it is
   * derived from.
   */
  it("stops the pair SCAN at the ceiling no findingCap can lift, and says so", async () => {
    const crawlId = await newCrawl({ findingCap: null });
    const rows = [];
    for (let i = 0; i < 450; i++) {
      const url = `${SITE}/c/${String(i).padStart(4, "0")}`;
      rows.push(
        mkPage({
          id: `page_${randomUUID()}`,
          crawlId,
          url,
          urlNormalised: url,
          canonicalHtml: url,
          contentHash: `ceil-${String(i)}`,
          simhash: 0n,
        }),
      );
    }
    await db.insert(pages).values(rows);

    const found = await rule(contentRules, "content.near-duplicate").run(
      db,
      crawlId,
      resolveRuleCaps(null),
    );
    expect(found).toHaveLength(NEAR_DUPLICATE_PAIR_CEILING);
    // Uncapped, and NOT noteless: the ceiling truncated the listing, so the
    // listing says it was truncated. A reader takes completeness from the
    // absence of this note, never from the crawl's `findingCap`.
    expect(found[NEAR_DUPLICATE_PAIR_CEILING - 1]!.evidence["truncated"]).toEqual({
      reported: NEAR_DUPLICATE_PAIR_CEILING,
      atLeast: NEAR_DUPLICATE_PAIR_CEILING + 1,
    });
  }, 180_000);

  it("takes the cap off the crawl's own row when the caller states none", async () => {
    const capped = await newCrawl({ findingCap: 3 });
    const uncapped = await newCrawl({ findingCap: null });
    await addOrphans(capped, 9);
    await addOrphans(uncapped, 9);

    const registry = new Registry();
    registry.register(rule(linkGraphRules, "links.orphan"));

    expect((await runRules(db, capped, registry)).byRule["links.orphan"]).toBe(3);
    expect((await runRules(db, uncapped, registry)).byRule["links.orphan"]).toBe(9);
  });

  it("refuses to judge a crawl whose stored cap cannot be read", async () => {
    const crawlId = await newCrawl({ findingCap: "everything" });
    await addOrphans(crawlId, 2);
    const registry = new Registry();
    registry.register(rule(linkGraphRules, "links.orphan"));
    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/findingCap/);
  });

  it("lets an explicit run option override the crawl's stored cap", async () => {
    const crawlId = await newCrawl({ findingCap: 3 });
    await addOrphans(crawlId, 9);
    const registry = new Registry();
    registry.register(rule(linkGraphRules, "links.orphan"));

    expect((await runRules(db, crawlId, registry, { findingCap: null })).byRule["links.orphan"]).toBe(
      9,
    );
    // And the row still says what the crawl was started as: an override is this
    // call's decision, not a rewrite of the crawl's.
    expect((await runRules(db, crawlId, registry)).byRule["links.orphan"]).toBe(3);
  });

  /**
   * THE PROPERTY A MODULE-LEVEL CAP WOULD NOT HAVE.
   *
   * `ApiService` serialises rules runs per crawl, and not across crawls: a
   * billed uncapped audit of one site and a 200-capped first look at another can
   * be inside `runRules` at the same moment in one process. This drives exactly
   * that — two runs over two crawls with different stored caps, started
   * together, each holding the other open at the rule boundary until both have
   * arrived — and asserts each rule invocation saw its own crawl's budget.
   *
   * The rendezvous is what makes it a test rather than a coincidence: without
   * it the two runs could complete one after the other and a module variable
   * would pass.
   */
  it("keeps two concurrent runs of different crawls on their own caps", { timeout: 180_000 }, async () => {
    const a = await newCrawl({ findingCap: 2 });
    const b = await newCrawl({ findingCap: null });
    await addOrphans(a, 6);
    await addOrphans(b, 6);

    let release!: () => void;
    const bothHere = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const seen = new Map<string, RuleCaps | undefined>();

    const spy: QueryRule = {
      kind: "query",
      id: "test.caps-spy",
      checkIds: ["CHECK-01"],
      category: "technical",
      severity: "info",
      title: "Caps spy",
      explanation: "Records the caps its run was given, so two runs can be compared.",
      howToFix: "Do not ship it.",
      rulesetVersion: RULESET_VERSION,
      run: async (_db, crawlId, caps): Promise<Finding[]> => {
        seen.set(crawlId, caps);
        // Both runs park here until the other has recorded its own caps, so the
        // two are genuinely overlapping when the assertion is made.
        waiting += 1;
        if (waiting >= 2) release();
        await bothHere;
        return [];
      },
    };

    const registry = new Registry();
    registry.register(spy);
    registry.register(rule(linkGraphRules, "links.orphan"));
    // Resolve the rendezvous even if only one run reaches the rule, so a
    // regression shows up as a failed assertion rather than as a hang.
    const timer = setTimeout(release, 20_000);

    const [ra, rb] = await Promise.all([
      runRules(db, a, registry),
      runRules(db, b, registry),
    ]);
    clearTimeout(timer);

    expect(seen.get(a)).toEqual({
      listing: 2,
      nearDuplicatePairs: 2,
      nearDuplicatePairCeiling: NEAR_DUPLICATE_PAIR_CEILING,
    });
    expect(seen.get(b)).toEqual({
      listing: null,
      nearDuplicatePairs: null,
      nearDuplicatePairCeiling: NEAR_DUPLICATE_PAIR_CEILING,
    });
    // And the findings each run wrote are its own crawl's, not the other's.
    expect(ra.byRule["links.orphan"]).toBe(2);
    expect(rb.byRule["links.orphan"]).toBe(6);
    const rows = await db.select().from(issues).where(eq(issues.crawlId, a));
    expect(rows.filter((r) => r.ruleId === "links.orphan")).toHaveLength(2);
  });
});
