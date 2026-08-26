/**
 * The end-to-end net.
 *
 * One local HTTP site, crawled once by the REAL crawler, judged once by the
 * REAL rule runner, asserted from the `issues` table. Nothing here stubs a
 * fetch, hand-builds a `pages` row, or calls a rule directly: if the analyzer
 * stops extracting a signal, or the writer stops persisting it, or a rule stops
 * reading it, this file fails, and none of the unit suites would.
 *
 * The crawl and the rule run happen once, in `beforeAll`. Every assertion below
 * reads the same result, so adding a fixture costs a page fetch, not a crawl.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlSummary } from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, issues, pages, sitemapUrls } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { THIN_WORDS } from "../../src/rules/page/on-page.js";
import { SOFT_404_WORDS } from "../../src/rules/query/content.js";
import { runRules } from "../../src/rules/run.js";
import type { Registry } from "../../src/rules/registry/registry.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import { allFixtures } from "./fixture.js";
import { startFixtureApp, type FixtureApp } from "./app.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Rules NO fixture can claim, because their firing condition is a property of an
 * unhealthy crawl, of a site this one cannot also be, or of the absence of
 * something another fixture had to publish.
 *
 * There is no second list beside this one any more. Phase 2 left ten rules
 * unclaimed and Phase 3 left twenty-two; Task 9 authored the pages, the sitemap
 * and the second host name they needed, and the assertion at the bottom of this
 * file is now the strict "every registered rule fires somewhere" it was always
 * meant to become. Adding an id here is a claim that no page could provoke it,
 * and it needs a paragraph of its own saying why, plus the test that covers the
 * rule directly.
 *
 * `links.orphan-skipped` fires only when the crawl did not finish — a frontier
 * that never drained, or a crawl stopped at its page cap. This harness asserts
 * the opposite in its first test (`frontier.pending === 0`, and `maxPages: 500`
 * against a site of a few dozen pages), so a fixture that made this rule speak
 * would be a fixture that broke the crawl. Its behaviour is covered by
 * `test/rules/link-graph-query.test.ts`, which builds the incomplete crawls
 * directly.
 *
 * `robots.missing` fires when the site ANSWERS 4xx for /robots.txt. The fixture
 * app serves one for the whole site — allow-all bar `/private/`, which is what
 * lets the crawl reach every fixture — and a robots.txt either exists for a site
 * or does not. No page could provoke this without removing the file the rest of
 * the harness depends on. `test/rules/robots-query.test.ts` builds both sites
 * directly.
 *
 * `robots.check-skipped` fires when the stored robots.txt cannot be re-parsed
 * soundly: a file past the 500KB read cap, or one the server never served. The
 * first would mean a fixture app serving half a megabyte of directives, the
 * second a crawl that fails outright (an unreachable robots.txt is a complete
 * disallow, so `runCrawl` closes the crawl as failed and nothing is crawled at
 * all). Both are properties of an unhealthy crawl, like `links.orphan-skipped`
 * above, and both are covered by the same DB test file.
 *
 * `host.probe-skipped` fires when the crawl recorded no host probe at all,
 * which happens only when a crawl is started with `probeHosts: false`. This
 * harness runs one crawl, with the probe on — asserted below, since
 * `host.http-serves-200` and `host.legacy-host-reachable` both fire from it — so
 * provoking this rule would mean turning off the evidence three other host rules
 * read. A property of how the crawl was started, like the two skips above, and
 * covered by `test/rules/host-query.test.ts`.
 *
 * `host.duplicate-host-200` needs the www and apex spellings of one host to
 * BOTH answer 200 over https. The fixture app is plain HTTP addressed by an IP
 * literal: an IP has no `www.` twin (see `hostnameSpellings`), and nothing on the
 * loopback serves TLS a crawl would accept, so neither half of the condition can
 * exist here however many pages or names are added. Its sibling
 * `host.legacy-host-reachable` IS claimed, by the second name this same server
 * answers to (`app.legacyBase`, passed as `legacyHosts`) — that one needs a
 * reachable extra origin, which is buildable, while this one needs two TLS
 * spellings of one host, which is not. Covered by the same DB test file, which
 * builds the probe rows directly.
 *
 * `sitemap.missing` fires when robots.txt declares no `Sitemap:` line. It fired
 * on every crawl of this site until Task 9, and it can never fire again: the
 * fixture app now declares two sitemaps, which is what the five rules joining
 * `sitemap_urls` to `pages` needed to have anything at all to read. The trade is
 * one way round — a site with a sitemap cannot also be a site without one — and
 * this is the direction that buys five claimed rules for one exempted. The rule
 * itself is covered directly by `test/rules/sitemap-query.test.ts`, which builds
 * a crawl whose discovery evidence names no sitemap source.
 *
 * `schema.none-on-site` is the same trade in the structured-data family. Its
 * condition is "this crawl stored no JSON-LD of any type", and
 * `/authored3/product-incomplete` and `/authored3/reviews` had to publish some
 * for `schema.product-incomplete` and `schema.self-serving-reviews` to be
 * claimed at all. One rule out, two in. Its sibling `schema.breadcrumb-absent`
 * survives and is asserted below: no fixture publishes a `BreadcrumbList`, and
 * none should — it is the only site-scoped structured-data rule a site with
 * markup can still provoke. `test/rules/structured-data-query.test.ts` covers
 * the exempted rule directly, on a crawl with no blocks at all.
 */
