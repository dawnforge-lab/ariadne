import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  assertNormalisedSitemap,
  capsOr,
  limitTo,
  noteTruncation,
} from "./crawl-evidence.js";

const ORPHAN: RuleIdentity = { id: "links.orphan", severity: "warning" };
const SKIPPED: RuleIdentity = { id: "links.orphan-skipped", severity: "info" };
const DEEP: RuleIdentity = { id: "structure.deep-page", severity: "info" };

/**
 * Click depth above which a page is reported as buried — hops along internal
 * links from the home page, not hops through the crawler's frontier.
 *
 * Exported because the client-facing copy quotes the number and a test asserts
 * the prose against this constant: change it here and the copy test fails until
 * the sentence is changed with it. It moved from src/rules/page/technical.ts
 * with the rule (Phase 9).
 */
export const DEEP_DEPTH = 5;

/**
 * The pages these rules count as the site: fetched OK, 200, indexable.
 *
 * One fragment rather than three lines repeated per rule, so "the same cohort
 * `links.orphan` reports over" is a structural fact about the file instead of a
 * claim in a comment that a future edit can quietly falsify. Same idiom as
 * src/rules/query/structured-data.ts.
 */
const INDEXABLE = sql`p.fetch_class = 'ok' and p.status_code = 200 and p.is_indexable`;

/** What the crawl row and the frontier say about whether the crawl finished. */
interface Completeness {
  pagesCrawled: number;
  maxPages: number | null;
  pending: number;
  leased: number;
  failed: number;
}

/**
 * `ruleId` names the caller in the refusal, because three rules read this now
 * and a message that always said `links.orphan` would send a reader of
 * `structure.deep-page`'s failure to the wrong rule.
 */
async function completeness(db: Db, crawlId: string, ruleId: string): Promise<Completeness> {
  const rows = await db.execute<{
    pages_crawled: number;
    max_pages: string | null;
    pending: number;
    leased: number;
    failed: number;
  }>(sql`
    select c.pages_crawled,
           c.config_jsonb ->> 'maxPages' as max_pages,
           count(*) filter (where f.state = 'pending')::int as pending,
           count(*) filter (where f.state = 'leased')::int as leased,
           count(*) filter (where f.state = 'failed')::int as failed
    from crawls c
    left join frontier f on f.crawl_id = c.id
    where c.id = ${crawlId}
    group by c.id, c.pages_crawled, c.config_jsonb`);
  const row = rows.rows[0];
  // No crawl row means nothing can be said about completeness, and a rule that
  // answered anyway would be answering about a crawl that does not exist.
  if (row === undefined) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);

  const maxPages = row.max_pages === null ? Number.NaN : Number(row.max_pages);
  return {
    pagesCrawled: Number(row.pages_crawled),
    maxPages: Number.isFinite(maxPages) ? maxPages : null,
    pending: Number(row.pending),
    leased: Number(row.leased),
    failed: Number(row.failed),
  };
}

/**
 * Why the orphan check cannot be run at all on this crawl, or null when it can.
 *
 * "Nothing links to this page" and "we never fetched the page that links to it"
 * are the same row in the database. Each condition below is a way the second
 * could be true of an unbounded number of URLs, so the check does not run — and
 * says so, under `links.orphan-skipped` — rather than reporting a crawl's own
 * incompleteness as the site's fault.
 *
 * FAILED frontier rows are deliberately NOT here. A failed URL is a bounded,
 * named blind spot: the check still runs and every finding carries a caveat
 * naming how many URLs went unread (see `orphanFindings`). Muting CHECK-32 for
 * the whole site because one URL timed out would hide every real orphan behind
 * a single fetch failure.
 */
function skipReason(c: Completeness): string | null {
  const unfetched = c.pending + c.leased;
  if (unfetched > 0) {
    return (
      `the crawl left ${unfetched} URL(s) unfetched (${c.pending} pending, ` +
      `${c.leased} leased), so a page's inbound links may simply not have been ` +
      "crawled yet"
    );
  }
  if (c.maxPages === null) {
    return (
      "the crawl's stored config records no numeric maxPages, so there is no " +
      "way to tell whether the crawl ran to completion or stopped at a cap"
    );
  }
  if (c.pagesCrawled >= c.maxPages) {
    return (
      `the crawl stopped at its ${c.maxPages}-page limit (${c.pagesCrawled} ` +
      "crawled), so the pages that would link to an apparent orphan may never " +
      "have been reached"
    );
  }
  return null;
}

