/**
 * The content rules — soft-404 and duplicate content — against a real database.
 *
 * Rows are inserted directly (the url-hygiene pattern): what is under test is
 * what the rules make of the content signals the crawler stored, not the
 * crawling that produced them. Two things are deliberately NOT hand-waved:
 *
 *  - every simhash in this file comes from `simhash64` over real text, stored
 *    exactly as `PageWriter` stores it (`BigInt.asIntN(64, …)`). The banding
 *    and `bit_count` arithmetic in the rules runs on the SIGNED value, so a
 *    test that invented round numbers would never exercise the sign, and the
 *    round trip analyzer -> column -> SQL is the thing most likely to break.
 *    The base text below hashes to a NEGATIVE signed bigint on purpose.
 *  - the notfound probe blob is typed as `NotFoundProbeEvidence`, so a test
 *    cannot describe a probe the crawl loop could never have written.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { NotFoundProbeEvidence } from "../../src/crawl/loop.js";
import { hammingDistance, simhash64 } from "../../src/crawl/parse/simhash.js";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import {
  DUPLICATE_SAMPLE_URLS,
  NEAR_DUPLICATE_HAMMING,
  NEAR_DUPLICATE_PAIR_CAP,
  SOFT_404_WORDS,
  TEMPLATE_HAMMING,
  contentRules,
} from "../../src/rules/query/content.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://content.example";
const url = (path: string): string => `${SITE}${path}`;

/**
 * Real page text, and three variants of it. The distances between them are
 * asserted below rather than assumed: these strings are the only thing standing
 * between the rules' thresholds and a test that passes for the wrong reason.
 */
const RETURNS = [
  "Returns and exchanges. You have thirty days from the day your order arrives to send anything back,",
  "as long as it is unused and still has its tags attached. Start the return in your account and we will",
  "email you a prepaid label; drop the parcel at any collection point and keep the receipt until the refund",
  "lands. Refunds go back to the original payment method within five working days of the parcel reaching",
  "our warehouse, and we will email you when the inspection is done. Exchanges are handled as a return plus",
  "a fresh order, so the replacement ships as soon as your card is authorised rather than waiting for the",
  "original parcel to arrive. Damaged or incorrect items are always our cost: send a photograph with your",
  "order number and we will arrange a courier collection and a replacement on the same day.",
].join(" ");

/** The same page with two words changed — 3 bits away, inside every threshold. */
const RETURNS_EDITED = RETURNS.replace("same day", "next day");
/** A larger edit — 6 bits away: outside the near-duplicate band, inside neither. */
const RETURNS_REWRITTEN = RETURNS.replace("five working days", "three working days");
/** A different page altogether. */
const SIZING = [
  "Sizing guide. Our shoes run a little narrow, so if you are between sizes we suggest taking the larger",
  "of the two. Every measurement below is taken from the inside of the shoe with the insole removed, in",
  "centimetres, and each style is listed separately because the lasts differ between the trail range and",
  "the road range. If you are unsure, measure your foot at the end of the day when it is at its largest,",
  "stand with your weight on it, and compare against the table rather than against your usual size.",
].join(" ");

/** What `PageWriter` puts in the column: the analyzer's value, signed. */
const stored = (text: string): bigint => BigInt.asIntN(64, simhash64(text));

const byId = new Map(contentRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in contentRules`);
  return r;
}

describe("the test corpus", () => {
  // The rules' thresholds are meaningless unless these distances are what the
  // tests below assume. Asserted first, so a change to `simhash64` or to the
  // prose fails here — naming the corpus — rather than as a puzzling silence
  // three describes down.
  it("holds texts at the distances the thresholds are about", () => {
    const base = simhash64(RETURNS);
    expect(hammingDistance(base, simhash64(RETURNS_EDITED))).toBe(3);
    expect(hammingDistance(base, simhash64(RETURNS_REWRITTEN))).toBe(6);
    expect(hammingDistance(base, simhash64(SIZING))).toBeGreaterThan(32);
  });

  it("stores the base text as a negative signed bigint", () => {
    // The sign is the point: `bit_count((a.simhash # b.simhash)::bit(64))` and
    // the four band comparisons all run on the signed value, and a corpus that
    // only ever produced positive bigints would never prove they do.
    expect(stored(RETURNS)).toBeLessThan(0n);
  });
});