const SKIP_HARNESS_CLAIMS: string[] = [
  "host.duplicate-host-200",
  "host.probe-skipped",
  "links.orphan-skipped",
  "robots.check-skipped",
  "robots.missing",
  "schema.none-on-site",
  "sitemap.missing",
];

let db: Db;
let app: FixtureApp;
let summary: CrawlSummary;
let registry: Registry;

/**
 * Path -> the `pages` row the crawl wrote for it. The whole row, not just the
 * path: an assertion about what a page fired means nothing without the fetch
 * outcome beside it, because most rules are gated on `isAuditable` and a page
 * that 404s or redirects fires nothing at all (see the control assertion).
 *
 * The key is pathname + query, and a collision throws rather than merging. Two
 * URLs that differ only in their query string are two pages and two sets of
 * findings; letting them share a key would let one page's finding satisfy
 * another page's expectation, which is the one failure this whole file exists
 * to prevent.
 */
const pageByPath = new Map<string, PageRecord>();
/** Path -> the rule ids that fired on the page at that path. */
const issuesByPath = new Map<string, Set<string>>();
/**
 * `${path}\n${ruleId}` -> the details the rule wrote. A rule id alone says a
 * finding landed; the details say it landed on the right evidence, which is
 * what makes a fixture load-bearing rather than decorative.
 *
 * **LAST WRITE WINS.** A rule that writes SEVERAL findings for one page — the
 * two hreflang join rules do, one per member of a cluster, and so does
 * `content.near-duplicate` per pair — leaves only the last of them here, and
 * which one that is depends on the order the rows came back in. Pin those from
 * the `issues` table instead, reading the whole set for the rule id and
 * asserting it as a set (`the hreflang clusters` and `the duplicate rules`
 * below do exactly that).
 */
const detailsByPath = new Map<string, unknown>();
/**
 * Findings that belong to no URL, by rule id, with the evidence each one wrote.
 *
 * An ARRAY per rule, because a site-scoped rule may legitimately speak more than
 * once: `host.http-serves-200` writes one finding per plaintext spelling, and
 * this site has two names. The keys are asserted exactly and the multi-finding
 * rules are asserted by their evidence, so a rule that changed shape — or one
 * whose skip condition started matching a healthy crawl — surfaces here instead
 * of vanishing.
 */
const siteFindings = new Map<string, unknown[]>();
/**
 * Path -> the hreflang codes the page at that path declared, sorted, read
 * straight from the `hreflang` table. This is the input side of the site-scoped
 * rule: it says which fixture contributed which declaration, so a fixture that
 * stopped contributing fails an assertion instead of quietly not mattering.
 */
const hreflangByPath = new Map<string, string[]>();

/**
 * A details blob serialised with its keys in a fixed order, for sorting.
 *
 * `JSON.stringify` alone would not do: `issues.details` is a jsonb column, and
 * Postgres stores an object's keys ordered by length and then by bytes rather
 * than as written — so the first characters of the serialised form would be
 * whichever key happened to be shortest, and the sort below would order findings
 * by a field nobody chose. Sorting the keys puts the blob's fields in a fixed,
 * readable order instead, so the sequence an assertion is written against comes
 * from the evidence rather than from how Postgres happened to store it.
 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, member]) => `${key}:${stableKey(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Every finding one rule wrote on this crawl, as its details blobs, sorted.
 *
 * The escape hatch from `detailsByPath` for a rule that writes SEVERAL findings
 * for one page: that map is keyed by path and rule and therefore keeps only the
 * last of them. The sort is by serialised content rather than by any one field,
 * because these queries have no ORDER BY and the row order is the planner's
 * business — the SET is what the assertion is about.
 */