/**
 * Pages nothing links to.
 *
 * The join is `links.target_url = pages.url`: both are `normalizeUrl` output —
 * the analyzer resolves every href through it and the frontier keys pages by
 * it — so the two are directly comparable, and the link table is never loaded
 * into memory (hard rule 3).
 *
 * `l.source_page_id <> p.id` is the load-bearing half of that anti-join. A page
 * that links to itself — a logo linking home, a "back to top" anchor rewritten
 * to the canonical URL, a self-referential breadcrumb — would otherwise satisfy
 * its own inbound-link test and vanish from this rule. An orphan that links to
 * itself is still an orphan: nothing else on the site can reach it.
 *
 * Three deliberate inclusions and one exclusion:
 *  - Only indexable 200s. A 404 or a noindexed page with no inbound links is
 *    not an orphan worth fixing; it is a page that should have no traffic.
 *  - The seed is excluded. It is where the crawl started, so nothing has to
 *    link to it, and reporting the homepage on every crawl would be the
 *    always-fires twin of a rule that always passes.
 *  - Pages the crawl reached only through the sitemap are INCLUDED, and that
 *    is the finding rather than an exemption: a URL a site publishes in its
 *    sitemap and links from nowhere is precisely the orphan the check is for.
 *    `inSitemap` says which kind it is.
 *
 * The membership test matches `sitemap_urls.url_normalised` — the `<loc>` put
 * through the same `normalizeUrl` that produced `pages.url` — rather than the
 * published `<loc>` beside it, so a sitemap entry carrying a fragment or
 * reordered query params is recognised as the page it names. `inSitemap` is
 * evidence rather than a condition: the finding itself does not depend on it.
 *
 * `failed` is the number of URLs the crawl could not fetch. Their outbound
 * links were never read, so any of them could have linked to a page reported
 * here — which is why every finding carries the count as a caveat rather than
 * the whole check being suppressed.
 *
 * Capped at `caps.listing` like every other URL-scoped rule. A site whose
 * navigation is built in JavaScript this crawl does not run, or one that
 * publishes a large sitemap and links none of it, produces an orphan per page
 * — O(pages) findings out of a rule that is supposed to name a problem, not
 * mirror the site. `count(*) over ()` is evaluated across the full result set
 * before `limit` takes its slice, so the exact total survives the cap.
 *
 * An UNCAPPED run (`findingCap: null`) lists every orphan and writes no
 * truncation note, because nothing was truncated — the case a billed audit asks
 * for, where "243 orphans, here are 200" is not a list anyone can work through
 * to the end. The `order by p.url` is what makes both answers reproducible.
 */
