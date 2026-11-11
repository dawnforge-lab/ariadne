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
import { crawls, hreflang, pages } from "../../src/db/schema.js";
import {
  DUPLICATE_SAMPLE_URLS,
  NEAR_DUPLICATE_COUNT_CAP,
  NEAR_DUPLICATE_HAMMING,
  NEAR_DUPLICATE_CLOSEST,
  NEAR_DUPLICATE_MIN_MAIN_WORDS,
  SOFT_404_WORDS,
  TEMPLATE_HAMMING,
  THIN_WORDS,
  contentRules,
} from "../../src/rules/query/content.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

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

/** The analyzer's word count, for the main-content column and the assertions. */
const wordsIn = (text: string): number => text.split(/\s+/).length;

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
  it("defines the four content rules and their two markers", () => {
    expect(contentRules.map((r) => r.id).sort()).toEqual([
      "content.exact-duplicate",
      "content.near-duplicate",
      "content.near-duplicate-skipped",
      "content.soft-404",
      // Phase 19 §11 moved these two here from the page rules: the thin floor
      // reads `main_word_count`, whose null only the crawl's census can read.
      "content.thin",
      "content.thin-skipped",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(contentRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "content.soft-404": [["CHECK-13"], "critical", "content"],
      "content.exact-duplicate": [["CHECK-39"], "critical", "content"],
      "content.near-duplicate": [["CHECK-39"], "warning", "content"],
      // The marker claims the check whose near-duplicate half it stands in for,
      // and only that one: the exact-duplicate half of CHECK-39 still runs.
      "content.near-duplicate-skipped": [["CHECK-39"], "info", "content"],
      // Unchanged by the move: same checks, same severity, same category as
      // when both were page rules. Only the kind and the column moved.
      "content.thin": [["CHECK-40", "CHECK-13"], "warning", "content"],
      "content.thin-skipped": [["CHECK-40", "CHECK-13"], "info", "content"],
    });
  });

  // A NOT MEASURED marker is declared by the flag, and the flag is what the
  // identifier guard derives the checklist obligations from. Exactly one rule in
  // this file carries it — a second would mean a live rule had quietly become a
  // marker — and the reason names the cause and what answers the check, which is
  // §6's rubric for every marker string.
  it("declares two markers, whose reasons say what would answer each check", () => {
    const markers = contentRules.filter((r) => r.marker !== undefined);
    expect(markers.map((r) => r.id)).toEqual([
      "content.near-duplicate-skipped",
      "content.thin-skipped",
    ]);
    for (const m of markers) {
      expect(m.marker, m.id).toContain("re-crawl");
      // Each states what the census OBSERVED. The predicate also fires on a
      // current crawl whose every page turned out to have no main content, so a
      // reason opening "This crawl ran before…" asserts a cause the rule never
      // established; the age of the crawl is offered as the likely explanation
      // rather than claimed as the finding.
      expect(m.marker, m.id).toMatch(/^No page in this crawl has a/);
      expect(m.marker, m.id).not.toMatch(/^This crawl ran before/);
    }
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
    /**
     * The MAIN-content text — what `content.near-duplicate` fingerprints since
     * Phase 19. Undefined means "the same as `text`", the shape of a page whose
     * whole body is its content; a different string is a page whose chrome and
     * whose content say different things, which is the whole reason the second
     * fingerprint exists. An explicit null writes a null `main_simhash` AND a
     * null `main_word_count`: the two move together (see the column contract in
     * src/db/schema.ts), and a crawl where every row is null is the pre-0018
     * crawl `content.near-duplicate-skipped` reports.
     */
    mainText?: string | null;
    /**
     * Overrides the main word count derived from `mainText` — how a page gets
     * too little content of its own to be one half of a pair, without having to
     * write a forty-nine-word paragraph to say so.
     */
    mainWordCount?: number;
    /**
     * The declared canonical, verbatim. Undefined leaves the column null (the
     * page declares none), and a URL other than the page's own is what makes it
     * canonicalised elsewhere — invisible to both duplicate rules since §1.
     */
    canonicalHtml?: string;
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
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE, hostKey: hostKeyOf(SITE),
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
      const mainText = s.mainText === undefined ? text : s.mainText;
      const words = (v: string): number => v.split(/\s+/).length;
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
        // The main-content pair, written by the same analysis and therefore
        // both-or-neither, exactly as `PageWriter` writes them.
        mainSimhash: mainText === null ? null : stored(mainText),
        mainWordCount: mainText === null ? null : (s.mainWordCount ?? words(mainText)),
        canonicalHtml: s.canonicalHtml ?? null,
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
        severity: rule(ID).severity,
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

    it("stays silent on a page that did not answer 200", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      await addPages(crawlId, [
        { path: "/404", text: RETURNS_EDITED, wordCount: 80, hasSoft404Phrases: true, statusCode: 404, fetchClass: "client_error" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // PHASE 22 §1, AND IT IS A WIDENING WHERE THE PHASE MOSTLY NARROWS. This
    // rule keeps the FETCHED-OK cohort while every rule beside it moved to the
    // judged one, and it dropped `is_indexable` in the same move: a 200 that is
    // really a not-found is a fault whatever the page's directives or canonical
    // say. The site is still serving 200 for an address that has nothing behind
    // it, and a crawler still spends a request on it.
    it("reports a soft 404 that is noindexed or canonicalised elsewhere", async () => {
      const crawlId = await newCrawl(probeServing(RETURNS));
      await addPages(crawlId, [
        { path: "/noindex", text: RETURNS_EDITED, wordCount: 80, hasSoft404Phrases: true, robotsMeta: "noindex" },
        { path: "/canonicalised", text: RETURNS_EDITED, wordCount: 80, hasSoft404Phrases: true, canonicalHtml: `${SITE}/live` },
      ]);
      expect((await run(ID, crawlId)).map((f) => f.pageUrl)).toEqual([
        `${SITE}/canonicalised`,
        `${SITE}/noindex`,
      ]);
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
        tenantId: LOCAL_TENANT,
        id,
        siteUrl: SITE, hostKey: hostKeyOf(SITE),
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
        severity: rule(ID).severity,
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

    // Phase 19 §1, the defect this whole exclusion exists for. Both findings on
    // the crawl that provoked it were a base URL beside a parameter variant of
    // itself, and the variant declared a canonical to the base — the exact fix
    // this rule's `howToFix` prescribes, reported back as critical.
    it("does not report a page against the base URL it is canonicalised to", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/collections/sale", text: RETURNS, contentHash: "same" },
        {
          path: "/collections/sale?product-type=dress",
          text: RETURNS,
          contentHash: "same",
          canonicalHtml: url("/collections/sale"),
        },
      ]);
      // One member left after the exclusion, and a group of one is not a group:
      // the finding vanishes rather than shrinking to a confusing count of one.
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("still reports the members of a group that are not canonicalised away", async () => {
      // Three identical pages, one of them pointing at another URL. The two that
      // genuinely compete are still competing, and the count and the URL list
      // must agree about that — which they only do because the exclusion is on
      // both the grouping query and the sample lateral.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, contentHash: "same" },
        { path: "/b", text: RETURNS, contentHash: "same" },
        { path: "/c", text: RETURNS, contentHash: "same", canonicalHtml: url("/a") },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        urls: [url("/a"), url("/b")],
        count: 2,
      });
    });

    // PHASE 22 §2, THE EXCEPTION. The three field-duplicate rules and
    // `content.near-duplicate` fold reciprocal hreflang alternates into one
    // member; this rule deliberately does not. Byte-identical bodies across two
    // locales is not internationalisation working — it is the translation
    // missing, and the annotation is what makes it worth reporting rather than
    // what excuses it.
    it("still reports an en/fr pair that serves byte-identical bodies", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/policies/refund", text: RETURNS, contentHash: "same" },
        { path: "/fr/policies/refund", text: RETURNS, contentHash: "same" },
      ]);
      await addReciprocalHreflang(crawlId, ids, [
        { path: "/policies/refund", code: "en" },
        { path: "/fr/policies/refund", code: "fr" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({
        count: 2,
        urls: [url("/fr/policies/refund"), url("/policies/refund")],
      });
    });

    it("keeps a page whose canonical is its own URL", async () => {
      // The self-referential canonical is the healthy declaration every page
      // should carry. Reading it as "canonicalised elsewhere" would silence the
      // rule on a correctly marked-up site, which is the wrong direction to be
      // wrong in (hard rule 1).
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, contentHash: "same", canonicalHtml: url("/a") },
        { path: "/b", text: RETURNS, contentHash: "same", canonicalHtml: url("/b") },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(1);
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

  /**
   * Reciprocal hreflang alternates, inserted the way the crawler stores them:
   * `target_page_id` null, the target as the absolute href the page declared.
   */
  async function addReciprocalHreflang(
    crawlId: string,
    ids: Map<string, string>,
    pairs: { path: string; code: string }[],
  ): Promise<void> {
    await db.insert(hreflang).values(
      pairs.flatMap((from) =>
        pairs.map((to) => {
          const pageId = ids.get(from.path);
          if (pageId === undefined) throw new Error(`no page '${from.path}' in this crawl`);
          return {
            crawlId,
            pageId,
            hreflangCode: to.code,
            targetUrl: url(to.path),
            targetPageId: null,
            source: "html",
          };
        }),
      ),
    );
  }

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

    // Phase 19 §11: ONE FINDING PER PAGE. Two near-identical pages are two
    // findings — each page's own row, naming the other — where the pair shape
    // produced one row whose two URLs a reader had to sort out for themselves.
    it("reports each page, its count and its closest partners", async () => {
      // The whole round trip: `simhash64` in this process, `BigInt.asIntN(64, …)`
      // into a signed bigint column, four band comparisons and a `bit_count`
      // XOR in Postgres — and a distance that agrees with `hammingDistance`.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/returns", text: RETURNS, pageType: "/:slug" },
        { path: "/help/returns", text: RETURNS_EDITED, pageType: "/help/:slug" },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(2);
      // Equal counts, so the tie is broken by URL — the order is total and
      // does not depend on which row the join met first.
      expect(found.map((f) => f.pageUrl)).toEqual([url("/help/returns"), url("/returns")]);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/help/returns"),
        pageUrl: url("/help/returns"),
        // The page IS the finding's identity now, so it is also the dedupe key.
        dedupeKey: url("/help/returns"),
      });
      expect(found[0]!.evidence).toEqual({
        mainWords: wordsIn(RETURNS_EDITED),
        nearDuplicates: 1,
        closest: [{ url: url("/returns"), hamming: 3, mainWords: wordsIn(RETURNS) }],
      });
      // And the other end of the same relationship, stated from the other page.
      expect(found[1]!.evidence).toEqual({
        mainWords: wordsIn(RETURNS),
        nearDuplicates: 1,
        closest: [{ url: url("/help/returns"), hamming: 3, mainWords: wordsIn(RETURNS_EDITED) }],
      });
    });

    it("gives one page the same finding however the rows were inserted", async () => {
      const first = await newCrawl();
      const second = await newCrawl();
      await addPages(first, [
        { path: "/returns", text: RETURNS },
        { path: "/help/returns", text: RETURNS_EDITED },
      ]);
      // Inserted in the other order, so the ids — and therefore the join's
      // a/b assignment — come out the other way round. The pair form had to
      // hash a sorted URL pair to survive this; a per-page finding is keyed by
      // the page and cannot depend on the join's direction at all.
      await addPages(second, [
        { path: "/help/returns", text: RETURNS_EDITED },
        { path: "/returns", text: RETURNS },
      ]);

      const [a] = await run(ID, first);
      const [b] = await run(ID, second);
      expect(a!.dedupeKey).toBe(b!.dedupeKey);
      expect(a!.evidence).toEqual(b!.evidence);
    });

    // PHASE 22 §2. The raelon.ca crawl's only two near-duplicate findings were
    // the English and French refund policies — a translation that shares its
    // structure closely enough to land inside the band. Reciprocal alternates
    // are one page, so neither is the other's near-duplicate and both findings
    // go.
    it("does not report a reciprocal hreflang pair against each other", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/policies/refund", text: RETURNS },
        { path: "/fr/policies/refund", text: RETURNS_EDITED },
      ]);
      await addReciprocalHreflang(crawlId, ids, [
        { path: "/policies/refund", code: "en" },
        { path: "/fr/policies/refund", code: "fr" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("still reports a third page that is near both halves of a cluster", async () => {
      // The cluster excuses the PAIR, not the page beside it: a third URL
      // serving the same content is still competing with the cluster, and both
      // cluster members still see it. What each of them must NOT see is the
      // other.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/policies/refund", text: RETURNS },
        { path: "/fr/policies/refund", text: RETURNS_EDITED },
        // The same main content as the French page under a third address, with
        // a body that is not byte-identical — otherwise the shared content hash
        // would hand this pair to `content.exact-duplicate` and the cluster
        // would not be what the test was measuring.
        { path: "/legal/refunds", text: RETURNS_EDITED, contentHash: "legal-refunds" },
      ]);
      await addReciprocalHreflang(crawlId, ids, [
        { path: "/policies/refund", code: "en" },
        { path: "/fr/policies/refund", code: "fr" },
      ]);
      const found = await run(ID, crawlId);
      expect(
        Object.fromEntries(
          found.map((f) => [f.pageUrl, (f.evidence as { nearDuplicates: number }).nearDuplicates]),
        ),
      ).toEqual({
        [url("/fr/policies/refund")]: 1,
        [url("/legal/refunds")]: 2,
        [url("/policies/refund")]: 1,
      });
      // And the list beside each count is the same population as the count:
      // the French page names the third URL and not its own English twin.
      const fr = found.find((f) => f.pageUrl === url("/fr/policies/refund"))!;
      expect((fr.evidence as { closest: { url: string }[] }).closest.map((c) => c.url)).toEqual([
        url("/legal/refunds"),
      ]);
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
      expect(found).toHaveLength(2);
      expect(found[0]!.evidence["closest"]).toEqual([
        { url: url("/b"), hamming: 0, mainWords: wordsIn(RETURNS) },
      ]);
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

    // Phase 19 §2. The fingerprint is the MAIN content's, so a pair whose whole
    // pages are three bits apart because they share a menu is silent, and a
    // pair whose main content is three bits apart fires even when the whole
    // pages are nothing alike. Both directions, because either one alone would
    // pass against a rule that read the wrong column.
    it("compares the main content and not the whole visible text", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        // Same whole-page text — chrome and all — and genuinely different
        // content of their own. The old column called these a near-duplicate.
        { path: "/returns", text: RETURNS, mainText: RETURNS },
        { path: "/sizing", text: RETURNS_EDITED, mainText: SIZING, mainWordCount: 95 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires on two pages whose main content matches under unlike chrome", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainText: RETURNS },
        // Whole-page text 30-odd bits away, main content 3 bits away: the pair
        // the old fingerprint could not see.
        { path: "/b", text: SIZING, mainText: RETURNS_EDITED },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(2);
      expect(found[0]!.evidence["closest"]).toMatchObject([{ hamming: 3 }]);
    });

    it("says nothing about a pair with too little content of its own", async () => {
      // The same two fingerprints as the firing case above — only the word
      // counts differ — so the silence can only come from the floor. Two pages
      // this thin are `content.thin`'s finding, and a simhash over a couple of
      // dozen words would pair every near-empty page on a template with every
      // other one.
      expect(NEAR_DUPLICATE_MIN_MAIN_WORDS).toBe(50);
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainWordCount: NEAR_DUPLICATE_MIN_MAIN_WORDS - 1 },
        { path: "/b", text: RETURNS_EDITED, mainWordCount: NEAR_DUPLICATE_MIN_MAIN_WORDS - 1 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("needs BOTH sides over the floor, not one", async () => {
      // And neither page is reported: the one under the floor is not a
      // candidate, and the one over it has nothing left to be similar to.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainWordCount: 400 },
        { path: "/b", text: RETURNS_EDITED, mainWordCount: NEAR_DUPLICATE_MIN_MAIN_WORDS - 1 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reports a pair sitting exactly on the floor", async () => {
      // The boundary is `>=`, so the floor itself is measurable. Asserted
      // because an off-by-one here is a silence nobody would notice.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainWordCount: NEAR_DUPLICATE_MIN_MAIN_WORDS },
        { path: "/b", text: RETURNS_EDITED, mainWordCount: NEAR_DUPLICATE_MIN_MAIN_WORDS },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(2);
      expect(found[0]!.evidence).toMatchObject({
        mainWords: NEAR_DUPLICATE_MIN_MAIN_WORDS,
        closest: [
          { url: url("/b"), hamming: 3, mainWords: NEAR_DUPLICATE_MIN_MAIN_WORDS },
        ],
      });
    });

    // §1 again, on the rule that reported the same two parameter variants under
    // its own name. A canonicalised page is neither reported NOR counted as
    // anybody else's near-duplicate — one filter on both sides of the join and
    // a third inside the lateral, so the count and the list agree about what a
    // partner is.
    it("does not pair a page with the base URL it is canonicalised to", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/collections/sale", text: RETURNS },
        {
          path: "/collections/sale?srsltid=abc",
          text: RETURNS_EDITED,
          canonicalHtml: url("/collections/sale"),
        },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("still pairs two pages that each declare their own URL", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, canonicalHtml: url("/a") },
        { path: "/b", text: RETURNS_EDITED, canonicalHtml: url("/b") },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(2);
    });

    it("is silent — and does not throw — on a crawl with no main fingerprint", async () => {
      // The pre-0018 crawl. The rule returns nothing, and the silence is not
      // left to speak for itself: `content.near-duplicate-skipped` is what says
      // why, and its own describe below asserts that it does.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: RETURNS_EDITED, mainText: null },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // THE SHAPE THE AMENDMENT WAS WRITTEN FOR. A cluster of eight templated
    // pages is 28 pairs and eight decisions; this is what the eight rows say.
    it("collapses a cluster into one row per page, five closest each", async () => {
      const crawlId = await newCrawl();
      await addPages(
        crawlId,
        Array.from({ length: 8 }, (_, i) => ({
          path: `/cluster/${String(i)}`,
          text: RETURNS,
          // Distinct hashes, so this is the near-duplicate rule's business
          // rather than the exact rule's.
          contentHash: `c${String(i)}`,
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(8);
      for (const f of found) {
        // Every page sees the other seven — the join is symmetric, so a page's
        // count does not depend on where its id sorts.
        expect(f.evidence["nearDuplicates"], String(f.pageUrl)).toBe(7);
        const closest = f.evidence["closest"] as { url: string; hamming: number }[];
        expect(closest, String(f.pageUrl)).toHaveLength(NEAR_DUPLICATE_CLOSEST);
        // All at distance 0, so the tie-break is the URL — and the page itself
        // is never one of its own near-duplicates.
        expect(closest.map((c) => c.url)).toEqual([...closest.map((c) => c.url)].sort());
        expect(closest.map((c) => c.url)).not.toContain(f.pageUrl);
      }
      expect(found.map((f) => f.pageUrl)).toEqual([...found.map((f) => f.pageUrl)].sort());
      // No truncation note: eight rows is the whole of it, and the absence of
      // the note is what says so.
      for (const f of found) expect(f.evidence["truncated"]).toBeUndefined();
    });

    it("lists the closest partners first, whatever their URLs", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/zulu", text: RETURNS, contentHash: "z" },
        // 0 bits away, sorts last by URL; 3 bits away, sorts first. Order by
        // distance, ties by URL — so this list is not the alphabet.
        { path: "/alpha", text: RETURNS_EDITED },
        { path: "/yankee", text: RETURNS, contentHash: "y" },
      ]);

      const found = await run(ID, crawlId);
      const zulu = found.find((f) => f.pageUrl === url("/zulu"));
      expect(zulu!.evidence["closest"]).toEqual([
        { url: url("/yankee"), hamming: 0, mainWords: wordsIn(RETURNS) },
        { url: url("/alpha"), hamming: 3, mainWords: wordsIn(RETURNS_EDITED) },
      ]);
    });

    it("caps the pages, orders the noisiest first and quotes the exact total", async () => {
      // One more page than the cap: 201 pages of one text with distinct hashes,
      // so every page has 200 near-duplicates. The listing is cut and the total
      // is EXACT — the aggregate counted every page, which is what the pair
      // shape could not do at any price.
      const crawlId = await newCrawl();
      await addPages(
        crawlId,
        Array.from({ length: URL_FINDING_CAP + 1 }, (_, i) => ({
          path: `/copy/${String(i).padStart(3, "0")}`,
          text: RETURNS,
          contentHash: `h${String(i)}`,
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total: URL_FINDING_CAP + 1,
      });
      // One row per page, and never two rows about one page.
      expect(new Set(found.map((f) => f.dedupeKey)).size).toBe(URL_FINDING_CAP);
      for (const f of found) expect(f.evidence["nearDuplicates"]).toBe(URL_FINDING_CAP);
      // Exactly at `NEAR_DUPLICATE_COUNT_CAP` and therefore EXACT: the probe
      // runs one row past the cap, so a page with precisely 200 partners is
      // counted to the end and carries no floor flag. The test below is the
      // other side of that boundary.
      for (const f of found) expect(f.evidence["nearDuplicatesAtLeast"]).toBeUndefined();
    }, 60_000);

    /**
     * THE COUNT IS BOUNDED PER PAGE, and the boundary is stated rather than
     * left to the reader. 202 identical pages give every one of them 201
     * partners — one past `NEAR_DUPLICATE_COUNT_CAP` — which is exactly the
     * probe's last row, so the count stops there and says so. Reporting 201, or
     * 200 without the flag, would both be the same defect: a number nothing
     * counted to the end presented as if it had been.
     */
    it("reports a floor, flagged, once a page passes the per-page count cap", async () => {
      const crawlId = await newCrawl();
      await addPages(
        crawlId,
        Array.from({ length: NEAR_DUPLICATE_COUNT_CAP + 2 }, (_, i) => ({
          path: `/many/${String(i).padStart(3, "0")}`,
          text: RETURNS,
          contentHash: `m${String(i)}`,
        })),
      );

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(URL_FINDING_CAP);
      for (const f of found) {
        // 200, not 201 and not 202: the cap is what the evidence says, and the
        // flag beside it is what makes 200 read as "200 or more".
        expect(f.evidence["nearDuplicates"], String(f.pageUrl)).toBe(NEAR_DUPLICATE_COUNT_CAP);
        expect(f.evidence["nearDuplicatesAtLeast"], String(f.pageUrl)).toBe(true);
        // The five closest are unaffected by the count's cap — they come from
        // their own lateral and are still the nearest five.
        expect(f.evidence["closest"]).toHaveLength(NEAR_DUPLICATE_CLOSEST);
      }
      // The LISTING note is still the exact page total: capping each page's own
      // count says nothing about how many pages there are, and that number is
      // still one `count(*) over ()` away.
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total: NEAR_DUPLICATE_COUNT_CAP + 2,
      });
    }, 60_000);

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("content.near-duplicate-skipped", () => {
    const ID = "content.near-duplicate-skipped";

    it("fires once on a crawl where no page carries a main fingerprint", async () => {
      // The pre-0018 crawl: every auditable row null in both main columns,
      // because nothing computed them. The check cannot be run and the marker is
      // what says so — a silence here would read as "no near-duplicates", which
      // is the always-passes hole hard rule 1 forbids.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: RETURNS_EDITED, mainText: null },
        { path: "/c", text: SIZING, mainText: null },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "info",
        // Site-scoped: the condition is a property of the crawl, not of a page.
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(found[0]!.evidence).toEqual({
        indexablePages: 3,
        minMainWords: NEAR_DUPLICATE_MIN_MAIN_WORDS,
      });
    });

    it("is silent on a crawl where every page carries one", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS },
        { path: "/b", text: SIZING },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // THE DISTINCTION THE PREDICATE IS FOR. A current crawl writes a null
    // `main_simhash` for any page with no main content of its own — a gallery, a
    // menu-only index — and those pages are simply not candidates, exactly as a
    // page with no `content_hash` is not a candidate for the exact rule. The
    // check WAS run on this crawl, over the pages that had something to compare,
    // so the marker must stay quiet: `bool_or`, not `count(*) filter`.
    it("is silent on a current crawl where only SOME pages carry one", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS },
        { path: "/chrome-only", text: SIZING, mainText: null },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent on a crawl with no auditable pages at all", async () => {
      // Nothing to measure is not the same as a measurement that could not be
      // made. A crawl of three 404s has no near-duplicate question to answer,
      // and a marker here would be a row saying nothing on every failed crawl.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/gone", text: RETURNS, mainText: null, statusCode: 404, fetchClass: "client_error" },
        { path: "/noindex", text: SIZING, mainText: null, robotsMeta: "noindex" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // The pair is a partition: on any one crawl exactly one of "the rule ran"
    // and "the marker fired" is true, and the rule's silence is never left
    // unexplained. Both directions on two crawls, in one test, because the
    // guarantee is about the pair rather than about either half.
    it("partitions with the rule: the marker fires exactly where the rule cannot run", async () => {
      const old = await newCrawl();
      await addPages(old, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: RETURNS_EDITED, mainText: null },
      ]);
      const current = await newCrawl();
      await addPages(current, [
        { path: "/a", text: RETURNS },
        { path: "/b", text: RETURNS_EDITED },
      ]);

      expect(await run("content.near-duplicate", old)).toHaveLength(0);
      expect(await run(ID, old)).toHaveLength(1);
      // Two findings on the current crawl, one per page: the rule reports pages
      // rather than pairs since §11.
      expect(await run("content.near-duplicate", current)).toHaveLength(2);
      expect(await run(ID, current)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  /**
   * `content.thin`, a QUERY rule since Phase 19 §11 — it read
   * `renderable_word_count` off one row until the floor moved onto the words a
   * page has of its OWN, whose null means two different things and only the
   * crawl's census says which (see `thinFindings`). Its cases moved here from
   * test/rules/on-page.test.ts with it.
   */
  describe("content.thin", () => {
    const ID = "content.thin";

    it("is silent on a page with plenty of content of its own", async () => {
      const crawlId = await newCrawl();
      // The corpus texts are shorter than the floor (145 and 93 words), so a
      // page meant to be healthy states its own main count — the fixtures were
      // written for a similarity threshold, not for this one.
      await addPages(crawlId, [{ path: "/returns", text: RETURNS, mainWordCount: 400 }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("boundary: 149 words of its own fire, 150 do not", async () => {
      expect(THIN_WORDS).toBe(150);
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/thin", text: RETURNS, wordCount: 900, mainWordCount: THIN_WORDS - 1 },
        { path: "/fine", text: SIZING, wordCount: 900, mainWordCount: THIN_WORDS },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/thin"),
        pageUrl: url("/thin"),
        dedupeKey: url("/thin"),
      });
      expect(found[0]!.evidence).toEqual({
        mainWords: THIN_WORDS - 1,
        wordCount: 900,
        threshold: THIN_WORDS,
      });
    });

    // THE DEFECT THE AMENDMENT WAS WRITTEN FOR, in miniature. On the crawl
    // behind Phase 19 every page carried ~900 words of header, menu and footer
    // around ~100 words of its own, so no page on the site was ever under the
    // floor on any whole-page count and this rule fired zero times.
    it("judges the page's own words, not the whole document's", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/empty-template", text: RETURNS, wordCount: 1005, mainWordCount: 105 },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toMatchObject({ mainWords: 105, wordCount: 1005 });
      // And the converse: a page whose own content clears the floor is silent
      // however much furniture the document carries around it.
      const other = await newCrawl();
      await addPages(other, [
        { path: "/real", text: RETURNS, wordCount: 1300, mainWordCount: 400 },
      ]);
      expect(await run(ID, other)).toHaveLength(0);
    });

    // Hard rule 1, the sharpest case of it in this file: a page with NO main
    // content at all stores null, and null must not be a page that slips
    // through unjudged. On a crawl that measured main content, null is the
    // measurement — nothing — and the finding says so in words as well as in
    // the number, because `mainWords: 0` alone reads as a count.
    it("reports a page with no main content at all as zero words", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        // A page whose whole body is chrome: the analyzer found nothing to
        // fingerprint and wrote null in both main columns.
        { path: "/chrome-only", text: RETURNS, wordCount: 830, mainText: null },
        // …on a crawl that plainly DID measure main content elsewhere.
        { path: "/real", text: SIZING, mainWordCount: 400 },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.pageUrl).toBe(url("/chrome-only"));
      expect(found[0]!.evidence).toEqual({
        mainWords: 0,
        note: "no main-content text at all",
        wordCount: 830,
        threshold: THIN_WORDS,
      });
    });

    it("is silent on the same page when the crawl measured nothing at all", async () => {
      // The pre-0018 crawl: every row null, and nothing may be concluded about
      // any of them. `content.thin-skipped` is what speaks here — asserted as a
      // partition in its own describe below.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: SIZING, mainText: null },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("says nothing about a page the analyzer never read", async () => {
      // A 200 that served a PDF: no analysis, null in every text column. That
      // is a page with no text evidence rather than a page with no content,
      // and this rule has always been quiet about it — `word_count is not
      // null` is what keeps the two apart.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        // No `text`: the analyzer never ran, so every text column is null.
        { path: "/file.pdf" },
        { path: "/real", text: SIZING, mainWordCount: 400 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("judges only indexable 200 pages — thin on purpose is fine", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/noindex", text: RETURNS, mainWordCount: 10, robotsMeta: "noindex" },
        {
          path: "/gone",
          text: RETURNS,
          mainWordCount: 10,
          statusCode: 404,
          fetchClass: "client_error",
        },
        { path: "/real", text: SIZING, mainWordCount: 400 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // §1 extended to this rule by §11: a parameter variant that defers to its
    // base URL is the same page said twice, and the page it defers to is where
    // the content is judged. Without this, a faceted site reports its whole
    // facet space as thin the day it does the right thing.
    it("does not judge a page canonicalised elsewhere", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        {
          path: "/collections/sale?srsltid=abc",
          text: RETURNS,
          mainWordCount: 20,
          canonicalHtml: url("/collections/sale"),
        },
        { path: "/collections/sale", text: RETURNS, mainWordCount: 400 },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("still judges a page that declares its own URL canonical", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/thin", text: RETURNS, mainWordCount: 20, canonicalHtml: url("/thin") },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(1);
    });

    it("lists the thinnest pages first and caps with an exact total", async () => {
      // The order is a decision about what a CUT list should hold: the pages
      // with nothing on them at all, not whatever the site names early.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/aaa", text: RETURNS, mainWordCount: 120 },
        { path: "/bbb", text: RETURNS, wordCount: 500, mainText: null },
        { path: "/ccc", text: RETURNS, mainWordCount: 60 },
      ]);
      expect((await run(ID, crawlId)).map((f) => f.pageUrl)).toEqual([
        url("/bbb"),
        url("/ccc"),
        url("/aaa"),
      ]);

      const big = await newCrawl();
      await addPages(
        big,
        Array.from({ length: URL_FINDING_CAP + 3 }, (_, i) => ({
          path: `/thin/${String(i).padStart(3, "0")}`,
          text: RETURNS,
          mainWordCount: 40,
        })),
      );
      const found = await run(ID, big);
      expect(found).toHaveLength(URL_FINDING_CAP);
      expect(found[URL_FINDING_CAP - 1]!.evidence["truncated"]).toEqual({
        reported: URL_FINDING_CAP,
        total: URL_FINDING_CAP + 3,
      });
    }, 60_000);

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("content.thin-skipped", () => {
    const ID = "content.thin-skipped";

    it("fires once on a crawl where no page carries a main-content count", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: RETURNS_EDITED, mainText: null },
        { path: "/c", text: SIZING, mainText: null },
      ]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "info",
        // Site-scoped since §11: the condition is a property of the crawl, and
        // a pre-0018 crawl of fifty thousand pages would otherwise write fifty
        // thousand copies of one sentence.
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(found[0]!.evidence).toEqual({ indexablePages: 3, threshold: THIN_WORDS });
    });

    it("is silent on a crawl where the measurement exists", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS },
        { path: "/b", text: SIZING },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent on a current crawl where only SOME pages have no main content", async () => {
      // Those pages were measured — at nothing — and `content.thin` reports
      // them as zero. A marker here would say the check did not run on a crawl
      // where it ran and found the worst case it can find.
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a", text: RETURNS, mainWordCount: 400 },
        { path: "/chrome-only", text: SIZING, mainText: null },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
      expect(await run("content.thin", crawlId)).toHaveLength(1);
    });

    it("is silent on a crawl with no auditable pages at all", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        {
          path: "/gone",
          text: RETURNS,
          mainText: null,
          statusCode: 404,
          fetchClass: "client_error",
        },
        { path: "/noindex", text: SIZING, mainText: null, robotsMeta: "noindex" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    // The pair is a partition, exactly as the near-duplicate pair is: on any
    // one crawl either the rule ran or the marker fired, and the rule's silence
    // is never left unexplained.
    it("partitions with the rule: the marker fires exactly where the rule cannot run", async () => {
      const old = await newCrawl();
      await addPages(old, [
        { path: "/a", text: RETURNS, mainText: null },
        { path: "/b", text: RETURNS_EDITED, mainText: null },
      ]);
      const current = await newCrawl();
      await addPages(current, [
        { path: "/a", text: RETURNS, mainWordCount: 20 },
        { path: "/b", text: RETURNS_EDITED, mainWordCount: 400 },
      ]);

      expect(await run("content.thin", old)).toHaveLength(0);
      expect(await run(ID, old)).toHaveLength(1);
      expect(await run("content.thin", current)).toHaveLength(1);
      expect(await run(ID, current)).toHaveLength(0);
    });

    it("refuses a crawl id nothing knows", async () => {
      await expect(run(ID, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });
});
