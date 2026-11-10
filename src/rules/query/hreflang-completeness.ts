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
 *     `docLimited`, `depthLimited`) and when the walk's time budget runs out
 *     (`truncation.timeLimited`, Phase 27d); an oversized document is read only to the
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
 *     declaration set that filled the cap in one source may have lost the very
 *     pair a rule looks for. `POSSIBLY_CAPPED_PAGES` names those page ids (how
 *     a filled cap is recognised is at its definition: ruling R23); such a
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
  /**
   * `truncation.timeLimited` (Phase 27d): the walk's time budget ran out with
   * documents unread. A crawl recorded before 27d lacks the key and reads false.
   */
  timeLimited: boolean;
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
 * checked HERE (`timeLimited` is newer, and its absence is false) rather than in `parseDiscovery`, which other rules share: the
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
  // Written since 27d. A truncation without the key predates the budget, which
  // did not exist: false is what it means. Any other non-boolean is corruption.
  const timeLimited = truncation["timeLimited"];
  if (timeLimited !== undefined && typeof timeLimited !== "boolean") {
    throw new Error(
      `${ruleId}: crawl '${crawlId}' discovery evidence has a non-boolean truncation.timeLimited; re-crawl the site`,
    );
  }
  return {
    hreflangLimited: facts.hreflangLimited,
    entryLimited: discovery.truncation.entryLimited,
    docLimited: flag("docLimited"),
    depthLimited: flag("depthLimited"),
    timeLimited: timeLimited === true,
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
    reading.timeLimited ||
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
 * Which pages a `POSSIBLY_CAPPED_PAGES` sub-select considers: a predicate over
 * the `pages` alias it is handed. A batch query passes its own page ids, so the
 * sub-select reads only that batch's rows (hard rule 3: no crawl-wide set is
 * ever held, in RAM or re-scanned per batch).
 */
export type PageScope = (pagesAlias: string) => SQL;

/** Every page of the crawl, for the one-scan readers (the marker, self-only). */
export const EVERY_PAGE: PageScope = () => sql`true`;

/** The pages whose ids are in `ids`: a declaration batch. */
export const PAGE_IDS =
  (ids: string[]): PageScope =>
  (p) =>
    sql`${sql.raw(p)}.id = any(${sql.param(ids)}::text[])`;

/** The pages whose `url` is in `urls`: a batch's crawled targets. */
export const PAGE_URLS =
  (urls: string[]): PageScope =>
  (p) =>
    sql`${sql.raw(p)}.url = any(${sql.param(urls)}::text[])`;

/**
 * `pages.overlong_urls.hreflang` for the `pages` alias `p`: hreflang targets
 * the page's HTML or `Link` header named that were over `INDEXED_URL_MAX`,
 * counted and never stored (Phase 26c, extraction 3).
 *
 * NULL COUNTS 0, and that is the column's own meaning here rather than a
 * default: null is written where no response was classified (no header and no
 * HTML were read, so no pair was taken or refused) and on a row from before
 * extraction 3, which refused no over-long target (the refusal is extraction
 * 3's; such a row stored every pair it kept). A NON-null blob without a numeric
 * `hreflang` is a defect in the write and is LOUD: the `strict` path raises
 * "JSON object does not contain key", and a non-number fails the cast (hard
 * rule 7; `url.reference-too-long` throws "re-crawl" on the same blob).
 */
const OVERLONG_HREFLANG = (p: string): SQL =>
  sql.raw(
    `(case when ${p}.overlong_urls is null then 0 ` +
      `else jsonb_path_query_first(${p}.overlong_urls, 'strict $.hreflang')::int end)`,
  );

/**
 * The page ids, among `among`, whose declarations may have filled the
 * per-source pair cap, as a sub-select (`page_id in (…)`). THE ONE DEFINITION
 * of "possibly capped" (ruling R23): the per-batch declaration and target
 * queries, the marker's count and `hreflang.self-only`'s exclusion all read it.
 *
 * A source filled its cap when the pairs that TOOK A SLOT reach
 * `MAX_HREFLANG_PAIRS`, which is not always the rows stored:
 *
 *  - HTML and `Link` header (`source in ('html', 'header')`): the source's
 *    stored rows plus `overlong_urls.hreflang`, because an over-long target
 *    takes a slot and is not stored. The over-long count is per PAGE, not
 *    split by source (the analyzer's and the header reader's are summed into
 *    one column), so it is added to EACH of the two: the conservative reading,
 *    which may call a set capped that was not and never the reverse. The left
 *    join keeps a page with no stored row from a source, so a page whose every
 *    slot went to an over-long target is caught too.
 *  - Sitemap: the page's STAGED `sitemap_hreflang` rows, joined to the page
 *    exactly as `deriveSitemapHreflang` joins them (`url_normalised =
 *    pages.url`), counted before the derivation's DISTINCT. A `<url>` that
 *    filled its cap with pairs another document (or a repeat of the `<url>`)
 *    also states derives to fewer than `MAX_HREFLANG_PAIRS` rows, and the
 *    derived rows alone would miss it. Staged rows of several documents add
 *    up, so a page listed twice with 100 alternates each counts as at the cap:
 *    conservative again. The derived `source = 'sitemap'` rows are not read:
 *    they never outnumber the staged rows they come from.
 *
 * WHAT IT STILL UNDERCOUNTS. An href that did not resolve took a slot and was
 * neither stored nor counted on the page (`PageWriter.counts.hreflangUnresolved`
 * is crawl-wide only), and a sitemap alternate over `INDEXED_URL_MAX` is
 * counted only crawl-wide (`sitemapFacts.overlongLocsSkipped`); a set short of
 * the cap by those is read as whole. Neither is recorded per page, and
 * recording it would be a migration.
 */
export const POSSIBLY_CAPPED_PAGES = (crawlId: string, among: PageScope): SQL => sql`
  select cp.id as page_id
  from pages cp
  left join hreflang ch
    on ch.crawl_id = cp.crawl_id and ch.page_id = cp.id and ch.source in ('html', 'header')
  where cp.crawl_id = ${crawlId} and ${among("cp")}
  -- cp.id is the primary key, so cp.overlong_urls may be read in the having.
  group by cp.id, ch.source
  having count(ch.page_id) + ${OVERLONG_HREFLANG("cp")} >= ${MAX_HREFLANG_PAIRS}
  union
  select sp.id as page_id
  from pages sp
  join sitemap_hreflang ss on ss.crawl_id = sp.crawl_id and ss.url_normalised = sp.url
  where sp.crawl_id = ${crawlId} and ${among("sp")}
  group by sp.id
  having count(*) >= ${MAX_HREFLANG_PAIRS}`;
