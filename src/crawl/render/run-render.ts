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
 *     and rendering it in a browser context it reuses from URL to URL (cache
 *     kept, cookies and storage cleared — see the renderer). One browser, at
 *     most `renderConcurrency` contexts, no page list in memory beyond the
 *     selection the budget already bounds (rule 6). Paced by a host gate
 *     SEEDED FROM THE CRAWL (Phase 24a §3.4): each host re-enters the render
 *     where the crawl left it — `crawls.host_spacing_jsonb`, its spacing,
 *     ratchet level, recovery count and lock — and every same-origin request
 *     of every page waits for that gate, not only the documents. The base is
 *     the configured delay, never below the crawl's platform profile's
 *     `perHostDelayMs` (`renderPacing`). Because every request waits, the
 *     NAVIGATION BUDGET grows with the spacing: `min(120 s, max(configured,
 *     15 s + 30 × the widest spacing in force at the start of the pass))`,
 *     and a profile's own budget (Shopify 60 s) still applies when it is
 *     larger (`renderNavigationBudgetMs`).
 *  4. **Record.** Every render — successful or failed — is written to its page
 *     row and its frontier row is completed in the SAME transaction, then the
 *     pass writes its count to `crawls.render_pass_count` and the gate's state
 *     back to `crawls.host_spacing_jsonb` (`RenderThrottleWriter`), so a 429 a
 *     theme asset answered during the render is in the crawl's throttle record
 *     and binds the next pass.
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
 * page whose render timed out is a page with `render_error = 'timeout under pacing (…'` and
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
import { isDeepStrictEqual } from "node:util";

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
import {
  PageRenderer,
  RENDERER_DEFAULTS,
  writeRenderResult,
  type RenderResult,
  type UnpinnedHost,
} from "./renderer.js";
import { parseStoredPlatformProfile, type StoredPlatformProfile } from "../platform.js";
import { DEFAULT_MAX_DELAY_MS, HostGate, throttleRecordOf } from "../politeness.js";
import { UrlPolicyError, type AddressResolver } from "../url-policy.js";
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
} as const;

/**
 * What a render may spend AFTER its navigation and settle: the in-page
 * measurement, serialising and analysing the DOM, writing it to disk, clearing
 * the context and the page-row transaction. All ours and all local — seconds
 * at most; 30 s is the allowance, stated rather than folded into a round
 * number.
 */
export const RENDER_POST_SETTLE_ALLOWANCE_MS = 30_000;

/**
 * A render's lease, DERIVED from what one render can take — never a guess.
 *
 * The lease is a crash-resume deadline (frontier module header), and it must
 * outlast the longest render a LIVE worker can be in the middle of: a render
 * whose lease ran out while it was still loading would be re-leased by a
 * sibling worker of the same pass and fetched twice (rule 9). One render is:
 *
 *  1. **The document's gate wait.** The gate caps every spacing and every
 *     `Retry-After` at `DEFAULT_MAX_DELAY_MS` (30 s). The interception claims
 *     at most ONE slot per render at a time (the renderer's `RenderTraffic`),
 *     and a render that has just ended may leave its last claim standing, so
 *     ahead of a document there are at most 2 claims per OTHER worker, its own
 *     worker's leftover one, and one `Retry-After` push: (2W + 1) × 30 s for W
 *     workers, rounded up from 2W.
 *  2. **The navigation budget** — every paced request the document needs
 *     before `domcontentloaded` is inside it (`renderNavigationBudgetMs`:
 *     45 s at the default 1 s spacing, 60 s under a Shopify profile, never
 *     more than 120 s unless a caller configured more).
 *  3. **The settle** (3 s).
 *  4. **`RENDER_POST_SETTLE_ALLOWANCE_MS`.**
 *
 * So four workers at the default 1 s spacing (a 45 s budget): (9 × 30) + 45 +
 * 3 + 30 = 348 s; four at the 120 s cap: 423 s; a Shopify profile's one worker
 * at 60 s: (3 × 30) + 60 + 3 + 30 = 183 s. The 120 s this replaced
 * covered neither the profile's 60 s budget behind a 30 s wait nor four
 * workers queued on one escalated host. The cost of a long lease is only how
 * long a CRASHED worker's URL waits before a re-run may take it.
 */
