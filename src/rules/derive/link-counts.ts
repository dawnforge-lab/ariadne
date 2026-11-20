/**
 * The link-count derivation (Phase 29c): three per-page columns the agent and
 * the later link rules read instead of re-aggregating `links` every time.
 *
 * Like the derivations beside it this is not a rule. It accuses nobody and
 * writes no findings; it fills `pages.inlinks_internal`, `pages.outlinks_internal`
 * and `pages.outlinks_external`.
 *
 * THE DEFINITIONS ARE THE ONES ALREADY IN USE, so the columns cannot disagree
 * with the surfaces that count the same thing today:
 *
 *  - `inlinks_internal` (R1) is `inlinks.distribution`'s count: distinct
 *    `links.source_page_id` whose `target_url` is this page's `url`, the page's
 *    own links excluded. A nofollow link counts. It is set on EVERY page of the
 *    crawl, 0 when nothing links in, because a 404 with inlinks is a fact worth
 *    listing.
 *  - `outlinks_internal` / `outlinks_external` (R2) are `links.high-outlinks`'s
 *    counts: `count(distinct target_url)` split by `is_internal`, self-links and
 *    nofollow included, so that rule's findings cannot change. They are set on
 *    FETCHED_OK pages (0 when none) and stay null elsewhere: only an analysed
 *    page has outlinks.
 *
 * Every link question is SQL and the statements carry the crawl id alone, so
 * RAM is O(1) in the number of links (hard rules 3 and 6).
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { FETCHED_OK } from "../helpers.js";

export interface LinkCountsDerivation extends Record<string, number> {
  /** Pages of the crawl, every fetch class: each one now carries `inlinks_internal`. */
  pages: number;
  /** Pages with at least one inlink. */
  withInlinks: number;
  /** Fetched-OK pages, the ones given outlink counts. */
  analysed: number;
}

/**
 * Recompute the three columns for one crawl.
 *
 * ONE STATEMENT WRITES THE FINAL VALUE OF EVERY ROW of the crawl, null included
 * (the outlink counts of a page that is not FETCHED_OK), so a count that no
 * longer holds (a link removed from a template) cannot survive a re-run. The
 * write is guarded by `is distinct from`: a row whose three values are already
 * right is not rewritten, so a re-run over an unchanged crawl writes almost
 * nothing (`pages` carries many indexes, and every rewritten row touches each
 * of them; final review M1). It runs in one transaction with the read-back, so
 * a reader never sees a half-written crawl.
 */
export async function deriveLinkCounts(db: Db, crawlId: string): Promise<LinkCountsDerivation> {
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveLinkCounts: no such crawl '${crawlId}'`);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      with inl as (
        -- INLINKS, every row, 0 when nothing links in (the left join + count).
        select p.id as id, count(distinct l.source_page_id)::int as n
        from pages p
        left join links l
          on l.crawl_id = ${crawlId}
         and l.target_url = p.url
         and l.source_page_id <> p.id
        where p.crawl_id = ${crawlId}
        group by p.id
      ), outl as (
        -- OUTLINKS, FETCHED_OK sources only, 0 when the page carries no links.
        select p.id as id,
               (count(distinct l.target_url) filter (where l.is_internal))::int as internal,
               (count(distinct l.target_url) filter (where not l.is_internal))::int as external
        from pages p
        left join links l
          on l.crawl_id = ${crawlId} and l.source_page_id = p.id
        where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")}
        group by p.id
      ), agg as (
        -- Every row of the crawl; outl's absence is a non-FETCHED_OK page: null.
        select inl.id, inl.n, outl.internal, outl.external
        from inl left join outl on outl.id = inl.id
      )
      update pages t
      set inlinks_internal = agg.n,
          outlinks_internal = agg.internal,
          outlinks_external = agg.external
      from agg
      where t.crawl_id = ${crawlId} and t.id = agg.id
        and (t.inlinks_internal, t.outlinks_internal, t.outlinks_external)
            is distinct from (agg.n, agg.internal, agg.external)`);

    const row = (
      await tx.execute<{ pages: number; with_inlinks: number; analysed: number }>(sql`
        select count(*)::int as pages,
               (count(*) filter (where inlinks_internal > 0))::int as with_inlinks,
               (count(*) filter (where outlinks_internal is not null))::int as analysed
        from pages where crawl_id = ${crawlId}`)
    ).rows[0];
    if (row === undefined) throw new Error(`deriveLinkCounts: crawl '${crawlId}' counted no rows`);
    return { pages: row.pages, withInlinks: row.with_inlinks, analysed: row.analysed };
  });
}
