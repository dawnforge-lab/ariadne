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
import type { RuleCaps } from "../registry/types.js";
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";

/** Source URLs listed on a broken-target finding. The count is never sampled. */
export const SAMPLE_SOURCES = 10;

/**
 * Pages read per round trip by the canonical-target scan — the memory contract:
 * a batch, never the whole table. Exported so a test can force the cursor to
 * iterate without hardcoding the number.
 */
export const CANONICAL_BATCH = 500;

/**
 * Internal links whose target page answered with a given failure class,
 * grouped by TARGET.
 *
 * One function, two rules, because the question is the same one asked of two
 * status classes: `links.broken-internal` reads `client_error` (4xx) and
 * `links.to-server-error` reads `server_error` (5xx). Splitting them at the
 * class is what lets each carry copy that names what the status actually means
 * and a fix that matches it — restore or repoint the URL for a 4xx, read the
 * server logs for a 5xx — instead of one finding saying "returns an error".
 *
 * Both rules report the LINK. The page's own answer is a separate fact reported
 * separately: `http.server-error` (or `http.server-error-transient`, when the
 * end-of-crawl second look got a page) fires against the 5xx URL itself. Both
 * firing on one 5xx URL that is linked to is correct — the page is broken AND
 * the site links to it — and neither is a duplicate of the other.
 *
 * Target-centric on purpose: one dead URL linked from two hundred pages is one
 * thing to fix, and two hundred findings would bury it. The count is exact and
 * the sources are a sample, so the finding says how big the problem is without
 * carrying an unbounded array — the `limit` is inside the lateral, so Postgres
 * never builds the full source list either (hard rule 3: the links table is
 * never loaded into memory).
 *
 * The class is matched exactly, never as "not ok": a target with no status code
 * at all (a timeout, a DNS failure) is a fetch the crawl could not complete and
 * says nothing about whether that URL serves a page, and a redirect target is
 * `redirect.*`'s business. Neither is a broken link here.
 *
 * The `targets` CTE is capped at `caps.listing`, so the lateral runs for at
 * most that many targets and the findings list never grows with the site (an
 * uncapped run lists every broken target and writes no truncation note — the
 * `SAMPLE_SOURCES` list inside each finding is unaffected either way: the cap
 * is on how many findings there are, never on how fat one of them is). The
 * `count(*) over ()` window sits after the grouping and before the `limit`, so
 * it counts distinct broken TARGETS — the unit of the finding — and the exact
 * total survives the cap (`noteTruncation`).
 */
