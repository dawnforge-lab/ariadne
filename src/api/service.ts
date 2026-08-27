/**
 * The service layer: every question the agent surface can ask, answered once.
 *
 * This module is transport-neutral by construction — plain arguments in, plain
 * data out, typed errors — because it has two callers. `src/api/http.ts` is
 * routing and serialisation over it; `src/api/mcp.ts` (Task 4) will be a second
 * transport over the SAME functions, not over the HTTP routes. Nothing here
 * knows about status codes, headers, JSON text or MCP tool shapes: it raises
 * `ServiceError` with a code, and each transport maps that code to whatever its
 * protocol calls a refusal.
 *
 * It is also the only place in the API layer where SQL lives (the plan's rule).
 * A route that needs a number asks a method here; it does not reach for a table.
 *
 * ## The crawl queue, and what a restart means
 *
 * A crawl is started by `POST /crawls`, which must answer immediately with an
 * id — so the `crawls` row is created **when the crawl is accepted**, in status
 * `queued`, and the run happens later. One crawl runs at a time per server
 * process; the rest wait in FIFO order.
 *
 * The queue is crawl-row-backed (Talos obligation 3: crawl rows are the
 * isolation unit, nothing assumes "the one current crawl"). The row carries the
 * site, the config and the ruleset stamp from the moment of acceptance, so a
 * queued crawl is durable, listable and inspectable exactly like a running one.
 * What is held in memory is only this process's *intent*: an ordered list of
 * ids it means to run.
 *
 * **Restart behaviour, stated rather than discovered.** A server that dies with
 * work queued leaves `queued` rows behind. This server does NOT adopt them at
 * boot, and the reason is not caution about our own state — it is that another
 * engine process may be running that very crawl right now (multi-instance is
 * the deployment obligation 3 anticipates), and a boot-time sweep cannot tell
 * "my orphan" from "someone else's live work". So:
 *
 *  - the work is **not silently lost**: the row stands, with its config, in
 *    status `queued`, and `GET /crawls` lists it;
 *  - it is **not silently started**: only crawls enqueued by THIS process are
 *    ever run by it;
 *  - and the difference is **visible**: `queuePosition` is a number for a crawl
 *    this process is holding and `null` for a queued row nobody is holding. A
 *    caller that finds `status: "queued"` with `queuePosition: null` is looking
 *    at abandoned work and can re-submit it.
 *
 * A crawl left `running` by a killed process is the other half of the same
 * story, and it already had an answer: `markCrawlFailed`, whose lease test is
 * the same one the render driver uses to tell a live crawl from a dead one.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls, frontier } from "../db/schema.js";
import {
  CRAWL_DEFAULTS,
  parseStoredConfig,
  resumeCrawl,
  storableConfig,
  validateCrawlConfig,
  type CrawlConfig,
} from "../crawl/loop.js";
import { frontierCounts, type FrontierCounts } from "../crawl/frontier.js";
import {
  RenderPassRefusal,
  runRenderPass,
  type RenderPassSummary,
} from "../crawl/render/run-render.js";
import { hostProbeStarts, normalizeUrl } from "../crawl/parse/url-utils.js";
import { isUrlAllowed } from "../crawl/url-policy.js";
import { buildRegistry } from "../rules/index.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import { runRules, type RunSummary } from "../rules/run.js";
import { isHostAllowed, type ApiServerConfig } from "./config.js";

/**
 * The four ways a request can be refused for a reason the caller can act on.
 * A transport maps these; nothing else in this module knows they become 400,
 * 403, 404 and 409.
 */
export type ServiceErrorCode = "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

/**
 * A refusal with a reason the caller may be shown.
 *
 * Every message raised as a `ServiceError` is tenant-safe by construction: it
 * is built from crawl ids, field names, statuses, counts and URL-policy reasons
 * — never from a stack, a file path or an internal hostname (Talos obligation
 * 6). Anything that is NOT a `ServiceError` is a defect, and the transport
 * turns it into a 500 with a correlation id, keeping the detail in the log.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * The crawl budget a request that does not name one gets.
 *
 * `CRAWL_DEFAULTS` deliberately has no `maxPages` — the crawl loop refuses to
 * invent a budget, because a budget is a politeness decision (rule 9). The API
 * has to have an answer anyway, and "unbounded" is the one answer that must not
 * be it: an agent that forgets the field would otherwise crawl a 400k-page site
 * to the end. 500 is a first look at a site, and a caller who wants more says
 * so in the request.
 */
