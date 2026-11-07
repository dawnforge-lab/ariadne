/**
 * The sitemap hreflang derivation (Phase 26c): the `xhtml:link` alternates a
 * sitemap states for a URL, tied to the page the crawl made of that URL.
 *
 * Discovery reads every sitemap before the crawl fetches anything, so when it
 * meets an alternate the page it describes does not exist yet. It stages the
 * pair in `sitemap_hreflang` keyed by the `<loc>` (Task 8). This derivation is
 * the other half: it copies each staged pair whose `<loc>` the crawl has a page
 * for into `hreflang`, with `source = 'sitemap'`, so every hreflang rule reads
 * the sitemap's annotations exactly as it reads the page's own HTML and its
 * `Link` header. Like every derivation it writes no findings; it writes the
 * rows the rules read.
 *
 * THE JOIN is `sitemap_hreflang.url_normalised = pages.url`, the one every
 * sitemap rule uses (src/rules/query/sitemap.ts): discovery wrote the `<loc>`
 * through the frontier's own `normalizeUrl`, and `pages.url` is that function's
 * output. `pages.url_normalised` is NOT the join key, despite the name: it is
 * the analytic variant key, lower-cased with the trailing slash dropped, so it
 * would tie `/A` and `/a/` to the same staged row, or to none.
 *
 * DISTINCT, because discovery stages duplicates and says so: a document listing
 * one URL twice stages its alternates twice, and two documents stating the same
 * pair stage it once each. `hreflang` keeps no `sitemap_source`, so either way
 * the pair is one row. A rule therefore never counts a sitemap duplicate as a
 * second declaration.
 *
 * A staged row whose `<loc>` the crawl never fetched stays staged and writes
 * nothing: there is no page to tie it to, and the sitemap rules already report
 * the URL as listed and not crawled. Alternates past `MAX_HREFLANG_PAIRS` on one
 * `<url>` were dropped at parse (Task 7) and are not here to derive.
 *
 * It is SQL end to end (hard rule 3): one statement deletes this crawl's
 * sitemap rows and inserts the new ones, so RAM is O(1) whatever the sitemap
 * holds, and a reader never sees the crawl between the two.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";

export interface SitemapHreflangDerivation extends Record<string, number> {
  /** `hreflang` rows written with `source = 'sitemap'`. */
  rows: number;
}

/**
 * Replace one crawl's `source = 'sitemap'` rows in `hreflang` with what its
 * staged sitemap alternates say about the pages it crawled.
 *
 * Idempotent by construction: the crawl's sitemap rows are deleted and
 * re-inserted in the same statement, so a second run leaves exactly what the
 * first did, and a pair a re-crawl no longer stages does not linger. The HTML
 * and header rows are the crawl's own record and are never touched.
 *
 * The delete is a data-modifying CTE beside the insert: both run against one
 * snapshot, so the insert cannot see (or collide with) the rows the delete
 * removes, and the two land together.
 */
export async function deriveSitemapHreflang(
  db: Db,
  crawlId: string,
): Promise<SitemapHreflangDerivation> {
  // A crawl id nothing knows derives nothing, and "no sitemap alternates" reads
  // exactly like a site whose sitemap states none. Ask the crawls table first
  // (hard rule 7, and the precedent of every other derivation).
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveSitemapHreflang: no such crawl '${crawlId}'`);

  const inserted = await db.execute(sql`
    with cleared as (
      delete from hreflang
      where crawl_id = ${crawlId} and source = 'sitemap'
    )
    insert into hreflang (crawl_id, page_id, hreflang_code, target_url, target_page_id, source)
    select distinct s.crawl_id, p.id, s.hreflang_code, s.target_url, null::text, 'sitemap'
    from sitemap_hreflang s
    join pages p on p.crawl_id = s.crawl_id and p.url = s.url_normalised
    where s.crawl_id = ${crawlId}`);

  // `rowCount` is what the insert wrote, reported rather than recounted, so the
  // number cannot claim more than the statement did.
  const written = inserted.rowCount;
  if (written === null) {
    throw new Error(
      `deriveSitemapHreflang: crawl '${crawlId}' — the insert reported no row count, ` +
        "so how many sitemap alternates were written is unknown",
    );
  }
  return { rows: written };
}
