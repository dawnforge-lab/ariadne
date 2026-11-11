/**
 * Migration 0018: `pages.main_simhash`, `pages.main_word_count` and
 * `pages.placeholder_snippet` — the main-content fingerprint and the quotation
 * behind `has_lorem_ipsum`.
 *
 * THE TWO DEFECTS THIS CLOSES, from the audit-accuracy diagnosis of a real
 * crawl (docs/superpowers/specs/2026-09-09-audit-accuracy-pass-design.md §2 and
 * §3):
 *  1. `content.near-duplicate` reported 500 findings, 237 of them across
 *     unrelated templates, because `simhash` reads the WHOLE visible text and
 *     that site carries ~900 words of header, navigation and footer around a
 *     median of ~150 words of its own. Two pages with nothing in common landed
 *     within the rule's 3-bit threshold.
 *  2. `content.placeholder` fired on three 1,000-word blog posts with evidence
 *     `{wordCount}`. The finding was true — the post's excerpt was "Lorem ipsum
 *     dolor sit amet…" — and no reader could act on it.
 *
 * What is under test is not the DDL (`runMigrations` either applied it or
 * threw) but the CLAIMS the three columns make, and they are driven through a
 * REAL CRAWL of a real fixture server rather than through hand-written rows —
 * the migration-0013 / 0016 / 0017 discipline. It is load-bearing here for one
 * specific reason: which subtree a page's main content lives in is decided
 * inside the analyzer's single streaming pass, and a seeded row would pass with
 * that decision deleted. The crawl also proves the WRITER: the signed-bigint
 * spelling, and that these columns travel with the analysis and not beside it.
 *
 * The claims:
 *
 *  1. a page that declares a `<main>` is measured INSIDE it — the count is the
 *     main content's, not the page's, and the fingerprint is not `simhash`;
 *  2. a page with no `<main>` is measured over the body MINUS its `<nav>`,
 *     `<header>`, `<footer>` and `<aside>`, and reaches the same fingerprint as
 *     a `<main>` page carrying the same words: the two routes are one
 *     measurement;
 *  3. a page that is nothing but chrome carries NULL in both, beside a non-null
 *     `word_count` — "nothing to fingerprint" is not a measurement of zero;
 *  4. the placeholder page carries the exact sentence a reader will find on it,
 *     STARTING at the placeholder and inside the 160-character bound;
 *  5. a page the analyzer never ran on (a 404, whose body says "lorem ipsum"
 *     into the void) carries null in all three and raises no flag;
 *  6. the pairing itself, asked as SQL over the whole table:
 *     `placeholder_snippet IS NULL` ⟺ `NOT has_lorem_ipsum`. Both directions,
 *     unlike migration 0017's one-way implication, because this pair is written
 *     by one writer from one match and has no pre-0018 history to protect: a
 *     row written before this migration has no `has_lorem_ipsum = true` without
 *     a snippet, it has no snippet column at all until the ALTER runs, and the
 *     ALTER gives every old row NULL beside a flag that may be true — which is
 *     why the implication is asserted OVER THIS CRAWL'S ROWS and the older
 *     history is left where it is;
 *  7. the defect and its fix, measured in SQL the way the rule will read it:
 *     two chrome-heavy pages about different products are within 3 bits on
 *     `simhash` (the false near-duplicate) and far outside it on `main_simhash`;
 *  8. the signed-bigint round trip, through the real crawler: the value the
 *     analyzer produced for that page's HTML is the value the column holds;
 *  9. and the cascade, which every column on this table depends on.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlConfig } from "../../src/crawl/loop.js";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * The chrome every page on the fixture site carries, exactly as a theme
 * carries it: 96 words of header, navigation, aside and footer, in the four
 * elements the fallback rule names. The nav is also the site's link graph, so
 * the crawl reaches every page from the seed.
 */
const CHROME =
  `<header><p>${"brand tagline ".repeat(10)}</p></header>` +
  `<nav>` +
  `<a href="/main">main</a> <a href="/no-main">plain</a> <a href="/chrome">chrome</a> ` +
  `<a href="/lorem">lorem</a> <a href="/product-a">a</a> <a href="/product-b">b</a> ` +
  `<a href="/missing">missing</a>` +
  `</nav>` +
  `<aside><p>${"you may also like ".repeat(10)}</p></aside>` +
  `<footer><p>${"terms delivery returns ".repeat(10)}</p></footer>`;
/** 20 + 7 + 40 + 30. Counted here so the assertions below can be arithmetic. */
const CHROME_WORDS = 97;

/** The page's own copy: 4 + 70 words, the same on the two pages that share it. */
const OWN_COPY =
  `<h1>The main content page</h1>` +
  `<p>${"a sentence of the page's own copy ".repeat(10)}</p>`;
const OWN_WORDS = 74;

/**
 * The placeholder page: a real post whose EXCERPT is the placeholder, which is
 * the shape the diagnosed crawl found. The sentence is what a reader meets on
 * the listing page and in every related-post card.
 */