export const API_CRAWL_DEFAULTS = { maxPages: 500 } as const;

/** Rows per page when the caller does not say, and the ceiling when they do. */
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

/**
 * The crawl-start body, after validation. Every field except `siteUrl` is an
 * override of a default; the set is closed (see `parseStartCrawlInput`).
 */
export interface StartCrawlInput {
  siteUrl: string;
  maxPages?: number;
  maxDepth?: number;
  userAgent?: string;
  perHostDelayMs?: number;
  maxConcurrency?: number;
  probeHosts?: boolean;
  legacyHosts?: string[];
  renderBudgetPct?: number;
  renderMaxPages?: number;
  renderSamplePerType?: number;
}

type FieldKind = "string" | "number" | "boolean" | "string[]";

/**
 * The wire's whole vocabulary for starting a crawl.
 *
 * A closed table rather than a cast: a body is validated field by field and an
 * unknown key is a 400 naming it. The alternative — spreading the body into a
 * config and letting the extra keys ride along — is how a field that was never
 * meant to cross the wire crosses it, which is precisely the failure
 * `allowPrivate` demonstrates below.
 */
const START_CRAWL_FIELDS: Record<keyof StartCrawlInput, FieldKind> = {
  siteUrl: "string",
  maxPages: "number",
  maxDepth: "number",
  userAgent: "string",
  perHostDelayMs: "number",
  maxConcurrency: "number",
  probeHosts: "boolean",
  legacyHosts: "string[]",
  renderBudgetPct: "number",
  renderMaxPages: "number",
  renderSamplePerType: "number",
};

/**
 * Validate a crawl-start body. Never casts, never ignores a field it does not
 * know, and never accepts `allowPrivate` at any value.
 *
 * Shared by both transports on purpose: the MCP server's `crawl_start` gets the
 * same field allowlist and the same refusals as the HTTP route, because the
 * argument that a test-only escape hatch must not be reachable from outside the
 * process does not weaken when the caller is on stdio.
 */
export function parseStartCrawlInput(raw: unknown): StartCrawlInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError("VALIDATION", "request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  // Named before the unknown-field loop so the refusal says WHY rather than
  // "unknown field": a caller sending this has read about the flag somewhere
  // and needs to be told it is not an API field at all, at any value.
  if ("allowPrivate" in body) {
    throw new ServiceError(
      "VALIDATION",
      "allowPrivate is not accepted over the API at any value: it is a test-only " +
        "escape hatch that admits loopback and private targets, it is never persisted " +
        "on a crawl row, and it can only be set by the process that constructs the " +
        "server",
    );
  }

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const kind = START_CRAWL_FIELDS[key as keyof StartCrawlInput];
    if (kind === undefined) {
      throw new ServiceError(
        "VALIDATION",
        `unknown field '${clip(key)}' (accepted: ${Object.keys(START_CRAWL_FIELDS).join(", ")})`,
      );
    }
    if (value === undefined) continue;
    assertKind(key, value, kind);
    input[key] = value;
  }

  if (typeof input["siteUrl"] !== "string" || input["siteUrl"].trim() === "") {
    throw new ServiceError("VALIDATION", "siteUrl is required and must be a non-empty string");
  }
  return input as unknown as StartCrawlInput;
}

function assertKind(key: string, value: unknown, kind: FieldKind): void {
  const bad = (expected: string): never => {
    throw new ServiceError("VALIDATION", `field '${key}' must be ${expected}`);
  };
  switch (kind) {
    case "string":
      if (typeof value !== "string") bad("a string");
      return;
    case "number":
      // A number that is not finite is not a number a config can use, and
      // JSON.parse produces no NaN — so this only ever catches a caller who
      // sent a string. Naming the type beats a RangeError three layers down.
      if (typeof value !== "number" || !Number.isFinite(value)) bad("a finite number");
      return;
    case "boolean":
      if (typeof value !== "boolean") bad("a boolean");
      return;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        bad("an array of strings");
      }
      return;
  }
}

/** What `POST /crawls` (and `crawl_start`) answers with. */
export interface CrawlAccepted {
  crawlId: string;
  /** The row's status at acceptance. Always `queued`; poll for the live one. */
  status: string;
  /** Crawls this process must finish first. 0 = it is starting now. */
  queuePosition: number;
}

