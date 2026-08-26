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
import {
  assertNormalisedSitemap,
  noteTruncation,
  URL_FINDING_CAP,
} from "./crawl-evidence.js";

const ORPHAN: RuleIdentity = { id: "links.orphan", severity: "warning" };
const SKIPPED: RuleIdentity = { id: "links.orphan-skipped", severity: "info" };

/** What the crawl row and the frontier say about whether the crawl finished. */
interface Completeness {
  pagesCrawled: number;
  maxPages: number | null;
  pending: number;
  leased: number;
  failed: number;
}

async function completeness(db: Db, crawlId: string): Promise<Completeness> {
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
  if (row === undefined) throw new Error(`links.orphan: no such crawl '${crawlId}'`);

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
 * Capped at `URL_FINDING_CAP` like every other URL-scoped rule. A site whose
 * navigation is built in JavaScript this crawl does not run, or one that
 * publishes a large sitemap and links none of it, produces an orphan per page
 * — O(pages) findings out of a rule that is supposed to name a problem, not
 * mirror the site. `count(*) over ()` is evaluated across the full result set
 * before `limit` takes its slice, so the exact total survives the cap.
 */
async function orphanFindings(db: Db, crawlId: string, failed: number): Promise<Finding[]> {
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
      and p.fetch_class = 'ok'
      and p.status_code = 200
      and p.is_indexable
      and not (p.depth = 0 and p.discovered_via = 'seed')
      and not exists (
        select 1 from links l
        where l.crawl_id = ${crawlId}
          and l.target_url = p.url
          and l.source_page_id <> p.id
      )
    order by p.url
    limit ${URL_FINDING_CAP}`);

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
 * The orphan check and the statement that it could not be run: two rule ids,
 * because a finding's copy is looked up by its rule id, and rendering "the
 * check did not run" under "Page has no internal links pointing to it" would be
 * a false statement to a client.
 *
 * Both claim CHECK-32 and both read the same gate, each running it for itself
 * rather than sharing state — a rule that depended on another rule having run
 * first would be a rule that quietly reports nothing when run alone. Exactly
 * one of them can produce a finding on any given crawl.
 */
export const linkGraphRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: ORPHAN.id,
    checkIds: ["CHECK-32"],
    category: "links",
    severity: ORPHAN.severity,
    ...copyFor(ORPHAN.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const state = await completeness(db, crawlId);
      if (skipReason(state) !== null) return [];
      return orphanFindings(db, crawlId, state.failed);
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
    ...copyFor(SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const state = await completeness(db, crawlId);
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
];
