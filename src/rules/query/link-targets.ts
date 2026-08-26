import { and, asc, gt, isNotNull, or, sql, eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pages } from "../../db/schema.js";
import { isAuditable, queryFinding, type RuleIdentity } from "../helpers.js";
import { resolveEffectiveCanonical } from "../page/canonical.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type PageRecord,
  type QueryRule,
} from "../registry/registry.js";

/** Source URLs listed on a broken-target finding. The count is never sampled. */
export const SAMPLE_SOURCES = 10;

/**
 * Pages read per round trip by the canonical-target scan — the memory contract:
 * a batch, never the whole table. Exported so a test can force the cursor to
 * iterate without hardcoding the number.
 */
export const CANONICAL_BATCH = 500;

/**
 * Internal links whose target page answered 4xx, grouped by TARGET.
 *
 * Target-centric on purpose: one dead URL linked from two hundred pages is one
 * thing to fix, and two hundred findings would bury it. The count is exact and
 * the sources are a sample, so the finding says how big the problem is without
 * carrying an unbounded array — the `limit` is inside the lateral, so Postgres
 * never builds the full source list either (hard rule 3: the links table is
 * never loaded into memory).
 *
 * 4xx only. A 5xx target is a server fault the page's own `http.server-error`
 * reports; calling it a broken link would point the client at the wrong repair.
 */
async function brokenInternalFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  const result = await db.execute<{
    target_page_id: string;
    target_url: string;
    status_code: number | null;
    inlink_count: number;
    sample_sources: string[];
  }>(sql`
    with targets as (
      select p.id as target_page_id, p.url as target_url, p.status_code,
             count(*)::int as inlink_count
      from links l
      join pages p on p.crawl_id = ${crawlId} and p.url = l.target_url
      where l.crawl_id = ${crawlId} and l.is_internal and p.fetch_class = 'client_error'
      group by p.id, p.url, p.status_code
    )
    select t.target_page_id, t.target_url, t.status_code, t.inlink_count,
           s.sample_sources
    from targets t
    cross join lateral (
      select coalesce(array_agg(sample.url), array[]::text[]) as sample_sources
      from (
        select src.url
        from links l2
        join pages src on src.id = l2.source_page_id
        where l2.crawl_id = ${crawlId} and l2.is_internal and l2.target_url = t.target_url
        order by src.url
        limit ${SAMPLE_SOURCES}
      ) sample
    ) s`);

  return result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.target_page_id,
      pageUrl: row.target_url,
      evidence: {
        targetUrl: row.target_url,
        statusCode: row.status_code,
        inlinkCount: row.inlink_count,
        sampleSources: row.sample_sources,
      },
      dedupeKey: row.target_url,
    }),
  );
}

/** A page's canonical, the URL it resolves to, and the page row for that URL. */
interface ResolvedTarget {
  page: PageRecord;
  canonical: string;
  resolvedTo: string;
  target: PageRecord;
}

/**
 * Every page whose effective canonical points at another URL the crawl fetched,
 * paired with that URL's page row.
 *
 * Batched rather than joined in SQL because the resolution is JavaScript: a
 * canonical can be relative, carry a fragment or spell its query string in a
 * different order, and `resolveEffectiveCanonical` — the same function the
 * canonical page rules use — is what settles all three. Each batch of pages is
 * resolved, its targets looked up in one `IN` query, and then dropped: nothing
 * outlives its batch, so RAM is O(batch) on a crawl of any size.
 *
 * Two silences are deliberate:
 *  - A canonical target with no page row produces nothing. The crawl never
 *    fetched that URL, so it has no evidence about it, and "unknown" is not a
 *    finding (hard rule 1).
 *  - A page canonicalising to itself produces nothing, and a page that is not a
 *    200 OK page is not read at all — its canonical is not what is wrong with
 *    it, and every canonical page rule is gated the same way.
 */