async function findingSet(ruleId: string): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.crawlId, summary.crawlId), eq(issues.ruleId, ruleId)));
  return rows
    .map((row) => row.details)
    .sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : 1));
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  app = await startFixtureApp(allFixtures());

  summary = await runCrawl(db, {
    siteUrl: app.base,
    maxPages: 500,
    maxDepth: 10,
    userAgent: "AriadneBot-fixture",
    perHostDelayMs: 0,
    maxConcurrency: 8,
    // The second name the fixture server answers to. It is the same machine and
    // the same site — which is exactly what a legacy domain from a rebrand is —
    // and it is the only way `host.legacy-host-reachable` can be exercised
    // through the real probe rather than from hand-built evidence.
    legacyHosts: [app.legacyBase],
    // The sanctioned test-only use: the fixture site is on 127.0.0.1.
    allowPrivate: true,
  });

  registry = buildRegistry();
  await runRules(db, summary.crawlId, registry);

  const pageRows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
  const pathById = new Map<string, string>();
  for (const page of pageRows) {
    const url = new URL(page.url);
    // Query included: `/x?a=1` and `/x` are two pages with two sets of
    // findings, and a fixture that asserts about one must never be handed the
    // other's. A collision is our defect, not a page to merge into.
    const key = `${url.pathname}${url.search}`;
    const existing = pageByPath.get(key);
    if (existing !== undefined) {
      throw new Error(
        `two pages rows share the key ${key}: ${existing.url} and ${page.url}`,
      );
    }
    pageByPath.set(key, page);
    pathById.set(page.id, key);
  }

  for (const row of await db.select().from(issues).where(eq(issues.crawlId, summary.crawlId))) {
    // A null page id is a site-scoped finding: it belongs to the crawl, not to
    // a URL, so it maps to no path — which is what keeps it off /control.
    if (row.pageId === null) {
      siteFindings.set(row.ruleId, [...(siteFindings.get(row.ruleId) ?? []), row.details]);
      continue;
    }
    const path = pathById.get(row.pageId);
    if (path === undefined) {
      throw new Error(`issue ${row.ruleId} names page ${row.pageId}, which has no pages row`);
    }
    const fired = issuesByPath.get(path) ?? new Set<string>();
    fired.add(row.ruleId);
    issuesByPath.set(path, fired);
    detailsByPath.set(`${path}\n${row.ruleId}`, row.details);
  }

  for (const row of await db
    .select()
    .from(hreflang)
    .where(eq(hreflang.crawlId, summary.crawlId))) {
    const path = pathById.get(row.pageId);
    if (path === undefined) {
      throw new Error(
        `hreflang ${row.hreflangCode} names page ${row.pageId}, which has no pages row`,
      );
    }
    const codes = hreflangByPath.get(path) ?? [];
    codes.push(row.hreflangCode);
    hreflangByPath.set(path, codes);
  }
  for (const codes of hreflangByPath.values()) codes.sort();
}, 120_000);

afterAll(async () => {
  // The crawl row cascades to pages, issues and the frontier.
  if (db !== undefined && summary !== undefined) {
    await db.delete(crawls).where(eq(crawls.id, summary.crawlId));
  }
  if (db !== undefined) await closeDb(db);
  await closeFetchAgents();
  if (app !== undefined) await app.close();
});

