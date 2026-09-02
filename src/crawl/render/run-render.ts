/**
 * The render pass: the second pass over a finished crawl.
 *
 * It does four things in order, and the order is the design.
 *
 *  1. **Refuse to run unless this crawl is finished and unattended.**
 *     `selectRenderSet` upserts frontier rows into `render_pending` and demotes
 *     the ones it does not name, and it is allowed to assume nobody else is
 *     touching them. Three ways that can be false, each thrown with its own
 *     message: a crawl worker holding leases (`leased > 0`), ANOTHER RENDER
 *     PASS holding render leases (`render_pending` with a live `leased_until` —
 *     invisible to `leased`, because a render lease does not change state), and
 *     a crawl whose row still says `running` (live, or dead mid-run and never
 *     resumed). A skip would be the silent fallback (rule 7) that lets two
 *     passes corrupt each other quietly.
 *
 *     NOT a condition: a frontier with `pending` rows in it. A crawl that hit
 *     `maxPages` is finished by definition and leaves its queue behind, which
 *     on a real site is the normal outcome — refusing it would refuse most
 *     crawls there are.
 *  2. **Select.** One statement chooses the set and puts it in the frontier
 *     (src/crawl/render/select.ts).
 *  3. **Render.** `renderConcurrency` workers, each leasing ONE URL at a time
 *     and rendering it in its own browser context. One browser, at most
 *     `renderConcurrency` contexts, no page list in memory beyond the
 *     selection the budget already bounds (rule 6). Paced at
 *     `renderPaceMs(cfg.perHostDelayMs, crawls.host_spacing_ms)` — the crawl's
 *     configured delay OR the wider one its ratchet earned, whichever is
 *     larger; see that function.
 *  4. **Record.** Every render — successful or failed — is written to its page
 *     row and its frontier row is completed in the SAME transaction, then the
 *     pass writes its count to `crawls.render_pass_count`.
 *
 * AND ONE THING THAT IS NOT A STEP: the pass creates `<renderHtmlDir>/<crawlId>/`
 * between steps 2 and 3, because from Phase 8 the renderer writes each
 * serialised post-JavaScript document there (src/crawl/render/renderer.ts). The
 * directory is made once, here, before the browser launches — a permission or a
 * disk problem is then one error at the top of the pass instead of one
 * classified `render_error` per page saying the same thing.
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
 *
 * ONE THING THE RECOMPUTATION CANNOT SEE, and therefore the one thing this pass
 * does persist about its selection: whether the selection was made
 * automatically at all. From Phase 8 a caller may NAME the pages, and a named
 * list is an input no column of `pages` records. It is written to
 * `crawls.render_urls_jsonb` — its own column since migration 0012 — see
 * `recordRenderSelection`.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import {
  completeUrls,
  frontierCounts,
  heldRenderLeases,
  leaseRenderUrls,
  releaseRenderLeases,
} from "../frontier.js";
import { PageRenderer, writeRenderResult, type RenderResult } from "./renderer.js";
import {
  selectExplicitRenderSet,
  selectRenderSet,
  type RenderSelection,
  type RenderSelectionConfig,
} from "./select.js";

/**
 * A render pass REFUSED, as opposed to a render pass that broke.
 *
 * The four guards below are decisions: the crawl is live, another pass holds
 * it, it has not started, it does not exist. They are all recoverable by the
 * caller — wait, resume, mark failed, use a different id — and a transport over
 * this module needs to say so with a 409 or a 404 rather than with a 500.
 *
 * A DEFECT IS NOT ONE OF THESE and must never be typed as one. The
 * `renderConcurrency` `RangeError` below, a failed write, a browser that would
 * not launch: those stay plain errors, and a transport that turns them into a
 * client-facing refusal is telling the caller to retry something that is our
 * bug. That distinction used to be made by matching on the message prefix, and
 * the `RangeError` — whose message also starts `runRenderPass: ` — walked
 * straight through it. This type exists so the distinction is carried by the
 * throw itself.
 */
export class RenderPassRefusal extends Error {
  constructor(
    message: string,
    /**
     * `live` — the crawl exists and may not be rendered right now.
     * `missing` — there is no such crawl. Separated because they are different
     * answers (409 vs 404), not different wordings of one.
     */
    readonly reason: "live" | "missing",
  ) {
    super(message);
    this.name = "RenderPassRefusal";
  }
}

