/**
 * The `click_depth` derivation: how many links from the site's entry point the
 * shortest path to each page is.
 *
 * Like the two derivations beside it this is not a rule. It accuses nobody and
 * writes no findings — it fills in `pages.click_depth`, which
 * `structure.click-depth-distribution` reads and which the agent reads as
 * context. The split is the one the runner enforces: derivations write their own
 * columns, rules write `issues`.
 *
 * **Why this column exists at all.** `pages.depth` is DISCOVERY depth: the depth
 * of the frontier item that first produced the URL. Every sitemap entry is
 * enqueued as a seed at depth 0 (src/crawl/loop.ts), so on a site whose sitemap
 * covers the estate almost every page is "at depth 0" and the number describes
 * the crawl rather than the site. The Phase 6 gate crawl is the record of it —
 * 437 of 443 indexable pages at depth 0 with a MEDIAN INBOUND LINK COUNT OF
 * ZERO — and the auditor had to rebuild reachability by hand from `links.orphan`
 * and `inlinks.sources-by-type` to say anything true about CHECK-31. This
 * derivation makes the honest number a column: hops along INTERNAL LINKS from
 * the home page, and null for a page no link path reaches.
 *
 * **Null is the finding, not a gap.** A page left null is one that no chain of
 * internal links reaches from the entry point — the sitemap-only page CHECK-31's
 * block capitals have always demanded be counted, and the same fact
 * `links.orphan` reports one page at a time. It is never spelled 0: depth 0 is
 * the home page and nothing else.
 *
 * **The whole search is in SQL.** Each level of the breadth-first search is one
 * `UPDATE` — the frontier is "the crawl's pages whose `click_depth` is the level
 * above", which lives in Postgres and is never a list in JavaScript (hard rule
 * 6). What crosses into JS per level is a row count.
 */
import { eq, sql } from "drizzle-orm";

import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";

/**
 * The deepest level the search will assign, and the bound that makes the loop
 * finite by arithmetic rather than by argument.
 *
 * Termination does NOT depend on it: a level only ever writes pages whose
 * `click_depth` is still null, so the levels partition the crawl's pages and the
 * search stops when a level writes nothing — at most one level per page. The cap
 * bounds the number of STATEMENTS instead, which is what stops a pathological
 * chain (a paginated series ten thousand rungs long) from issuing ten thousand
 * round trips inside one transaction.
 *
 * Fifty, because a site with a genuine click path past fifty has a structural
 * problem this engine should be reporting rather than measuring precisely, and
 * because a page past it is left null — which is the honest reading of "this
 * search did not reach it" and is why the cap being HIT is reported (`capped`)
 * rather than absorbed.
 */
export const MAX_CLICK_DEPTH = 50;

/**
 * How many redirect hops the ENTRY POINT may take before the search gives up on
 * finding a home page.
 *
 * The seed is a CONFIGURATION VALUE — `crawls.site_url`, whatever spelling the
 * client handed us — and it is routine for it to redirect to the site's real
 * home page (`http://` to `https://`, apex to `www`, a missing trailing slash).
 * A search that started at the redirect row would find no links there and would
 * report EVERY page of the site as unreachable: a whole-site false orphan
 * report, which is the exact class of defect this derivation exists to remove.
 *
 * A LINK is never resolved this way, and the asymmetry is the design. A link's
 * target is a fact about the site's markup, and a link that lands on a redirect
 * is a finding the redirect rules already make; following it here would hide it
 * and would claim a click path the site does not publish. The seed is not markup
 * at all, so resolving it claims nothing about the site.
 */
export const ROOT_REDIRECT_HOPS = 5;

export interface ClickDepthDerivation extends Record<string, number> {
  /** 1 when the crawl's entry point was found in `pages`, 0 when it was not. */
  root: number;
  /** Redirect hops the entry point took before a page with a body was found. */
  rootRedirects: number;
  /** Pages given a depth — the entry point included. */
  reachable: number;
  /**
   * Pages left null: no internal link path from the entry point reaches them.
   * Counted over EVERY page of the crawl, not over the indexable cohort the
   * metric measures, so this number and the metric's `nullCount` answer two
   * different questions and are not expected to agree.
   */
  unreachable: number;
  /** The deepest level assigned, or -1 when no page carries a depth at all. */
  maxDepth: number;
  /**
   * 1 when the search stopped because it reached `MAX_CLICK_DEPTH` while the
   * last level was still assigning pages — so pages deeper than the cap are
   * null and are indistinguishable, in the column, from pages nothing reaches.
   *
   * Deliberately conservative in the loud direction: a search whose last
   * permitted level happened to be its natural last level also reports 1, since
   * proving otherwise would cost the extra statement the cap exists to avoid.
   */
  capped: number;
}

type RootRow = {
  id: string;
  fetch_class: string;
  redirect: string | null;
};

/**
 * Recompute `click_depth` for one crawl by breadth-first search from its entry
 * point.
 *
 * IDEMPOTENT BY NULL-THEN-SET, inside one transaction. The column is cleared for
 * the whole crawl before the search starts, so a page that LOST its reachability
 * between two runs of the rules — a link removed from a template, a hub that now
 * 404s — loses its depth with it. An update-only pass would leave that page
 * carrying the depth of a path that no longer exists, which is a stale number
 * wearing a fresh one's clothes (hard rule 7). The clear and the search share a
 * transaction because a reader between them would see a site whose every page is
 * unreachable, which is false about every site.
 */
