/**
 * The crawl loop's write path: one `addPage` per fetched URL, batched inserts
 * into `pages` / `links` / `hreflang` / `structured_data` / `resources` /
 * `page_resources`.
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
 * `hreflang`, `structured_data`, `resources` and `page_resources` rows
 * unwritten for pages the frontier now
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
 *    which the analyzer's own caps bound (links 2000, resource refs 2000 —
 *    which materialise TWICE, once as `resources` rows and once as
 *    `page_resources` edges — hreflang 200, structured data 50). Across the
 *    crawl loop that is
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
 * THE RESOURCE PAIR (P11-T1) sits in those same buffers and follows the same
 * rules, with one difference that is the point of the pair: `resources` is
 * about FILES and is written `on conflict do nothing` against
 * `(crawl_id, url)`, so the second page to reference an image writes an EDGE
 * and no row. THE DEDUP IS THE DATABASE'S, not the writer's — a per-crawl set
 * of resource URLs held here is precisely the O(URLs) structure the memory
 * contract forbids (hard rule 6), and it is also the structure that would be
 * wrong on a resumed crawl, where the earlier run's rows are in the table and
 * in no process's memory. The writer's own state stays O(batchSize).
 *
 * The crawl path writes three columns of a resource row — `crawl_id`, `url`,
 * `kind` — and leaves every fetch column null. That null is `fetch_class`'s
 * "seen, not yet asked" (see src/db/schema.ts), and it is the resource fetch
 * pass's work list.
 *
 * `pageId` is minted here rather than read back from the insert, so child rows
 * can reference their page without a round trip. The consequence is stated
 * where it happens (see flushPages): if a page row loses the
 * `onConflictDoNothing` race, its children still carry the minted id.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  hreflang,
  links,
  pageResources,
  pages,
  resources,
  structuredData,
} from "../db/schema.js";
import type { FetchResult } from "./fetch-page.js";
import type { PageAnalysis } from "./parse/page-analyzer.js";
import { isSameOrigin, normalizeUrl } from "./parse/url-utils.js";
import { completeUrls } from "./frontier.js";
import { derivePageType, type PageTypePattern } from "./page-type.js";
import { EXTRACTION_VERSION } from "./versions.js";
import { storableDeep } from "./storable-text.js";

const DEFAULT_BATCH_SIZE = 100;

/**
 * Robots-blocked page rows per INSERT (`insertRobotsBlocked`). A page row binds
 * ~76 parameters, so 500 rows is ~38,000 — well under Postgres' 65,535 — with
 * room for the row to grow.
 */
const BLOCKED_INSERT_CHUNK_ROWS = 500;

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
   * Resource rows INSERTED — distinct URLs this crawl had not seen before.
   * Excludes the rows the `(crawl_id, url)` conflict dropped, which is what
   * makes the number "files discovered" rather than "references written"
   * (`pages` is counted the same way, and for the same reason).
   */
  resources: number;
  /** Page→resource edges written: one per reference, not per file. */
  pageResources: number;
  /**
   * `<link rel=alternate hreflang>` hrefs that would not resolve against
   * their page URL. `hreflang.target_url` is NOT NULL, so such a pair has no
   * row to be in — it is counted here instead of vanishing.
   */
  hreflangUnresolved: number;
  /**
   * Pages whose analyzer hit `MAX_RESOURCE_REFS` and dropped a reference —
   * `PageAnalysis.resourceRefsCapped`, counted (P12-T1).
   *
   * O(pages), never O(edges), and that is the whole reason it lives here. The
   * question "how many pages lost references" is answerable from
   * `page_resources` alone, and phase-11.md §10.1 measured what that costs: a
   * scan of every reference the crawl holds, 73 ms over a 500,000-edge crawl,
   * against a `crawl_status` whose other reads are ≤ 3 ms. This class is the
   * one component every page passes through exactly once, so the count is a
   * `+= 1` in the same place the link and resource counters are incremented,
   * and the crawl loop stamps the total onto `crawls.resource_refs_capped_pages`
   * at close.
   *
   * COUNTED WHEN THE PAGE IS HANDED OVER, not when its row lands, which is the
   * one reading a careful consumer must know: a page row that loses the
   * `(crawl_id, url)` conflict race is counted here even though its `pages` row
   * was dropped. That is the same accounting its resource and edge rows already
   * get — those are written for the losing page too (see the module header on
   * the minted id) — so the number stays consistent with the rows on disk. It
   * is NOT `stats().pages`' accounting, which counts inserts.
   */
  resourceRefsCappedPages: number;
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
type ResourceRow = typeof resources.$inferInsert;
type PageResourceRow = typeof pageResources.$inferInsert;