/** The render navigation budget's floor: a page at zero spacing (`renderNavigationBudgetMs`). */
export const RENDER_BUDGET_BASE_MS = 15_000;
/** Paced requests the budget makes room for: ms of budget per ms of spacing. */
export const RENDER_BUDGET_PER_SPACING = 30;
/** The most the spacing can grow the budget to (a caller's own larger setting stands). */
export const RENDER_BUDGET_CAP_MS = 120_000;

/**
 * The navigation budget of a render pass, from the spacing it renders at.
 *
 * Since Phase 24a EVERY same-origin request a page makes waits for the host
 * gate, not only its document, so a page that needs N scripts before
 * `domcontentloaded` needs about N spacings of budget before it has done
 * anything slow at all. A fixed 15 s made any page needing 15 or more
 * uncached same-origin assets at 1 s spacing a `timeout under pacing` —
 * coverage lost to our own politeness (final review, 24a). So the budget
 * makes room for 30 paced requests on top of
 * the 15 s floor: `min(120 s, max(configured, 15 s + 30 × spacing))` — 45 s
 * at the default 1 s, the 120 s cap from 3.5 s up. The cap binds what the
 * SPACING adds, never a caller's own larger setting: a caller who configured
 * more patience keeps it, as a profile only ever slows the pass down.
 *
 * The cost if this is wrong is the slow direction only: a page that will
 * never load waits longer before it becomes a classified timeout, and the
 * render lease (`renderLeaseSeconds`, derived from this) grows with it.
 */
export function renderNavigationBudgetMs(configuredMs: number, effectiveSpacingMs: number): number {
  const derived = Math.min(
    RENDER_BUDGET_CAP_MS,
    RENDER_BUDGET_BASE_MS + RENDER_BUDGET_PER_SPACING * effectiveSpacingMs,
  );
  return Math.max(configuredMs, derived);
}

/**
 * The widest spacing in force when the pass starts: the gate the renderer
 * will build, built here with the same inputs and read rather than
 * re-derived — `max(base, robots Crawl-delay, crawl-wide earned)` and every
 * host's restored spacing (its base at its ratchet level), capped at 30 s.
 * One policy, in the module that owns spacing. A stored map the gate cannot
 * read throws here, before the frontier is touched (rule 7).
 */
