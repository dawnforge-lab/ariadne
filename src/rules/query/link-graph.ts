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

/**
 * The orphan finding, and the finding that says the orphan check could not be
 * answered. One rule id, two severities: a fault on the site is a warning, a
 * statement about the crawl is information.
 */
const ORPHAN: RuleIdentity = { id: "links.orphan", severity: "warning" };
const SKIPPED: RuleIdentity = { id: "links.orphan", severity: "info" };

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
 * Why the orphan check cannot be trusted on this crawl, or null when it can.
 *
 * "Nothing links to this page" and "we never fetched the page that links to it"
 * are the same row in the database. Every condition below is a way the second
 * could be true, so the check does not run — and says so — rather than
 * reporting a crawl's own incompleteness as the site's fault.
 */
function skipReason(c: Completeness): string | null {
  const unfinished = c.pending + c.leased + c.failed;
  if (unfinished > 0) {
    return (
      `the crawl left ${unfinished} URL(s) unfetched (${c.pending} pending, ` +
      `${c.leased} leased, ${c.failed} failed), so a page's inbound links may ` +
      `simply not have been crawled yet`
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
 * `sitemap_urls.url` is the `<loc>` as the site published it and `pages.url` is
 * the frontier key, so the membership test is an exact match on the same URL
 * from two sources. A `<loc>` carrying a fragment or reordered query params is
 * the case where the two spellings differ and `inSitemap` reads false; the
 * finding itself does not depend on it.
 */
async function orphanFindings(db: Db, crawlId: string): Promise<Finding[]> {
  const rows = await db.execute<{
    id: string;
    url: string;
    discovered_via: string;
    in_sitemap: boolean;
  }>(sql`
    select p.id, p.url, p.discovered_via,
           exists (
             select 1 from sitemap_urls s
             where s.crawl_id = ${crawlId} and s.url = p.url
           ) as in_sitemap
    from pages p
    where p.crawl_id = ${crawlId}
      and p.fetch_class = 'ok'
      and p.status_code = 200
      and p.is_indexable
      and not (p.depth = 0 and p.discovered_via = 'seed')
      and not exists (
        select 1 from links l
        where l.crawl_id = ${crawlId} and l.target_url = p.url
      )
    order by p.url`);

  return rows.rows.map((row) =>
    queryFinding(ORPHAN, {
      pageId: String(row.id),
      pageUrl: String(row.url),
      evidence: {
        inSitemap: row.in_sitemap,
        discoveredVia: String(row.discovered_via),
      },
      dedupeKey: String(row.url),
    }),
  );
}

export const linkGraphRules: QueryRule[] = [
  // The one rule in the ruleset whose verdict depends on the crawl having
  // finished. When it has not, the check is reported as skipped — one finding,
  // naming the reason — rather than either guessing or falling silent
  // (hard rule 7: a check we could not run is visible).
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
      const skipped = skipReason(state);
      if (skipped === null) return orphanFindings(db, crawlId);
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
