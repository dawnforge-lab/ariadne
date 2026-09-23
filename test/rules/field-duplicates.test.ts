/**
 * The field-level duplicate rules — title, meta description, H1 text — against
 * a real database.
 *
 * Rows are inserted directly (the url-hygiene and content-query pattern): what
 * is under test is what the rules make of the values the crawler stored, not the
 * crawling that produced them. The harness (test/fixtures/harness.test.ts) is
 * where the same rules run over pages a real crawl fetched.
 *
 * Every group asserted below is hand-derived from the page table printed beside
 * it, and the negative cases are the point of the file: a rule that grouped
 * near-matches, or grouped the pages that have no title at all, would pass a
 * suite made only of positives.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { hreflang, pages } from "../../src/db/schema.js";
import { DUPLICATE_SAMPLE_URLS } from "../../src/rules/query/content.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { fieldDuplicateRules } from "../../src/rules/query/field-duplicates.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { databaseUrl, dropCrawls, newMetricCrawl } from "./metric-db.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

const SITE = "https://duplicates.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(fieldDuplicateRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in fieldDuplicateRules`);
  return r;
}

const TITLE = "title.duplicate";
const META = "meta-description.duplicate";
const H1 = "h1.duplicate-text";
const H1_SKIPPED = "h1.duplicate-skipped";

describe("fieldDuplicateRules metadata", () => {
  it("defines the three duplicate rules and the heading skip", () => {
    expect(fieldDuplicateRules.map((r) => r.id)).toEqual([TITLE, META, H1, H1_SKIPPED]);
  });

  it("claims the checklist ids, severities and categories the task assigns", () => {
    expect(
      Object.fromEntries(
        fieldDuplicateRules.map((r) => [r.id, [r.checkIds, r.severity, r.category, r.kind]]),
      ),
    ).toEqual({
      [TITLE]: [["CHECK-35"], "warning", "on-page", "query"],
      [META]: [["CHECK-36"], "warning", "on-page", "query"],
      [H1]: [["CHECK-37"], "warning", "on-page", "query"],
      // The skip is a statement about the CRAWL, not a fault on the site, so it
      // is info — and it claims the same check as the rule it stands in for.
      [H1_SKIPPED]: [["CHECK-37"], "info", "on-page", "query"],
    });
  });

  it("every rule carries its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of fieldDuplicateRules) {
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.howToFix.length, r.id).toBeGreaterThan(30);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    // Four rules, four titles: the skip must not render under the finding's
    // headline, which is the whole reason it is a separate rule id.
    expect(titles.size).toBe(fieldDuplicateRules.length);
  });
});

describe("the field duplicate rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    title?: string | null;
    metaDescription?: string | null;
    h1Text?: string | null;
    /** How many `<h1>` elements the page carried. Defaults to 1 where there is text. */
    h1Count?: number;
    /**
     * The page's `<link rel=canonical>`, absolute. Omitted means none declared,
     * which is "not canonicalised elsewhere" and therefore judged (Phase 22 §1).
     */
    canonical?: string;
  }

  /** One `<link rel=alternate hreflang>` declaration, as the crawler stores it. */
  interface HreflangSpec {
    from: string;
    code: string;
    to: string;
  }

  async function addHreflang(crawlId: string, ids: Map<string, string>, specs: HreflangSpec[]):
    Promise<void> {
    await db.insert(hreflang).values(
      specs.map((h) => {
        const pageId = ids.get(h.from);
        if (pageId === undefined) throw new Error(`no page '${h.from}' in this crawl`);
        return {
          crawlId,
          pageId,
          hreflangCode: h.code,
          targetUrl: url(h.to),
          // Written null by the crawler for every row; the cluster CTE joins on
          // the URL, exactly as the hreflang rules do.
          targetPageId: null,
          source: "html",
        };
      }),
    );
  }

  const newCrawl = async (): Promise<string> =>
    newMetricCrawl(db, SITE, createdCrawls, {
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
    });

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      const h1Text = s.h1Text === undefined ? null : s.h1Text;
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: normalised,
        pageType: "/:slug",
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        robotsMeta: s.robotsMeta ?? null,
        xRobotsTag: s.xRobotsTag ?? null,
        title: s.title === undefined ? null : s.title,
        metaDescription: s.metaDescription === undefined ? null : s.metaDescription,
        h1Text,
        // The writer stores a count and the text off the same parse, so a row
        // with text has an h1. A spec that says otherwise is describing the
        // pre-Phase-7 row, which is what the skip rule is about.
        h1Count: s.h1Count ?? (h1Text === null ? 0 : 1),
        canonicalHtml: s.canonical ?? null,
        depth: 1,
        discoveredVia: "link",
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  const run = (id: string, crawlId: string): Promise<Finding[]> => rule(id).run(db, crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await dropCrawls(db, createdCrawls);
    await closeDb(db);
  });

  it("every rule refuses a crawl id nothing knows", async () => {
    // An unknown crawl groups nothing, and "no duplicates" is what a healthy
    // site looks like. Four rules, four `assertCrawl` gates (hard rule 7).
    const missing = `crawl_${randomUUID()}`;
    for (const r of fieldDuplicateRules) {
      await expect(r.run(db, missing), r.id).rejects.toThrow(/no such crawl/);
    }
  });

  describe("title.duplicate", () => {
    /**
     * THE CATALOGUE UNDER TEST. Six indexable pages, three titles:
     *
     *   /shoes/marathon   "Blue Running Shoes | Sole Mates"   <- group of 3
     *   /shoes/sprint     "Blue Running Shoes | Sole Mates"
     *   /shoes/trail      "Blue Running Shoes | Sole Mates"
     *   /bags/tote        "Blue Running Shoes | Sole Mate"    <- one character off
     *   /about            "About Sole Mates"                  <- unique
     *   /contact          "About Sole Mates "                 <- the same, trimmed
     *
     * Two groups: the three shoes, and `/about` with `/contact`. The bag is in
     * neither — this rule states exact equality and nothing softer.
     */
    const SHARED = "Blue Running Shoes | Sole Mates";
    const SPECS: PageSpec[] = [
      { path: "/shoes/marathon", title: SHARED },
      { path: "/shoes/sprint", title: SHARED },
      { path: "/shoes/trail", title: SHARED },
      { path: "/bags/tote", title: "Blue Running Shoes | Sole Mate" },
      { path: "/about", title: "About Sole Mates" },
      { path: "/contact", title: "  About Sole Mates " },
    ];

    it("reports one finding per group, on the group's first URL, with the whole group counted", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, SPECS);

      const found = await run(TITLE, crawlId);
      // Groups are ordered by their own first URL: `/about` before `/shoes/…`.
      expect(found.map((f) => f.pageUrl)).toEqual([url("/about"), url("/shoes/marathon")]);

      expect(found[0]!).toMatchObject({
        ruleId: TITLE,
        severity: "warning",
        pageId: ids.get("/about"),
        pageUrl: url("/about"),
      });
      // The trimmed value, once: `/contact` declares the same title with
      // whitespace either side, which is a difference no reader and no search
      // result can see.
      expect(found[0]!.evidence).toEqual({
        title: "About Sole Mates",
        count: 2,
        pages: [url("/about"), url("/contact")],
        // No hreflang on this crawl, so no URL was folded into another — and
        // the key is carried anyway, so a reader never has to guess whether a
        // group of two was really a group of three (Phase 22 §2).
        alternatesCollapsed: 0,
      });

      expect(found[1]!.pageId).toBe(ids.get("/shoes/marathon"));
      expect(found[1]!.evidence).toEqual({
        title: SHARED,
        count: 3,
        // Alphabetical, and the same three on every run.
        pages: [url("/shoes/marathon"), url("/shoes/sprint"), url("/shoes/trail")],
        alternatesCollapsed: 0,
      });
    });

    it("does not group titles that merely resemble each other", async () => {
      // `/bags/tote` is one character from the shared title. A rule that grouped
      // it would be making a similarity claim with no measurement behind it —
      // which is `content.near-duplicate`'s job, over a distance it can quote.
      const crawlId = await newCrawl();
      await addPages(crawlId, SPECS);
      const found = await run(TITLE, crawlId);
      const grouped = found.flatMap((f) => (f.evidence as { pages: string[] }).pages);
      expect(grouped).not.toContain(url("/bags/tote"));
    });

    it("never groups the pages that have no title at all", async () => {
      // Postgres groups nulls together. Without the guard these three would be
      // reported as sharing a title — a finding built on the absence of the
      // thing being compared, and a second, wrong-copy report of what
      // `title.missing` already says about each of them.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", title: null },
        { path: "/b", title: null },
        { path: "/c", title: "   " },
        { path: "/d", title: "" },
      ]);
      expect(await run(TITLE, crawlId)).toEqual([]);
    });

    it("compares indexable 200s only, and does not count the others in the group", async () => {
      // Four pages carry the title; two of them are out of the index or were
      // never a page. What is left is a group of two, and the count says two —
      // the excluded pages are not quietly in the number.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live-a", title: SHARED },
        { path: "/live-b", title: SHARED },
        { path: "/noindexed", title: SHARED, robotsMeta: "noindex, follow" },
        { path: "/gone", title: SHARED, statusCode: 404, fetchClass: "client_error" },
      ]);

      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        title: SHARED,
        count: 2,
        pages: [url("/live-a"), url("/live-b")],
        alternatesCollapsed: 0,
      });
    });

    it("stays silent when one indexable page is left carrying the title", async () => {
      // The other half of the cohort filter: with the duplicates out of the
      // index there is no duplicate left, and a finding here would be reporting
      // a page for sharing a title with a page nobody can find.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live", title: SHARED },
        { path: "/noindexed", title: SHARED, robotsMeta: "noindex" },
      ]);
      expect(await run(TITLE, crawlId)).toEqual([]);
    });

    it("counts the whole template floor and lists a bounded, ordered sample of it", async () => {
      // The shape the first real audit met: one title written by one template
      // over a whole section. The COUNT is the finding — it is what says the
      // problem is a template rather than a page — and the URL list is a sample
      // that cannot grow with the site (hard rule 3).
      const crawlId = await newCrawl();
      const size = DUPLICATE_SAMPLE_URLS + 5;
      await addPages(
        crawlId,
        // Two-digit paths so alphabetical order is numeric order and the
        // expectation below can be written as a slice.
        Array.from({ length: size }, (_, i) => ({
          path: `/p/${String(i).padStart(2, "0")}`,
          title: SHARED,
        })),
      );

      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      const evidence = found[0]!.evidence as { count: number; pages: string[] };
      expect(evidence.count).toBe(size);
      expect(evidence.pages).toHaveLength(DUPLICATE_SAMPLE_URLS);
      expect(evidence.pages).toEqual(
        Array.from({ length: DUPLICATE_SAMPLE_URLS }, (_, i) =>
          url(`/p/${String(i).padStart(2, "0")}`),
        ),
      );
      // The listing was not capped — one group — so no truncation note rides on
      // it. The sample inside a finding and the cap on the findings list are
      // different things, and only the second writes a note.
      expect(evidence).not.toHaveProperty("truncated");
    });

    it("stops listing groups at the cap and states the exact total behind it", async () => {
      // `URL_FINDING_CAP + 3` groups of two. The scan runs to completion, so the
      // total is exact (`noteTruncation`) rather than a lower bound.
      const crawlId = await newCrawl();
      const groups = URL_FINDING_CAP + 3;
      await addPages(
        crawlId,
        Array.from({ length: groups }, (_, i) => i).flatMap((i) => {
          const title = `Group ${String(i).padStart(4, "0")}`;
          return [
            { path: `/g/${String(i).padStart(4, "0")}/a`, title },
            { path: `/g/${String(i).padStart(4, "0")}/b`, title },
          ];
        }),
      );

      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[found.length - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total: groups,
      });
      // And the cap kept the FIRST groups in URL order, not an arbitrary two
      // hundred: the same crawl judged twice reports the same list.
      expect(found[0]!.pageUrl).toBe(url("/g/0000/a"));
      expect(found[URL_FINDING_CAP - 1]!.pageUrl).toBe(
        url(`/g/${String(URL_FINDING_CAP - 1).padStart(4, "0")}/a`),
      );
    });

    it("keys each group by its value, so a group is one row however often it is judged", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, SPECS);
      const first = await run(TITLE, crawlId);
      const second = await run(TITLE, crawlId);
      // Stable across runs (the `issues` unique index is per crawl, rule and
      // key), and distinct between groups — two groups sharing a key would
      // collide on insert and one of them would be lost.
      expect(second.map((f) => f.dedupeKey)).toEqual(first.map((f) => f.dedupeKey));
      expect(new Set(first.map((f) => f.dedupeKey)).size).toBe(first.length);
      // The value itself is not the key: a title can be far longer than a
      // sensible index entry, and the evidence is where a reader reads it.
      expect(first[1]!.dedupeKey).not.toContain("Blue Running Shoes");
      expect(first[1]!.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("meta-description.duplicate", () => {
    const SHARED =
      "Fresh, seasonal, and made locally every morning, then delivered to your door. Order today.";

    it("groups the shared description and nothing else", async () => {
      /**
       *   /bakery   the shared sentence          <- group of 2
       *   /florist  the shared sentence
       *   /studio   the same sentence, trimmed   <- so, group of 3
       *   /news     a description of its own
       *   /legal    no description at all
       */
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/bakery", metaDescription: SHARED },
        { path: "/florist", metaDescription: SHARED },
        { path: "/studio", metaDescription: ` ${SHARED} ` },
        { path: "/news", metaDescription: "What we baked this week, and who came to eat it." },
        { path: "/legal", metaDescription: null },
      ]);

      const found = await run(META, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageId).toBe(ids.get("/bakery"));
      expect(found[0]!.evidence).toEqual({
        metaDescription: SHARED,
        count: 3,
        pages: [url("/bakery"), url("/florist"), url("/studio")],
        alternatesCollapsed: 0,
      });
    });

    it("is silent on a site whose descriptions are all its own", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", metaDescription: "One honest sentence about the first page." },
        { path: "/b", metaDescription: "One honest sentence about the second page." },
      ]);
      expect(await run(META, crawlId)).toEqual([]);
    });

    it("does not read the title column", async () => {
      // The two rules share a body and differ only in the column they group by.
      // Pages with one shared title and five distinct descriptions must produce
      // a title finding and no description finding.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", title: "One title, twice", metaDescription: "The first description." },
        { path: "/b", title: "One title, twice", metaDescription: "The second description." },
      ]);
      expect(await run(META, crawlId)).toEqual([]);
      expect(await run(TITLE, crawlId)).toHaveLength(1);
    });
  });

  describe("h1.duplicate-text", () => {
    const SHARED = "Everything you need to know";

    it("groups by the stored heading, independently of title and description", async () => {
      // The load-bearing arrangement: the two pages sharing a heading have
      // DIFFERENT titles and descriptions, so a rule that had quietly grouped by
      // one of the other columns would report nothing here.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        {
          path: "/guides/returns",
          title: "How returns work",
          metaDescription: "Everything about sending something back to us.",
          h1Text: SHARED,
        },
        {
          path: "/guides/sizing",
          title: "How sizing works",
          metaDescription: "Everything about finding the size that fits.",
          h1Text: SHARED,
        },
        {
          path: "/guides/delivery",
          title: "How delivery works",
          metaDescription: "Everything about when the parcel arrives.",
          h1Text: "When your parcel arrives",
        },
      ]);

      const found = await run(H1, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageId).toBe(ids.get("/guides/returns"));
      expect(found[0]!.evidence).toEqual({
        h1Text: SHARED,
        count: 2,
        pages: [url("/guides/returns"), url("/guides/sizing")],
        alternatesCollapsed: 0,
      });
      // And neither of the other two rules has anything to say about the same
      // pages, which is what makes the grouping column provable.
      expect(await run(TITLE, crawlId)).toEqual([]);
      expect(await run(META, crawlId)).toEqual([]);
    });

    it("never groups the pages whose h1 is present and empty", async () => {
      // `''` is the writer saying the page HAS an h1 with no text in it (the
      // present-but-blank distinction the column carries). Grouping those would
      // report every empty heading on the site as a duplicate of every other.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", h1Text: "" },
        { path: "/b", h1Text: "" },
        { path: "/c", h1Text: "   " },
      ]);
      expect(await run(H1, crawlId)).toEqual([]);
      // And no skip either: these rows have heading text stored, it is just
      // blank, so the column was written and the check DID run.
      expect(await run(H1_SKIPPED, crawlId)).toEqual([]);
    });
  });

  describe("h1.duplicate-skipped", () => {
    it("fires once on a crawl that stored h1 counts and no h1 text", async () => {
      // The pre-Phase-7 row: `h1_text` null on every page, `h1_count` non-zero
      // because the analyzer of the day did count headings. The grouping rule
      // finds nothing, and that silence is indistinguishable from a site with no
      // duplicate headings — so the skip says which crawl this is.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", h1Text: null, h1Count: 1 },
        { path: "/b", h1Text: null, h1Count: 1 },
        { path: "/c", h1Text: null, h1Count: 2 },
        // Not in the cohort, so not in any of the three numbers.
        { path: "/gone", h1Text: null, h1Count: 1, statusCode: 404, fetchClass: "client_error" },
      ]);

      const found = await run(H1_SKIPPED, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: H1_SKIPPED,
        severity: "info",
        // Site-scoped: the reason is about the crawl, not about a URL.
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      const evidence = found[0]!.evidence as {
        skipped: string;
        indexablePages: number;
        pagesWithH1: number;
        pagesWithH1Text: number;
      };
      expect(evidence.indexablePages).toBe(3);
      expect(evidence.pagesWithH1).toBe(3);
      expect(evidence.pagesWithH1Text).toBe(0);
      expect(evidence.skipped).toMatch(/re-crawl the site/i);

      // Exactly one of the pair speaks about a crawl, and here it is the skip.
      expect(await run(H1, crawlId)).toEqual([]);
    });

    it("stays quiet on a site that genuinely carries no h1 anywhere", async () => {
      // No h1 text and no h1 elements either. The silence is then a true
      // statement about the site, `headings.h1-missing` reports each page, and a
      // skip would tell the client to re-crawl for nothing.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", h1Text: null, h1Count: 0 },
        { path: "/b", h1Text: null, h1Count: 0 },
      ]);
      expect(await run(H1_SKIPPED, crawlId)).toEqual([]);
      expect(await run(H1, crawlId)).toEqual([]);
    });

    it("stays quiet on a crawl with no indexable pages at all", async () => {
      // Nothing was measured, so nothing was skipped. A skip here would be a
      // report about a check that had no cohort to run over.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/gone", h1Text: null, h1Count: 1, statusCode: 404, fetchClass: "client_error" },
      ]);
      expect(await run(H1_SKIPPED, crawlId)).toEqual([]);
    });

    it("does not fire on a crawl where only some rows predate the column", async () => {
      // A mixed crawl runs the check over the rows that have text: the skip's
      // condition is "no page has any", and a narrower blind spot than the whole
      // check is not something this pair can describe. The two pages that do
      // carry the same heading are still reported.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/old-a", h1Text: null, h1Count: 1 },
        { path: "/old-b", h1Text: null, h1Count: 1 },
        { path: "/new-a", h1Text: "The same new heading" },
        { path: "/new-b", h1Text: "The same new heading" },
      ]);
      expect(await run(H1_SKIPPED, crawlId)).toEqual([]);
      const found = await run(H1, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        h1Text: "The same new heading",
        count: 2,
        pages: [url("/new-a"), url("/new-b")],
        alternatesCollapsed: 0,
      });
    });

    it("is silent on a healthy modern crawl", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", h1Text: "A heading of its own" },
        { path: "/b", h1Text: "Another heading entirely" },
      ]);
      expect(await run(H1_SKIPPED, crawlId)).toEqual([]);
      expect(await run(H1, crawlId)).toEqual([]);
    });
  });

  /**
   * THE JUDGED COHORT'S CANONICAL HALF (Phase 22 §1).
   *
   * The noindex half was already pinned above ("compares indexable 200s only").
   * This is the one that moved: a URL that hands its signals to another page is
   * not competing with anything, so a title it shares is the base URL's title
   * and not a duplicate. On the raelon.ca crawl this is 74 of 79 groups.
   */
  describe("pages canonicalised elsewhere", () => {
    const SHARED = "One title, several addresses";

    it("does not count a canonicalised page in a group", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live-a", title: SHARED },
        { path: "/live-b", title: SHARED },
        { path: "/live-a?variant=2", title: SHARED, canonical: url("/live-a") },
      ]);
      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        count: 2,
        pages: [url("/live-a"), url("/live-b")],
        // Not "collapsed": the variant is out of the COHORT, which is a
        // different exclusion from an hreflang alternate folded into a cluster,
        // and the two must not be reported as one number. `site.health`'s
        // `urlsCanonicalised` is where this one is counted.
        alternatesCollapsed: 0,
      });
    });

    it("is silent when the only other member is canonicalised elsewhere", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live", title: SHARED },
        { path: "/live?ref=email", title: SHARED, canonical: url("/live") },
      ]);
      expect(await run(TITLE, crawlId)).toEqual([]);
    });
  });

  /**
   * HREFLANG ALTERNATES ARE ONE MEMBER (Phase 22 §2).
   *
   * Every case below is the same two-language site with the same untranslated
   * title; what changes is what the two pages DECLARE about each other, which is
   * the whole of what the cluster CTE reads.
   */
  describe("the hreflang cluster", () => {
    const SHARED = "Refund policy";
    const EN = "/policies/refund";
    const FR = "/fr/policies/refund";

    it("collapses a reciprocal en/fr pair, so a group of two vanishes", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: EN, title: SHARED },
        { path: FR, title: SHARED },
      ]);
      await addHreflang(crawlId, ids, [
        { from: EN, code: "en", to: EN },
        { from: EN, code: "fr", to: FR },
        { from: FR, code: "en", to: EN },
        { from: FR, code: "fr", to: FR },
      ]);
      // One cluster, so one member, so no duplicate at all: the annotation is
      // exactly the mechanism that says these two ARE one page.
      expect(await run(TITLE, crawlId)).toEqual([]);
      expect(await run(META, crawlId)).toEqual([]);
    });

    it("counts a group of three with one pair in it as two, and says what it folded", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: EN, title: SHARED },
        { path: FR, title: SHARED },
        { path: "/legal/refunds", title: SHARED },
      ]);
      await addHreflang(crawlId, ids, [
        { from: EN, code: "en", to: EN },
        { from: EN, code: "fr", to: FR },
        { from: FR, code: "en", to: EN },
        { from: FR, code: "fr", to: FR },
      ]);
      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        title: SHARED,
        // Two clusters: the en/fr pair, and the third page on its own.
        count: 2,
        // One URL per cluster, the lexically first of each. `/fr/...` sorts
        // before `/legal/...` and `/policies/...`, and it is the pair's key.
        pages: [url(FR), url("/legal/refunds")],
        alternatesCollapsed: 1,
      });
    });

    it("does not collapse a one-way declaration", async () => {
      // The English page claims the French one; the French one says nothing
      // back. An unreciprocated annotation is discarded by search engines
      // (`hreflang.missing-return-link` is the rule that reports it), so the
      // two really are two pages with one title.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: EN, title: SHARED },
        { path: FR, title: SHARED },
      ]);
      await addHreflang(crawlId, ids, [
        { from: EN, code: "en", to: EN },
        { from: EN, code: "fr", to: FR },
      ]);
      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ count: 2, alternatesCollapsed: 0 });
    });

    it("does not collapse a pair that claims each other in the SAME language", async () => {
      // Two URLs both declaring themselves and the other as `en` are not a
      // translation pair. They are the same language twice — which is the
      // duplicate this rule exists to report, annotated.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/a", title: SHARED },
        { path: "/b", title: SHARED },
      ]);
      await addHreflang(crawlId, ids, [
        { from: "/a", code: "en", to: "/b" },
        { from: "/b", code: "en", to: "/a" },
      ]);
      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ count: 2, alternatesCollapsed: 0 });
    });

    it("collapses a three-language cluster to one member", async () => {
      const crawlId = await newCrawl();
      const paths = ["/en/x", "/fr/x", "/de/x"];
      const ids = await addPages(
        crawlId,
        paths.map((path) => ({ path, title: SHARED })),
      );
      const codes = ["en", "fr", "de"];
      await addHreflang(
        crawlId,
        ids,
        paths.flatMap((from) => paths.map((to, i) => ({ from, code: codes[i]!, to }))),
      );
      expect(await run(TITLE, crawlId)).toEqual([]);
    });

    /**
     * THE HUB: a page OUTSIDE the duplicate group that both members declare.
     *
     * `/a` and `/c` share a title and say nothing about each other; each is
     * reciprocal only with a hub that carries a different title and is
     * therefore not in the group at all. They are two pages competing for one
     * query, and the answer may not depend on where the hub's URL happens to
     * sort — which is exactly what the earlier one-hop key did (it folded them
     * into one when the hub sorted first and kept two when it sorted last).
     */
    for (const hub of ["/0-hub", "/z-hub"]) {
      it(`keeps two members when both declare only a hub outside the group (${hub})`, async () => {
        const crawlId = await newCrawl();
        const ids = await addPages(crawlId, [
          { path: "/a", title: SHARED },
          { path: "/c", title: SHARED },
          { path: hub, title: "A different title entirely" },
        ]);
        await addHreflang(crawlId, ids, [
          { from: "/a", code: "en", to: "/a" },
          { from: "/a", code: "fr", to: hub },
          { from: hub, code: "en", to: "/a" },
          { from: "/c", code: "en", to: "/c" },
          { from: "/c", code: "de", to: hub },
          { from: hub, code: "en", to: "/c" },
        ]);
        const found = await run(TITLE, crawlId);
        expect(found).toHaveLength(1);
        expect(found[0]!.evidence).toMatchObject({
          count: 2,
          pages: [url("/a"), url("/c")],
          alternatesCollapsed: 0,
        });
      });
    }

    /**
     * THE CHAIN: A↔B and B↔C declared, A↔C not.
     *
     * The same graph as the hub above with the middle page inside the group
     * this time, and the same principle decides it: only pages that declare
     * EACH OTHER fold. A and C never named each other, so no set of three URLs
     * here is one page, and the group keeps all three members — the honest
     * answer for a cluster broken in the way `hreflang.missing-return-link` and
     * `hreflang.missing-self-reference` report by name.
     *
     * Run twice, with the middle page's URL sorting last and then first: a
     * broken chain must not change its size because of a string comparison.
     */
    for (const middle of ["/m-mid", "/0-mid"]) {
      it(`keeps three members on a chain whose ends do not declare each other (${middle})`, async () => {
        const crawlId = await newCrawl();
        const ids = await addPages(crawlId, [
          { path: "/a", title: SHARED },
          { path: middle, title: SHARED },
          { path: "/c", title: SHARED },
        ]);
        await addHreflang(crawlId, ids, [
          { from: "/a", code: "fr", to: middle },
          { from: middle, code: "en", to: "/a" },
          { from: middle, code: "de", to: "/c" },
          { from: "/c", code: "fr", to: middle },
        ]);
        const found = await run(TITLE, crawlId);
        expect(found).toHaveLength(1);
        expect(found[0]!.evidence).toMatchObject({
          count: 3,
          alternatesCollapsed: 0,
        });
      });
    }

    it("does not fold in an alternate that is itself out of the judged cohort", async () => {
      // The French page carries a noindex, so it is not in the cohort at all
      // and cannot be a group member — and folding the English page into it
      // would key the cluster on a URL the group does not contain. The English
      // page stands on its own beside the third URL.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: EN, title: SHARED },
        { path: FR, title: SHARED, robotsMeta: "noindex" },
        { path: "/legal/refunds", title: SHARED },
      ]);
      await addHreflang(crawlId, ids, [
        { from: EN, code: "fr", to: FR },
        { from: FR, code: "en", to: EN },
      ]);
      const found = await run(TITLE, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        count: 2,
        pages: [url("/legal/refunds"), url(EN)],
        alternatesCollapsed: 0,
      });
    });
  });
});