export function renderEffectiveSpacingMs(seed: {
  perHostDelayMs: number;
  robotsCrawlDelaySec: number | null;
  hostSpacingMs: number | null;
  hostSpacingJsonb: unknown;
}): number {
  const gate = new HostGate({
    perHostDelayMs: seed.perHostDelayMs,
    robotsCrawlDelaySec: seed.robotsCrawlDelaySec,
    earnedSpacingMs: seed.hostSpacingMs,
  });
  if (seed.hostSpacingJsonb !== null && seed.hostSpacingJsonb !== undefined) {
    try {
      gate.restore(seed.hostSpacingJsonb);
    } catch (error) {
      throw new Error(
        `runRenderPass: stored host_spacing_jsonb cannot be restored: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return Math.max(gate.effectiveDelayMs(), ...Object.values(gate.maxSpacingMsByHost()));
}

export function renderLeaseSeconds(pacing: {
  renderConcurrency: number;
  navigationTimeoutMs: number;
  settleMs: number;
}): number {
  const gateWaitMs = (2 * pacing.renderConcurrency + 1) * DEFAULT_MAX_DELAY_MS;
  return Math.ceil(
    (gateWaitMs + pacing.navigationTimeoutMs + pacing.settleMs + RENDER_POST_SETTLE_ALLOWANCE_MS) /
      1000,
  );
}

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
  /**
   * TEST ONLY — the resolver the browser's pin approves the origin through
   * (`RendererOptions.resolve`), so a suite can hand the pass a name that
   * resolves nowhere, or a resolver that fails, without touching the network.
   * Never wire it to an API field.
   */
  resolveAddress?: AddressResolver;
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
  /**
   * The pass's same-origin requests, summed over every render: `paced` waited
   * for a gate slot (documents included), `fromCache` were answered by the
   * shared HTTP cache without reaching the site, `unpacedNetwork` reached the
   * site without a slot — a cache hit predicted and missed (at most once per
   * URL, see the renderer's `FreshnessLedger`) or a speculation-rules prefetch
   * (`RenderResult.unpacedNetworkRequests`). Paint-only and third-party
   * requests are never sent and are in none of the three.
   */
  requests: { paced: number; fromCache: number; unpacedNetwork: number };
  /**
   * The spellings of the crawl's origin (`www.` and apex; see the renderer's
   * `originVariants`) whose address could not be approved when the browser
   * launched, each with its reason. The browser cannot reach them for the
   * whole pass, and a page on one is a classified `policy refusal`. Empty
   * when every spelling was approved.
   */
  unpinnedHosts: UnpinnedHost[];
}

/**
 * The sentence `crawls.render_launch_error` records for a pass that could not
 * launch (Phase 25 §5; Talos obligation 6). CLASSIFIED, never the raw error:
 * resolver and transport text, stack traces and local paths travel only on the
 * error the caller rethrows, to the log.
 *
 *  - a `UrlPolicyError` is an address refusal; its message is already bounded
 *    by the 24a redaction (`resolveApprovedAddress`);
 *  - a failed `mkdir` (`stage: "mkdir"`) is the directory;
 *  - anything else, including `HostGate.restore` throwing inside the launch,
 *    is the browser.
 */
export function describeLaunchFailure(
  error: unknown,
  stage: "mkdir" | "launch" = "launch",
): string {
  if (error instanceof UrlPolicyError) {
    return `address refused: ${error.message} (${error.code})`;
  }
  if (stage === "mkdir") return "the render directory could not be created";
  return "the render browser could not be launched";
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
  const { status, hostSpacingMs, hostSpacingJsonb, platformProfile } = await crawlRow(
    db,
    crawlId,
  );
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

  // THE CRAWL'S PLATFORM PROFILE binds the render pass too (Phase 24a §3.1):
  // a site that tolerates one request at a time tolerates one browser at a
  // time, and a slow storefront gets the profile's longer navigation budget
  // rather than a `render_error` for being slow. `min` and `max` against what
  // the caller asked for, so the profile only ever slows the pass down. An
  // opted-out profile (`applied: null`) and a crawl with no platform change
  // nothing. The BASE spacing is floored by the profile's own
  // `perHostDelayMs`: the crawl's per-host state usually carries it already,
  // but a profile is a fact about the site in its own right and the pass does
  // not depend on another column having recorded it. What the crawl EARNED on
  // top of its base is not folded in here — it is the gate's seed (below),
  // where it keeps its ratchet level instead of being flattened into a base
  // that a recovery could never step down from (and that the restored level
  // would then double again).
  //
  // THE NAVIGATION BUDGET is set here too, for EVERY pass, profiled or not:
  // every same-origin request waits for the gate, so the budget grows with
  // the spacing the pass starts at (`renderNavigationBudgetMs`), and the
  // lease below is derived from it.
  const profiled = renderPacing(
    {
      renderConcurrency: concurrency,
      navigationTimeoutMs: cfg.navigationTimeoutMs ?? RENDERER_DEFAULTS.navigationTimeoutMs,
      perHostDelayMs: cfg.perHostDelayMs,
    },
    platformProfile,
    {
      robotsCrawlDelaySec: cfg.robotsCrawlDelaySec ?? null,
      hostSpacingMs,
      hostSpacingJsonb,
    },
  );
  const settleMs = cfg.settleMs ?? RENDERER_DEFAULTS.settleMs;
  const leaseSeconds = renderLeaseSeconds({
    renderConcurrency: profiled.renderConcurrency,
    navigationTimeoutMs: profiled.navigationTimeoutMs,
    settleMs,
  });

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
  // A pass that cannot launch is RECORDED on the crawl (Phase 25 §5): the
  // selected rows stay `render_pending` so a later pass retries them, and
  // `crawls.render_launch_error` carries a classified, tenant-safe reason that
  // `render.coverage` reads as `failed`. The ORIGINAL error is rethrown
  // unchanged — the API's 409/500 mapping and the log still see the raw text.
  // A launch that succeeds clears a reason an earlier pass left.
  let renderer: PageRenderer;
  let launchStage: "mkdir" | "launch" = "mkdir";
  try {
    await mkdir(htmlDir, { recursive: true });
    launchStage = "launch";
    renderer = await PageRenderer.launch({
      origin: new URL(cfg.siteUrl).origin,
      htmlDir,
      userAgent: cfg.userAgent,
      perHostDelayMs: profiled.perHostDelayMs,
      robotsCrawlDelaySec: cfg.robotsCrawlDelaySec ?? null,
      // WHAT THE CRAWL EARNED, which a later pass has no right to forget (rule
      // 9): the first real-site gate crawl escalated 1000 → 2000 ms and the
      // render pass that followed went straight back to 1000 ms with the answer
      // sitting in the database. The per-host state is restored into the gate
      // as it stands — spacing, ratchet level, recovery count, lock — and the
      // crawl-wide `host_spacing_ms` covers a host the map does not name (a
      // pre-0015 crawl has no map at all). `HostGate.restore` throws on a map it
      // cannot read, and so does the launch.
      earnedSpacingMs: hostSpacingMs,
      hostSpacing: hostSpacingJsonb,
      navigationTimeoutMs: profiled.navigationTimeoutMs,
      settleMs,
      allowPrivate: cfg.allowPrivate === true,
      ...(cfg.resolveAddress === undefined ? {} : { resolve: cfg.resolveAddress }),
      ...(opts.onRequestBlocked === undefined
        ? {}
        : { onRequestBlocked: opts.onRequestBlocked }),
    });
  } catch (error) {
    try {
      await db
        .update(crawls)
        .set({ renderLaunchError: describeLaunchFailure(error, launchStage) })
        .where(eq(crawls.id, crawlId));
    } catch (writeError) {
      // Loud, and the true cause survives: both errors surface together.
      throw new AggregateError(
        [error, writeError],
        "runRenderPass: the render launch failed and the failure could not be recorded on the crawl either",
      );
    }
    throw error;
  }

  let rendered = 0;
  let failures = 0;
  const requests = { paced: 0, fromCache: 0, unpacedNetwork: 0 };
  const workerIds: string[] = [];
  const throttle = new RenderThrottleWriter(db, crawlId, hostSpacingJsonb, renderer);

  try {
    // The browser is up: clear a reason an earlier pass left. Inside the try so
    // a failed write still closes the renderer.
    await db.update(crawls).set({ renderLaunchError: null }).where(eq(crawls.id, crawlId));
    // STEP 3. `profiled.renderConcurrency` workers, each leasing one URL at a
    // time. One at a time rather than a batch: a batch leased and then rendered serially holds
    // its last URL's lease for the whole batch, and a worker that dies loses
    // the whole batch to a lease expiry instead of one URL.
    const workers = Array.from({ length: profiled.renderConcurrency }, (_, i) => {
      const workerId = `render_${crawlId}_${i}`;
      workerIds.push(workerId);
      return runWorker(
        db,
        crawlId,
        workerId,
        renderer,
        leaseSeconds,
        opts.signal ?? null,
        () => throttle.checkpoint(),
        (result) => {
          if (result.rendered) rendered += 1;
          else failures += 1;
          requests.paced += result.pacedRequests;
          requests.fromCache += result.cachedResponses;
          requests.unpacedNetwork += result.unpacedNetworkRequests;
        },
      );
    });
    try {
      await Promise.all(workers);
    } catch (error) {
      // The pass is stopping on a defect of ours, but the requests it already
      // made were made: what the site answered them is crawl evidence, and a
      // host it escalated must not be forgotten by the next pass (rule 9). If
      // that write fails too, both errors surface.
      try {
        await throttle.final();
      } catch (writeError) {
        throw new AggregateError(
          [error, writeError],
          "runRenderPass: the pass failed and its throttle record could not be written either",
        );
      }
      throw error;
    }
    await throttle.final();
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
    requests,
    unpinnedHosts: renderer.unpinnedHosts(),
  };
}

/**
 * Write the render gate's per-host state back over the crawl's, so the
 * render's own answers count (Phase 24a §3.4.5): a 429 on a theme script is in
 * `crawl_status.throttle`, and the escalation it caused binds the next pass.
 *
 * The gate was restored FROM this column, so its snapshot is the crawl's record
 * plus what the render added — counters, escalations, recoveries, lock — not a
 * replacement of it. `host_spacing_ms` is rewritten from the same gate
 * (`maxSpacingMs`, which starts at the restored peak), the pair the crawl loop
 * always writes together.
 *
 * WHEN. After every render whose answers MOVED a host's spacing (the gate's
 * `spacingGeneration`, the crawl loop's own trigger), so a pass that dies
 * mid-way keeps every escalation it caused; and once at the end of the pass,
 * whatever moved, so counters that moved without the spacing (a `Retry-After`
 * that escalated nothing) land too. Writes are serialised.
 *
 * COMPARE-AND-SET. Each write names the value it replaces (`where
 * host_spacing_jsonb = <what we last read or wrote>`). Zero rows updated means
 * somebody else wrote the column under this pass — a resumed crawl, another
 * writer — and overwriting their record with ours would silently lose one of
 * the two. It throws instead, naming the crawl (rule 7).
 *
 * ONLY OVER A 24a RECORD. A NULL column (pre-0015, or a crawl that never wrote
 * one) and a pre-24a `{host: ms}` map are left exactly as they are: the crawl
 * counted nothing on them, `crawl_status.throttle` says so with `null`, and a
 * record written now would present the render's counters as the crawl's — a
 * record of zeros for a crawl that was never counted (rule 7; Task 2's
 * contract). Such a crawl's render escalations end with the pass.
 */
class RenderThrottleWriter {
  private readonly enabled: boolean;
  private last: unknown;
  private lastGeneration: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly crawlId: string,
    stored: unknown,
    private readonly renderer: PageRenderer,
  ) {
    this.enabled = stored !== null && throttleRecordOf(stored) !== null;
    this.last = stored;
    this.lastGeneration = renderer.spacingGeneration();
  }

  /** After a render: write if any host's spacing moved since the last write. */
  checkpoint(): Promise<void> {
    return this.enqueue(() => this.renderer.spacingGeneration() !== this.lastGeneration);
  }

  /** At the end of the pass: write if anything at all differs from the last write. */
  final(): Promise<void> {
    return this.enqueue(
      // Semantically: the stored value came back from jsonb, whose key order
      // is not ours, so a string comparison would see changes that are not.
      () => !isDeepStrictEqual(this.renderer.throttleSnapshot(), this.last),
    );
  }

  /** The write that failed, once one has: it is already on its way up. */
  private failed: unknown = null;

  private enqueue(due: () => boolean): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    // One failed write is the pass's error; a second attempt at the end would
    // only bury it under an AggregateError saying the same thing twice.
    if (this.failed !== null) return Promise.resolve();
    this.chain = this.chain.then(async () => {
      if (!due()) return;
      const generation = this.renderer.spacingGeneration();
      const snapshot = this.renderer.throttleSnapshot();
      const res = await this.db.execute(sql`
        update crawls set
          host_spacing_jsonb = ${JSON.stringify(snapshot)}::jsonb,
          host_spacing_ms = ${this.renderer.maxSpacingMs()}
        where id = ${this.crawlId}
          and host_spacing_jsonb = ${JSON.stringify(this.last)}::jsonb
        returning id`);
      if (res.rows.length !== 1) {
        throw new Error(
          `runRenderPass: crawl ${this.crawlId}'s host_spacing_jsonb changed under the render ` +
            `pass (${res.rows.length} rows matched the value it last read) — another writer ` +
            "holds this crawl's throttle record, and overwriting it would lose one of the two",
        );
      }
      this.last = snapshot;
      this.lastGeneration = generation;
    });
    this.chain = this.chain.catch((error: unknown) => {
      this.failed = error;
      throw error;
    });
    return this.chain;
  }
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
): Promise<{
  status: string;
  hostSpacingMs: number | null;
  hostSpacingJsonb: unknown;
  platformProfile: StoredPlatformProfile | null;
}> {
  const rows = await db
    .select({
      status: crawls.status,
      hostSpacingMs: crawls.hostSpacingMs,
      hostSpacingJsonb: crawls.hostSpacingJsonb,
      platformProfile: crawls.platformProfile,
    })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new RenderPassRefusal(`runRenderPass: no such crawl '${crawlId}'`, "missing");
  }
  return {
    status: row.status,
    hostSpacingMs: row.hostSpacingMs,
    hostSpacingJsonb: row.hostSpacingJsonb,
    // Validated, not trusted: a profile we cannot read throws (rule 7) rather
    // than rendering a Shopify store with four browsers.
    platformProfile: parseStoredPlatformProfile(row.platformProfile, crawlId),
  };
}

