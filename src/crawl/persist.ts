/**
 * The crawl loop's write path: one `addPage` per fetched URL, batched inserts
 * into `pages` / `links` / `hreflang` / `structured_data`.
 *
 * The page buffer is also the crawl's durability anchor. Each buffered page
 * row carries the frontier URL it settles, and `flushPages` inserts the rows
 * and marks those URLs `done` in ONE transaction. Nothing outside this class
 * completes a frontier row on the success path any more, and the reason is a
 * failure mode the loop could not fix on its own: it used to complete a URL as
 * soon as its page row had been *buffered*, so a process killed outright
 * (SIGKILL, OOM, power) lost up to `batchSize - 1` page rows that the frontier
 * already recorded as finished, and no resume would fetch them again (build
 * plan §7, "hard-kill durability"). Now the two facts commit together: a URL is
 * `done` only if its page row is in the database, and a kill between them can
 * only cost a re-fetch.
 *
 * The child tables are not part of that transaction. They are additive
 * evidence hanging off a page row, and rolling a page row back because a link
 * insert failed would delete the audit's primary fact to protect a secondary
 * one. The loop keeps their window narrow instead, by flushing the writer at
 * the end of every leased batch.
 *
 * KNOW WHAT THAT COSTS, because the fix above sharpened it. A kill between the
 * `pages` commit and the child inserts leaves up to `batchSize - 1` `links`,
 * `hreflang` and `structured_data` rows unwritten for pages the frontier now
 * marks `done` — and unlike the page rows, they are UNRECOVERABLE: the URL is
 * finished, so no resume re-fetches it, and a page with no link rows reads
 * exactly like a page that genuinely had no links. The rules cannot tell the
 * two apart. The window is one leased batch rather than one full buffer, which
 * is a smaller hole, not a closed one. Closing it means moving the child
 * inserts into the same transaction and accepting the trade this paragraph
 * opens with.
 *
 * The memory contract lives here as much as in the analyzer, and the exact
 * bound matters. Two separate things are bounded:
 *  - The persistent buffers. Each is ≤ `batchSize` at all times — the page
 *    buffer counted in `{ row, complete }` pairs, which add one boolean to a
 *    row and copy nothing. Not "on average", not "after `addPage` returns":
 *    rows are appended one at a time and the buffer is drained the instant it
 *    fills. A mega-menu page with
 *    2000 links pushes twenty 100-row batches through the buffer instead of
 *    holding a 2000-row one.
 *  - The transient per-call arrays. `addPage` materialises the row objects for
 *    one page before pushing them, so a call peaks at that page's row count,
 *    which the analyzer's own caps bound (links 2000, hreflang 200,
 *    structured data 50). Across the crawl loop that is
 *    O(concurrency × analyzer caps), not O(URLs) — lazy generators would drop
 *    the constant but buy nothing real at this scale.
 * Nothing here is keyed by URL or by page, so the writer's footprint never
 * grows with the size of the crawl.
 *
 * Three facts about the row shapes that readers of this data need:
 *  - `pages.simhash` is a SIGNED bigint and the analyzer's simhash is in the
 *    unsigned 64-bit range. It is stored as `BigInt.asIntN(64, simhash)`;
 *    recover the analyzer's value with `BigInt.asUintN(64, stored)`. The bit
 *    pattern is unchanged, so hamming distances work on the stored form too.
 *  - `pages.url_normalised` is the *analytic* variant-detection key —
 *    `normalizeUrl` output, lowercased, trailing slash stripped — and is
 *    deliberately NOT the frontier key. Two URLs differing only in case or in
 *    a trailing slash are two frontier entries (they are two HTTP resources,
 *    and one usually redirects to the other) but one `url_normalised` group,
 *    which is exactly what the duplicate-URL checks want to see.
 *  - `pages.redirect_url` is the resolved `Location` verbatim and
 *    `pages.redirect_url_normalised` is that same target through
 *    `normalizeUrl` — the spelling `pages.url` is keyed by. Join the redirect
 *    graph on the second; quote the first as evidence. A `Location` carrying a
 *    fragment, or query params in an order `normalizeUrl` sorts, is the same
 *    URL as the page row the crawler created from it, and only the normalised
 *    column can say so.
 *
 * `pageId` is minted here rather than read back from the insert, so child rows
 * can reference their page without a round trip. The consequence is stated
 * where it happens (see flushPages): if a page row loses the
 * `onConflictDoNothing` race, its children still carry the minted id.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { hreflang, links, pages, structuredData } from "../db/schema.js";
import type { FetchResult } from "./fetch-page.js";
import type { PageAnalysis } from "./parse/page-analyzer.js";
import { isSameOrigin, normalizeUrl } from "./parse/url-utils.js";
import { completeUrls } from "./frontier.js";
import { derivePageType, type PageTypePattern } from "./page-type.js";

const DEFAULT_BATCH_SIZE = 100;

/** The frontier's view of a URL — `LeasedUrl` satisfies this structurally. */
export interface PageWriterItem {
  url: string;
  depth: number;
  discoveredVia: string;
}

