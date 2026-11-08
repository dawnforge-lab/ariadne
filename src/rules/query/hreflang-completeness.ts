/**
 * Whether this crawl read the site's hreflang declarations in full (PR #24
 * review, rulings R20 and R21).
 *
 * Every absence-based hreflang rule reads "no row" as "not declared". That is
 * only true when the declarations were read whole, and two things cut them
 * short:
 *
 *  1. THE SITEMAP WALK. Discovery stages a sitemap's alternates up to its row
 *     and byte budgets (`sitemapFacts.hreflangLimited`), and stops reading
 *     documents at the entry, document and depth caps (`truncation.entryLimited`,
 *     `docLimited`, `depthLimited`); an oversized document is read only to the
 *     50 MB limit (`sitemapFacts.oversizedDocs`). In every one of those the
 *     `<loc>`s read before the cut are still crawled, so a page can be fetched
 *     whose sitemap alternates were never read: "B does not name A back" is then
 *     a statement about what we read, not about the site. That is
 *     `sitemapHreflangCutShort`, the ONE condition on which
 *     `hreflang.missing-return-link`, `hreflang.missing-self-reference`,
 *     `hreflang.missing-x-default` and `hreflang.self-only` refuse, and
 *     `hreflang.declarations-incomplete` speaks for them.
 *
 *     A sitemap document that FAILED (`truncation.failures`) leaves its
 *     declarations unread too, but it is NOT in that condition (ruling R21): a
 *     stale sitemap that 404s is commonplace, `sitemap.invalid` already
 *     reports it, and silencing four rules site-wide for it would hide far more
 *     than it protects. The marker names it (`sitemapDocsFailed`) so the
 *     reader knows the sitemap source is a floor. The same holds for
 *     alternates past `MAX_HREFLANG_PAIRS` in one `<url>`
 *     (`sitemapFacts.alternatesCapped`, ruling R22): counted, their URLs not
 *     recorded, so the marker reports them and nothing is silenced
 *     (`sitemapIncomplete`).
 *
 *  2. THE PER-SOURCE PAIR CAP. The page analyzer, the `Link` header reader and
 *     the sitemap stream each keep at most `MAX_HREFLANG_PAIRS` pairs and drop
 *     the rest uncounted (the sitemap stream counts its own, per `<url>`). A
 *     declaration set with that many rows from one source may have lost the very
 *     pair a rule looks for. `POSSIBLY_CAPPED_PAGES` names those page ids; such a
 *     set is never a declarer for the self-reference, x-default and self-only
 *     rules, and never a target that "does not return the link". This applies
 *     on every crawl, whatever its sitemap facts say.
 *
 *     `>=` rather than `>`: the cap stores exactly `MAX_HREFLANG_PAIRS`, so a
 *     set of that size is indistinguishable from a cut one. The count is of
 *     ROWS, so a template emitting a hundred pairs twice also reaches it; that
 *     is a skipped judgement and a marker, never a false finding.
 */
import { sql, type SQL } from "drizzle-orm";

import { MAX_HREFLANG_PAIRS } from "../../crawl/parse/page-analyzer.js";
import type { Db } from "../../db/client.js";
import { readCrawlEvidence } from "./crawl-evidence.js";
import { readSitemapFacts } from "./page-facts.js";

/** What a Phase 26c crawl's discovery says about how much sitemap hreflang it read. */
export interface SitemapHreflangReading {
  hreflangLimited: boolean;
  entryLimited: boolean;
  docLimited: boolean;
  depthLimited: boolean;
  /** `truncation.failures`: documents pointed at and not read. */
  sitemapDocsFailed: number;
  /** `truncation.oversizedDocsSkipped`: documents read only to the size limit. */
  sitemapDocsOversized: number;
  /**
   * `sitemapFacts.alternatesCapped`: alternates past `MAX_HREFLANG_PAIRS` in one
   * `<url>`, read and never staged. The URLs they belong to are not recorded,
   * so like a failed document this is the marker's to report and silences
   * nothing (ruling R22).
   */
  alternatesCapped: number;
}