async function eachCanonicalTarget(
  db: Db,
  crawlId: string,
  visit: (t: ResolvedTarget) => void,
): Promise<void> {
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          gt(pages.id, cursor),
          or(isNotNull(pages.canonicalHtml), isNotNull(pages.canonicalHeader)),
        ),
      )
      .orderBy(asc(pages.id))
      .limit(CANONICAL_BATCH);
    if (batch.length === 0) return;
    cursor = batch[batch.length - 1]!.id;

    const wanted = new Map<string, Array<{ page: PageRecord; canonical: string }>>();
    for (const page of batch) {
      if (!isAuditable(page)) continue;
      const canonical = resolveEffectiveCanonical(page);
      if (canonical === null || canonical.resolved === null || !canonical.pointsElsewhere) continue;
      const declared = { page, canonical: canonical.canonical };
      const existing = wanted.get(canonical.resolved);
      if (existing === undefined) wanted.set(canonical.resolved, [declared]);
      else existing.push(declared);
    }
    if (wanted.size === 0) continue;

    // `pages.url` is `normalizeUrl` output (the frontier key), and so is a
    // resolved canonical — the two are directly comparable, which is why this
    // matches on `url` rather than on the analytic `url_normalised` key.
    const targets = await db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          // One array parameter rather than one placeholder per URL: the batch
          // is 500 pages, and `= any($n)` keeps the statement's shape constant
          // so Postgres can reuse the plan across batches.
          sql`${pages.url} = any(${sql.param([...wanted.keys()])}::text[])`,
        ),
      );

    for (const target of targets) {
      for (const { page, canonical } of wanted.get(target.url) ?? []) {
        visit({ page, canonical, resolvedTo: target.url, target });
      }
    }
  }
}

async function canonicalTargetFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fires: (t: ResolvedTarget) => Record<string, unknown> | null,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  await eachCanonicalTarget(db, crawlId, (t) => {
    const evidence = fires(t);
    if (evidence === null) return;
    findings.push(
      queryFinding(self, {
        pageId: t.page.id,
        pageUrl: t.page.url,
        evidence: { canonical: t.canonical, resolvedTo: t.resolvedTo, ...evidence },
        dedupeKey: t.page.url,
      }),
    );
  });
  return findings;
}

const BROKEN: RuleIdentity = { id: "links.broken-internal", severity: "warning" };
const NON_200: RuleIdentity = { id: "canonical.non-200-target", severity: "warning" };
const NON_INDEXABLE: RuleIdentity = { id: "canonical.non-indexable-target", severity: "warning" };

export const linkTargetRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: BROKEN.id,
    checkIds: ["CHECK-11"],
    category: "links",
    severity: BROKEN.severity,
    ...copyFor(BROKEN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => brokenInternalFindings(BROKEN, db, crawlId),
  }),

  // A canonical names the URL whose ranking signals every duplicate should be
  // consolidated into. When that URL does not answer with a 200, the
  // consolidation has nowhere to land.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_200.id,
    checkIds: ["CHECK-19"],
    category: "canonical",
    severity: NON_200.severity,
    ...copyFor(NON_200.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      canonicalTargetFindings(NON_200, db, crawlId, ({ target }) =>
        isAuditable(target)
          ? null
          : { targetStatus: target.statusCode, targetFetchClass: target.fetchClass },
      ),
  }),

  // The target answers, but tells search engines to keep it out of the index.
  // `is_indexable` is null when nothing was analysed, and unknown is not the
  // same as "not indexable" — only an explicit false fires.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE.id,
    checkIds: ["CHECK-19"],
    category: "canonical",
    severity: NON_INDEXABLE.severity,
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      canonicalTargetFindings(NON_INDEXABLE, db, crawlId, ({ target }) =>
        target.isIndexable === false
          ? { targetRobotsMeta: target.robotsMeta, targetXRobotsTag: target.xRobotsTag }
          : null,
      ),
  }),
];