export interface PageWriterOpts {
  /** Rows per multi-row insert, and the ceiling on every buffer. */
  batchSize?: number;
  /** Client-supplied page-type patterns; see derivePageType. */
  pageTypePatterns?: PageTypePattern[];
}

/**
 * What the writer has actually written, plus what it could not write. The
 * counters are cumulative over the writer's life and are the crawl summary's
 * source for "did the persistence layer drop anything".
 */
export interface PageWriterStats {
  /** Page rows inserted. Excludes rows dropped by the (crawl, url) conflict. */
  pages: number;
  links: number;
  hreflang: number;
  structuredData: number;
  /**
   * `<link rel=alternate hreflang>` hrefs that would not resolve against
   * their page URL. `hreflang.target_url` is NOT NULL, so such a pair has no
   * row to be in — it is counted here instead of vanishing.
   */
  hreflangUnresolved: number;
}

/**
 * What the caller says about the frontier row behind a page.
 *
 * `complete: false` is for a URL the caller is settling itself — the loop
 * marks a URL whose retries are spent `failed`, and a flush that then marked it
 * `done` would overwrite the crawl's own account of what happened. It is a
 * required argument rather than an option with a default because "does this
 * page row finish this URL" has no safe assumption: guessing `true` resurrects
 * failures, guessing `false` strands leases.
 */
export interface AddPageOpts {
  /** Mark this URL `done` in the transaction that commits its page row. */
  complete: boolean;
}

type PageRow = typeof pages.$inferInsert;

/** A page row waiting to be written, and the frontier URL it settles. */
interface BufferedPage {
  row: PageRow;
  complete: boolean;
}

type LinkRow = typeof links.$inferInsert;
type HreflangRow = typeof hreflang.$inferInsert;
type StructuredDataRow = typeof structuredData.$inferInsert;

export class PageWriter {
  private readonly batchSize: number;
  private readonly pageTypePatterns: PageTypePattern[] | undefined;

  private readonly pageBuffer: BufferedPage[] = [];
  private readonly linkBuffer: LinkRow[] = [];
  private readonly hreflangBuffer: HreflangRow[] = [];
  private readonly structuredDataBuffer: StructuredDataRow[] = [];

  private readonly counts: PageWriterStats = {
    pages: 0,
    links: 0,
    hreflang: 0,
    structuredData: 0,
    hreflangUnresolved: 0,
  };