async function orphanFindings(
  db: Db,
  crawlId: string,
  failed: number,
  caps: RuleCaps,
): Promise<Finding[]> {
  // The `inSitemap` evidence reads `sitemap_urls.url_normalised`, so this rule
  // is gated on that column being populated exactly like the sitemap rules
  // are: on a pre-Phase-4 crawl every orphan would be labelled `inSitemap:
  // false`, which is a quiet falsehood rather than a loud one.
  await assertNormalisedSitemap(db, crawlId, ORPHAN.id);
  const rows = await db.execute<{
    id: string;
    url: string;
    discovered_via: string;
    in_sitemap: boolean;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.discovered_via,
           exists (
             select 1 from sitemap_urls s
             where s.crawl_id = ${crawlId} and s.url_normalised = p.url
           ) as in_sitemap,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and ${INDEXABLE}
      and not (p.depth = 0 and p.discovered_via = 'seed')
      and not exists (
        select 1 from links l
        where l.crawl_id = ${crawlId}
          and l.target_url = p.url
          and l.source_page_id <> p.id
      )
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings = rows.rows.map((row) =>
    queryFinding(ORPHAN, {
      pageId: String(row.id),
      pageUrl: String(row.url),
      evidence: {
        inSitemap: row.in_sitemap,
        discoveredVia: String(row.discovered_via),
        ...(failed > 0 ? { caveat: { failedPages: failed } } : {}),
      },
      dedupeKey: String(row.url),
    }),
  );
  return noteTruncation(findings, rows.rows[0]?.total_matches ?? 0);
}

/**
 * Pages the reader has to click too many times to reach.
 *
 * click_depth, not discovery depth: discovery depth is "how the crawler
 * found it" (a sitemap URL is seeded at depth 0 however buried it is);
 * click_depth is the link-graph BFS the reader actually clicks through.
 * Reading discovery depth kept this rule silent through two real audits on
 * a site whose 437 sitemap-discovered pages all sat at discovery depth 0
 * (docs/gates/phase-8.md §15 item 1; the numbers disentangled in
 * docs/gates/phase-9.md §9.1).
 * A NULL click_depth is EXCLUDED rather than treated as infinitely deep: a page
 * no link path reaches has no depth to be past a threshold. It is the
 * distribution metric's `nullCount` bucket, and where nothing links to it at all
 * it is `links.orphan`'s finding — but the two sets are not the same one, and
 * the difference is a real page: an ISLAND is linked (from other unreachable
 * pages), so it is null here and absent from the orphan list, which is exactly
 * what CHECK-31's cross-read asks the agent to name. A page past
 * `MAX_CLICK_DEPTH` is null for a third reason again. Excluding null is
 * therefore "not this rule's finding", not "already reported once elsewhere".
 *
 * A QUERY rule for one reason, and it is the reason the move had to happen at
 * all: `deriveClickDepth` fills the column in the DERIVATION phase, which runs
 * after the page cursor and before the query rules (src/rules/run.ts). A page
 * rule reading `click_depth` would see last run's value, or null on a crawl's
 * first judgement — a rule that always passes the first time it is asked, which
 * is hard rule 1.
 *
 * Indexable 200s only, the same cohort `links.orphan` reports over: click depth
 * is about crawl attention and internal link equity, and a page that is not
 * going in the index is competing for neither. Burying a noindex page is not a
 * fault, so reporting it would be asking for a fix that should not be made.
 *
 * `click_depth > N` is what excludes null, by SQL's own three-valued logic —
 * stated here rather than relied on, because it is the behaviour the paragraph
 * above argues for and not an accident of the operator.
 *
 * AN INCOMPLETE CRAWL MAKES THIS RULE OVERSTATE, WHICH IS WHY EVERY FINDING
 * CARRIES A CAVEAT WHEN THE CRAWL WAS ONE. A breadth-first search over a
 * SUBGRAPH can only ever return an UPPER BOUND on the true shortest path:
 * missing pages remove paths, they never add one, so a page the crawl left
 * unfetched may hold the two-click route to a page reported here at nine. The
 * copy says "the shortest route… from the home page" about the SITE, so on a
 * truncated crawl a finding can be a false positive — the opposite direction
 * from `links.orphan`, whose incompleteness produces the same false positive by
 * a different mechanism and which therefore refuses to run at all.
 *
 * This rule does NOT refuse, and the asymmetry is a decision rather than an
 * oversight. An orphan verdict on an incomplete crawl is unsound about every
 * page it names; a depth verdict is right about most and overstated about some,
 * and dropping the whole listing to avoid the some would hide the most (hard
 * rule 7). So the crawl's own state travels with the finding — the same
 * `caveat` channel `links.orphan` uses for its failed pages — and a reader who
 * needs certainty re-crawls rather than being told nothing.
 *
 * Capped like every other URL-scoped rule, deepest first so the worst page is
 * the first one an action plan reads. `count(*) over ()` is evaluated across the
 * full result set before `limit` takes its slice, so the exact total survives
 * the cap.
 */
async function deepPageFindings(
  db: Db,
  crawlId: string,
  state: Completeness,
  caps: RuleCaps,
): Promise<Finding[]> {
  const rows = await db.execute<{
    id: string;
    url: string;
    click_depth: number;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.click_depth, count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and ${INDEXABLE}
      and p.click_depth > ${DEEP_DEPTH}
    order by p.click_depth desc, p.url
    ${limitTo(caps.listing)}`);

  const caveat = depthCaveat(state);
  const findings = rows.rows.map((row) =>
    queryFinding(DEEP, {
      pageId: String(row.id),
      pageUrl: String(row.url),
      evidence: {
        clickDepth: Number(row.click_depth),
        threshold: DEEP_DEPTH,
        ...(caveat === null ? {} : { caveat }),
      },
      dedupeKey: String(row.url),
    }),
  );
  return noteTruncation(findings, rows.rows[0]?.total_matches ?? 0);
}

/**
 * What this crawl's own incompleteness does to a click depth, or null when
 * nothing does.
 *
 * Two independent halves, either or both:
 *
 *  - `incompleteCrawl` — the crawl did not demonstrably run to completion, in
 *    exactly the cases `skipReason` enumerates for `links.orphan`. Every unread
 *    page is a link the search never followed, so every depth here is an upper
 *    bound. The reason is carried verbatim rather than as a flag, because "500
 *    URLs still pending" and "stopped at its 200-page limit" call for different
 *    next steps.
 *  - `failedPages` — URLs the crawl could not fetch. A bounded, countable blind
 *    spot, and the same number under the same key `links.orphan` reports.
 *
 * A null return is a positive statement, not an absence: this crawl drained its
 * frontier, stayed under its cap and failed nothing, so the depths are the site's
 * own.
 */
function depthCaveat(c: Completeness): Record<string, unknown> | null {
  const incomplete = skipReason(c);
  if (incomplete === null && c.failed === 0) return null;
  return {
    ...(incomplete === null ? {} : { incompleteCrawl: incomplete }),
    ...(c.failed > 0 ? { failedPages: c.failed } : {}),
  };
}

/**
 * The orphan check, the statement that it could not be run, and the depth of
 * the pages the same link graph does reach.
 *
 * The first two are two rule ids for one check, because a finding's copy is
 * looked up by its rule id, and rendering "the check did not run" under "Page
 * has no internal links pointing to it" would be a false statement to a client.
 * Both claim CHECK-32 and both read the same gate, each running it for itself
 * rather than sharing state — a rule that depended on another rule having run
 * first would be a rule that quietly reports nothing when run alone. Exactly
 * one of them can produce a finding on any given crawl.
 *
 * The third claims CHECK-31 and lives here rather than beside the page rules
 * because it reads the link graph too: the orphan rule reports the pages the
 * graph does not reach, and this one reports the pages it reaches only after
 * too many clicks. Same column, one derivation apart.
 */
export const linkGraphRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: ORPHAN.id,
    checkIds: ["CHECK-32"],
    category: "links",
    severity: ORPHAN.severity,
    columns: [
      { key: "discoveredVia", label: "Discovered Via" },
      { key: "inSitemap", label: "In Sitemap" },
      { key: "caveat", label: "Caveat", optional: true },
    ],
    ...copyFor(ORPHAN.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      const state = await completeness(db, crawlId, ORPHAN.id);
      if (skipReason(state) !== null) return [];
      return orphanFindings(db, crawlId, state.failed, capsOr(caps));
    },
  }),

  // A check we could not run is visible, never silent (hard rule 7). One
  // finding, site-scoped, naming the reason in its evidence — and the reason is
  // about the crawl, so the severity is info rather than a fault on the site.
  defineRule<QueryRule>({
    kind: "query",
    id: SKIPPED.id,
    checkIds: ["CHECK-32"],
    category: "links",
    severity: SKIPPED.severity,
    columns: [
      { key: "skipped", label: "Reason" },
      { key: "pagesCrawled", label: "Pages Crawled" },
      { key: "maxPages", label: "Page Limit" },
      { key: "pending", label: "Pending URLs" },
      { key: "leased", label: "Leased URLs" },
      { key: "failed", label: "Failed URLs" },
    ],
    ...copyFor(SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl did not reach every URL it knew about, so a page nothing appears to link to may simply be linked from a page that was never fetched; re-run or resume the crawl, raising the page limit if it stopped at one.",
    run: async (db, crawlId): Promise<Finding[]> => {
      const state = await completeness(db, crawlId, SKIPPED.id);
      const skipped = skipReason(state);
      if (skipped === null) return [];
      return [
        queryFinding(SKIPPED, {
          pageId: null,
          pageUrl: null,
          evidence: { skipped, ...state },
          dedupeKey: "site",
        }),
      ];
    },
  }),

  // Reads the same completeness state the two rules above gate on, and CAVEATS
  // rather than gates: a search over an incomplete crawl overstates depth (it
  // cannot see the shorter path through a page nobody fetched), which makes a
  // finding here possibly wrong rather than certainly unsound. See
  // `deepPageFindings`. The state read also serves as the existence check — a
  // crawl id nothing knows throws there, naming this rule, instead of selecting
  // no rows and reading as a site with no buried pages.
  defineRule<QueryRule>({
    kind: "query",
    id: DEEP.id,
    checkIds: ["CHECK-31"],
    category: "technical",
    severity: DEEP.severity,
    columns: [
      { key: "clickDepth", label: "Crawl Depth" },
      { key: "threshold", label: "Threshold" },
      { key: "caveat", label: "Caveat", optional: true },
    ],
    ...copyFor(DEEP.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      const state = await completeness(db, crawlId, DEEP.id);
      return deepPageFindings(db, crawlId, state, capsOr(caps));
    },
  }),
];
