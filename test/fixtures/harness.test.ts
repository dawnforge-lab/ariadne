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
import { crawls, issues, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { runRules } from "../../src/rules/run.js";
import type { Registry } from "../../src/rules/registry/registry.js";
import { allFixtures } from "./fixture.js";
import { startFixtureApp, type FixtureApp } from "./app.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Rules no fixture claims yet. Task 9 authors the missing pages and DELETES
 * this list, at which point the third assertion below becomes the strict "every
 * registered rule fires somewhere" it wants to be.
 *
 * It is asserted exactly, not as a floor: a rule that quietly stops firing
 * shows up here as an unexpected addition, and a rule Task 9 claims without
 * removing its entry shows up as an unexpected absence. Every id in it was
 * hand-checked against the fixture collection — none of the absorbed pages or
 * the control page targets any of these.
 */
const UNCLAIMED_UNTIL_TASK_9: string[] = [
  "canonical.cross-domain",
  "canonical.missing",
  "canonical.multiple",
  "content.placeholder",
  "directive.canonical-noindex-conflict",
  "hreflang.invalid-code",
  "hreflang.missing-x-default",
  "images.missing-dimensions",
  "indexability.meta-header-conflict",
  "mobile.viewport-missing",
];

let db: Db;
let app: FixtureApp;
let summary: CrawlSummary;
let registry: Registry;

/** Every path the crawl produced a `pages` row for. */
const crawledPaths = new Set<string>();
/** Path -> the rule ids that fired on the page at that path. */
const issuesByPath = new Map<string, Set<string>>();
/**
 * Rule ids from findings that belong to no URL — today only
 * `hreflang.missing-x-default`, which is a fact about the crawl's annotation
 * set rather than about a page. They count towards coverage (a fixture's
 * hreflang is what produces them) and attach to no path, `/control` included.
 */
const siteFindings = new Set<string>();

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
  const pathById = new Map(pageRows.map((p) => [p.id, new URL(p.url).pathname]));
  for (const path of pathById.values()) crawledPaths.add(path);

  for (const row of await db.select().from(issues).where(eq(issues.crawlId, summary.crawlId))) {
    // A null page id is a site-scoped finding: it belongs to the crawl, not to
    // a URL, so it maps to no path — which is what keeps it off /control.
    if (row.pageId === null) {
      siteFindings.add(row.ruleId);
      continue;
    }
    const path = pathById.get(row.pageId);
    if (path === undefined) {
      throw new Error(`issue ${row.ruleId} names page ${row.pageId}, which has no pages row`);
    }
    const fired = issuesByPath.get(path) ?? new Set<string>();
    fired.add(row.ruleId);
    issuesByPath.set(path, fired);
  }
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
      expect([...crawledPaths], `${fixture.path} was never crawled`).toContain(fixture.path);
    }
  });

  it("every fixture's expected issues fire on its path", () => {
    for (const fixture of allFixtures()) {
      for (const ruleId of fixture.expectedIssues) {
        expect(
          [...(issuesByPath.get(fixture.path) ?? new Set<string>())],
          `${fixture.path} should fire ${ruleId}`,
        ).toContain(ruleId);
      }
    }
  });

  it("no rule fires on the control page", () => {
    // The hub at `/` legitimately fires rules — it is a page, not the control.
    expect([...(issuesByPath.get("/control") ?? new Set<string>())]).toEqual([]);
  });

  it("every registered rule fires on at least one fixture", () => {
    // Fixture paths only. The hub is crawled and judged like any other page,
    // but it proves nothing: a rule "covered" only by the hub would be a rule
    // no fixture was ever written for.
    const fired = new Set(siteFindings);
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
      "a rule that fires nowhere is a rule no fixture proves — add a fixture, " +
        "or remove the id from UNCLAIMED_UNTIL_TASK_9 once one exists",
    ).toEqual([...UNCLAIMED_UNTIL_TASK_9].sort());
  });
});