  constructor(
    private readonly db: Db,
    private readonly crawlId: string,
    opts: PageWriterOpts = {},
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error(`PageWriter: batchSize must be a positive integer, got ${opts.batchSize}`);
    }
    this.pageTypePatterns = opts.pageTypePatterns;
  }

  /** Cumulative write counters (see PageWriterStats). */
  stats(): PageWriterStats {
    return { ...this.counts };
  }

  /**
   * Buffer one crawled URL and everything the analyzer found on it, flushing
   * any buffer that fills. Returns the page id the child rows were written
   * against.
   *
   * `analysis` is null for every fetch class that produced no HTML — a 404, a
   * redirect, a timeout. Those still get a `pages` row: the fetch outcome is
   * the audit fact, and a URL that vanished from the table would be a silent
   * failure.
   *
   * `opts.complete` decides whether this page row also finishes the URL's
   * frontier row. It is not acted on here — buffering a row is not writing it,
   * and that gap is the whole bug this argument exists to close. The
   * completion happens in `flushPages`, with the insert.
   */
  async addPage(
    item: PageWriterItem,
    fetch: FetchResult,
    analysis: PageAnalysis | null,
    opts: AddPageOpts,
  ): Promise<string> {
    const pageId = `page_${randomUUID()}`;

    await this.push(
      this.pageBuffer,
      [{ row: this.pageRow(pageId, item, fetch, analysis), complete: opts.complete }],
      () => this.flushPages(),
    );

    if (analysis !== null) {
      // The analyzer already deduped links by resolved target (first anchor
      // wins) and numbered them; these rows are that set verbatim.
      await this.push(
        this.linkBuffer,
        analysis.links.map((link) => ({
          crawlId: this.crawlId,
          sourcePageId: pageId,
          targetUrl: link.href,
          targetPageId: null,
          anchor: link.anchor,
          rel: link.rel,
          isInternal: isSameOrigin(link.href, item.url),
          isNofollow: link.nofollow,
          position: link.position,
        })),
        () => this.flushLinks(),
      );

      await this.push(
        this.hreflangBuffer,
        this.hreflangRows(pageId, item.url, analysis),
        () => this.flushHreflang(),
      );

      await this.push(
        this.structuredDataBuffer,
        analysis.structuredData.map((block) => ({
          crawlId: this.crawlId,
          pageId,
          schemaType: block.type,
          raw: block.raw,
          fieldPresence: null,
        })),
        () => this.flushStructuredData(),
      );
    }

    return pageId;
  }

  /**
   * Write whatever is still buffered. Idempotent — an empty buffer is a no-op,
   * so the crawl loop's `finally` can call it unconditionally, and calling it
   * mid-crawl only costs a smaller-than-usual insert.
   *
   * Every table is attempted even when an earlier one fails. Sequential
   * `await`s would abandon three buffers' worth of rows because one table's
   * insert threw, and since this runs in the loop's `finally`, that failure
   * would also be the error the crawl reports instead of whatever actually
   * went wrong. So each flush is tried, the failures are collected, and an
   * `AggregateError` naming every failed table is thrown at the end — the
   * whole picture, loudly (hard rule 7), rather than the first fragment of it.
   *
   * A batch that fails is lost: its rows were taken out of the buffer before
   * the insert. That is the transparent outcome — the error names the table
   * and the row count, and the caller decides — not a silent retry that could
   * double-write rows the database may in fact have committed. For `pages` the
   * loss is also recoverable: the transaction took the frontier completions
   * down with it, so those URLs are still unfinished and a resume re-fetches
   * precisely them.
   */
  async flush(): Promise<void> {
    const drains: Array<[string, () => Promise<void>]> = [
      ["pages", () => this.flushPages()],
      ["links", () => this.flushLinks()],
      ["hreflang", () => this.flushHreflang()],
      ["structured_data", () => this.flushStructuredData()],
    ];
    const failed: string[] = [];
    const errors: unknown[] = [];
    for (const [table, drain] of drains) {
      try {
        await drain();
      } catch (error) {
        failed.push(table);
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `PageWriter.flush: ${errors.length} of ${drains.length} table flushes failed (${failed.join(", ")})`,
      );
    }
  }

  /**
   * Append rows one at a time, draining the moment the buffer is full. Row by
   * row rather than "append all, then drain" precisely so that a page with
   * more rows than `batchSize` never puts them all in the buffer at once.
   */
  private async push<T>(
    buffer: T[],
    rows: readonly T[],
    flush: () => Promise<void>,
  ): Promise<void> {
    for (const row of rows) {
      buffer.push(row);
      if (buffer.length >= this.batchSize) await flush();
    }
  }

  /**
   * Take everything in one buffer and write it. The buffer is emptied before
   * the insert is attempted, so a failing batch is gone from memory — the
   * error says which table and how many rows, with the driver's own error as
   * its `cause`.
   */
  private async drain<T>(
    table: string,
    counter: keyof PageWriterStats,
    buffer: T[],
    insert: (batch: T[]) => Promise<number>,
  ): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    let written: number;
    try {
      written = await insert(batch);
    } catch (error) {
      throw new Error(
        `PageWriter: insert into ${table} failed; ${batch.length} row(s) lost`,
        { cause: error },
      );
    }
    this.counts[counter] += written;
  }

  /**
   * Write the buffered page rows and complete their frontier URLs, atomically.
   *
   * The transaction is the fix for hard-kill durability (see the module
   * header): outside it, a crash between the insert and the completion leaves
   * either a page nobody will ever mark done (harmless — the resume re-fetches
   * it and the conflict absorbs the row) or a URL marked done whose page row
   * never landed (a hole in the audit that no resume will fill). Only one
   * ordering is safe, and a transaction is how the database enforces it rather
   * than how we remember to.
   *
   * The completion is deliberately unconditional on the insert's outcome: a
   * page row dropped by the `(crawl_id, url)` conflict means the page is
   * already in the table under a row this crawl wrote, so the URL is settled
   * either way. `completeUrls` is a no-op for a URL with no frontier row, which
   * is what makes the writer usable without a frontier at all.
   */
  private async flushPages(): Promise<void> {
    await this.drain("pages", "pages", this.pageBuffer, async (batch) =>
      this.db.transaction(async (tx) => {
        // A redirect target can already have been crawled under its own row,
        // and (crawl_id, url) is unique. The loser of that race keeps its
        // minted pageId on its child rows, which then point at a page row that
        // does not exist. That is deliberate: de-duplicating here would need a
        // per-crawl set of URLs in memory, which is exactly the O(URLs)
        // structure the memory contract forbids. Link resolution is a SQL join
        // on target_url, not on these ids, so it is unaffected.
        const inserted = await tx
          .insert(pages)
          .values(batch.map((buffered) => buffered.row))
          .onConflictDoNothing({ target: [pages.crawlId, pages.url] })
          .returning({ id: pages.id });

        await completeUrls(
          tx,
          this.crawlId,
          batch.filter((buffered) => buffered.complete).map((buffered) => buffered.row.url),
        );

        return inserted.length;
      }),
    );
  }

  private async flushLinks(): Promise<void> {
    await this.drain("links", "links", this.linkBuffer, async (batch) => {
      await this.db.insert(links).values(batch);
      return batch.length;
    });
  }

  private async flushHreflang(): Promise<void> {
    await this.drain("hreflang", "hreflang", this.hreflangBuffer, async (batch) => {
      await this.db.insert(hreflang).values(batch);
      return batch.length;
    });
  }

  private async flushStructuredData(): Promise<void> {
    await this.drain(
      "structured_data",
      "structuredData",
      this.structuredDataBuffer,
      async (batch) => {
        await this.db.insert(structuredData).values(batch);
        return batch.length;
      },
    );
  }

  private pageRow(
    pageId: string,
    item: PageWriterItem,
    fetch: FetchResult,
    analysis: PageAnalysis | null,
  ): PageRow {
    const normalised = normalizeUrl(item.url);
    if (normalised === null) {
      // The frontier only holds http(s) URLs that passed url-policy, so this
      // is a defect upstream of the writer. Persisting a page under a guessed
      // key would hide it; throwing does not.
      throw new Error(`PageWriter: cannot normalise page url ${item.url}`);
    }

    return {
      id: pageId,
      crawlId: this.crawlId,
      url: item.url,
      // Lowercased and trailing-slash-stripped on top of normalizeUrl: the
      // analytic key, not the frontier key (see the module header).
      urlNormalised: normalised.toLowerCase().replace(/\/$/, ""),
      pageType: derivePageType(item.url, this.pageTypePatterns),
      statusCode: fetch.statusCode,
      fetchClass: fetch.fetchClass,
      contentType: fetch.contentType,
      redirectUrl: fetch.redirectUrl,
      // The join key for the redirect graph. `fetch.redirectUrl` is already
      // absolute, http(s) and policy-checked (see FetchResult), so a null out
      // of `normalizeUrl` here is a defect in this engine rather than something
      // a site did — and a redirect chain that silently stopped walking because
      // of it would be a false negative nobody could see (hard rule 7).
      redirectUrlNormalised:
        fetch.redirectUrl === null ? null : normaliseRedirect(fetch.redirectUrl),
      depth: item.depth,
      discoveredVia: item.discoveredVia,
      title: analysis?.title ?? null,
      metaDescription: analysis?.metaDescription ?? null,
      canonicalHtml: analysis?.canonicalHtml ?? null,
      canonicalHeader: fetch.canonicalHeader,
      canonicalCount: analysis?.canonicalCount ?? 0,
      robotsMeta: analysis?.robotsMeta ?? null,
      xRobotsTag: fetch.xRobotsTag,
      isIndexable: isIndexable(fetch, analysis),
      ogTitle: analysis?.ogTitle ?? null,
      ogDescription: analysis?.ogDescription ?? null,
      ogImage: analysis?.ogImage ?? null,
      h1Count: analysis?.headingCounts[0] ?? 0,
      h2Count: analysis?.headingCounts[1] ?? 0,
      h3Count: analysis?.headingCounts[2] ?? 0,
      h4Count: analysis?.headingCounts[3] ?? 0,
      h5Count: analysis?.headingCounts[4] ?? 0,
      h6Count: analysis?.headingCounts[5] ?? 0,
      headingOrder: analysis?.headingOrder ?? null,
      wordCount: analysis?.wordCount ?? null,
      textRatio: analysis?.textRatio ?? null,
      contentHash: analysis?.contentHash ?? null,
      // Unsigned analyzer value -> signed column; see the module header.
      simhash: analysis === null ? null : BigInt.asIntN(64, analysis.simhash),
      responseTimeMs: fetch.responseTimeMs,
      htmlBytes: fetch.htmlBytes,
      domSize: analysis?.domSize ?? null,
      imagesTotal: analysis?.imagesTotal ?? 0,
      imagesMissingAlt: analysis?.imagesMissingAlt ?? 0,
      imagesMissingDimensions: analysis?.imagesMissingDimensions ?? 0,
      hasAmp: analysis?.hasAmp ?? false,
      hasViewport: analysis?.hasViewport ?? false,
      hasLoremIpsum: analysis?.hasLoremIpsum ?? false,
      hasSoft404Phrases: analysis?.hasSoft404Phrases ?? false,
      relNext: analysis?.relNext ?? null,
      relPrev: analysis?.relPrev ?? null,
      // A page with no HTML has no navigation and no framework tell, so the
      // no-analysis case is 0/0/[] rather than a null: the columns are NOT
      // NULL, and "this page served a PDF" is not "we do not know how many nav
      // links it had". The render-side twins are the ones that stay null, and
      // they are written by the render pass, never here.
      navLinkCount: analysis?.navLinkCount ?? 0,
      footerLinkCount: analysis?.footerLinkCount ?? 0,
      frameworkMarkers: analysis?.frameworkMarkers ?? [],
      structuredDataParseErrors: analysis?.structuredDataParseErrors ?? 0,
    };
  }

  /**
   * Resolve each hreflang href against the page URL. The analyzer hands them
   * over verbatim (`href="/fr/"` is a legal and common form) while
   * `hreflang.target_url` is NOT NULL, so an href that will not resolve has no
   * row it can occupy. Those are counted, never quietly discarded.
   */
  private hreflangRows(
    pageId: string,
    pageUrl: string,
    analysis: PageAnalysis,
  ): HreflangRow[] {
    const rows: HreflangRow[] = [];
    for (const pair of analysis.hreflang) {
      let target: string;
      try {
        target = new URL(pair.href, pageUrl).href;
      } catch {
        this.counts.hreflangUnresolved += 1;
        continue;
      }
      rows.push({
        crawlId: this.crawlId,
        pageId,
        hreflangCode: pair.code,
        targetUrl: target,
        targetPageId: null,
        source: "html",
      });
    }
    return rows;
  }
}