describe("the fixture site end to end", () => {
  it("crawls cleanly and reaches every fixture", () => {
    expect(summary.status).toBe("finished");
    expect(summary.frontier.pending).toBe(0);
    expect(summary.frontier.failed).toBe(0);

    // Asserted from the `pages` rows, not from the findings: a fixture that
    // fires nothing (the control) still has to have been fetched, and a fixture
    // the hub forgot to link would otherwise surface as a missing finding,
    // which reads like a broken rule rather than an unreachable page.
    for (const fixture of allFixtures()) {
      expect([...pageByPath.keys()], `${fixture.path} was never crawled`).toContain(
        fixture.path,
      );
    }
  });

  it("every fixture's expected issues fire on its path", () => {
    for (const fixture of allFixtures()) {
      const fired = [...(issuesByPath.get(fixture.path) ?? new Set<string>())].sort();

      // The authored fixtures declare the COMPLETE set (see `Fixture.exact`):
      // each is the control page with one thing deliberately broken, so a rule
      // they did not name is a rule that should not have fired, and a
      // containment assertion would let it through in silence.
      if (fixture.exact === true) {
        expect(
          fired,
          `${fixture.path} must fire exactly the issues it declares`,
        ).toEqual([...fixture.expectedIssues].sort());
        continue;
      }

      // The absorbed pages declare a floor: upstream built them to demonstrate
      // one issue, not to be quiet about the rest.
      for (const ruleId of fixture.expectedIssues) {
        expect(fired, `${fixture.path} should fire ${ruleId}`).toContain(ruleId);
      }
    }
  });

  it("no rule fires on the control page", () => {
    // "Fired nothing" is only evidence if the page was actually audited. Almost
    // every page rule is gated on `isAuditable`, so a control that regressed to
    // a 404, a redirect or a body the analyzer could not read would fire
    // nothing and pass this assertion while proving the opposite of what it
    // claims. The fetch outcome is checked first, from the page row.
    const control = pageByPath.get("/control");
    if (control === undefined) {
      throw new Error("/control has no pages row: the control page was never crawled");
    }
    expect(control.fetchClass, "/control must be a clean fetch to prove anything").toBe("ok");
    expect(control.statusCode).toBe(200);
    // A null word count means no analysis ran — the page rules read a row with
    // nothing in it, which is silence for the wrong reason.
    expect(control.wordCount, "/control must have been analyzed").not.toBeNull();

    // The hub at `/` legitimately fires rules — it is a page, not the control.
    expect([...(issuesByPath.get("/control") ?? new Set<string>())]).toEqual([]);
  });

  it("the site-scoped findings are the two host names, the sitemap's own faults and the missing breadcrumbs", async () => {
    // Six rules write a null-page finding on this crawl, and each of them is a
    // statement about the SITE rather than about a URL:
    //
    //  - `host.http-serves-200` twice, because this server answers to two names
    //    and both of them serve a page over plain HTTP. That is CHECK-14, true
    //    of both spellings, and reporting it once would hide one of them.
    //  - `host.legacy-host-reachable` for the second of those names, which the
    //    crawl was given as `legacyHosts`: an origin that is not one of the
    //    site's own spellings and still serves the site under its own name.
    //    Between them these two prove the probe RAN, which is what puts
    //    `host.probe-skipped` in `SKIP_HARNESS_CLAIMS` rather than anywhere else.
    //  - `robots.blocks-sitemap-urls` and `sitemap.uncrawled` for the same URL,
    //    `/private/hidden`: robots.txt disallows it, so the crawl never enqueued
    //    it, so it has no `pages` row. Two rules, two fixes — take it out of the
    //    sitemap, or stop disallowing it — which is why they are not one finding.
    //  - `sitemap.invalid` for the second declared document, which answers 200
    //    with an HTML error page.
    //  - `schema.breadcrumb-absent`, because no fixture publishes a
    //    `BreadcrumbList` and the site is well past the five-page floor.
    //
    // Everything else must stay off this list. `links.orphan-skipped` and
    // `robots.check-skipped` write null-page findings only when the crawl was
    // incomplete or its robots.txt unreadable — this crawl drains its frontier,
    // stops well short of maxPages and reads a five-line robots.txt — and
    // `robots.missing` needs a site that answers 4xx for it. `sitemap.missing`
    // and `schema.none-on-site` were both live here until Task 9 and can never
    // fire again, which is what their `SKIP_HARNESS_CLAIMS` paragraphs are about.
    expect([...siteFindings.keys()].sort()).toEqual([
      "host.http-serves-200",
      "host.legacy-host-reachable",
      "robots.blocks-sitemap-urls",
      "schema.breadcrumb-absent",
      "sitemap.invalid",
      "sitemap.uncrawled",
    ]);

    // The breadcrumb finding carries how many pages of this site a search engine
    // could index, and the number is checked against the `pages` rows the crawl
    // actually wrote rather than pinned as a literal, so adding a fixture does
    // not turn into an unrelated failure here.
    const indexablePages = [...pageByPath.values()].filter(
      (p) => p.fetchClass === "ok" && p.statusCode === 200 && p.isIndexable,
    ).length;
    expect(indexablePages).toBeGreaterThanOrEqual(5);
    // `runRules` writes `pageUrl` into every details blob; a site-scoped finding
    // names no page, so it is null here.
    expect(siteFindings.get("schema.breadcrumb-absent")).toEqual([
      { pageUrl: null, indexablePages },
    ]);

    // Both plaintext spellings, each with the single hop its chain walked: the
    // fixture server answered the root itself rather than redirecting anywhere.
    // Sorted, because the order the two variants are probed in is the probe's
    // business and not something this assertion should depend on.
    const httpVariants = (siteFindings.get("host.http-serves-200") ?? [])
      .map((d) => (d as { variant: string }).variant)
      .sort();
    expect(httpVariants).toEqual([`${app.base}/`, `${app.legacyBase}/`].sort());
    for (const finding of siteFindings.get("host.http-serves-200") ?? []) {
      const variant = (finding as { variant: string }).variant;
      expect(finding).toMatchObject({
        pageUrl: variant,
        hops: [{ url: variant, statusCode: 200, fetchClass: "ok", location: null }],
      });
    }

    // The legacy name, and only that one: the site's own spellings are excluded
    // by subtraction from `hostProbeStarts`, so a rule that started reporting
    // them would show up here as a second entry rather than as a silent change.
    expect(siteFindings.get("host.legacy-host-reachable")).toEqual([
      {
        pageUrl: `${app.legacyBase}/`,
        variant: `${app.legacyBase}/`,
        hops: [
          { url: `${app.legacyBase}/`, statusCode: 200, fetchClass: "ok", location: null },
        ],
      },
    ]);

    // The blocked URL, from both sides. `matchedBy` quotes the line of the file
    // that decided, which is what makes the finding a place in a document rather
    // than a claim to be taken on trust.
    const blockedUrl = `${app.base}/private/hidden`;
    expect(siteFindings.get("robots.blocks-sitemap-urls")).toEqual([
      {
        pageUrl: blockedUrl,
        url: blockedUrl,
        userAgent: "AriadneBot-fixture",
        matchedBy: { line: 3, text: "Disallow: /private/" },
      },
    ]);
    expect(siteFindings.get("sitemap.uncrawled")).toEqual([
      // `attempted: false` is the shape that matters: there is no `pages` row at
      // all, because the crawl refused to enqueue a URL robots.txt disallows.
      // A URL that was fetched and failed would carry a fetch class instead.
      { pageUrl: blockedUrl, url: blockedUrl, attempted: false },
    ]);

    expect(siteFindings.get("sitemap.invalid")).toEqual([
      {
        pageUrl: null,
        failures: [
          {
            url: `${app.base}/sitemap-broken.xml`,
            // The HTML error page that document serves opens with a doctype, and
            // a DTD in a sitemap is refused before the XML parser is handed the
            // bytes. See the fixture app's own comment.
            reason: "refused: <!DOCTYPE declaration in a sitemap (entity-expansion risk)",
          },
        ],
        failureCount: 1,
      },
    ]);
  });

  it("the sitemap's deliberate mistakes land on the URLs that carry them", () => {
    // One entry per fault, each on the page the entry names — the join is
    // `sitemap_urls.url = pages.url` and these three assertions are what proves
    // the two spellings agree end to end, through the crawler that wrote both.
    expect(detailsByPath.get("/status/not-found\nsitemap.non-200")).toEqual({
      pageUrl: `${app.base}/status/not-found`,
      url: `${app.base}/status/not-found`,
      statusCode: 404,
      fetchClass: "client_error",
    });
    expect(detailsByPath.get("/redirect/chain-1\nsitemap.redirected")).toEqual({
      pageUrl: `${app.base}/redirect/chain-1`,
      url: `${app.base}/redirect/chain-1`,
      statusCode: 301,
      redirectUrl: `${app.base}/redirect/chain-2`,
    });
    expect(detailsByPath.get("/index/noindex-meta\nsitemap.non-indexable")).toEqual({
      pageUrl: `${app.base}/index/noindex-meta`,
      url: `${app.base}/index/noindex-meta`,
      robotsMeta: "noindex, follow",
      xRobotsTag: null,
    });

    // And the other direction: the indexable pages the sitemap does not list.
    // Two KINDS of omission — `/authored3/unlisted` is the page the file
    // forgot, and the deep click-path's seven rungs are left out because a
    // sitemap entry is enqueued at depth 0 and would flatten the chain (see
    // `Fixture.inSitemap`). Asserted as the exact set, so a fixture that fell
    // off the sitemap by accident fails here rather than passing quietly.
    const unlisted = [...issuesByPath]
      .filter(([, ids]) => ids.has("pages.not-in-sitemap"))
      .map(([path]) => path)
      .sort();
    expect(unlisted).toEqual([
      "/authored3/unlisted",
      "/deep/1",
      "/deep/2",
      "/deep/3",
      "/deep/4",
      "/deep/5",
      "/deep/6",
      "/deep/7",
    ]);
  });

  it("a <loc> spelled with a fragment and unsorted parameters joins its own page", async () => {
    // The end-to-end half of the normalization seam. `/authored3/loc-variant`
    // is published by `/sitemap.xml` as `?sort=asc&ref=sitemap#top` and fetched
    // by the crawl as `?ref=sitemap&sort=asc`: one URL, two spellings, written
    // by two different parts of this system. Read from the tables rather than
    // asserted from the fixture constants, so what is proved is what the
    // crawler stored.
    const path = "/authored3/loc-variant?ref=sitemap&sort=asc";
    const published = `${app.base}/authored3/loc-variant?sort=asc&ref=sitemap#top`;
    const page = pageByPath.get(path);
    if (page === undefined) throw new Error("the loc-variant fixture was never crawled");

    // The published spelling is stored verbatim — the `<loc>` is evidence, and
    // normalising the column would destroy the line a client goes and edits —
    // and the join column beside it is the frontier key of the page above.
    const [entry] = await db
      .select()
      .from(sitemapUrls)
      .where(and(eq(sitemapUrls.crawlId, summary.crawlId), eq(sitemapUrls.url, published)));
    if (entry === undefined) throw new Error(`no sitemap_urls row for ${published}`);
    expect(entry.urlNormalised).toBe(page.url);

    // And so neither of the two findings that spelling used to invent exists.
    // They are looked for in two places because they land in two: an entry that
    // matches no page row is site-scoped and reaches `siteFindings`, while
    // `pages.not-in-sitemap` names the page and lands on its path.
    expect([...(issuesByPath.get(path) ?? new Set<string>())]).not.toContain(
      "pages.not-in-sitemap",
    );
    const uncrawled = (siteFindings.get("sitemap.uncrawled") ?? []).map(
      (d) => (d as { url: string }).url,
    );
    expect(uncrawled).not.toContain(published);
  });

  it("the paginated series proves all three pagination rules", () => {
    const url = (path: string): string => `${app.base}${path}`;

    // Page 2: the canonical folds it into page 1, and its rel=next names a page
    // nothing links to. Page 1 is the control for both and fires nothing, which
    // the exact-set assertion above already holds.
    expect(detailsByPath.get("/authored3/paged-2\npagination.canonical-to-other")).toEqual({
      pageUrl: url("/authored3/paged-2"),
      canonical: url("/authored3/paged-1"),
      resolvedTo: url("/authored3/paged-1"),
      relPrev: url("/authored3/paged-1"),
    });
    expect(detailsByPath.get("/authored3/paged-2\npagination.next-not-linked")).toEqual({
      pageUrl: url("/authored3/paged-2"),
      relNext: url("/authored3/paged-3"),
      resolvedTo: url("/authored3/paged-3"),
    });

    // Page 3: its own rel=next names a page no link and no sitemap entry
    // mentions, so the crawl never fetched it and the engine can say nothing
    // about it beyond that.
    expect(detailsByPath.get("/authored3/paged-3\npagination.next-target-uncrawled")).toEqual({
      pageUrl: url("/authored3/paged-3"),
      relNext: url("/authored3/paged-4"),
      resolvedTo: url("/authored3/paged-4"),
    });
    expect(pageByPath.has("/authored3/paged-4")).toBe(false);
  });

  it("the orphans are exactly the two pages nothing links to", () => {
    // Both reached the crawl through the sitemap and nothing else, which is what
    // `discoveredVia` and `inSitemap` say. `/authored3/paged-3` is the
    // load-bearing one: it renders its own URL as a link, the way a pagination
    // control does, and an anti-join that counted a page's link to ITSELF as an
    // inbound link would report it as reachable.
    const orphans = [...issuesByPath]
      .filter(([, ids]) => ids.has("links.orphan"))
      .map(([path]) => path)
      .sort();
    expect(orphans).toEqual(["/authored3/paged-3", "/structure/orphan"]);

    for (const path of orphans) {
      expect(detailsByPath.get(`${path}\nlinks.orphan`), path).toEqual({
        pageUrl: `${app.base}${path}`,
        inSitemap: true,
        discoveredVia: "sitemap",
        // No `caveat`: the crawl failed no URL, so no page's outbound links went
        // unread and nothing qualifies the finding.
      });
    }
  });

  it("the hreflang fixtures' declarations reach the rules that judge them", async () => {
    // Which fixture declared what, asserted exactly — both as the map of
    // declarations that went in, and as the findings that came out.
    //
    // This is what makes each hreflang fixture load-bearing rather than
    // decorative. Asserting the rule id alone would be satisfied by whichever
    // page happened to declare a cluster, and the others could be deleted
    // without a test noticing. Pinning the codes, and the targets each finding
    // carries, means removing a page or changing what it declares fails here.
    expect(Object.fromEntries(hreflangByPath)).toEqual({
      "/authored/hreflang-bad-code": ["english-uk"],
      "/authored/hreflang-no-xdefault": ["de", "en"],
      "/authored3/hreflang-a": ["en", "fr", "x-default"],
      "/authored3/hreflang-b": ["en", "fr", "x-default"],
      "/authored3/hreflang-noindex": ["de", "en", "x-default"],
      "/authored3/hreflang-one-way": ["de", "en", "x-default"],
    });

    // The x-default finding belongs to the two-alternate cluster, not to the
    // single bad-code declaration: a page naming one URL is not a cluster and
    // has nothing to fall back from. It lands on the lexically first member of
    // the set, which here is the fixture's own URL — the German alternate is on
    // another host the crawl never fetched, and is named in the evidence all
    // the same.
    const declared = pageByPath.get("/authored/hreflang-no-xdefault");
    if (declared === undefined) throw new Error("the no-xdefault fixture was never crawled");
    expect(
      detailsByPath.get("/authored/hreflang-no-xdefault\nhreflang.missing-x-default"),
    ).toEqual({
      pageUrl: declared.url,
      targets: [declared.url, "https://de.example/willkommen"],
      setSize: 2,
    });

    // And the bad-code page, whose one declaration is not a set, carries no
    // x-default finding at all.
    expect([
      ...(issuesByPath.get("/authored/hreflang-bad-code") ?? new Set<string>()),
    ]).not.toContain("hreflang.missing-x-default");

    // The two join rules write one finding per CLUSTER MEMBER, so a page can
    // carry several and `detailsByPath` would keep only the last of them (see
    // its declaration). Both are read as whole sets out of `issues` instead.
    expect(await findingSet("hreflang.missing-return-link")).toEqual([
      {
        pageUrl: `${app.base}/authored3/hreflang-noindex`,
        target: `${app.base}/index/noindex-meta`,
        targetHasHreflang: false,
      },
      {
        pageUrl: `${app.base}/authored3/hreflang-one-way`,
        target: `${app.base}/authored3/hreflang-mute`,
        targetHasHreflang: false,
      },
    ]);
    // The reciprocated pair is absent from that list, which is the whole point
    // of having it: `/authored3/hreflang-a` and `-b` name each other and fire
    // nothing.
    expect(await findingSet("hreflang.non-indexable-target")).toEqual([
      {
        pageUrl: `${app.base}/authored3/hreflang-noindex`,
        target: `${app.base}/index/noindex-meta`,
        targetFetchClass: "ok",
        targetIndexable: false,
      },
    ]);
  });

  it("the soft 404 fires on wording alone, because the site has no 404 template", async () => {
    // The rule has two signal paths and this site can only offer one. The
    // crawl's own probe asks for a URL that cannot exist and the fixture app
    // answers a real 404, so there is no 200 body to fingerprint and the
    // template path is unavailable — asserted from the stored probe rather than
    // inferred from the finding, because "no template" and "a template that
    // happened not to match" are different crawls with the same silence.
    const [crawlRow] = await db
      .select({ probe: crawls.notfoundProbe })
      .from(crawls)
      .where(eq(crawls.id, summary.crawlId));
    expect(crawlRow?.probe).toMatchObject({ statusCode: 404, simhash: null });

    // So the only signal left is the wording, and the page's length is what
    // makes that wording mean something: over `THIN_WORDS` (or it would be a
    // thin page as well) and under `SOFT_404_WORDS` (or an article about broken
    // links would qualify). The bounds are read from the rules rather than
    // restated, so a threshold that moves fails here instead of drifting.
    const details = detailsByPath.get("/authored3/soft-404\ncontent.soft-404") as {
      signals: string[];
      wordCount: number;
    };
    expect(details.signals).toEqual(["phrases"]);
    expect(details.wordCount).toBeGreaterThanOrEqual(THIN_WORDS);
    expect(details.wordCount).toBeLessThan(SOFT_404_WORDS);
    // `hammingToTemplate` appears only when a distance was computed; there was
    // no template, so the blob carries the two fields above and nothing else.
    expect(details).toEqual({
      pageUrl: `${app.base}/authored3/soft-404`,
      signals: ["phrases"],
      wordCount: details.wordCount,
    });
  });

  it("the URL-hygiene fixtures name the right URLs", () => {
    // Two spellings of one path, both answering 200. The finding lands on the
    // group's first URL under the DATABASE's collation — the lowercase one on
    // the documented postgres:16 container; see the fixture's own paragraph —
    // and the other member is in the evidence beside it, in the same order.
    expect(detailsByPath.get("/authored3/case\nurl.normalisation-variants")).toEqual({
      pageUrl: `${app.base}/authored3/case`,
      urlNormalised: `${app.base}/authored3/case`.toLowerCase(),
      variants: [`${app.base}/authored3/case`, `${app.base}/authored3/Case`],
      count: 2,
    });

    // One page, two findings, about two different things: the LINK that carries
    // a campaign tag, and the PAGE that declares the tagged address canonical.
    const tracked = `${app.base}/authored3/tracked?utm_source=newsletter`;
    expect(
      detailsByPath.get(
        "/authored3/tracked?utm_source=newsletter\nurl.tracking-params-internal",
      ),
    ).toEqual({
      pageUrl: tracked,
      targetUrl: tracked,
      params: ["utm_source"],
      // The hub's link, and only that one. The sitemap lists the same URL and is
      // not a link, which is what this count would notice if the rule ever
      // started reading `sitemap_urls`.
      inlinkCount: 1,
    });
    expect(
      detailsByPath.get(
        "/authored3/tracked?utm_source=newsletter\nurl.parameter-pages-indexable",
      ),
    ).toEqual({ pageUrl: tracked, url: tracked, params: ["utm_source"] });
  });

  it("the structured-data fixtures name the field that is missing and the rating that is self-serving", () => {
    // The field names are what a client goes and adds, so they are pinned rather
    // than counted: the Product block carries a name and a priced offer and no
    // image, and three of the five recommended fields are absent too.
    expect(
      detailsByPath.get("/authored3/product-incomplete\nschema.product-incomplete"),
    ).toEqual({
      pageUrl: `${app.base}/authored3/product-incomplete`,
      missingRequired: ["image"],
      missingRecommended: ["brand", "aggregateRating", "review"],
    });

    expect(detailsByPath.get("/authored3/reviews\nschema.self-serving-reviews")).toEqual({
      pageUrl: `${app.base}/authored3/reviews`,
      schemaType: "Organization",
      fields: ["aggregateRating"],
    });
  });

  it("the duplicate rules see the site's real duplicates, end to end", async () => {
    // The simhash round trip, through the real crawler for once: an unsigned
    // 64-bit value from the analyzer, stored as a signed bigint by the writer,
    // compared by four band equalities and a `bit_count` XOR inside Postgres.
    // The unit tests hand-build those rows; only this one proves the value that
    // reaches the column is the value the SQL reads.
    expect(detailsByPath.get("/content/duplicate-a\ncontent.exact-duplicate")).toEqual({
      pageUrl: `${app.base}/content/duplicate-a`,
      // The two absorbed copies are byte-identical by construction.
      contentHash: expect.any(String),
      urls: [`${app.base}/content/duplicate-a`, `${app.base}/content/duplicate-b`],
      count: 2,
      pageTypes: ["/content/duplicate-a", "/content/duplicate-b"],
    });

    // The click-chain's rungs are one template with a number substituted, so
    // several of them land inside the three-bit band. Read from the `issues`
    // rows rather than from `detailsByPath`, which is keyed by path and rule and
    // therefore keeps only the LAST of the pairs a page belongs to — and the
    // pair join has no ORDER BY, so which one that is depends on the plan.
    //
    // The SET is deterministic even though the order is not: the cap is nowhere
    // near, so every pair inside the band is reported. Pinning the pairs and
    // their distances is what makes this an assertion about the fingerprints
    // rather than about two pages happening to be similar.
    const pairs = (
      await db
        .select()
        .from(issues)
        .where(
          and(eq(issues.crawlId, summary.crawlId), eq(issues.ruleId, "content.near-duplicate")),
        )
    )
      .map((row) => {
        const d = row.details as { urlA: string; urlB: string; hamming: number };
        return `${d.urlA.replace(app.base, "")} ~${d.hamming}~ ${d.urlB.replace(app.base, "")}`;
      })
      .sort();
    expect(pairs).toEqual([
      "/deep/2 ~1~ /deep/6",
      "/deep/2 ~3~ /deep/4",
      "/deep/2 ~3~ /deep/5",
    ]);

    // And nowhere else. A group is reported once, on its first member, and a
    // pair once, on the first of the two — so a second page carrying either
    // finding would mean a rule had started reporting per page.
    const duplicated = [...issuesByPath]
      .filter(([, ids]) => ids.has("content.exact-duplicate") || ids.has("content.near-duplicate"))
      .map(([path]) => path)
      .sort();
    expect(duplicated).toEqual(["/content/duplicate-a", "/deep/2"]);
  });

  it("every registered rule fires on at least one fixture", () => {
    // Fixture paths only. The hub is crawled and judged like any other page,
    // but it proves nothing: a rule "covered" only by the hub would be a rule
    // no fixture was ever written for.
    //
    // `siteFindings` seeds the set. A site-scoped rule has no page to land on —
    // it is provoked by the site as a whole rather than by one fixture's markup
    // — so counting it towards coverage regardless of which page produced it is
    // correct. The assertion above is what holds the contents of that map
    // honest.
    const fired = new Set(siteFindings.keys());
    for (const fixture of allFixtures()) {
      for (const ruleId of issuesByPath.get(fixture.path) ?? []) fired.add(ruleId);
    }

    const exempt = new Set(SKIP_HARNESS_CLAIMS);
    // METRIC rules are skipped by KIND, not exempted by id, and the reason is
    // categorical rather than fixture-specific: a metric rule writes rows to
    // the `metrics` table and never writes an issue, so "fires on a fixture"
    // is a question that cannot be asked of one. Listing them in
    // SKIP_HARNESS_CLAIMS would be a lie of a different shape — that paragraph
    // is for rules a page COULD provoke but this site cannot.
    //
    // They are not left unproven: `test/rules/link-metrics.test.ts` asserts
    // every number against a hand-computed crawl, and Task 7 adds the harness's
    // own metric assertion — the exact metric-id set present after `runRules`,
    // with three site rows pinned to hand-derived fixture-site values. That is
    // the coverage net for this kind.
    const unfired = registry
      .all()
      .filter((rule) => rule.kind !== "metric")
      .map((rule) => rule.id)
      .filter((id) => !fired.has(id) && !exempt.has(id))
      .sort();
    // The strict form, at last: every registered rule fires on this one crawl,
    // save the seven `SKIP_HARNESS_CLAIMS` name and explain. A new rule arrives
    // here with no fixture and fails immediately, which is the point — the
    // alternative is a rule nobody has ever seen speak.
    expect(
      unfired,
      "a rule that fires nowhere is a rule no fixture proves — author a fixture " +
        "that makes it speak, or add it to SKIP_HARNESS_CLAIMS with a paragraph " +
        "saying why no page could",
    ).toEqual([]);

    // The exemption is asserted, not assumed. An id listed as unfireable that
    // then fires is a rule whose condition is not what the list claims, and it
    // must leave the list rather than sit there as a stale excuse.
    for (const id of SKIP_HARNESS_CLAIMS) {
      expect(fired.has(id), `${id} fired — it is not unfireable, drop the exemption`).toBe(
        false,
      );
      expect(
        registry.all().map((rule) => rule.id),
        `${id} is exempted from coverage but is not a registered rule`,
      ).toContain(id);
    }
  });
});