export async function deriveClickDepth(db: Db, crawlId: string): Promise<ClickDepthDerivation> {
  // A crawl id nothing knows has no pages to walk, and "nothing was reachable"
  // reads exactly like a site whose home page links nowhere. Ask the crawls
  // table first (hard rule 7, and the two derivations beside this one).
  const crawl = await db
    .select({ siteUrl: crawls.siteUrl })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveClickDepth: no such crawl '${crawlId}'`);

  // THE SEED'S SPELLING, derived the way the crawl derives it: `runCrawl`
  // enqueues `config.siteUrl` through `normalizeUrl`, and `pages.url` is the
  // frontier key that produced. So the entry point's row is the one whose `url`
  // equals the normalised site URL — not the raw `site_url`, which may carry a
  // fragment, unsorted params, an uppercase host or no trailing slash and would
  // then match nothing at all.
  const siteUrl = crawl[0]!.siteUrl;
  const seed = normalizeUrl(siteUrl);
  if (seed === null) {
    throw new Error(
      `deriveClickDepth: crawl '${crawlId}' has a site URL no crawl of ours could have ` +
        `used as a seed: ${siteUrl}`,
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`update pages set click_depth = null
          where crawl_id = ${crawlId} and click_depth is not null`,
    );

    // THE ENTRY POINT, following the seed's own redirects (see
    // `ROOT_REDIRECT_HOPS`). The loop is bounded by the hop count, so a redirect
    // cycle ends it rather than spinning.
    let url = seed;
    let rootRedirects = 0;
    let rootId: string | null = null;
    for (;;) {
      const found = (
        await tx.execute<RootRow>(sql`
          select id, fetch_class, redirect_url_normalised as redirect
          from pages
          where crawl_id = ${crawlId} and url = ${url}
          limit 1`)
      ).rows[0];
      // The seed URL has no row: it was refused before it was fetched, or the
      // crawl died before reaching it. There is no entry point, so there is no
      // click depth — every page stays null and `root: 0` says why.
      if (found === undefined) break;
      if (found.fetch_class !== "redirect" || found.redirect === null) {
        rootId = found.id;
        break;
      }
      if (rootRedirects >= ROOT_REDIRECT_HOPS) break;
      rootRedirects += 1;
      url = found.redirect;
    }

    const unreachable = async (): Promise<number> => {
      const row = (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from pages
          where crawl_id = ${crawlId} and click_depth is null`)
      ).rows[0];
      if (row === undefined) throw new Error(`deriveClickDepth: crawl '${crawlId}' counted no rows`);
      return row.n;
    };

    if (rootId === null) {
      return {
        root: 0,
        rootRedirects,
        reachable: 0,
        unreachable: await unreachable(),
        maxDepth: -1,
        capped: 0,
      };
    }

    await tx.execute(
      sql`update pages set click_depth = 0 where crawl_id = ${crawlId} and id = ${rootId}`,
    );

    let reachable = 1;
    let maxDepth = 0;
    let depth = 0;
    for (; depth < MAX_CLICK_DEPTH; depth += 1) {
      // ONE LEVEL OF THE SEARCH, as one statement.
      //
      // The frontier is `src` — the pages already sitting at `depth` — and the
      // pages it reaches are written at `depth + 1`. The two filters are what
      // make this a breadth-first search rather than a walk:
      //
      //  - `target.click_depth is null` means a page is written ONCE, at the
      //    first level that reaches it, which is by definition its minimum
      //    number of hops. It is also what makes cycles harmless (a page
      //    already assigned is never a target again) and a self-link a no-op,
      //    the same reading `links.orphan` takes of one.
      //  - the join is `pages.url = links.target_url`, the established
      //    link-to-page spelling: `links.target_page_id` is written null by the
      //    crawler, so the URL is the only thing the two tables share.
      //
      // `is_internal` only: an off-site link is not a click path through this
      // site. `is_nofollow` is deliberately NOT filtered — a nofollow link is
      // still a link a person clicks, and a click path is what this measures.
      //
      // The SOURCE side is not filtered by indexability, for the reason the
      // metric layer states once: a noindex page still links, and the link it
      // makes is still a link.
      //
      // NO PER-ROW PARAMETERS, so the 65,535-parameter ceiling the batched
      // inserts elsewhere respect is not in play here: the statement carries the
      // crawl id and two integers however large the crawl is.
      const level = await tx.execute(sql`
        update pages t set click_depth = ${depth + 1}
        from (
          select distinct target.id as id
          from pages src
          join links l
            on l.crawl_id = ${crawlId} and l.source_page_id = src.id and l.is_internal
          join pages target
            on target.crawl_id = ${crawlId} and target.url = l.target_url
          where src.crawl_id = ${crawlId}
            and src.click_depth = ${depth}
            and target.click_depth is null
        ) f
        where t.crawl_id = ${crawlId} and t.id = f.id`);
      const written = level.rowCount;
      if (written === null) {
        throw new Error(
          `deriveClickDepth: crawl '${crawlId}' — the depth ${depth + 1} update reported ` +
            "no row count, so how many pages that level reached is unknown",
        );
      }
      if (written === 0) break;
      reachable += written;
      maxDepth = depth + 1;
    }

    return {
      root: 1,
      rootRedirects,
      reachable,
      unreachable: await unreachable(),
      maxDepth,
      capped: depth === MAX_CLICK_DEPTH ? 1 : 0,
    };
  });
}