async function linkTargetClassFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fetchClass: "client_error" | "server_error",
  caps: RuleCaps,
): Promise<Finding[]> {
  // A LISTED 4xx NOBODY LINKS TO (27c, Deviation 7). The rule reports the LINK,
  // and a list crawl follows no link, so a listed 404 has no inlink row and 4xx
  // has no page rule: without this arm it would be reported by nothing. Only
  // the client-error class (5xx has `http.server-error`), and only rows the
  // crawl wrote as listed (`discovered_via = 'list'`), which a spider crawl
  // never writes — so no mode check is needed and a spider crawl is unchanged.
  const listedOnly =
    fetchClass === "client_error"
      ? sql`listed_only as (
      select p.id as target_page_id, p.url as target_url, p.status_code,
             0 as inlink_count
      from pages p
      where p.crawl_id = ${crawlId} and p.fetch_class = 'client_error'
        and p.discovered_via = 'list'
        and not exists (
          select 1 from links l
          where l.crawl_id = ${crawlId} and l.is_internal and l.target_url = p.url
        )
    ),`
      : sql``;
  const listedUnion =
    fetchClass === "client_error"
      ? sql`union all select listed_only.*, true as listed from listed_only`
      : sql``;
  const result = await db.execute<{
    target_page_id: string;
    target_url: string;
    status_code: number | null;
    inlink_count: number;
    total_matches: number;
    sample_sources: string[];
    listed: boolean;
  }>(sql`
    with linked as (
      select p.id as target_page_id, p.url as target_url, p.status_code,
             count(*)::int as inlink_count
      from links l
      join pages p on p.crawl_id = ${crawlId} and p.url = l.target_url
      where l.crawl_id = ${crawlId} and l.is_internal and p.fetch_class = ${fetchClass}
      group by p.id, p.url, p.status_code
    ),
    ${listedOnly}
    targets as (
      select u.target_page_id, u.target_url, u.status_code, u.inlink_count, u.listed,
             count(*) over ()::int as total_matches
      from (
        select linked.*, false as listed from linked
        ${listedUnion}
      ) u
      order by u.target_url
      ${limitTo(caps.listing)}
    )
    select t.target_page_id, t.target_url, t.status_code, t.inlink_count,
           t.total_matches, t.listed, s.sample_sources
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
    ) s
    order by t.target_url`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.target_page_id,
      pageUrl: row.target_url,
      evidence: {
        targetUrl: row.target_url,
        statusCode: row.status_code,
        inlinkCount: row.inlink_count,
        sampleSources: row.sample_sources,
        ...(row.listed ? { listed: true } : {}),
      },
      dedupeKey: row.target_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/** A page's canonical, the URL it resolves to, and the page row for that URL. */
export interface ResolvedTarget {
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
 * NONE OF THESE RULES MOVED TO THE JUDGED COHORT in Phase 22 §1. The two link
 * rules judge the TARGET's response — a 404 is a 404 however the page linking
 * to it is annotated — and the two canonical rules judge a canonical, which is
 * the one thing the judged cohort excludes by definition.
 *
 * Two silences are deliberate:
 *  - A canonical target with no page row produces nothing. The crawl never
 *    fetched that URL, so it has no evidence about it, and "unknown" is not a
 *    finding (hard rule 1).
 *  - A page canonicalising to itself produces nothing, and a page that is not a
 *    200 OK page is not read at all — its canonical is not what is wrong with
 *    it, and every canonical page rule is gated the same way.
 */
export async function eachCanonicalTargetBatch(
  db: Db,
  crawlId: string,
  visitBatch: (batch: ResolvedTarget[]) => Promise<void>,
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

    const visits: ResolvedTarget[] = [];
    for (const target of targets) {
      for (const { page, canonical } of wanted.get(target.url) ?? []) {
        visits.push({ page, canonical, resolvedTo: target.url, target });
      }
    }
    // Sorted by the DECLARING page's URL — the finding's own key — before
    // anything is handed on. The target lookup above has no ORDER BY, so its
    // row order is whatever the plan emits, and the callers stop listing at
    // `caps.listing`: an unordered visit would let a re-run of the same
    // crawl report a different two hundred. (While `issues` was append-only
    // that also grew the table past the cap run over run; a rules run now
    // recomputes it — see the delete at the top of `runRules` — so what a
    // defined order buys today is a rule that answers the same question the
    // same way twice.) O(batch), like everything else in this loop.
    visits.sort((a, b) => a.page.url.localeCompare(b.page.url));
    await visitBatch(visits);
  }
}

/**
 * `eachCanonicalTargetBatch` for the rule whose verdict needs nothing but the
 * pair in front of it: a synchronous visit per resolved canonical.
 */
async function eachCanonicalTarget(
  db: Db,
  crawlId: string,
  visit: (t: ResolvedTarget) => void,
): Promise<void> {
  await eachCanonicalTargetBatch(db, crawlId, async (batch) => {
    for (const t of batch) visit(t);
  });
}

/**
 * The shape both canonical-target rules take: walk the resolved canonicals and
 * keep the ones the rule fires on.
 *
 * Capped at `caps.listing` like every other URL-scoped rule — a template
 * that canonicalises a whole section at one dead URL is O(pages) findings —
 * and the scan runs to the end of the last batch either way, so the count
 * behind the cap is exact (`noteTruncation`): only the LISTING stops at the
 * cap, never the counting.
 *
 * WHICH findings the cap keeps is settled by the walk: batches advance by
 * `pages.id` and each batch is visited in declaring-URL order (see
 * `eachCanonicalTarget`), so the same crawl re-judged reports the same two
 * hundred rather than a fresh arbitrary two hundred beside the last run's.
 */
async function canonicalTargetFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fires: (t: ResolvedTarget) => Record<string, unknown> | null,
  caps: RuleCaps,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  await eachCanonicalTarget(db, crawlId, (t) => {
    const evidence = fires(t);
    if (evidence === null) return;
    total += 1;
    if (caps.listing !== null && findings.length >= caps.listing) return;
    findings.push(
      queryFinding(self, {
        pageId: t.page.id,
        pageUrl: t.page.url,
        evidence: { canonical: t.canonical, resolvedTo: t.resolvedTo, ...evidence },
        dedupeKey: t.page.url,
      }),
    );
  });
  return noteTruncation(findings, total);
}

const BROKEN: RuleIdentity = { id: "links.broken-internal", severity: "critical" };
const TO_SERVER_ERROR: RuleIdentity = { id: "links.to-server-error", severity: "critical" };
const NON_200: RuleIdentity = { id: "canonical.non-200-target", severity: "critical" };
const NON_INDEXABLE: RuleIdentity = { id: "canonical.non-indexable-target", severity: "critical" };

export const linkTargetRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: BROKEN.id,
    listPartial: true,
    checkIds: ["CHECK-11"],
    category: "links",
    severity: BROKEN.severity,
    columns: [
      { key: "inlinkCount", label: "Inlinks" },
      { key: "sampleSources", label: "Sample Sources" },
      { key: "listed", label: "Listed", optional: true },
    ],
    ...copyFor(BROKEN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      linkTargetClassFindings(BROKEN, db, crawlId, "client_error", capsOr(caps)),
  }),

  // The 5xx half of the same question, and a separate rule rather than a wider
  // condition on the one above: the two status classes have different causes
  // and different repairs, and a client told "this link is broken" about a 502
  // would go and edit the link when the server is what failed.
  //
  // It shares CHECK-11 with its sibling — the check is "internal links whose
  // target does not answer" — and reports the LINK. CHECK-12's
  // `http.server-error` reports the PAGE. Both fire on a 5xx URL the site
  // links to; that is two facts, not one repeated.
  defineRule<QueryRule>({
    kind: "query",
    id: TO_SERVER_ERROR.id,
    listPartial: true,
    checkIds: ["CHECK-11"],
    category: "links",
    severity: TO_SERVER_ERROR.severity,
    columns: [
      { key: "inlinkCount", label: "Inlinks" },
      { key: "sampleSources", label: "Sample Sources" },
    ],
    ...copyFor(TO_SERVER_ERROR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      linkTargetClassFindings(TO_SERVER_ERROR, db, crawlId, "server_error", capsOr(caps)),
  }),

  // A canonical names the URL whose ranking signals every duplicate should be
  // consolidated into. When that URL answered with something other than a 200,
  // the consolidation has nowhere to land.
  //
  // The condition is the status code, not `isAuditable`, and the difference is
  // what the rule is honest about:
  //  - `status_code` is null when the crawl got no HTTP answer at all (a
  //    timeout, a DNS or connection failure, a challenge with no response).
  //    We learned nothing about that URL, which is the same silence a canonical
  //    for an uncrawled URL gets. `crawl.blocked` and the crawl summary are
  //    where a fetch we could not complete is reported.
  //  - a 200 that was not HTML (`fetch_class` `non_html`) DID return 200, so
  //    firing "does not return 200" on it would be a false statement. It is not
  //    this rule's finding.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_200.id,
    listPartial: true,
    checkIds: ["CHECK-19"],
    category: "canonical",
    severity: NON_200.severity,
    columns: [
      { key: "canonical", label: "Canonical Link Element" },
      { key: "resolvedTo", label: "Canonical Target" },
      { key: "targetStatus", label: "Target Status Code" },
      { key: "targetFetchClass", label: "Target Fetch Class" },
    ],
    ...copyFor(NON_200.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      canonicalTargetFindings(
        NON_200,
        db,
        crawlId,
        ({ target }) =>
          target.statusCode !== null && target.statusCode !== 200
            ? { targetStatus: target.statusCode, targetFetchClass: target.fetchClass }
            : null,
        capsOr(caps),
      ),
  }),

  // The target answers with a 200 OK page, and that page tells search engines
  // to keep it out of the index.
  //
  // `isAuditable` is half the condition, and it is what makes this rule and the
  // one above disjoint. `is_indexable` is a plain boolean the writer sets false
  // for every 404, redirect, 5xx and non-HTML response, so testing it alone
  // would report a canonical pointing at a 404 as "points at a noindexed page"
  // — a second finding for the same fault, carrying copy about a robots
  // directive that page never had.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE.id,
    listPartial: true,
    checkIds: ["CHECK-19"],
    category: "canonical",
    severity: NON_INDEXABLE.severity,
    columns: [
      { key: "canonical", label: "Canonical Link Element" },
      { key: "resolvedTo", label: "Canonical Target" },
      { key: "targetRobotsMeta", label: "Target Meta Robots" },
      { key: "targetXRobotsTag", label: "Target X-Robots-Tag" },
    ],
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      canonicalTargetFindings(
        NON_INDEXABLE,
        db,
        crawlId,
        ({ target }) =>
          isAuditable(target) && target.isIndexable === false
            ? { targetRobotsMeta: target.robotsMeta, targetXRobotsTag: target.xRobotsTag }
            : null,
        capsOr(caps),
      ),
  }),
];