/**
 * The crawl's sitemap reading, or `null` for a crawl whose discovery predates
 * the Phase 26c sitemap facts: such a crawl staged no sitemap alternates, so
 * there is nothing of that source to have cut, and only the pair cap applies.
 *
 * Throws for a crawl that does not exist (`readSitemapFacts`), and for a 26c
 * crawl whose truncation lacks a cap flag. `docLimited` and `depthLimited` are
 * checked HERE rather than in `parseDiscovery`, which other rules share: the
 * walk has written both since discovery began, but a hand-built row a test or
 * an older tool wrote need not carry them, and only a 26c crawl reaches this
 * check. A missing flag is never read as false (hard rule 7).
 */
export async function readSitemapHreflang(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<SitemapHreflangReading | null> {
  const facts = await readSitemapFacts(db, crawlId, ruleId);
  if (facts === null) return null;
  const { discovery } = await readCrawlEvidence(db, crawlId, ruleId);
  const truncation = discovery.truncation as unknown as Record<string, unknown>;
  const flag = (key: "docLimited" | "depthLimited"): boolean => {
    const v = truncation[key];
    if (typeof v !== "boolean") {
      throw new Error(
        `${ruleId}: crawl '${crawlId}' discovery evidence has a non-boolean truncation.${key}; re-crawl the site`,
      );
    }
    return v;
  };
  return {
    hreflangLimited: facts.hreflangLimited,
    entryLimited: discovery.truncation.entryLimited,
    docLimited: flag("docLimited"),
    depthLimited: flag("depthLimited"),
    sitemapDocsFailed: discovery.truncation.failures.length,
    sitemapDocsOversized: discovery.truncation.oversizedDocsSkipped,
    alternatesCapped: facts.alternatesCapped,
  };
}

/**
 * Whether the sitemap source is incomplete at all: cut short (`cutShort`, the
 * four rules refuse), or a document failed, or a `<url>` lost alternates past
 * the per-URL cap (the rules run; the marker says the source is a floor).
 */
export function sitemapIncomplete(reading: SitemapHreflangReading | null): boolean {
  if (reading === null) return false;
  return cutShort(reading) || reading.sitemapDocsFailed > 0 || reading.alternatesCapped > 0;
}

/**
 * THE condition the four absence-based rules refuse on: the sitemap walk was
 * cut short, so a crawled page's sitemap alternates may never have been read.
 * A failed document is deliberately not part of it (ruling R21, header).
 */
export function cutShort(reading: SitemapHreflangReading | null): boolean {
  if (reading === null) return false;
  return (
    reading.hreflangLimited ||
    reading.entryLimited ||
    reading.docLimited ||
    reading.depthLimited ||
    reading.sitemapDocsOversized > 0
  );
}

/** `cutShort` read from the database, for a rule's opening line. */
export async function sitemapHreflangCutShort(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<boolean> {
  return cutShort(await readSitemapHreflang(db, crawlId, ruleId));
}

/**
 * True on every row of a declaration query whose (page, source) holds
 * `MAX_HREFLANG_PAIRS` or more rows: the window form of
 * `POSSIBLY_CAPPED_PAGES`, for the per-batch queries that already read every
 * row of their pages (`alias` is the `hreflang` alias; the query must select
 * ALL of each page's rows for the count to be the set's).
 */
export const AT_PAIR_CAP = (alias: string): SQL =>
  sql`(count(*) over (partition by ${sql.raw(alias)}.page_id, ${sql.raw(alias)}.source) >= ${MAX_HREFLANG_PAIRS})`;

/**
 * The page ids of the crawl with `MAX_HREFLANG_PAIRS` or more declarations
 * from one source, as a sub-select (`page_id in (…)`): the marker's count and
 * `hreflang.self-only`'s exclusion, each one grouped scan of the crawl's rows.
 */
export const POSSIBLY_CAPPED_PAGES = (crawlId: string): SQL => sql`
  select c.page_id
  from hreflang c
  where c.crawl_id = ${crawlId}
  group by c.page_id, c.source
  having count(*) >= ${MAX_HREFLANG_PAIRS}`;