export interface RenderPacing {
  renderConcurrency: number;
  navigationTimeoutMs: number;
  perHostDelayMs: number;
}

/** What the crawl left behind that the render's spacing starts from. */
export interface RenderSpacingSeed {
  robotsCrawlDelaySec: number | null;
  hostSpacingMs: number | null;
  hostSpacingJsonb: unknown;
}

const NO_SEED: RenderSpacingSeed = {
  robotsCrawlDelaySec: null,
  hostSpacingMs: null,
  hostSpacingJsonb: null,
};

/**
 * The render pass's concurrency, navigation budget and spacing once the
 * crawl's platform profile has had its say: `min(asked, profile)` contexts,
 * `max(asked, profile)` ms between two hits on the host, and a navigation
 * budget that grows with the spacing the pass starts at
 * (`renderNavigationBudgetMs` over `renderEffectiveSpacingMs`), never below
 * the profile's own. Exported for its unit test.
 */
export function renderPacing(
  asked: RenderPacing,
  profile: StoredPlatformProfile | null,
  seed: RenderSpacingSeed = NO_SEED,
): RenderPacing {
  const applied = profile?.applied ?? null;
  const perHostDelayMs =
    applied === null ? asked.perHostDelayMs : Math.max(asked.perHostDelayMs, applied.perHostDelayMs);
  const budget = renderNavigationBudgetMs(
    asked.navigationTimeoutMs,
    renderEffectiveSpacingMs({ perHostDelayMs, ...seed }),
  );
  return {
    renderConcurrency:
      applied === null
        ? asked.renderConcurrency
        : Math.min(asked.renderConcurrency, applied.renderConcurrency),
    navigationTimeoutMs:
      applied === null ? budget : Math.max(budget, applied.navigationTimeoutMs),
    perHostDelayMs,
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
  leaseSeconds: number,
  signal: AbortSignal | null,
  checkpoint: () => Promise<void>,
  onResult: (result: RenderResult) => void,
): Promise<void> {
  for (;;) {
    if (signal?.aborted === true) return;

    const leased = await leaseRenderUrls(
      db,
      crawlId,
      workerId,
      1,
      leaseSeconds,
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
    // The gate's state, on the crawl row, as soon as a render moved it — so a
    // pass that dies before its end keeps every escalation it caused.
    await checkpoint();
  }
}
