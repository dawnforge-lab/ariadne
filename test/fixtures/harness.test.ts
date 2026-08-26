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
import { eq } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlSummary } from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, hreflang, issues, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
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
 * Rules no fixture claims yet. Each needs a page shape the fixture site does
 * not serve today: a canonical or an hreflang alternate pointing at a URL the
 * crawl fetched and found broken or noindexed, a page nothing links to (the
 * hub links every fixture, which is what makes the crawl reach them all), and
 * a paginated series, and — for the sitemap rules — a sitemap at all. The
 * fixture site deliberately publishes none today (see app.ts), so every rule
 * that joins `sitemap_urls` to `pages` has nothing to read: Task 9 authors a
 * declared sitemap listing a 404, a redirect, a noindexed page, a URL the crawl
 * cannot reach and a URL robots.txt disallows, and leaves at least one
 * indexable page off it. Phase 3's fixture task (Task 9) authors those pages and
 * DELETES this list, at which point the last assertion below becomes the strict
 * "every registered rule fires somewhere" it wants to be. The same pattern, and
 * the same promise, as Phase 2's Task 8 -> 9.
 *
 * It is asserted exactly, not as a floor: a rule that quietly stops firing
 * shows up here as an unexpected addition, and a rule Task 9 claims without
 * removing its entry shows up as an unexpected absence. The other Phase 3 rules
 * are not here because the absorbed redirect and 404 pages, and the authored
 * hreflang pair, already provoke them — see their `expectedIssues`.
 */
const UNCLAIMED_UNTIL_TASK_9: string[] = [
  "canonical.non-200-target",
  "canonical.non-indexable-target",
  "hreflang.missing-return-link",
  "hreflang.non-indexable-target",
  "links.orphan",
  "pages.not-in-sitemap",
  "pagination.canonical-to-other",
  "pagination.next-not-linked",
  "pagination.next-target-uncrawled",
  "robots.blocks-sitemap-urls",
  "sitemap.invalid",
  "sitemap.non-200",
  "sitemap.non-indexable",
  "sitemap.redirected",
  "sitemap.uncrawled",
];

/**
 * Rules NO fixture can ever claim, because their firing condition is a property
 * of an unhealthy crawl rather than of a page the site could serve.
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
 * app serves one for the whole site — allow-all, which is what lets the crawl
 * reach every fixture — and a robots.txt either exists for a site or does not.
 * No page could provoke this without removing the file the rest of the harness
 * depends on. `test/rules/robots-query.test.ts` builds both sites directly.
 *
 * `robots.check-skipped` fires when the stored robots.txt cannot be re-parsed
 * soundly: a file past the 500KB read cap, or one the server never served. The
 * first would mean a fixture app serving half a megabyte of directives, the
 * second a crawl that fails outright (an unreachable robots.txt is a complete
 * disallow, so `runCrawl` closes the crawl as failed and nothing is crawled at
 * all). Both are properties of an unhealthy crawl, like `links.orphan-skipped`
 * above, and both are covered by the same DB test file.
 *
 * Unlike `UNCLAIMED_UNTIL_TASK_9` this list does not empty: it is a permanent,
 * named exemption. Task 9 deletes that list and leaves this one, so the
 * every-rule-fires assertion stays strict about every rule a fixture COULD
 * provoke. Adding an id here is a claim that no page can provoke it, and it
 * needs the same kind of paragraph as the one above.
 */
const SKIP_HARNESS_CLAIMS: string[] = [
  "links.orphan-skipped",
  "robots.check-skipped",
  "robots.missing",
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
 */
const detailsByPath = new Map<string, unknown>();
/**
 * Findings that belong to no URL, by rule id, with the evidence the rule wrote.
 * One registered rule writes one on THIS crawl: the fixture site's robots.txt
 * declares no sitemap, which is `sitemap.missing`. The map is asserted exactly,
 * so a second site-scoped finding — a rule that changed shape, or one whose
 * skip condition started matching a healthy crawl — surfaces here instead of
 * vanishing.
 */
const siteFindings = new Map<string, unknown>();
/**
 * Path -> the hreflang codes the page at that path declared, sorted, read
 * straight from the `hreflang` table. This is the input side of the site-scoped
 * rule: it says which fixture contributed which declaration, so a fixture that
 * stopped contributing fails an assertion instead of quietly not mattering.
 */
const hreflangByPath = new Map<string, string[]>();

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
      siteFindings.set(row.ruleId, row.details);
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

  it("the only site-scoped finding is the sitemap the site never declares", () => {
    // The fixture app serves a robots.txt with no `Sitemap:` line on purpose
    // (see app.ts: every page is reached by link, so no fixture is quietly
    // rescued by a sitemap). That is exactly what CHECK-06 reports, once, for
    // the crawl rather than for a URL.
    //
    // Everything else must stay off this list. `links.orphan-skipped` and
    // `robots.check-skipped` write null-page findings only when the crawl was
    // incomplete or its robots.txt unreadable — this crawl drains its frontier,
    // stops well short of maxPages and reads a two-line robots.txt — and
    // `robots.missing` needs a site that answers 404 for it.
    expect([...siteFindings.keys()]).toEqual(["sitemap.missing"]);
    expect(siteFindings.get("sitemap.missing")).toEqual({
      // `runRules` writes `pageUrl` into every details blob; a site-scoped
      // finding names no page, so it is null here.
      pageUrl: null,
      robotsOutcome: "read",
      sitemapSources: [],
    });
  });

  it("the hreflang fixtures' declarations reach the rules that judge them", () => {
    // Which fixture declared what, asserted exactly — both as the map of
    // declarations that went in, and as the set the finding named on the way
    // out.
    //
    // This is what makes each hreflang fixture load-bearing rather than
    // decorative. Asserting the rule id alone would be satisfied by whichever
    // page happened to declare a cluster, and the other could be deleted
    // without a test noticing. Pinning the codes, and the targets the finding
    // carries, means removing either page or changing what it declares fails
    // here.
    expect(Object.fromEntries(hreflangByPath)).toEqual({
      "/authored/hreflang-bad-code": ["english-uk"],
      "/authored/hreflang-no-xdefault": ["de", "en"],
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
  });

  it("every registered rule fires on at least one fixture", () => {
    // Fixture paths only. The hub is crawled and judged like any other page,
    // but it proves nothing: a rule "covered" only by the hub would be a rule
    // no fixture was ever written for.
    //
    // `siteFindings` seeds the set, and holds `sitemap.missing` today. A
    // site-scoped rule has no page to land on — it is provoked by the site as a
    // whole rather than by one fixture's markup — so counting it towards
    // coverage regardless of which page produced it is correct. The assertion
    // above is what holds the contents of that map honest.
    const fired = new Set(siteFindings.keys());
    for (const fixture of allFixtures()) {
      for (const ruleId of issuesByPath.get(fixture.path) ?? []) fired.add(ruleId);
    }

    const exempt = new Set(SKIP_HARNESS_CLAIMS);
    const unfired = registry
      .all()
      .map((rule) => rule.id)
      .filter((id) => !fired.has(id) && !exempt.has(id))
      .sort();
    expect(
      unfired,
      "a rule that fires nowhere is a rule no fixture proves — author a fixture " +
        "that makes it speak, or remove the id from UNCLAIMED_UNTIL_TASK_9 once " +
        "one exists",
    ).toEqual([...UNCLAIMED_UNTIL_TASK_9].sort());

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
