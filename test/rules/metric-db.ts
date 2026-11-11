/**
 * The scaffolding every metric-rule DB test needs, in one place.
 *
 * Five metric test files (link, content, hreflang, url, crawl) each build the
 * same four things before they can assert anything: the database URL with no
 * fallback, a `crawls` row to hang pages off, a rule looked up by id in its own
 * exported array, and a metric's rows shaped as `"<scope>|<scopeValue>" ->
 * value` so an assertion can name a cohort instead of an array index. They were
 * copied verbatim from the first file to the next four, which is four chances
 * for the copies to drift — a `newCrawl` that stopped setting `status`, a
 * shaper that stopped checking `metricId` — while every file still passed.
 *
 * This is the same move `mk-page.ts` made for the page-rule tests: the shared
 * setup is defined once, and what stays in each file is the site under test and
 * the arithmetic asserted against it. NO assertion moved here — only the
 * plumbing that gets a rule to the point of being run.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { eq } from "drizzle-orm";

import type { Db } from "../../src/db/client.js";
import { crawls } from "../../src/db/schema.js";
import type { Metric, MetricRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

/** The dev-container URL, refused rather than defaulted (hard rule 7). */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Look a metric rule up by id in one exported array, failing loudly when it is
 * absent — `mk-page.ts`'s `ruleLookup`, for the metric kind. Every metric test
 * drives its rules through this rather than indexing the array by position, so
 * renaming or reordering a rule breaks the test that names it instead of
 * silently testing a different rule.
 */
export function metricLookup(
  rules: readonly MetricRule[],
  arrayName: string,
): (id: string) => MetricRule {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return (id) => {
    const rule = byId.get(id);
    if (rule === undefined) throw new Error(`no rule '${id}' in ${arrayName}`);
    return rule;
  };
}

/**
 * A finished `crawls` row for `siteUrl`, its id pushed onto `created` so the
 * file's `afterAll` can drop it (the row cascades to pages, links, issues and
 * the rest).
 *
 * `overrides` is spread last, so a file that needs a discovery blob, a user
 * agent in the config or a particular `pagesCrawled` states that and nothing
 * else. What is NOT overridable by omission is `status: "finished"` — a metric
 * reading a half-finished crawl is a different test, and one that has to say so.
 *
 * `id` is excluded from the override type rather than merely ignored: the id is
 * generated here and RETURNED, so an override of it would be spread into the
 * row while every caller kept using the returned value — a test inserting one
 * crawl and querying another. It fails to compile instead.
 */
export async function newMetricCrawl(
  db: Db,
  siteUrl: string,
  created: string[],
  overrides: Partial<Omit<typeof crawls.$inferInsert, "id">> = {},
): Promise<string> {
  const id = `crawl_${randomUUID()}`;
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl,
    config: { maxPages: 500 },
    rulesetVersion: "test",
    status: "finished",
    ...overrides,
  });
  created.push(id);
  return id;
}

/** Drop every crawl the file created, in the order it created them. */
export async function dropCrawls(db: Db, created: readonly string[]): Promise<void> {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
}

/**
 * One metric rule's rows, keyed by `"<scope>|<scopeValue>"`.
 *
 * The key is what lets an assertion name the cohort it is about — `rows["site|"]`,
 * `rows["page_type|blog"]` — rather than depending on the order the query
 * returned. Every row's `metricId` is checked on the way past: a rule that
 * stamped a row with someone else's id would otherwise be invisible here,
 * and the metrics primary key is `(crawl, metricId, scope, scopeValue)`.
 */
export async function metricRowsByScope(
  db: Db,
  rule: MetricRule,
  crawlId: string,
): Promise<Record<string, unknown>> {
  const rows: Metric[] = await rule.run(db, crawlId);
  for (const row of rows) expect(row.metricId, `${rule.id} row identity`).toBe(rule.id);
  return Object.fromEntries(rows.map((m) => [`${m.scope}|${m.scopeValue}`, m.value]));
}

/**
 * Every rule in the array refuses a crawl id nothing knows.
 *
 * The reason this is a test at all rather than an obvious property: each of
 * these rules aggregates over `pages` (or `sitemap_urls`, or `url_params`)
 * filtered by `crawl_id`, and an id with no row behind it aggregates to a table
 * of zeroes, an empty list, or no rows at all — every one of which is ALSO the
 * honest answer for some real crawl. Two facts sharing one shape is the silent
 * failure hard rule 7 forbids, so the rules open with `assertCrawl` and this
 * asserts that they still do.
 */
export async function expectRefusesUnknownCrawl(
  db: Db,
  rules: readonly MetricRule[],
): Promise<void> {
  const missing = `crawl_${randomUUID()}`;
  for (const rule of rules) {
    await expect(rule.run(db, missing), rule.id).rejects.toThrow(/no such crawl/);
  }
}
