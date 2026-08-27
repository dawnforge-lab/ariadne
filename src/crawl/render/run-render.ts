/**
 * The render pass: the second pass over a finished crawl.
 *
 * It does four things in order, and the order is the design.
 *
 *  1. **Refuse to run over a live crawl.** `selectRenderSet` upserts frontier
 *     rows into `render_pending`; a row a crawl worker holds a lease on would
 *     be taken out from under it, and the URL would then be both "being
 *     fetched" and "waiting to be rendered". The check is `leased > 0` and it
 *     throws — a skip would be the silent fallback (rule 7) that lets a crawl
 *     and a render pass corrupt each other quietly.
 *  2. **Select.** One statement chooses the set and puts it in the frontier
 *     (src/crawl/render/select.ts).
 *  3. **Render.** `renderConcurrency` workers, each leasing ONE URL at a time
 *     and rendering it in its own browser context. One browser, at most
 *     `renderConcurrency` contexts, no page list in memory beyond the
 *     selection the budget already bounds (rule 6).
 *  4. **Record.** Every render — successful or failed — is written to its page
 *     row and its frontier row is completed in the SAME transaction, then the
 *     pass writes its count to `crawls.render_pass_count`.
 *
 * WHY A FAILED RENDER IS NOT RETRIED. `leaseRenderUrls` increments `attempts`,
 * but nothing in this pass reads it, because nothing in this pass loops: a URL
 * is leased once, rendered once, and completed once, whatever the outcome. A
 * page whose render timed out is a page with `render_error = 'timeout: …'` and
 * `rendered = false`, which is evidence — the same shape a failed fetch takes
 * in the crawl pass, where a classified row beats a skipped URL. The retry that
 * would be worth having (a different network moment) is a re-run of the pass,
 * not a loop inside it, and a re-run re-selects from scratch. The consequence
 * is the invariant the driver can then state plainly: `rendered + failures ==
 * selected.length`, always, with no URL left in `render_pending`.
 *
 * WHERE THE SELECTION STATS GO. They do not go anywhere. `render.coverage`
 * (P5-T5) needs `{budget, suspects, sampled, truncated}`, and `crawls` has no
 * render evidence column — the phase's schema change (migration 0007) added
 * page columns only, and `config_jsonb` is the crawl's *input*, not a place to
 * write results. Rather than hand-roll a migration, the numbers stay derivable:
 * every input the selection reads (`word_count`, `html_bytes`, `title`,
 * `framework_markers`, `links`) is a raw-crawl column that this pass does not
 * touch, so `renderSelectionStats` recomputes them from the same SQL that chose
 * the set, at any time after the pass, with the same answer. `selected`,
 * `rendered` and `renderFailures` come from the page rows this pass writes
 * (`rendered = true` / `render_error is not null`). What IS persisted is
 * `crawls.render_pass_count`, because that column exists and the pass is the
 * only writer of it.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import {
  completeUrls,
  frontierCounts,
  leaseRenderUrls,
  releaseRenderLeases,
} from "../frontier.js";
import { PageRenderer, writeRenderResult, type RenderResult } from "./renderer.js";
import {
  selectRenderSet,
  type RenderSelection,
  type RenderSelectionConfig,
} from "./select.js";

export const RENDER_PASS_DEFAULTS = {
  /**
   * Browser contexts alive at once. Four is the crawl's initial window, and a
   * context is far heavier than a socket: this is the number the memory
   * contract is stated against (rule 6), not a throughput knob to raise
   * because a machine looks idle.
   */
  renderConcurrency: 4,
  /**
   * A render's lease. The work it must cover is one host-gate wait plus one
   * navigation (15s) plus the settle (3s); 120s leaves an order of magnitude
   * for a slow host without stranding a crashed worker's URLs for long. It is
   * a crash-resume deadline, not a lock — see the frontier module header.
   */
  leaseSeconds: 120,
} as const;

/**
 * The pass's configuration. A `CrawlConfig` satisfies it structurally, which is
 * deliberate: the caller that just crawled a site renders it with the same
 * object, and a render cannot end up with a different user agent or a different
 * per-host delay than the crawl it belongs to (rule 9).
 */
export interface RenderPassConfig extends RenderSelectionConfig {
  siteUrl: string;
  userAgent: string;
  perHostDelayMs: number;
  /** robots.txt `Crawl-delay` the crawl honoured, honoured again here. */
  robotsCrawlDelaySec?: number | null;
  renderConcurrency?: number;
  navigationTimeoutMs?: number;
  settleMs?: number;
  /** TEST ONLY — the fixture-server escape hatch. See `CrawlConfig`. */
  allowPrivate?: boolean;
}

export interface RenderPassOptions {
  /** Graceful shutdown: leasing stops and held leases are released. */
  signal?: AbortSignal;
  /** Told about every third-party request aborted. Diagnostics only. */
  onRequestBlocked?: (url: string) => void;
}

export interface RenderPassSummary {
  crawlId: string;
  /** What the selection chose, verbatim, for the coverage story. */
  selection: RenderSelection;
  /** Pages the browser measured. */
  rendered: number;
  /** Pages whose render was attempted and classified as failed. */
  failures: number;
  /**
   * URLs still `render_pending` when the pass returned. Zero unless the pass
   * was aborted — it is the honest count of work the abort left behind, not a
   * rounding error.
   */
  unrendered: number;
  /** Wall time of the whole pass, selection included. */
  elapsedMs: number;
}