/** One crawl, as a listing row. */
export interface CrawlListItem {
  crawlId: string;
  siteUrl: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesCrawled: number;
  renderPassCount: number;
}

/** One crawl, in full. */
export interface CrawlDetail extends CrawlListItem {
  rulesetVersion: string;
  pagesTotal: number | null;
  frontier: FrontierCounts;
  /**
   * This process's queue position, or null.
   *
   * Null for every crawl that is not `queued` — and, importantly, null for a
   * `queued` row this process is NOT holding: work a dead process accepted and
   * nobody will run. See the module header.
   */
  queuePosition: number | null;
  /**
   * Unexpired leases the crawl holds right now — crawl leases and render leases
   * alike. Non-zero means somebody is working it; zero on a `running` row means
   * the worker is gone (the condition `markCrawlFailed` requires).
   */
  liveLeases: number;
}

/** A page of results, in the surface's one pagination shape. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** `runRenderPass`'s summary, minus the selection's URL list. */
export interface RenderSummaryOut {
  crawlId: string;
  rendered: number;
  failures: number;
  unrendered: number;
  elapsedMs: number;
  selection: {
    selected: number;
    budget: number;
    suspects: number;
    sampled: number;
    truncated: boolean;
  };
}

interface QueueEntry {
  crawlId: string;
  /** The effective config, `allowPrivate` included — never the stored one. */
  config: CrawlConfig;
}

interface RunningCrawl {
  crawlId: string;
  controller: AbortController;
  done: Promise<void>;
}

export class ApiService {
  private readonly registry: Registry;
  private readonly log: (line: string) => void;