/**
 * Where a crawl's serialised post-JavaScript documents go, relative to the
 * process's working directory unless a caller names an absolute path.
 *
 * One directory per crawl underneath it (`<root>/<crawlId>/`), because a crawl
 * is the unit a reader deletes, archives or hands to somebody: a flat directory
 * of hashes from every crawl this machine ever ran is not evidence anybody can
 * use. Git-ignored — see .gitignore — and its disk cost belongs in the gate
 * document, not in a silent assumption that a laptop has room.
 */
export const RENDER_HTML_DIR = "renders";

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
  /**
   * Root directory for this pass's serialised documents; defaults to
   * `RENDER_HTML_DIR`. The pass creates `<root>/<crawlId>/` itself, before the
   * browser launches, so a permission or disk problem is one error at the top
   * of the pass rather than seventy identical ones inside it.
   */
  renderHtmlDir?: string;
  /**
   * The pages a caller NAMED, in place of the automatic selection.
   *
   * Absent (or undefined) is the default and the only behaviour that existed
   * before Phase 8: the pass selects for itself. Present, it must be a list of
   * URLs that are already pages of this crawl, already validated by whoever
   * accepted them — see `selectExplicitRenderSet`, which states what it refuses
   * to guess and what belongs to the transport.
   *
   * A list REPLACES the automatic selection for this pass rather than adding to
   * it, and the pass around it is byte-identical either way: the same three
   * refusals, the same pacing, the same earned spacing, the same evidence.
   */
  renderUrls?: readonly string[];
  /** TEST ONLY — the fixture-server escape hatch. See `CrawlConfig`. */
  allowPrivate?: boolean;
}

/**
 * The spacing the render pass paces at: the wider of what the caller
 * CONFIGURED and what the crawl EARNED.
 *
 * `crawls.host_spacing_ms` is the base delay the crawl's adaptive back-off
 * ratcheted to before it finished (src/crawl/loop.ts) — it is not a setting,
 * it is a finding, written because the site pushed back and the engine listened.
 * The render pass hits the same host minutes later, and taking its pace from
 * `cfg.perHostDelayMs` alone would throw that finding away: the first real-site
 * gate crawl escalated 1000 → 2000 ms and the render pass that followed went
 * straight back to 1000 ms with the answer sitting in the database. **A later
 * pass has no right to forget spacing the site's own responses taught us**
 * (rule 9).
 *
 * `max`, not "replace": a caller who deliberately asks for a wider delay than
 * the crawl earned keeps it, and a crawl that never escalated (`null`, or a
 * spacing at or below the configured one) changes nothing.
 *
 * CRAWL-WIDE ON PURPOSE, not per-host. Migration 0015 gave the crawl loop a
 * per-host earned map (`crawls.host_spacing_jsonb`) so a resume re-enters each
 * host at its own spacing rather than the crawl-wide widest — and the render
 * pass deliberately does NOT read it. The pass renders pages of the crawl, which
 * are same-origin by construction (the crawl only enqueues same-origin URLs), so
 * its workload is effectively one host and per-host fidelity would change
 * nothing; and `PageRenderer` takes a single `perHostDelayMs` scalar, not a
 * per-host gate seeded from a map. The crawl-wide widest is the polite direction
 * over that small, explicit set — the over-politeness cost is bounded by the
 * selection — so this stays one number (P13-T3).
 */
