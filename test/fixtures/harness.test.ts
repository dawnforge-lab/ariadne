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
 * a paginated series. Phase 3's fixture task (Task 9) authors those pages and
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
  "pagination.canonical-to-other",
  "pagination.next-not-linked",
  "pagination.next-target-uncrawled",
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
 * No registered rule writes one on THIS crawl any more — `links.orphan` writes
 * a site-scoped finding only when the crawl was incomplete, and this one is
 * not — so the map is asserted empty. It is still collected rather than
 * dropped: a site-scoped finding appearing here is a rule that changed shape,
 * and the assertion below is where that surfaces instead of vanishing.
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

  it("no finding on this crawl is site-scoped", () => {
    // `hreflang.missing-x-default` used to be the registry's one site-scoped
    // rule and is now per declaration SET, landing on a URL. The only rule that
    // can still write a null-page finding is `links.orphan`, and only when the
    // crawl was incomplete — this one drains its frontier and stops well short
    // of maxPages, so it must not.
    expect([...siteFindings.keys()]).toEqual([]);
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
    // `siteFindings` still seeds the set, and is empty today. A site-scoped
    // rule has no page to land on — it is provoked by a fixture's markup but
    // written against the crawl — so counting one towards coverage regardless
    // of which page produced it would be correct. The assertion above is what
    // holds "no page" honest while there are none.
    const fired = new Set(siteFindings.keys());
    for (const fixture of allFixtures()) {
      for (const ruleId of issuesByPath.get(fixture.path) ?? []) fired.add(ruleId);
    }

    const unfired = registry
      .all()
      .map((rule) => rule.id)
      .filter((id) => !fired.has(id))
      .sort();
    expect(
      unfired,
      "a rule that fires nowhere is a rule no fixture proves — author a fixture " +
        "that makes it speak, or remove the id from UNCLAIMED_UNTIL_TASK_9 once " +
        "one exists",
    ).toEqual([...UNCLAIMED_UNTIL_TASK_9].sort());
  });
});