/**
 * Run the render pass for `crawlId`.
 *
 * Throws — loudly, before touching the frontier — if the crawl is still live.
 * Throws if a render result cannot be written. Everything a *site* does comes
 * back as a classified `render_error` instead.
 */
export async function runRenderPass(
  db: Db,
  crawlId: string,
  cfg: RenderPassConfig,
  opts: RenderPassOptions = {},
): Promise<RenderPassSummary> {
  const started = Date.now();
  const concurrency = cfg.renderConcurrency ?? RENDER_PASS_DEFAULTS.renderConcurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `runRenderPass: renderConcurrency must be an integer ≥ 1, got ${concurrency}`,
    );
  }

  // STEP 1. The crawl must be over. A leased row is a URL a worker is fetching
  // right now, and `selectRenderSet` would upsert `render_pending` straight
  // over its lease — the worker would then complete a row the render pass
  // believes it owns, and the selection array and the frontier would stop being
  // the same fact. Nothing is written before this check passes.
  const before = await frontierCounts(db, crawlId);
  if (before.leased > 0) {
    throw new Error(
      `runRenderPass: crawl ${crawlId} has ${before.leased} leased URL(s) — the render ` +
        `pass may not run over a live crawl (it would steal the crawler's rows). ` +
        `Wait for the crawl to finish, or release its leases if its workers are known dead.`,
    );
  }

  // STEP 2. Choose the set. After this statement the frontier is the selection.
  const selection = await selectRenderSet(db, crawlId, cfg);

  const renderer = await PageRenderer.launch({
    origin: new URL(cfg.siteUrl).origin,
    userAgent: cfg.userAgent,
    perHostDelayMs: cfg.perHostDelayMs,
    robotsCrawlDelaySec: cfg.robotsCrawlDelaySec ?? null,
    ...(cfg.navigationTimeoutMs === undefined
      ? {}
      : { navigationTimeoutMs: cfg.navigationTimeoutMs }),
    ...(cfg.settleMs === undefined ? {} : { settleMs: cfg.settleMs }),
    allowPrivate: cfg.allowPrivate === true,
    ...(opts.onRequestBlocked === undefined
      ? {}
      : { onRequestBlocked: opts.onRequestBlocked }),
  });

  let rendered = 0;
  let failures = 0;
  const workerIds: string[] = [];

  try {
    // STEP 3. `concurrency` workers, each leasing one URL at a time. One at a
    // time rather than a batch: a batch leased and then rendered serially holds
    // its last URL's lease for the whole batch, and a worker that dies loses
    // the whole batch to a lease expiry instead of one URL.
    const workers = Array.from({ length: concurrency }, (_, i) => {
      const workerId = `render_${crawlId}_${i}`;
      workerIds.push(workerId);
      return runWorker(db, crawlId, workerId, renderer, opts.signal ?? null, (result) => {
        if (result.rendered) rendered += 1;
        else failures += 1;
      });
    });
    await Promise.all(workers);
  } finally {
    await renderer.close();
    // A graceful shutdown returns its URLs immediately rather than leaving them
    // unavailable until the lease deadline passes (frontier module header).
    if (opts.signal?.aborted === true) {
      for (const workerId of workerIds) await releaseRenderLeases(db, crawlId, workerId);
    }
  }

  // STEP 4. The one column this pass persists. Set, not incremented: it is what
  // THIS pass rendered, and a re-run re-selects from scratch, so an accumulated
  // total would count the same page twice and mean nothing.
  await db.update(crawls).set({ renderPassCount: rendered }).where(eq(crawls.id, crawlId));

  const after = await frontierCounts(db, crawlId);
  return {
    crawlId,
    selection,
    rendered,
    failures,
    unrendered: after.renderPending,
    elapsedMs: Date.now() - started,
  };
}

/**
 * One worker: lease, render, record, repeat until the render frontier is empty.
 *
 * An empty lease ends the worker. There is no "wait and try again": every URL
 * of this pass is already in `render_pending` before the first lease — the
 * selection put it there — so an empty batch means the other workers have taken
 * everything, not that more work is coming.
 */
async function runWorker(
  db: Db,
  crawlId: string,
  workerId: string,
  renderer: PageRenderer,
  signal: AbortSignal | null,
  onResult: (result: RenderResult) => void,
): Promise<void> {
  for (;;) {
    if (signal?.aborted === true) return;

    const leased = await leaseRenderUrls(
      db,
      crawlId,
      workerId,
      1,
      RENDER_PASS_DEFAULTS.leaseSeconds,
    );
    const next = leased[0];
    if (next === undefined) return;

    const result = await renderer.render(next.url);

    // The page row and the frontier completion land together or not at all —
    // the same rule the crawl's write path follows (frontier.completeUrls). A
    // process killed between them would otherwise leave a URL marked `done`
    // whose render nobody recorded, and the next pass would never revisit it.
    await db.transaction(async (tx) => {
      await writeRenderResult(tx, crawlId, result);
      await completeUrls(tx, crawlId, [result.url]);
    });

    onResult(result);
  }
}