const EXCERPT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

/** The chrome-heavy pair, ~970 words each with ~150 of their own. */
const HEAVY_CHROME =
  `<header><p>${"the shop brand tagline ".repeat(25)}</p></header>` +
  `<nav><p>${"shop all new in dresses knitwear sale gifts ".repeat(40)}</p></nav>` +
  `<aside><p>${"you may also like these ".repeat(30)}</p></aside>` +
  `<footer><p>${"terms delivery returns privacy contact ".repeat(50)}</p></footer>`;
const product = (topic: string) =>
  `<p>${`a paragraph about our ${topic} and how it is made `.repeat(15)}</p>`;

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

/** The fixture site, keyed by path — the same strings the assertions re-read. */
const SITE: Record<string, string> = {
  "/": html(`${CHROME}<main><p>the seed page of this fixture site</p></main>`),
  // Claim 1: the content is where the document says it is.
  "/main": html(`${CHROME}<main>${OWN_COPY}</main>`),
  // Claim 2: the same words, with nothing declaring where they are.
  "/no-main": html(`${CHROME}<div class="content">${OWN_COPY}</div>`),
  // Claim 3: a page with no content of its own at all.
  "/chrome": html(CHROME),
  // Claim 4. The chrome sits AFTER the article here, the way a footer does, so
  // the words the quotation runs into after the excerpt are the post's own.
  "/lorem": html(
    `<main><h1>A post about linen</h1>` +
      `<p class="excerpt">${EXCERPT}</p>` +
      `<p>${"the real body copy of this post ".repeat(30)}</p></main>${CHROME}`,
  ),
  // Claim 7: two products a whole-page fingerprint cannot tell apart.
  "/product-a": html(`${HEAVY_CHROME}<main>${product("dresses")}</main>`),
  "/product-b": html(`${HEAVY_CHROME}<main>${product("candles")}</main>`),
};

let db: Db;
let server: Server;
let base = "";
let crawlId = "";
const created: string[] = [];

function config(siteUrl: string): CrawlConfig {
  return {
    siteUrl,
    maxPages: 20,
    maxDepth: 3,
    userAgent: "AriadneBot-0018",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    probeHosts: false,
    // The sanctioned test-only use: the fixture is on 127.0.0.1.
    allowPrivate: true,
  };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const body = SITE[path];
    if (body === undefined) {
      // Claim 5: a 404 whose body carries the placeholder phrase. The analyzer
      // never runs on it, so the flag stays false and the snippet stays null —
      // and the row is still a row (hard rule 7), which is what makes it a
      // meaningful third case for the invariant in claim 6.
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html(`<main><p>Lorem ipsum dolor sit amet — this page is gone.</p></main>`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no fixture port");
  base = `http://127.0.0.1:${addr.port}`;

  const summary = await runCrawl(db, LOCAL_TENANT, config(`${base}/`));
  crawlId = summary.crawlId;
  created.push(crawlId);
}, 60_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => server.close(() => ok()));
  await closeFetchAgents();
});