export function renderPaceMs(configuredMs: number, earnedMs: number | null): number {
  return Math.max(configuredMs, earnedMs ?? 0);
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
 * Throws — loudly, before touching the frontier — if the crawl is still live,
 * held by another pass, not started, or absent. Those four are
 * `RenderPassRefusal`s and are the caller's to act on. Everything else it
 * throws is a defect of ours (the `RangeError` below, a failed write, a browser
 * that would not launch) and stays a plain error, so a transport can tell them
 * apart without reading messages. Everything a *site* does comes back as a
 * classified `render_error` rather than as a throw at all.
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
    // DELIBERATELY NOT A `RenderPassRefusal`. A caller that asked for zero
    // browser contexts has a bug, and telling them "wait and try again" — which
    // is what a refusal means — would be the wrong advice. See the class.
    throw new RangeError(
      `runRenderPass: renderConcurrency must be an integer ≥ 1, got ${concurrency}`,
    );
  }

  // STEP 1. NOBODY ELSE MAY BE WORKING THIS CRAWL. `selectRenderSet` promotes
  // rows into `render_pending` and demotes the ones it does not name, in one
  // statement, and it is allowed to assume it is alone (see its header). Three
  // separate ways that assumption can be false, each with its own message —
  // "someone else is here" is not an actionable error, "a crawl worker holds 4
  // URLs" is. Nothing is written before all three pass.
  const before = await frontierCounts(db, crawlId);
  if (before.leased > 0) {
    throw new RenderPassRefusal(
      `runRenderPass: crawl ${crawlId} has ${before.leased} leased URL(s) — the render ` +
        `pass may not run over a live crawl (it would steal the crawler's rows). ` +
        `Wait for the crawl to finish, or release its leases if its workers are known dead.`,
      "live",
    );
  }
  // A render lease leaves the row's state at `render_pending`, so it is
  // invisible to the check above and to `frontierCounts` alike — a concurrent
  // render pass is the ONE conflict neither of them can see. Its rows would be
  // demoted to `done` by our selection while its workers went on rendering and
  // completing them.
  const heldRenders = await heldRenderLeases(db, crawlId);
  if (heldRenders > 0) {
    throw new RenderPassRefusal(
      `runRenderPass: crawl ${crawlId} has ${heldRenders} render URL(s) leased by another ` +
        `render pass — two passes may not share a crawl (this one's selection would ` +
        `demote rows that one is rendering). Wait for it, or call releaseRenderLeases ` +
        `if its worker is known dead.`,
      "live",
    );
  }
  // And the crawl must have STOPPED. Not "must have drained": a crawl that hit
  // `maxPages` is `finished` with a frontier full of `pending` rows by design,
  // and on a real site that is the normal outcome, so refusing a queued
  // frontier would refuse most crawls there are. What is actually unsafe is a
  // crawl whose row still says `running` — either a live one between leases
  // (its next `leaseBatch` is coming for rows we would have promoted) or one
  // that died mid-run and was never resumed or marked failed. Both leave a
  // frontier in flight; `finished`, `cancelled` and `failed` do not.
  const { status, hostSpacingMs } = await crawlRow(db, crawlId);
  // A crawl that has not started yet is unsafe for the same reason a live one
  // is, one step earlier: `queued` is the API queue's accepted-but-not-yet-run
  // state (src/api/service.ts), and the worker that picks it up will seed a
  // frontier straight over the rows this pass promoted. It is also empty, so
  // there is nothing to render — but "nothing selected" is the wrong answer to
  // give for it, because it reads like a crawl with no suspects.
  if (status === "queued") {
    throw new RenderPassRefusal(
      `runRenderPass: crawl ${crawlId} is 'queued' — it has not run yet, so there is ` +
        `nothing to render, and the worker that dequeues it would seed a frontier over ` +
        `this pass's selection. Wait for it to finish.`,
      "live",
    );
  }
  if (status === "running") {
    throw new RenderPassRefusal(
      `runRenderPass: crawl ${crawlId} is still marked 'running' — the render pass may ` +
        `not run over a crawl that has not stopped (a live worker's next lease would ` +
        `take rows this pass promoted, and a crashed crawl's frontier is mid-flight). ` +
        `Resume it to completion, or mark it failed or cancelled first.`,
      "live",
    );
  }

  // STEP 2. Choose the set. After this statement the frontier is the selection
  // — either the automatic one, or the list the caller named, which REPLACES it
  // (see selectExplicitRenderSet).
  //
  // The selection and the record of HOW it was made are written in one
  // transaction, because a reader a week later has only the record:
  // `render.coverage` recomputes the automatic decision from SQL and, without
  // this, could not tell "the automatic selection chose these twelve pages"
  // from "an agent named twelve pages". See `recordRenderSelection`.
  const named = cfg.renderUrls;
  const selection = await db.transaction(async (tx) => {
    const chosen =
      named === undefined
        ? await selectRenderSet(tx, crawlId, cfg)
        : await selectExplicitRenderSet(tx, crawlId, named);
    await recordRenderSelection(tx, crawlId, named ?? null);
    return chosen;
  });

  // …and make the place this pass's evidence goes, ONCE, before the browser
  // exists. `recursive` so a first-ever pass creates the root too, and so a
  // re-run over a crawl that already has a directory is not an error: a
  // re-selected crawl legitimately re-renders pages, and the file it overwrites
  // is the same page's older document.
  //
  // `resolve`, NOT `join`: the path this produces is written into
  // `pages.rendered_html_path` and read back by a person, days later, from a
  // different working directory. A relative pointer stored in a database is a
  // pointer whose meaning depends on where the reader happens to be standing —
  // it is only interpretable beside the cwd of the process that wrote it, which
  // nothing records. Absolutising here means the default `renders/` is still
  // "under wherever the server runs" and the STORED value still says where that
  // was.
  const htmlDir = resolve(cfg.renderHtmlDir ?? RENDER_HTML_DIR, crawlId);
  await mkdir(htmlDir, { recursive: true });

  const renderer = await PageRenderer.launch({
    origin: new URL(cfg.siteUrl).origin,
    htmlDir,
    userAgent: cfg.userAgent,
    // NOT `cfg.perHostDelayMs`. The crawl's ratchet may have earned a wider
    // spacing than the config asked for, and that lesson is the site's, not
    // ours to discard between passes — see `renderPaceMs`.
    perHostDelayMs: renderPaceMs(cfg.perHostDelayMs, hostSpacingMs),
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
 * Record WHICH INPUT this pass's selection was made from: the caller's URL
 * list, or `null` for the automatic selection.
 *
 * ## Why this is written at all
 *
 * `render.coverage` describes the selection long after the pass is over, and it
 * does so by RECOMPUTING the automatic decision from the crawl's columns (see
 * that rule's header for why recomputation is sound). Recomputation cannot see
 * a list somebody named. Without this record the metric would describe an
 * automatic selection that never ran, on a crawl whose render set was chosen by
 * hand — a wrong answer delivered as a table of numbers, which is the worst
 * shape a wrong answer can take.
 *
 * ## Where it lives, and where it used to
 *
 * `crawls.render_urls_jsonb`, its own column since migration 0012. Through
 * Phase 8 it lived under a `renderUrls` key inside `config_jsonb` beside the
 * three render knobs `render.coverage` reads from there — defensible, because
 * an explicit URL list IS an input of the same pass, and argued at length
 * rather than assumed. What it cost was a second writer on a blob
 * `storableConfig` was the sole author of, and a standing "patch keys
 * individually, never rewrite the config" rule that every future writer had to
 * know. 0012 paid that debt (docs/gates/phase-8.md §15) and backfilled the key
 * out; `config_jsonb` has one writer again and this is a plain column write.
 *
 * Nothing about the OUTCOME is recorded here — not what rendered, not what
 * failed, not how long it took. Those are page rows and `render_pass_count`.
 * This column says WHO CHOSE the pages and nothing else, because the
 * alternative — deriving the mode from the evidence — is unsound in a way that
 * is easy to miss: an automatic pass renders only candidates, so a rendered
 * non-candidate would prove an explicit list, but an explicit list that happens
 * to name only candidates would be indistinguishable from an automatic one. A
 * guess that is right most of the time is exactly what hard rule 7 forbids.
 *
 * ## Why an automatic pass writes NULL rather than leaving the column alone
 *
 * Because a crawl rendered from a list and then rendered automatically must
 * stop saying "explicit". Every pass overwrites the record, so it always
 * describes the LAST selection — which is the only selection the frontier and
 * the page rows describe either. NULL therefore means "not chosen by hand":
 * the last pass selected automatically, or no pass has run at all. Those two
 * are not distinguished here and do not need to be — `render_pass_count` says
 * whether a pass ran, this says who chose the pages.
 */
async function recordRenderSelection(
  db: Pick<Db, "update">,
  crawlId: string,
  urls: readonly string[] | null,
): Promise<void> {
  await db
    .update(crawls)
    .set({ renderUrlsJsonb: urls === null ? null : [...urls] })
    .where(eq(crawls.id, crawlId));
}

/**
 * The two things this pass needs from the crawl row: its own verdict on whether
 * it is still going, and the spacing its back-off ended up at.
 *
 * One read for both, because both are decisions taken before the browser
 * launches and a second round trip would only invite them to disagree.
 *
 * A missing row throws here rather than being read as "not running": a render
 * pass over a crawl that does not exist is a caller bug, and `selectRenderSet`
 * would only discover it one statement later (rule 7).
 */
async function crawlRow(
  db: Db,
  crawlId: string,
): Promise<{ status: string; hostSpacingMs: number | null }> {
  const rows = await db
    .select({ status: crawls.status, hostSpacingMs: crawls.hostSpacingMs })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new RenderPassRefusal(`runRenderPass: no such crawl '${crawlId}'`, "missing");
  }
  return row;
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