describe("contentRules metadata", () => {
  it("defines the three rules of the plan's table", () => {
    expect(contentRules.map((r) => r.id).sort()).toEqual([
      "content.exact-duplicate",
      "content.near-duplicate",
      "content.soft-404",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(contentRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "content.soft-404": [["CHECK-13"], "warning", "content"],
      "content.exact-duplicate": [["CHECK-39"], "warning", "content"],
      "content.near-duplicate": [["CHECK-39"], "warning", "content"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of contentRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(contentRules.length);
  });
});

describe("the content rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    /** The visible text: its simhash and (by default) its hash go in the row. */
    text?: string;
    /** Overrides the hash derived from `text` — how two pages become exact duplicates. */
    contentHash?: string | null;
    wordCount?: number;
    /**
     * The renderable word count — what `content.soft-404`'s length ceiling
     * reads. Undefined means "the same as `wordCount`", the shape of a page
     * with nothing hidden; an explicit null is a row a pre-P7 crawl wrote,
     * which SQL drops from the phrase path rather than judging on the other
     * column.
     */
    renderableWordCount?: number | null;
    hasSoft404Phrases?: boolean;
    pageType?: string;
  }

  async function newCrawl(probe?: NotFoundProbeEvidence): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
      // Undefined leaves the column null: the crawl never reached the probe.
      notfoundProbe: probe,
    });
    createdCrawls.push(id);
    return id;
  }

  /** The probe as the loop writes it when the site answered 200 with `text`. */
  function probeServing(text: string): NotFoundProbeEvidence {
    return {
      probeUrl: url("/__ariadne-404-probe-x"),
      statusCode: 200,
      fetchClass: "ok",
      wordCount: text.split(" ").length,
      simhash: String(stored(text)),
    };
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      const text = s.text ?? null;
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: normalised,
        pageType: s.pageType ?? "/:slug",
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        robotsMeta: s.robotsMeta ?? null,
        xRobotsTag: s.xRobotsTag ?? null,
        // The writer derives both from the same analysis, so a row has both or
        // neither. `contentHash` overrides only which pages count as exact
        // duplicates of each other.
        contentHash: s.contentHash === undefined ? (text === null ? null : `h:${text}`) : s.contentHash,
        simhash: text === null ? null : stored(text),
        wordCount: s.wordCount ?? (text === null ? null : text.split(" ").length),
        renderableWordCount:
          s.renderableWordCount === undefined
            ? (s.wordCount ?? (text === null ? null : text.split(" ").length))
            : s.renderableWordCount,
        hasSoft404Phrases: s.hasSoft404Phrases ?? false,
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
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("content.soft-404", () => {
    const ID = "content.soft-404";

    it("is silent on a healthy page with neither signal", async () => {
      const crawlId = await newCrawl(probeServing(SIZING));
      await addPages(crawlId, [{ path: "/returns", text: RETURNS, wordCount: 800 }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires on the phrase signal alone, naming it and the word count", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/gone", text: SIZING, wordCount: 80, hasSoft404Phrases: true },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/gone"),
        pageUrl: url("/gone"),
        dedupeKey: url("/gone"),
      });
      // No probe: the template signal was not available, so it is not named and
      // no distance is quoted. The rule still ran.
      expect(found[0]!.evidence).toEqual({
        signals: ["phrases"],
        wordCount: 80,
        renderableWordCount: 80,
      });
    });

    it("is silent when a long page merely contains the phrases", async () => {
      // A real article about broken links says "page not found" too. The word
      // count is what separates the two, and with no probe there is no second
      // signal to fall back on.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/article", text: RETURNS, wordCount: 500, hasSoft404Phrases: true },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires on the template signal alone, quoting the distance", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      const ids = await addPages(crawlId, [
        // Long, no phrases: the phrase path cannot fire. It is 3 bits from the
        // template the site served for a URL that cannot exist.
        { path: "/product/x", text: RETURNS_EDITED, wordCount: 500 },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageId).toBe(ids.get("/product/x"));
      expect(found[0]!.evidence).toEqual({
        signals: ["template-match"],
        wordCount: 500,
        renderableWordCount: 500,
        hammingToTemplate: 3,
      });
    });

    it("names both signals when both fire", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      await addPages(crawlId, [
        { path: "/product/y", text: RETURNS_EDITED, wordCount: 90, hasSoft404Phrases: true },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        signals: ["phrases", "template-match"],
        wordCount: 90,
        renderableWordCount: 90,
        hammingToTemplate: 3,
      });
    });

    it("does not fire on a page further from the template than the threshold", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      await addPages(crawlId, [{ path: "/rewritten", text: RETURNS_REWRITTEN, wordCount: 500 }]);
      expect(TEMPLATE_HAMMING).toBe(4);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("ignores a probe that did not answer 200: there is no template in a 404", async () => {
      // The healthy site. Its probe URL 404s, so the site has no soft-404
      // template at all and the template path cannot fire — but the phrase path
      // still runs, which is what the page below proves.
      const crawlId = await newCrawl({
        probeUrl: url("/__ariadne-404-probe-x"),
        statusCode: 404,
        fetchClass: "client_error",
        wordCount: null,
        simhash: null,
      });
      await addPages(crawlId, [
        { path: "/looks-like-the-template", text: RETURNS, wordCount: 500 },
        { path: "/gone", text: SIZING, wordCount: 80, hasSoft404Phrases: true },
      ]);

      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/gone")]);
      expect(found[0]!.evidence).toEqual({
        signals: ["phrases"],
        wordCount: 80,
        renderableWordCount: 80,
      });
    });

    it("still runs the phrase path when the probe was skipped", async () => {
      // `{ skipped }` is the loop saying the sample was not taken. That removes
      // one signal, not the rule: a page whose phrases and length both say
      // soft-404 is still a finding, and the evidence quotes no distance.
      const crawlId = await newCrawl({ skipped: "crawl cancelled before the known-404 probe" });
      await addPages(crawlId, [
        { path: "/gone", text: SIZING, wordCount: 80, hasSoft404Phrases: true },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({
        signals: ["phrases"],
        wordCount: 80,
        renderableWordCount: 80,
      });
    });

    it("stays silent on a page that is not indexable or did not answer 200", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      await addPages(crawlId, [
        { path: "/noindex", text: RETURNS_EDITED, wordCount: 80, hasSoft404Phrases: true, robotsMeta: "noindex" },
        { path: "/404", text: RETURNS_EDITED, wordCount: 80, hasSoft404Phrases: true, statusCode: 404, fetchClass: "client_error" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("uses the word-count threshold the copy quotes", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/under", text: SIZING, wordCount: SOFT_404_WORDS - 1, hasSoft404Phrases: true },
        { path: "/at", text: SIZING, wordCount: SOFT_404_WORDS, hasSoft404Phrases: true },
      ]);
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/under")]);
    });

    it("measures that threshold against the renderable count, not the raw one", async () => {
      // The soft 404 rendered into the site's own shell: 42 words of "we could
      // not find that page" inside 780 words of mega-menu, currency picker and
      // closed accordions. The raw column puts it 480 words above a ceiling
      // meant to catch exactly this page — a false negative in the phase's own
      // direction — while the renderable one puts it 258 below.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/shelled-404", text: SIZING, wordCount: 780, renderableWordCount: 42, hasSoft404Phrases: true },
        // And the converse, so the swap is not a licence to fire: a long
        // article about broken links stays silent on both counts.
        { path: "/article", text: RETURNS, wordCount: 900, renderableWordCount: 850, hasSoft404Phrases: true },
      ]);

      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/shelled-404")]);
      expect(found[0]!.evidence).toEqual({
        signals: ["phrases"],
        wordCount: 780,
        renderableWordCount: 42,
      });
    });

    it("does not judge a pre-P7 row on the other column — it leaves it to the skip rule", async () => {
      // A word count under the ceiling, no renderable count, the wording
      // present. `null < 300` is NULL, so SQL drops the row and this rule says
      // nothing about it: a coalesce here would be the silent wrong-column
      // fallback `content.thin` refuses by name one file away. The page is not
      // passed over in silence either — `content.thin-skipped` reports it.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/pre-p7", text: SIZING, wordCount: 80, renderableWordCount: null, hasSoft404Phrases: true },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("caps the list and still says how many pages there are", async () => {
      const crawlId = await newCrawl();
      const total = URL_FINDING_CAP + 3;
      await addPages(
        crawlId,
        Array.from({ length: total }, (_, i) => ({
          path: `/gone/${String(i).padStart(4, "0")}`,
          text: SIZING,
          wordCount: 20,
          hasSoft404Phrases: true,
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total,
      });
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });

    it("refuses a notfound probe blob it cannot read", async () => {
      const id = `crawl_${randomUUID()}`;
      await db.insert(crawls).values({
        id,
        siteUrl: SITE,
        config: { userAgent: "AriadneBot-test" },
        rulesetVersion: "test",
        status: "finished",
        discovery: mkDiscovery(),
        // A blob nothing of ours wrote: the simhash arrived as a number rather
        // than the signed decimal string the loop stores. Casting it would put
        // a `[object Object]`-shaped value into a bigint comparison; validating
        // it names the crawl.
        notfoundProbe: { probeUrl: url("/x"), statusCode: 200, fetchClass: "ok", wordCount: 5, simhash: 12 },
      });
      createdCrawls.push(id);
      await expect(run(ID, id)).rejects.toThrow(/notfound probe evidence/);
    });
  });

  describe("content.exact-duplicate", () => {
    const ID = "content.exact-duplicate";

    it("is silent when every page has its own content", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS },
        { path: "/b", text: SIZING },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports one finding per group, landing on the first member", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/returns", text: RETURNS, contentHash: "same", pageType: "/:slug" },
        { path: "/help/returns", text: RETURNS, contentHash: "same", pageType: "/help/:slug" },
        { path: "/sizing", text: SIZING },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/help/returns"),
        pageUrl: url("/help/returns"),
        dedupeKey: "same",
      });
      expect(found[0]!.evidence).toEqual({
        contentHash: "same",
        urls: [url("/help/returns"), url("/returns")],
        count: 2,
        pageTypes: ["/:slug", "/help/:slug"],
      });
    });

    it("counts only indexable 200 pages", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live", text: RETURNS, contentHash: "same" },
        { path: "/noindex", text: RETURNS, contentHash: "same", robotsMeta: "noindex" },
        { path: "/gone", text: RETURNS, contentHash: "same", statusCode: 404, fetchClass: "client_error" },
      ]);
      // One indexable member left: a group of one is not a duplicate.
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("never groups pages the analyzer produced no hash for", async () => {
      // A null hash means no analysis ran. Postgres groups nulls together, so
      // without the filter these two would be reported as identical pages on
      // the strength of knowing nothing about either.
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/x" }, { path: "/y" }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("quotes at most twenty URLs and always the exact count", async () => {
      const crawlId = await newCrawl();
      const members = DUPLICATE_SAMPLE_URLS + 5;
      await addPages(
        crawlId,
        Array.from({ length: members }, (_, i) => ({
          path: `/copy/${String(i).padStart(3, "0")}`,
          text: RETURNS,
          contentHash: "same",
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence["urls"]).toHaveLength(DUPLICATE_SAMPLE_URLS);
      expect(found[0]!.evidence["count"]).toBe(members);
    });

    it("does not read another crawl's pages into this crawl's groups", async () => {
      const mine = await newCrawl();
      const yours = await newCrawl();
      await addPages(mine, [{ path: "/x", text: RETURNS, contentHash: "same" }]);
      await addPages(yours, [{ path: "/y", text: RETURNS, contentHash: "same" }]);
      expect(await run(ID, mine)).toHaveLength(0);
    });

    it("caps the number of groups and still says how many there are", async () => {
      const crawlId = await newCrawl();
      const groups = URL_FINDING_CAP + 2;
      await addPages(
        crawlId,
        Array.from({ length: groups }, (_, i) => [
          { path: `/g${String(i).padStart(4, "0")}/a`, text: RETURNS, contentHash: `h${i}` },
          { path: `/g${String(i).padStart(4, "0")}/b`, text: RETURNS, contentHash: `h${i}` },
        ]).flat(),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total: groups,
      });
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("content.near-duplicate", () => {
    const ID = "content.near-duplicate";

    it("is silent when two pages are genuinely different", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/returns", text: RETURNS },
        { path: "/sizing", text: SIZING },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports the pair, the distance, and the two page types", async () => {
      // The whole round trip: `simhash64` in this process, `BigInt.asIntN(64, …)`
      // into a signed bigint column, four band comparisons and a `bit_count`
      // XOR in Postgres — and a distance that agrees with `hammingDistance`.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/returns", text: RETURNS, pageType: "/:slug" },
        { path: "/help/returns", text: RETURNS_EDITED, pageType: "/help/:slug" },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        // The pair is reported in URL order, and lands on the first of them.
        pageId: ids.get("/help/returns"),
        pageUrl: url("/help/returns"),
      });
      expect(found[0]!.evidence).toEqual({
        urlA: url("/help/returns"),
        urlB: url("/returns"),
        hamming: 3,
        pageTypeA: "/help/:slug",
        pageTypeB: "/:slug",
      });
      expect(found[0]!.dedupeKey.length).toBeGreaterThan(0);
    });

    it("gives the same pair the same dedupe key however the rows are ordered", async () => {
      const first = await newCrawl();
      const second = await newCrawl();
      await addPages(first, [
        { path: "/returns", text: RETURNS },
        { path: "/help/returns", text: RETURNS_EDITED },
      ]);
      // Inserted in the other order, so the ids — and therefore the join's
      // a/b assignment — come out the other way round.
      await addPages(second, [
        { path: "/help/returns", text: RETURNS_EDITED },
        { path: "/returns", text: RETURNS },
      ]);

      const [a] = await run(ID, first);
      const [b] = await run(ID, second);
      expect(a!.dedupeKey).toBe(b!.dedupeKey);
      expect(a!.evidence).toEqual(b!.evidence);
    });

    it("does not report a pair further apart than the band", async () => {
      expect(NEAR_DUPLICATE_HAMMING).toBe(3);
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/returns", text: RETURNS },
        { path: "/rewritten", text: RETURNS_REWRITTEN },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("leaves exact duplicates to the rule that reports them", async () => {
      // Identical text: distance 0, which is inside the band. They are excluded
      // because they share a content hash, so one pair of pages never produces
      // two findings saying the same thing.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, contentHash: "same" },
        { path: "/b", text: RETURNS, contentHash: "same" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
      expect(await run("content.exact-duplicate", crawlId)).toHaveLength(1);
    });

    it("reports identical text served with different hashes as a near duplicate", async () => {
      // The complement of the case above: same simhash, different content hash
      // (a page whose text differs only where the hash sees it). Distance 0, no
      // exact-duplicate group, so this rule is the one that speaks.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, contentHash: "one" },
        { path: "/b", text: RETURNS, contentHash: "two" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence["hamming"]).toBe(0);
    });

    it("counts only indexable 200 pages", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/live", text: RETURNS },
        { path: "/noindex", text: RETURNS_EDITED, robotsMeta: "noindex" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("does not pair pages from two different crawls", async () => {
      const mine = await newCrawl();
      const yours = await newCrawl();
      await addPages(mine, [{ path: "/x", text: RETURNS }]);
      await addPages(yours, [{ path: "/y", text: RETURNS_EDITED }]);
      expect(await run(ID, mine)).toHaveLength(0);
    });

    it("caps the pairs and says the list was cut, without inventing a total", async () => {
      // 33 pages one bit apart from nothing — same text, distinct hashes — are
      // 528 pairs. The rule reports 500 and says so; it does NOT claim to know
      // the total, because counting every pair is the unbounded scan the cap
      // exists to avoid.
      const crawlId = await newCrawl();
      await addPages(
        crawlId,
        Array.from({ length: 33 }, (_, i) => ({
          path: `/copy/${String(i).padStart(3, "0")}`,
          text: RETURNS,
          contentHash: `h${i}`,
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(NEAR_DUPLICATE_PAIR_CAP);
      expect(found[NEAR_DUPLICATE_PAIR_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: NEAR_DUPLICATE_PAIR_CAP,
        atLeast: NEAR_DUPLICATE_PAIR_CAP + 1,
      });
      // Every reported pair is a real pair, whatever the join's order was.
      for (const f of found) {
        expect(f.evidence["hamming"]).toBe(0);
        expect(String(f.evidence["urlA"]) < String(f.evidence["urlB"])).toBe(true);
      }
      expect(new Set(found.map((f) => f.dedupeKey)).size).toBe(NEAR_DUPLICATE_PAIR_CAP);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });
});