async function row(path: string) {
  const [found] = await db
    .select({
      url: pages.url,
      statusCode: pages.statusCode,
      wordCount: pages.wordCount,
      simhash: pages.simhash,
      mainSimhash: pages.mainSimhash,
      mainWordCount: pages.mainWordCount,
      hasLoremIpsum: pages.hasLoremIpsum,
      placeholderSnippet: pages.placeholderSnippet,
    })
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${base}${path}`)));
  if (found === undefined) throw new Error(`no page row for ${path}`);
  return found;
}

describe("0018 — the main-content fingerprint and the placeholder quotation", () => {
  it("measures a page that declares a <main> inside it", async () => {
    const page = await row("/main");
    expect(page.statusCode).toBe(200);
    // The premise: the page really does carry its chrome as well.
    expect(page.wordCount).toBe(CHROME_WORDS + OWN_WORDS);
    expect(page.mainWordCount).toBe(OWN_WORDS);
    expect(page.mainSimhash).not.toBeNull();
    // And it is NOT the whole-page fingerprint, which is the entire point of
    // the column: two different texts, two different values.
    expect(page.mainSimhash).not.toBe(page.simhash);
  });

  it("falls back to the body minus chrome, and reaches the same fingerprint", async () => {
    const declared = await row("/main");
    const plain = await row("/no-main");
    expect(plain.wordCount).toBe(CHROME_WORDS + OWN_WORDS);
    expect(plain.mainWordCount).toBe(OWN_WORDS);
    // The two pages carry the same words in different markup. The fallback is
    // the same measurement by another route, so the two columns agree exactly.
    expect(plain.mainSimhash).toBe(declared.mainSimhash);
  });

  it("writes null on a page that is nothing but chrome — not zero", async () => {
    const page = await row("/chrome");
    // It fetched, it was analyzed, and it has words: only its MAIN content is
    // absent. A zero here would be a measurement of a page nobody measured.
    expect(page.wordCount).toBe(CHROME_WORDS);
    expect(page.mainWordCount).toBeNull();
    expect(page.mainSimhash).toBeNull();
  });

  it("quotes the placeholder sentence a reader will find on the page", async () => {
    const page = await row("/lorem");
    expect(page.hasLoremIpsum).toBe(true);
    const snippet = String(page.placeholderSnippet);
    // THE CLAIM THE COLUMN EXISTS FOR: the evidence names the copy, not the
    // page. The whole sentence is in it, verbatim.
    expect(snippet.startsWith(EXCERPT)).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(160);
    // Pinned whole, because the shape of the quotation is the deliverable: it
    // OPENS on the placeholder sentence — the heading above it is not quoted —
    // and runs into the body copy that follows, a whole word at the cut end,
    // 156 characters.
    expect(snippet).toBe(
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
        "the real body copy of this post the real body copy of this post the real body copy of this post the",
    );
  });

  it("leaves all three null on a page the analyzer never ran on", async () => {
    const page = await row("/missing");
    expect(page.statusCode).toBe(404);
    // Its body says "Lorem ipsum" and nothing read it: a 404 is a classified
    // row with no analysis, so every analyzer column on it is null and the
    // flag is false. That is a different fact from "measured, and empty".
    expect(page.wordCount).toBeNull();
    expect(page.mainWordCount).toBeNull();
    expect(page.mainSimhash).toBeNull();
    expect(page.hasLoremIpsum).toBe(false);
    expect(page.placeholderSnippet).toBeNull();
  });

  it("holds placeholder_snippet IS NULL <=> NOT has_lorem_ipsum over the crawl", async () => {
    // Asked as SQL rather than in TypeScript because it is a claim about the
    // TABLE and not about the rows this file happens to read — and this crawl
    // puts a page on each side of it: `/lorem` (flag and quotation) and every
    // other page (neither).
    //
    // Scoped to this crawl deliberately. Rows written before 0018 carry a flag
    // and a null snippet because the ALTER gave them one, and a test that
    // refused those would be refusing our own history rather than testing this
    // writer — the migration-0017 reasoning, applied to a pair that is written
    // together from here on.
    const [violations] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(
        sql`${pages.crawlId} = ${crawlId}
            and (${pages.placeholderSnippet} is null) <> (not ${pages.hasLoremIpsum})`,
      );
    expect(violations?.n).toBe(0);
    // And the implication is not vacuous: one row on this crawl carries both.
    const [flagged] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(sql`${pages.crawlId} = ${crawlId} and ${pages.hasLoremIpsum}`);
    expect(flagged?.n).toBe(1);
  });

  it("tells the chrome-heavy pair apart in SQL, where simhash cannot", async () => {
    // The defect and its fix, in the shape the rule reads: a hamming distance
    // between two rows, computed by Postgres over the signed bigints.
    const distance = async (column: "simhash" | "main_simhash") => {
      const [d] = await db.execute<{ hamming: number }>(sql`
        select bit_count((a.${sql.raw(column)} # b.${sql.raw(column)})::bit(64))::int as hamming
        from pages a, pages b
        where a.crawl_id = ${crawlId} and a.url = ${`${base}/product-a`}
          and b.crawl_id = ${crawlId} and b.url = ${`${base}/product-b`}`).then(
        (res) => res.rows,
      );
      if (d === undefined) throw new Error(`no pair row for ${column}`);
      return d.hamming;
    };
    const a = await row("/product-a");
    // The premise: chrome really is most of these pages.
    expect(a.wordCount).toBe(970);
    expect(a.mainWordCount).toBe(150);
    // Read whole, two unrelated products are inside `content.near-duplicate`'s
    // 3-bit threshold. This is the 500-finding defect, reproduced.
    expect(await distance("simhash")).toBeLessThanOrEqual(3);
    // Read over their main content, they are not the same page.
    expect(await distance("main_simhash")).toBeGreaterThan(3);
  });

  it("round-trips the analyzer's unsigned value through the signed column", async () => {
    // The writer's half of the contract, through the real crawler: the same
    // HTML the fixture served, analyzed again here, must produce the value the
    // column holds once the signed spelling is undone.
    const page = await row("/main");
    const analysis = analyzePage(SITE["/main"]!, `${base}/main`);
    expect(analysis.mainSimhash).not.toBeNull();
    expect(BigInt.asUintN(64, BigInt(String(page.mainSimhash)))).toBe(analysis.mainSimhash);
    expect(page.mainWordCount).toBe(analysis.mainWordCount);
    expect(page.placeholderSnippet).toBe(analysis.placeholderSnippet);
  });

  it("cascades from the crawl delete, the three new columns and all", async () => {
    const id = created.pop()!;
    const count = async () => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, id));
      return rows[0]?.n ?? 0;
    };
    expect(await count()).toBeGreaterThan(0);
    await db.delete(crawls).where(eq(crawls.id, id));
    expect(await count()).toBe(0);
    const [gone] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawls)
      .where(eq(crawls.id, id));
    expect(gone?.n).toBe(0);
  });
});