/**
 * A redirect target in the spelling `pages.url` is keyed by. Throws rather than
 * storing a null the join would read as "this redirect goes nowhere": see the
 * call site.
 */
function normaliseRedirect(redirectUrl: string): string {
  const normalised = normalizeUrl(redirectUrl);
  if (normalised === null) {
    throw new Error(`PageWriter: cannot normalise redirect target ${redirectUrl}`);
  }
  return normalised;
}

/**
 * `none` as a whole directive — Google's shorthand for "noindex, nofollow".
 * Bounded on both sides because the directive list is comma- and
 * space-delimited: a substring test would read "nonevent" as a directive and
 * drop the page out of the index.
 */
const NONE_DIRECTIVE = /(?:^|[\s,])none(?:[\s,]|$)/i;

/** Whether one robots directive string asks for the page to stay out of the index. */
function saysNoindex(value: string | null): boolean {
  return /noindex/i.test(value ?? "") || NONE_DIRECTIVE.test(value ?? "");
}

/**
 * Indexability as the checklist defines it: a 200 that fetched cleanly and is
 * not told to stay out of the index by either robots channel. Anything else —
 * a redirect, a 404, a blocked page, a page with no HTML — is not indexable,
 * which is why the fetch class is part of the test and not just the status.
 *
 * MIRRORED BY `saysNoindex` (src/rules/page/indexability.ts), which asks the
 * same question of the stored columns when the rules run. The two must agree —
 * a page the rule layer calls noindex and this column calls indexable is a
 * contradiction the report cannot resolve. Change one, change the other.
 */
function isIndexable(fetch: FetchResult, analysis: PageAnalysis | null): boolean {
  return (
    fetch.statusCode === 200 &&
    fetch.fetchClass === "ok" &&
    !saysNoindex(analysis?.robotsMeta ?? null) &&
    !saysNoindex(fetch.xRobotsTag)
  );
}