export class PageWriter {
  private readonly batchSize: number;
  private readonly pageTypePatterns: PageTypePattern[] | undefined;

  private readonly pageBuffer: BufferedPage[] = [];
  private readonly linkBuffer: LinkRow[] = [];
  private readonly hreflangBuffer: HreflangRow[] = [];
  private readonly structuredDataBuffer: StructuredDataRow[] = [];
  private readonly resourceBuffer: ResourceRow[] = [];
  private readonly pageResourceBuffer: PageResourceRow[] = [];

  private readonly counts: PageWriterStats = {
    pages: 0,
    links: 0,
    hreflang: 0,
    structuredData: 0,
    resources: 0,
    pageResources: 0,
    hreflangUnresolved: 0,
    resourceRefsCappedPages: 0,
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
      // The truncation flag, counted before anything is buffered: it is a fact
      // about the ANALYSIS rather than about any row, so it must not depend on
      // which insert succeeds. A page with no analysis (a 404, a redirect, a
      // timeout) answers nothing here and is not counted — "no references were
      // dropped" and "there was no HTML to drop them from" are different
      // sentences (hard rule 7).
      if (analysis.resourceRefsCapped) this.counts.resourceRefsCappedPages += 1;

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

      // The analyzer already deduped the refs by resolved URL for THIS page,
      // so the edges are unique per page by construction and the resource rows
      // are unique per page before the table's own dedup ever sees them. Both
      // buffers are pushed row by row like every other, so a gallery page with
      // more assets than `batchSize` never holds them all.
      await this.push(
        this.resourceBuffer,
        analysis.resourceRefs.map((ref) => ({
          crawlId: this.crawlId,
          url: ref.url,
          kind: ref.kind,
          // Every fetch column stays null: this crawl saw the reference and
          // asked nobody anything about it. See the module header.
        })),
        () => this.flushResources(),
      );

      await this.push(
        this.pageResourceBuffer,
        analysis.resourceRefs.map((ref) => ({
          crawlId: this.crawlId,
          pageId,
          resourceUrl: ref.url,
        })),
        () => this.flushPageResources(),
      );

      // DEVIATION 3 (Phase 26b): og:image / twitter:image URLs become
      // `resources` rows — kind `image`, so the fetch pass asks for their
      // status and bytes — and NEVER `page_resources` edges. A browser does not
      // load a share image, so it is no part of page weight, mixed content or
      // `resources.broken`; every rule in that family judges only URLs with an
      // edge. A URL the page also loads through a resource ref already has its
      // row from the push above (with that ref's kind) and is not repeated.
      const pageRefs = new Set(analysis.resourceRefs.map((ref) => ref.url));
      await this.push(
        this.resourceBuffer,
        analysis.socialImageRefs
          .filter((url) => !pageRefs.has(url))
          .map((url) => ({ crawlId: this.crawlId, url, kind: "image" as const })),
        () => this.flushResources(),
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
      // Resources before their edges, so a crash between the two leaves edges
      // missing rather than edges pointing at files the table never learned
      // about. Neither is a foreign key (see schema.ts) — this is about which
      // half of the pair is the more useful survivor.
      ["resources", () => this.flushResources()],
      ["page_resources", () => this.flushPageResources()],
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
   *
   * THE STORABILITY BOUNDARY (ruling R10). Every row this writer buffers passes
   * through here, so every page-derived string in it is made storable at this
   * one place: titles, anchors, rels, JSON-LD values and keys, URLs, header
   * values, reasons. `storableDeep` maps U+0000 to U+2400 and a lone surrogate
   * to U+FFFD, and returns a clean value unchanged. One hostile page therefore
   * cannot make a batch insert throw, which would lose the batch and fail the
   * crawl, and a resume would hit the same page again.
   */
  private async push<T>(
    buffer: T[],
    rows: readonly T[],
    flush: () => Promise<void>,
  ): Promise<void> {
    for (const row of rows) {
      buffer.push(storableDeep(row));
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

  /**
   * Write the page rows of URLs the crawl will NEVER REQUEST because robots.txt
   * disallowed them, immediately, and return how many rows actually landed
   * (Phase 23 T3, study D1).
   *
   * Not through the page buffer, for three reasons that are each enough:
   *  - **The count is the budget.** The loop spends `maxBlockedUrls` against
   *    rows that EXIST, and only the insert's `returning` knows which candidates
   *    a `(crawl_id, url)` conflict dropped — a URL a sibling page already
   *    recorded, or that an earlier run of a resumed crawl did. A buffered write
   *    would answer that after the loop had already spent the budget.
   *  - **There is no frontier row to settle.** These URLs are never enqueued,
   *    so the hard-kill transaction `flushPages` exists for — page row and
   *    frontier completion committing together — has nothing to pair.
   *  - **There is nothing hanging off them.** No analysis, so no links,
   *    hreflang, structured data or resources.
   *
   * The rows are built by `pageRow`, the one place a page row is shaped, from a
   * `FetchResult` that says exactly what happened: class `disallowed`, no
   * status, no bytes, and the reason the caller composed
   * (`robotsBlockedReason` — `robots.txt: <the matching line>`). Two columns
   * are then corrected to what is true of a URL nobody asked for:
   * `response_time_ms` and `html_bytes` are NULL (not measured), never the 0 a
   * fetch that answered instantly with nothing would write. `fetched_at` keeps
   * its stamp: it dates THIS observation, which is "robots.txt said no", and
   * the recheck pass never reads a `disallowed` row.
   *
   * NOT COUNTED IN `stats().pages`, which is the crawl summary's count of the
   * fetches the writer persisted; the loop owns the blocked count and the
   * crawl row carries the overflow (`crawls.robots_blocked_dropped`).
   */
  async insertRobotsBlocked(
    blocked: ReadonlyArray<{ item: PageWriterItem; reason: string }>,
  ): Promise<number> {
    if (blocked.length === 0) return 0;
    // Through the storability boundary like every buffered row (see `push`):
    // the reason quotes the site's robots.txt line.
    const rows = blocked.map(({ item, reason }) => storableDeep({
      ...this.pageRow(
        `page_${randomUUID()}`,
        item,
        {
          url: item.url,
          statusCode: null,
          fetchClass: "disallowed",
          contentType: null,
          redirectUrl: null,
          body: null,
          htmlBytes: 0,
          responseTimeMs: 0,
          retryAfterMs: null,
          canonicalHeader: null,
          xRobotsTag: null,
          platformHint: null,
          // Never requested, so no response and no headers.
          responseHeaders: null,
          disallowedReason: reason,
        },
        null,
      ),
      responseTimeMs: null,
      htmlBytes: null,
    }));
    // Chunked under Postgres' 65,535-parameter ceiling: a page row binds every
    // column it names (~76), and one page can link to up to the analyzer's
    // 2,000 blocked URLs — `INSERT_CHUNK_ROWS`' problem in frontier.ts, at a
    // wider row. Not one transaction, deliberately: each row is idempotent
    // under the conflict target, and the count returned is what landed.
    let count = 0;
    for (let i = 0; i < rows.length; i += BLOCKED_INSERT_CHUNK_ROWS) {
      const inserted = await this.db
        .insert(pages)
        .values(rows.slice(i, i + BLOCKED_INSERT_CHUNK_ROWS))
        .onConflictDoNothing({ target: [pages.crawlId, pages.url] })
        .returning({ id: pages.id });
      count += inserted.length;
    }
    return count;
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

  /**
   * The upsert. `on conflict do nothing` on `(crawl_id, url)` absorbs both
   * shapes of duplicate: a URL already in the table from an earlier page or an
   * earlier run, and two pages in the SAME batch referencing one file (which
   * Postgres resolves within the statement — the `pages` insert has always
   * relied on the same behaviour for redirect targets).
   *
   * The count is `returning`'s length, so it is files DISCOVERED. A conflict
   * dropping a row is not a loss: the row it conflicted with says the same
   * three things, and this crawl's own edge is written either way.
   */
  private async flushResources(): Promise<void> {
    await this.drain("resources", "resources", this.resourceBuffer, async (batch) => {
      const inserted = await this.db
        .insert(resources)
        .values(batch)
        .onConflictDoNothing({ target: [resources.crawlId, resources.url] })
        .returning({ url: resources.url });
      return inserted.length;
    });
  }

  private async flushPageResources(): Promise<void> {
    await this.drain(
      "page_resources",
      "pageResources",
      this.pageResourceBuffer,
      async (batch) => {
        await this.db.insert(pageResources).values(batch);
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
      // The one field that says WHY, in the fetch layer's own words: the URL
      // or address the policy refused, the `Location` that was dropped and
      // what was wrong with it, the `content-encoding` we could not read. A
      // classified failure with no reason on disk is a row nobody can act on
      // (hard rule 7), and until this column existed that is what every one of
      // them was.
      fetchReason: fetch.disallowedReason,
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
      h1Text: analysis?.h1Text ?? null,
      wordCount: analysis?.wordCount ?? null,
      // Written together with `word_count`, off the same pass, and null in
      // exactly the same case — no analysis ran. That pairing is what lets a
      // rule tell "this page has no text evidence at all" (both null) from
      // "this row predates Phase 7" (a word count and no renderable one), which
      // is the distinction `content.thin-skipped` is built on.
      renderableWordCount: analysis?.renderableWordCount ?? null,
      // `click_depth` is Phase 7 Task 4's column and this writer does not touch
      // it: the crawl knows the depth of the frontier item that found the URL
      // (`depth`, above), not the shortest click path to it.
      textRatio: analysis?.textRatio ?? null,
      contentHash: analysis?.contentHash ?? null,
      // Unsigned analyzer value -> signed column; see the module header.
      simhash: analysis === null ? null : BigInt.asIntN(64, analysis.simhash),
      // The main-content fingerprint (migration 0018), same spelling and the
      // same round trip as `simhash` above it. TWO different nulls reach this
      // column and both are correct: no analysis ran at all (no HTML), and an
      // analysis that found no main content to fingerprint — an empty <main>,
      // or a body that is nothing but chrome. The pair below moves with it.
      mainSimhash:
        analysis === null || analysis.mainSimhash === null
          ? null
          : BigInt.asIntN(64, analysis.mainSimhash),
      mainWordCount: analysis?.mainWordCount ?? null,
      // Null exactly when `has_lorem_ipsum` below is false — the analyzer
      // derives both from one match, so the writer cannot break the pairing by
      // writing one of them.
      placeholderSnippet: analysis?.placeholderSnippet ?? null,
      // Where the head ended (migration 0021). All six null exactly when no
      // analysis ran; with one, the five flags are always written, so a null
      // `head_closed_by` beside them means `</head>` (or no close at all).
      headClosedBy: analysis?.headClosedBy ?? null,
      titleOutsideHead: analysis?.titleOutsideHead ?? null,
      metaDescriptionOutsideHead: analysis?.metaDescriptionOutsideHead ?? null,
      robotsOutsideHead: analysis?.robotsOutsideHead ?? null,
      canonicalOutsideHead: analysis?.canonicalOutsideHead ?? null,
      hreflangOutsideHeadCount: analysis?.hreflangOutsideHeadCount ?? null,
      responseTimeMs: fetch.responseTimeMs,
      // WHEN THIS OBSERVATION WAS TAKEN (migration 0016). One `new Date()` per
      // row on the hot path, which is what the row costs and nothing more.
      //
      // STAMPED HERE AND NOWHERE ELSE. This is the only place a page row is
      // created from a FETCH, and the timestamp belongs to the fetch: the
      // render pass, the click-depth derivation and the page-type inference all
      // update ANALYSIS columns of a body this row already has, so none of them
      // may touch it — moving it would date the fetch by when we last thought
      // about the page.
      //
      // NOTHING IS NEEDED ON THE RESUME PATH EITHER, and that is a decision
      // rather than an omission: the pages insert is `on conflict do nothing`
      // on (crawl_id, url) (see `flushPages`), never an upsert, so a URL a
      // previous run already wrote keeps that run's row and that run's
      // timestamp. That is the correct answer — the first observation is the
      // one `fetch_class` beside it describes, and re-stamping it would claim
      // the census was taken at a time it was not (hard rule 7).
      fetchedAt: new Date(),
      // The allowlisted headers of THIS observation, or null when none arrived.
      // The recheck pass never writes this column (first observation is the record).
      responseHeaders: fetch.responseHeaders,
      // Stamped on every row the writer shapes, robots-blocked rows included.
      extractionVersion: EXTRACTION_VERSION,
      // Phase 26b facts (migration 0026). Null exactly when no analysis ran
      // (no HTML: nothing measured). With one, `social` is null only for a
      // page with no social tag and `meta_refresh` only for a page with no
      // refresh; the counts, the anchor/insecure/structure objects and the
      // image sample are never null.
      htmlLang: analysis === null ? null : analysis.htmlLang,
      social: analysis === null ? null : analysis.social,
      h2Text: analysis === null ? null : analysis.h2Text,
      titleCount: analysis === null ? null : analysis.titleCount,
      metaDescriptionCount: analysis === null ? null : analysis.metaDescriptionCount,
      robotsMetas: analysis === null ? null : analysis.robotsMetas,
      metaRefresh: analysis === null ? null : analysis.metaRefresh,
      anchorCounts: analysis === null ? null : analysis.anchorCounts,
      insecureRefs: analysis === null ? null : analysis.insecureRefs,
      imagesEmptyAlt: analysis === null ? null : analysis.imagesEmptyAlt,
      imagesAltTooLong: analysis === null ? null : analysis.imagesAltTooLong,
      imagesMissingAltSample: analysis === null ? null : analysis.imagesMissingAltSample,
      relNextCount: analysis === null ? null : analysis.relNextCount,
      relPrevCount: analysis === null ? null : analysis.relPrevCount,
      htmlStructure: analysis === null ? null : analysis.htmlStructure,
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
 * MIRRORED BY `saysNoindex` (src/rules/helpers.ts), which asks the
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