  /** Crawls accepted by this process and not yet started, in FIFO order. */
  private readonly waiting: QueueEntry[] = [];
  private running: RunningCrawl | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly config: ApiServerConfig,
  ) {
    // Built once, here: `buildRegistry` runs `defineRule` over every rule, so a
    // rule missing its client-facing copy throws at server construction rather
    // than at the first `POST /crawls/:id/rules`.
    this.registry = buildRegistry();
    this.log = config.log ?? ((line) => console.error(line));
  }

  /**
   * Accept a crawl: check it may be pointed at this host, create its row, and
   * put it in this process's queue.
   *
   * The order of the checks is the order of their authority. The allowlist is
   * the operator's policy and comes first, so a host nobody permitted is
   * refused before we spend a URL-policy verdict on it. `isUrlAllowed` is the
   * engine's own perimeter (hard rule 5) and is applied to the seed here even
   * though the crawl loop re-applies it at enqueue and `fetchPage` re-applies
   * it at connect: a caller who names a blocked host deserves a 403 now, not a
   * crawl row that fails later for a reason they must go and read.
   *
   * THE SEED IS NOT THE ONLY HOST A CRAWL FETCHES. `legacyHosts` adds hosts the
   * host probe visits before any robots.txt has been read, so they go through
   * the same two checks — see `checkLegacyHosts`, which is where the allowlist
   * would otherwise have had a hole big enough to drive a crawler through.
   */
  async startCrawl(input: StartCrawlInput): Promise<CrawlAccepted> {
    if (this.closed) {
      throw new ServiceError("CONFLICT", "the server is shutting down and is not accepting crawls");
    }

    const siteUrl = normalizeUrl(input.siteUrl.trim());
    if (siteUrl === null) {
      throw new ServiceError(
        "VALIDATION",
        `siteUrl is not an http(s) URL: ${clip(input.siteUrl)}`,
      );
    }
    const host = new URL(siteUrl).hostname;

    if (!isHostAllowed(host, this.config.allowedDomains)) {
      // The rejected host is named; the allowlist itself is NOT listed back.
      // On a multi-tenant deployment its contents are other tenants' domains
      // (obligation 6), and the caller does not need them to fix their request.
      throw new ServiceError(
        "FORBIDDEN",
        this.config.allowedDomains.length === 0
          ? `host '${host}' is not permitted: this server's crawl allowlist is empty, ` +
            `so no crawl target is accepted (queries are unaffected)`
          : `host '${host}' is not in this server's crawl allowlist`,
      );
    }

    const allowPrivate = this.config.crawlDefaults?.allowPrivate === true;
    const verdict = await isUrlAllowed(siteUrl, { allowPrivate });
    if (!verdict.allowed) {
      throw new ServiceError(
        "FORBIDDEN",
        `siteUrl refused by the URL policy: ${verdict.reason ?? "no reason given"}`,
      );
    }

    await this.checkLegacyHosts(siteUrl, input.legacyHosts, allowPrivate);

    const crawlConfig = this.effectiveConfig(siteUrl, input);
    try {
      validateCrawlConfig(crawlConfig);
    } catch (error) {
      // The loop's own range checks, surfaced where the caller can fix them.
      // Its messages name the field and the value and nothing else.
      throw new ServiceError("VALIDATION", messageOf(error));
    }

    const crawlId = `crawl_${randomUUID()}`;
    await this.db.insert(crawls).values({
      id: crawlId,
      siteUrl,
      // The same strip `runCrawl` applies, by the same function: `allowPrivate`
      // never reaches a row, so a resume of this crawl months from now cannot
      // inherit it (build-plan §7 item 3).
      config: storableConfig(crawlConfig),
      rulesetVersion: RULESET_VERSION,
      status: "queued",
    });

    const entry: QueueEntry = { crawlId, config: crawlConfig };
    this.waiting.push(entry);
    this.pump();
    return { crawlId, status: "queued", queuePosition: this.queuePosition(crawlId) ?? 0 };
  }

  /** Newest first, `(started_at, id)` descending — a total order, so a cursor is exact. */
  async listCrawls(opts: { limit?: number; cursor?: string } = {}): Promise<Page<CrawlListItem>> {
    const limit = parseLimit(opts.limit);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);

    const rows = await this.db
      .select({
        id: crawls.id,
        siteUrl: crawls.siteUrl,
        status: crawls.status,
        startedAt: crawls.startedAt,
        // THE CURSOR'S HALF OF THE SORT KEY, AND IT IS NOT `startedAt`.
        // `timestamptz` has microsecond precision and node-postgres parses it
        // into a JS `Date`, which has milliseconds — so a cursor built from the
        // Date would compare `12:00:00.123000` against a row stored at
        // `12:00:00.123111` and SKIP it. Two crawls accepted in the same
        // millisecond is not a hypothetical: a client submitting a batch does
        // it, and the skipped row would simply never be listed. This column is
        // the stored value at full precision, and it is what the cursor carries.
        startedAtExact: sql<string>`to_char(${crawls.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        finishedAt: crawls.finishedAt,
        pagesCrawled: crawls.pagesCrawled,
        renderPassCount: crawls.renderPassCount,
      })
      .from(crawls)
      .where(
        cursor === null
          ? undefined
          : sql`(${crawls.startedAt}, ${crawls.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::text)`,
      )
      .orderBy(desc(crawls.startedAt), desc(crawls.id))
      .limit(limit + 1);

    // One row past the page is what says whether there IS a next page. It is
    // dropped, never returned, so `items.length <= limit` always holds.
    const items = rows.slice(0, limit).map((row) => ({
      crawlId: row.id,
      siteUrl: row.siteUrl,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
      pagesCrawled: row.pagesCrawled,
      renderPassCount: row.renderPassCount,
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor: last === undefined ? null : encodeCursor(last.startedAtExact, last.id),
    };
  }

  async getCrawl(crawlId: string): Promise<CrawlDetail> {
    const row = await this.crawlRow(crawlId);
    const [counts, liveLeases] = await Promise.all([
      frontierCounts(this.db, crawlId),
      this.liveLeaseCount(crawlId),
    ]);
    return {
      crawlId: row.id,
      siteUrl: row.siteUrl,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
      pagesCrawled: row.pagesCrawled,
      pagesTotal: row.pagesTotal,
      renderPassCount: row.renderPassCount,
      rulesetVersion: row.rulesetVersion,
      frontier: counts,
      queuePosition: row.status === "queued" ? this.queuePosition(crawlId) : null,
      liveLeases,
    };
  }

  /**
   * Close a crawl whose worker is gone: `running` → `failed`.
   *
   * Two conditions, both refused with a 409 that says which one failed, because
   * this endpoint's whole risk is being used on a crawl that is merely slow.
   *
   *  1. **The row says `running`.** Anything else is either already closed or
   *     not started, and neither is a crash to clean up after.
   *  2. **It holds no unexpired lease.** A live worker holds leases; a dead
   *     one's expire (see `leaseSecondsFor` in the crawl loop). This is the
   *     same live/dead distinction `runRenderPass`'s guard makes, and it counts
   *     render leases too — a `render_pending` row with a live deadline belongs
   *     to a working render pass and is invisible to the frontier's `leased`
   *     count (see `heldRenderLeases`).
   *
   * Plus one this process can answer directly: a crawl IT is running is refused
   * whatever the leases say. A live crawl between batches momentarily holds
   * none, and that window is exactly when an impatient caller would look.
   */
  async markCrawlFailed(crawlId: string): Promise<CrawlDetail> {
    const row = await this.crawlRow(crawlId);
    if (row.status !== "running") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is '${row.status}', not 'running': only a running crawl whose ` +
          `worker is gone can be marked failed`,
      );
    }
    if (this.running?.crawlId === crawlId) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is being run by this server right now: cancel the server or ` +
          `wait for it, do not mark a live crawl failed`,
      );
    }
    const live = await this.liveLeaseCount(crawlId);
    if (live > 0) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} holds ${live} unexpired lease(s): a worker is still on it. ` +
          `A dead worker's leases expire on their own — try again after they do`,
      );
    }

    await this.db
      .update(crawls)
      .set({ status: "failed", finishedAt: new Date() })
      .where(and(eq(crawls.id, crawlId), eq(crawls.status, "running")));
    return this.getCrawl(crawlId);
  }

  /**
   * Run the render pass over a finished crawl.
   *
   * The driver's own three-condition guard is the authority on whether a crawl
   * may be rendered, and it is NOT re-implemented here — it is called, and its
   * refusals are mapped. See `mapRenderPassError` for the coupling that costs.
   *
   * What this method does own is the pass's configuration, and it comes from
   * the crawl's own row: the same user agent, the same per-host delay, the same
   * render budget, plus the robots `Crawl-delay` the crawl honoured. A render
   * pass that paced itself differently from the crawl it belongs to would be a
   * politeness regression the site would experience as a second, ruder crawler
   * (rule 9).
   */
  async renderCrawl(crawlId: string): Promise<RenderSummaryOut> {
    const row = await this.crawlRow(crawlId);

    let config: CrawlConfig;
    try {
      config = parseStoredConfig(row.config, crawlId);
    } catch (error) {
      throw new ServiceError("CONFLICT", messageOf(error));
    }
    const robotsCrawlDelaySec = this.robotsCrawlDelay(row.discovery, crawlId);

    let summary: RenderPassSummary;
    try {
      summary = await runRenderPass(this.db, crawlId, {
        ...config,
        robotsCrawlDelaySec,
        allowPrivate: this.config.crawlDefaults?.allowPrivate === true,
      });
    } catch (error) {
      throw mapRenderPassError(error);
    }

    return {
      crawlId: summary.crawlId,
      rendered: summary.rendered,
      failures: summary.failures,
      unrendered: summary.unrendered,
      elapsedMs: summary.elapsedMs,
      // The selection's URL list is a page list, and a page list is not a
      // response body (obligation 1: never a full export inline). Its size is.
      selection: {
        selected: summary.selection.selected.length,
        budget: summary.selection.budget,
        suspects: summary.selection.suspects,
        sampled: summary.selection.sampled,
        truncated: summary.selection.truncated,
      },
    };
  }

  /**
   * Judge a crawl: run every rule in the registry over it.
   *
   * Refused while the crawl is in flight. `runRules` itself has no such guard —
   * it would happily judge a half-crawled site — and the findings it produced
   * would change under the reader as the crawl went on: an orphan that is only
   * an orphan because the page linking to it has not been fetched yet, a
   * sitemap entry "uncrawled" because its turn has not come. Evidence has to be
   * about a crawl that has stopped moving.
   */
  async runRulesForCrawl(crawlId: string): Promise<RunSummary> {
    const row = await this.crawlRow(crawlId);
    if (row.status === "queued" || row.status === "running") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is '${row.status}': the rules may only run over a crawl that ` +
          `has stopped, or they would judge a site that is still being fetched`,
      );
    }
    try {
      return await runRules(this.db, crawlId, this.registry);
    } catch (error) {
      // The one refusal `runRules` owns: an id nothing knows. It is raced with
      // the read above (a crawl deleted in between), so it is mapped rather
      // than assumed impossible.
      if (error instanceof Error && error.message.startsWith("no such crawl")) {
        throw new ServiceError("NOT_FOUND", `no such crawl '${crawlId}'`);
      }
      throw error;
    }
  }

  /**
   * Stop the queue: abort the crawl in flight and wait for it to close its row.
   *
   * The abort is the crawl loop's own graceful path — the run ends `cancelled`
   * with its frontier intact, resumable. Crawls still waiting are left as
   * `queued` rows and logged: this process will not run them and says so, which
   * is the restart contract in the module header.
   */
  async close(): Promise<void> {
    this.closed = true;
    const abandoned = this.waiting.splice(0, this.waiting.length);
    const current = this.running;
    if (current !== null) {
      current.controller.abort();
      await current.done;
    }
    if (abandoned.length > 0) {
      this.log(
        `api: ${abandoned.length} crawl(s) left queued and unstarted ` +
          `(${abandoned.map((e) => e.crawlId).join(", ")}); their rows stay 'queued' and ` +
          `no process is holding them`,
      );
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Start the next crawl if nothing is running.
   *
   * `this.running` is assigned in the same synchronous step that removes the
   * entry from `waiting`, before the run's first `await` can yield, so two
   * `startCrawl` calls in the same tick cannot both find the runner idle.
   */
  private pump(): void {
    if (this.closed || this.running !== null) return;
    const next = this.waiting.shift();
    if (next === undefined) return;

    const controller = new AbortController();
    const entry: RunningCrawl = {
      crawlId: next.crawlId,
      controller,
      done: Promise.resolve(),
    };
    this.running = entry;
    // NOTHING AWAITS THIS PROMISE UNTIL `close()`, so it must not be able to
    // reject. `runQueued` already catches the crawl's own errors — but its
    // catch block writes to the database, and a database that is gone makes
    // BOTH the run and its own record-keeping throw. That rejection would then
    // sit unhandled on a promise nobody is holding, and an unhandled rejection
    // ends the process in Node 22: one bad crawl would take the whole API
    // server down with it.
    //
    // The catch is before the `finally` deliberately, so `entry.done` is a
    // settled, non-rejecting promise by the time `close()` awaits it.
    entry.done = this.runQueued(next, controller.signal)
      .catch((error: unknown) => {
        this.log(
          `api: crawl ${entry.crawlId} — the queue runner itself failed and could not ` +
            `record it: ${messageOf(error)}`,
        );
      })
      .finally(() => {
        if (this.running === entry) this.running = null;
        this.pump();
      });
  }

  /**
   * Run one queued crawl.
   *
   * `resumeCrawl` rather than `runCrawl` because the row already exists — it
   * was created when the crawl was accepted. A queued crawl's frontier is
   * empty, so a resume of it does exactly what a fresh run does: discover,
   * seed, loop. The config passed in is the effective one, `allowPrivate`
   * included; the row's stored copy never had it (`storableConfig`), and
   * `ResumeOpts.config` is the documented place to re-assert it.
   */
  private async runQueued(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    this.log(`api: crawl ${entry.crawlId} starting (${entry.config.siteUrl})`);
    try {
      const summary = await resumeCrawl(this.db, entry.crawlId, {
        config: entry.config,
        signal,
      });
      this.log(
        `api: crawl ${entry.crawlId} ${summary.status} — ${summary.pagesCrawled} page(s)`,
      );
    } catch (error) {
      // The crawl's own failure path has already closed the row as `failed`
      // (see `execute` in the crawl loop) for anything thrown inside the run.
      // A throw BEFORE that — a row deleted underneath us, a config the loop
      // will not take — would leave the row `queued`, which is a lie: nobody
      // will ever run it. Closing it is transparency, not recovery; the error
      // is logged either way and never swallowed into a clean-looking row.
      this.log(`api: crawl ${entry.crawlId} threw — ${messageOf(error)}`);
      await this.db
        .update(crawls)
        .set({ status: "failed", finishedAt: new Date() })
        .where(and(eq(crawls.id, entry.crawlId), eq(crawls.status, "queued")));
    }
  }

  /** 0 = running now or next; null = this process is not holding this crawl. */
  private queuePosition(crawlId: string): number | null {
    if (this.running?.crawlId === crawlId) return 0;
    const index = this.waiting.findIndex((e) => e.crawlId === crawlId);
    if (index < 0) return null;
    return this.running === null ? index : index + 1;
  }

  /**
   * The allowlist, applied to the hosts `legacyHosts` adds to the crawl.
   *
   * WHY THIS EXISTS AT ALL. `legacyHosts` is not decoration: `probeHostVariants`
   * fetches the origin root of every one of them, up to five hops each, and
   * those fetches are — by host-probe.ts's own account — the ONLY fetches in
   * the crawler not covered by robots.txt, because which host's robots.txt
   * governs the site is exactly what the probe is trying to find out. Gating
   * only `siteUrl` therefore left `{siteUrl: <allowed>, legacyHosts:
   * ["victim.example"]}` as a way to point a branded crawler at any host on the
   * internet with an operator's allowlist in force and no rules read first.
   *
   * WHAT IS GATED, precisely: the hosts the probe would fetch that are NOT the
   * site's own spellings. `hostProbeStarts(siteUrl)` is the family the crawler
   * already treats as this one site — apex/www × http/https, the same variants
   * `isSameOrigin` admits into the crawl — and an allowlist entry authorises
   * that family (see `isHostAllowed`). Everything `legacyHosts` ADDS is a
   * different site by every definition the engine has, so each one must be
   * allowlisted in its own right, and each one gets the URL policy applied to
   * it as well.
   *
   * The subtraction is done with `hostProbeStarts` itself rather than by
   * re-deriving the spellings here, for the reason its own docblock gives: it
   * is the probe's contract, and the host rules already subtract with it.
   *
   * RUN EVEN WHEN `probeHosts` IS FALSE. Nothing is fetched in that case, but
   * the entries are still written to the crawl row, and a resume that turns
   * probing on would fetch hosts this server never authorised. The row must not
   * carry a host the allowlist would have refused.
   *
   * A malformed entry is a 400 here — `hostProbeStarts` throws on one — rather
   * than an error the crawl discovers after it has been accepted, queued and
   * started.
   */
  private async checkLegacyHosts(
    siteUrl: string,
    legacyHosts: readonly string[] | undefined,
    allowPrivate: boolean,
  ): Promise<void> {
    if (legacyHosts === undefined || legacyHosts.length === 0) return;

    let ownSpellings: string[];
    let everyStart: string[];
    try {
      ownSpellings = hostProbeStarts(siteUrl);
      everyStart = hostProbeStarts(siteUrl, legacyHosts);
    } catch (error) {
      throw new ServiceError("VALIDATION", messageOf(error));
    }

    const own = new Set(ownSpellings);
    const checked = new Set<string>();
    for (const start of everyStart) {
      if (own.has(start)) continue;
      const host = new URL(start).hostname;
      if (checked.has(host)) continue;
      checked.add(host);

      if (!isHostAllowed(host, this.config.allowedDomains)) {
        throw new ServiceError(
          "FORBIDDEN",
          `legacyHosts names '${host}', which is not in this server's crawl allowlist: ` +
            `the host probe fetches every legacy host, and those fetches are the only ` +
            `ones the crawler makes before it has read anybody's robots.txt`,
        );
      }
      const verdict = await isUrlAllowed(start, { allowPrivate });
      if (!verdict.allowed) {
        throw new ServiceError(
          "FORBIDDEN",
          `legacyHosts entry '${host}' refused by the URL policy: ` +
            `${verdict.reason ?? "no reason given"}`,
        );
      }
    }
  }

  private effectiveConfig(siteUrl: string, input: StartCrawlInput): CrawlConfig {
    // Precedence, low to high: the engine's defaults, the API's own maxPages,
    // the process-trust overrides, then the request. `stripUndefined` on the
    // request half because an absent optional field must not overwrite a
    // default with `undefined`.
    return {
      ...CRAWL_DEFAULTS,
      ...API_CRAWL_DEFAULTS,
      ...stripUndefined(this.config.crawlDefaults ?? {}),
      ...stripUndefined({ ...input, siteUrl }),
    } as CrawlConfig;
  }

  private async crawlRow(crawlId: string): Promise<typeof crawls.$inferSelect> {
    const rows = await this.db.select().from(crawls).where(eq(crawls.id, crawlId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
    return row;
  }

  /**
   * Leases with a deadline still in the future, of either kind.
   *
   * Deliberately keyed on `lease_id is not null and leased_until > now()`
   * rather than on the row's state, because the two kinds of lease live in
   * different states: a crawl lease moves the row to `leased`, a render lease
   * leaves it at `render_pending` (see `heldRenderLeases`). "Is anyone working
   * this crawl" has to be true of both.
   */
  private async liveLeaseCount(crawlId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(frontier)
      .where(
        and(
          eq(frontier.crawlId, crawlId),
          isNotNull(frontier.leaseId),
          sql`${frontier.leasedUntil} > now()`,
        ),
      );
    const n = rows[0]?.n;
    if (typeof n !== "number") {
      throw new Error(`liveLeaseCount: count came back as ${typeof n}, not a number`);
    }
    return n;
  }

  /**
   * The robots `Crawl-delay` this crawl honoured, read back off its own
   * discovery evidence so the render pass honours it too.
   *
   * A crawl with no discovery blob is refused rather than rendered at the
   * config delay alone: `discovery_jsonb` is written before the frontier is
   * seeded, so a row without one belongs to a crawl that never got that far,
   * and rendering it would mean visiting a site at a pace we have no evidence
   * it permits (rule 9 — and the "no silent fallback" rule, since the missing
   * evidence would otherwise be read as "no delay").
   */
  private robotsCrawlDelay(discovery: unknown, crawlId: string): number | null {
    if (discovery === null || discovery === undefined) {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} has no discovery evidence: it never completed discovery, so ` +
          `there is nothing to render and no robots crawl-delay to honour`,
      );
    }
    const robots = (discovery as Record<string, unknown>)["robots"];
    if (robots === null || typeof robots !== "object") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} discovery evidence has no robots object`,
      );
    }
    const delay = (robots as Record<string, unknown>)["crawlDelaySec"];
    if (delay === null || delay === undefined) return null;
    if (typeof delay !== "number") {
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} discovery evidence has a non-numeric robots.crawlDelaySec`,
      );
    }
    return delay;
  }
}

/**
 * Map a `runRenderPass` throw onto a service refusal.
 *
 * The driver's deliberate refusals are `RenderPassRefusal`s and carry the
 * answer they need (`live` → 409, `missing` → 404); everything else it throws
 * is a defect and is returned untouched, to become a 500 with a correlation id.
 *
 * This used to match on the message prefix, and that was wrong in a way worth
 * recording: `runRenderPass`'s `RangeError` for a bad `renderConcurrency` also
 * begins `runRenderPass: `, so our own bug was being handed to the caller as
 * "the crawl is busy, try later". The type is carried by the throw now, and the
 * guards' wording is free to change without changing this function.
 */
function mapRenderPassError(error: unknown): unknown {
  if (!(error instanceof RenderPassRefusal)) return error;
  // The `runRenderPass: ` prefix is the driver naming itself to a log reader.
  // A caller of the API already knows which endpoint they called.
  const message = error.message.startsWith("runRenderPass: ")
    ? error.message.slice("runRenderPass: ".length)
    : error.message;
  return new ServiceError(error.reason === "missing" ? "NOT_FOUND" : "CONFLICT", message);
}

/**
 * A listing cursor: the sort key of the last row returned, base64url-encoded so
 * it is opaque to the caller and one token rather than two query parameters.
 *
 * Opaque, not encrypted — it carries a timestamp and a crawl id the caller was
 * just given. What it must not be is *guessable in the wrong shape*: a cursor
 * that does not decode is a 400, never an empty page, because an agent that
 * paginated into silence would conclude the crawl list had ended.
 */
function encodeCursor(startedAt: string, id: string): string {
  return Buffer.from(`${startedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { startedAt: string; id: string } {
  const bad = (): never => {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  };
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return bad();
  }
  const sep = decoded.indexOf("|");
  if (sep < 0) return bad();
  const startedAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (id === "" || Number.isNaN(Date.parse(startedAt))) return bad();
  return { startedAt, id };
}

function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
    throw new ServiceError(
      "VALIDATION",
      `limit must be an integer between 1 and ${PAGE_SIZE_MAX}, got ${clip(String(limit))}`,
    );
  }
  return limit;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bound and de-fang a caller's own string before it goes back in an error.
 *
 * Not an escaping function — the response is JSON, which quotes for us — but a
 * length and control-character cap, so a 10MB field name or a terminal escape
 * sequence cannot ride an error message into somebody's log or console.
 */
function clip(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}
