/**
 * The crawl frontier: the queue of URLs a crawl still owes work on, kept in
 * Postgres rather than in memory.
 *
 * Two hard requirements shape every statement in this file.
 *
 *  - **The memory contract (build plan rule 6).** The frontier of a 50k-page
 *    crawl is 50k rows in a table, never a `Set` in the crawler's heap. Nothing
 *    here returns more than the `n` rows the caller asked to lease, and the
 *    dedupe that stops a URL entering twice is the `(crawl_id, url)` primary
 *    key doing it in the database, not a visited-set doing it in RAM.
 *
 *  - **Crash resume.** A leased row carries a *deadline*, not a lock. A worker
 *    that dies mid-batch leaves rows marked `leased` with a `leased_until` in
 *    the past, and the very next `leaseBatch` picks them up again — that is the
 *    whole resume mechanism, and it needs no recovery pass, no journal and no
 *    liveness protocol. `releaseLeases` exists only to make a *graceful*
 *    shutdown instant instead of waiting out the deadline.
 *
 *    The other half of resume is `completeUrls`: a row leaves `leased` for
 *    `done` in the *same transaction* that commits its page row, so a resume
 *    re-fetches exactly the URLs whose evidence a hard kill took with it. A
 *    `done` row is a promise that the page is in the database.
 *
 * Concurrency safety lives in one statement, `leaseBatch`: an `UPDATE` whose
 * row set comes from a `SELECT … FOR UPDATE SKIP LOCKED` picked out in a
 * `WITH … AS MATERIALIZED` CTE. Two workers leasing at the same instant get
 * disjoint batches because the second one skips the rows the first has locked,
 * rather than blocking on them or — far worse — reading them as available. Do
 * not reshape it into a read then a write: that gap is exactly where two
 * workers crawl the same URL twice. And the CTE must stay MATERIALIZED with the
 * update joining it: the earlier `WHERE (crawl_id, url) IN (subselect)` shape
 * let the planner run the subselect once per candidate row, and because each
 * update makes the just-claimed row stop matching the subselect's WHERE, each
 * re-evaluation claimed a FRESH row — `LIMIT n` leased more than n whenever the
 * planner chose that plan (it did, on CI's freshly-analyzed tables; PR #7 run
 * 33268659558). A materialized CTE is evaluated exactly once, so `LIMIT n`
 * means n.
 *
 * The frontier serves TWO passes. The crawl pass owns `pending` / `leased`; the
 * render pass owns `render_pending`, which `selectRenderSet` (src/crawl/render/
 * select.ts) promotes `done` rows into, `leaseRenderUrls` hands out, and
 * `completeUrls` settles back to `done` when the render — successful or
 * recorded as failed — is written. The two passes share no state value, which
 * is what makes their leases unable to collide; `leaseRenderUrls` says why that
 * matters more than it looks.
 *
 * The URL a row is keyed by is `normalizeUrl` output (url-utils), which is the
 * single frontier-key authority. This module does not normalise: it stores the
 * key it is given, so a caller that skips normalisation gets duplicate rows
 * rather than a silently rewritten URL.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { frontier } from "../db/schema.js";

/**
 * How a URL came to be in the frontier — the whole vocabulary, and the value
 * stored in `frontier.discovered_via` and copied onto `pages.discovered_via`.
 *
 * FOUR VALUES, ONE WRITER. The crawl loop's `enqueue` is the only thing that
 * puts a row in this table, and it is called exactly four times: the seed, the
 * sitemap entries, a page's links and a redirect target (src/crawl/loop.ts).
 * The list exists at runtime because the agent surface validates a
 * `discoveredVia` filter against it (`ApiService.listPages`), and `enqueue`'s
 * parameter is typed `DiscoveredVia` so a fifth kind of discovery cannot be
 * introduced without appearing here — a filter that silently refused a value
 * the crawler really writes would read as "no pages were discovered that way".
 *
 * It is NOT applied to rows read back out of the database (`toLeased` keeps its
 * `string`): what the column holds is a fact about a row that already exists,
 * and narrowing it on read would be a cast rather than a check.
 */
export const DISCOVERED_VIA = ["seed", "link", "sitemap", "redirect"] as const;

export type DiscoveredVia = (typeof DISCOVERED_VIA)[number];

/** A row leased to one worker for one attempt. */
export interface LeasedUrl {
  url: string;
  depth: number;
  discoveredVia: string;
  /** Attempts *including* this one — `leaseBatch` increments as it leases. */
  attempts: number;
}

export interface FrontierCounts {
  pending: number;
  leased: number;
  done: number;
  failed: number;
  /**
   * Selected for the render pass and not yet rendered. These URLs have ALREADY
   * BEEN CRAWLED — a render row is a `done` row the selection promoted — so a
   * caller counting how much of the site is in the record must count them
   * alongside `done`; `crawledRows` does exactly that, and is what the loop
   * uses so a resume after a render selection does not re-crawl the site.
   */
  renderPending: number;
}

/**
 * The states a frontier row may be in. Anything else is a defect.
 *
 * `render_pending` is the render pass's, and it is the ONLY state that pass
 * ever puts a row in — see `leaseRenderUrls` for why a render lease does not
 * move the row to `leased`.
 */
const STATES = ["pending", "leased", "done", "failed", "renderPending"] as const;

/** `FrontierCounts` key -> the string stored in `frontier.state`. */
const STATE_COLUMN: Record<(typeof STATES)[number], string> = {
  pending: "pending",
  leased: "leased",
  done: "done",
  failed: "failed",
  renderPending: "render_pending",
};

/**
 * How many of the crawl's URLs have been fetched and written: `done` plus the
 * ones the render selection took out of `done`. Two states, one fact — and
 * stating it once is what keeps a resume from reading a render selection as
 * "these pages were never crawled" and fetching them all again.
 */
export function crawledRows(counts: FrontierCounts): number {
  return counts.done + counts.renderPending;
}

export interface EnqueueItem {
  url: string;
  depth: number;
  discoveredVia: string;
}

/**
 * Rows per INSERT statement. Not a tuning knob — a correctness bound.
 *
 * Postgres binds parameters with a 16-bit count, so one statement carries at
 * most 65,535 of them; a frontier row spends four (crawl_id, url, depth,
 * discovered_via), which puts the wall at 16,383 rows. The caller that reaches
 * it is not exotic: the crawl loop enqueues a whole sitemap in one call, and a
 * 50k-URL sitemap is an ordinary large site. Well before the wall, the driver
 * fails differently and worse — a ~30k-row statement overflows the call stack
 * while the SQL is still being assembled, which reads like a crawler bug rather
 * than a batch-size one.
 *
 * 1,000 rows (4,000 parameters) leaves an order of magnitude of headroom for
 * the column count to grow without anyone having to rediscover this.
 */
const INSERT_CHUNK_ROWS = 1_000;

/**
 * Add URLs to the frontier, ignoring any that are already there. Returns the
 * number of rows actually inserted — which is the caller's honest answer to
 * "how much did this page grow the crawl", and is what the loop budgets
 * against `maxPages`.
 *
 * A conflicting row is left exactly as it was: the first discovery of a URL
 * owns its depth and provenance. Re-enqueueing a `done` URL therefore does not
 * resurrect it, which is what makes a resumed crawl continue rather than
 * restart (the seed is re-enqueued on every resume and stays done).
 *
 * A call larger than `INSERT_CHUNK_ROWS` becomes several statements rather
 * than one oversized one. They are not one transaction, and deliberately so:
 * a frontier row is idempotent (the conflict target makes re-enqueueing free),
 * so a call that fails halfway leaves a partly-seeded frontier that the next
 * call completes — which is strictly better than rolling 50,000 rows back
 * because the last chunk timed out. The returned count is what actually
 * landed, so a caller budgeting against it is never told about rows that did
 * not.
 */
export async function enqueueUrls(
  db: Db,
  crawlId: string,
  urls: readonly EnqueueItem[],
): Promise<number> {
  if (urls.length === 0) return 0;

  let count = 0;
  for (let i = 0; i < urls.length; i += INSERT_CHUNK_ROWS) {
    const inserted = await db
      .insert(frontier)
      .values(
        urls.slice(i, i + INSERT_CHUNK_ROWS).map((item) => ({
          crawlId,
          url: item.url,
          depth: item.depth,
          discoveredVia: item.discoveredVia,
        })),
      )
      // Duplicates *within* one batch collapse here too: DO NOTHING tolerates a
      // row conflicting with one inserted earlier in the same statement.
      .onConflictDoNothing({ target: [frontier.crawlId, frontier.url] })
      .returning({ url: frontier.url });
    count += inserted.length;
  }

  return count;
}

/**
 * Claim up to `n` URLs for `leaseId` for `leaseSeconds`.
 *
 * Shallow first, then oldest first: a breadth-first crawl reaches a site's
 * navigation before its long tail, so a crawl cut short by `maxPages` has
 * covered the part of the site that matters most.
 *
 * `leaseSeconds` is a deadline on the *whole* attempt (fetch, parse, persist).
 * Too short and a slow page gets crawled twice; too long and a crashed worker's
 * URLs sit idle. The loop's 180s is comfortably above any single page's
 * worst case (a 20s fetch timeout) without stalling a resume for long.
 *
 * The state filter is `pending` (plus an expired `leased`) and must stay that
 * way: it is the whole of the render pass's invisibility to this one. A
 * `render_pending` row is a page this crawl has already fetched, and leasing it
 * here would re-fetch it — see `leaseRenderUrls`.
 *
 * This is the concurrency-safety core — see the module header before changing
 * its shape.
 */
export async function leaseBatch(
  db: Db,
  crawlId: string,
  leaseId: string,
  n: number,
  leaseSeconds: number,
): Promise<LeasedUrl[]> {
  validateLease("leaseBatch", n, leaseSeconds);

  const res = await db.execute(sql`
    with picked as materialized (
      select crawl_id, url from frontier
      where crawl_id = ${crawlId}
        and (state = 'pending' or (state = 'leased' and leased_until < now()))
      order by depth asc, discovered_at asc
      limit ${n}
      for update skip locked)
    update frontier set state = 'leased', lease_id = ${leaseId},
      leased_until = now() + make_interval(secs => ${leaseSeconds}::double precision),
      attempts = attempts + 1
    from picked
    where frontier.crawl_id = picked.crawl_id and frontier.url = picked.url
    returning frontier.url, frontier.depth, frontier.discovered_via, frontier.attempts`);

  return toLeased(res.rows);
}

/** The two arguments both lease paths share, checked the same way in both. */
function validateLease(fn: string, n: number, leaseSeconds: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`${fn}: n must be an integer ≥ 1, got ${n}`);
  }
  if (!Number.isFinite(leaseSeconds) || leaseSeconds < 0) {
    throw new RangeError(`${fn}: leaseSeconds must be ≥ 0, got ${leaseSeconds}`);
  }
}

function toLeased(rows: readonly Record<string, unknown>[]): LeasedUrl[] {
  return rows.map((r) => ({
    url: r["url"] as string,
    depth: Number(r["depth"]),
    discoveredVia: r["discovered_via"] as string,
    attempts: Number(r["attempts"]),
  }));
}

/**
 * Claim up to `n` URLs of the RENDER pass for `leaseId` for `leaseSeconds`.
 *
 * The same mechanism as `leaseBatch` — an `UPDATE` joining a `SELECT … FOR
 * UPDATE SKIP LOCKED` materialized CTE (see the module header for why
 * MATERIALIZED is load-bearing), a `lease_id`, a `leased_until` deadline that
 * is a crash-resume mechanism rather than a lock — over the rows
 * `selectRenderSet` moved to `render_pending`.
 *
 * ONE DELIBERATE DIFFERENCE, and it is the reason the two passes cannot
 * collide: a render lease does NOT move the row to `leased`. It writes the
 * lease fields and leaves the state where it is, so a render row is never in
 * any state `leaseBatch` looks at — not while it is held, and not after the
 * deadline passes, which is exactly when a shared `leased` state would have
 * handed a rendered page back to the crawler to fetch a second time (rule 9).
 * The cost is that `frontierCounts` reports a held render row as
 * `renderPending`, which is true: it is still owed a render.
 *
 * URL order rather than the crawl's depth-then-age order: the render set is a
 * selection, not a discovery frontier, and `selectRenderSet` already returns it
 * in URL order. Two workers still get disjoint batches — that is SKIP LOCKED's
 * job, not the ORDER BY's — but a single-worker pass then renders in a stable,
 * reproducible order.
 *
 * The batch is sorted on the way out, and that is not belt and braces: an
 * `UPDATE … RETURNING` emits rows in the order it happened to update them, not
 * in the sub-select's `ORDER BY`, so the ORDER BY chooses WHICH rows are leased
 * and this sort chooses the order they are worked in. Bounded by `n`.
 */
export async function leaseRenderUrls(
  db: Db,
  crawlId: string,
  leaseId: string,
  n: number,
  leaseSeconds: number,
): Promise<LeasedUrl[]> {
  validateLease("leaseRenderUrls", n, leaseSeconds);

  const res = await db.execute(sql`
    with picked as materialized (
      select crawl_id, url from frontier
      where crawl_id = ${crawlId}
        and state = 'render_pending'
        and (leased_until is null or leased_until < now())
      order by url asc
      limit ${n}
      for update skip locked)
    update frontier set lease_id = ${leaseId},
      leased_until = now() + make_interval(secs => ${leaseSeconds}::double precision),
      attempts = attempts + 1
    from picked
    where frontier.crawl_id = picked.crawl_id and frontier.url = picked.url
    returning frontier.url, frontier.depth, frontier.discovered_via, frontier.attempts`);

  return toLeased(res.rows).sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * How many render rows are leased RIGHT NOW — `render_pending` with a deadline
 * still in the future.
 *
 * `frontierCounts` cannot answer this and must not be made to: a render lease
 * deliberately leaves the row's state alone (see `leaseRenderUrls`), so every
 * held render row counts as `renderPending` there, exactly like an unleased
 * one. That is the right answer for "how much is still owed a render" and the
 * wrong one for "is another render pass running", which is what `runRenderPass`
 * has to ask before it re-selects — a second pass's selection would demote the
 * rows the first one is holding.
 *
 * Expired leases are excluded on purpose: a lease past its deadline is a dead
 * worker's, and reclaiming it is the whole resume mechanism.
 */
export async function heldRenderLeases(db: Db, crawlId: string): Promise<number> {
  const res = await db.execute(sql`
    select count(*)::int as n from frontier
    where crawl_id = ${crawlId}
      and state = 'render_pending'
      and leased_until is not null
      and leased_until > now()`);
  const n = res.rows[0]?.["n"];
  if (typeof n !== "number") {
    throw new Error(`heldRenderLeases: count came back as ${typeof n}, not a number`);
  }
  return n;
}

/**
 * Clear render leases so the rows can be picked up immediately — the render
 * pass's `releaseLeases`, for a graceful shutdown.
 *
 * It cannot be `releaseLeases`, and the reason is quieter than it looks. That
 * function's WHERE is `state = 'leased'`, which a `render_pending` row never
 * matches — so calling it on a render pass would not misplace a single row, it
 * would report 0 released and do NOTHING, leaving every lease standing until
 * its deadline expired. A shutdown that silently fails to release is exactly
 * the shape of no-op hard rule 7 exists to prevent: the pass looks cleanly
 * closed and its URLs are unavailable for minutes.
 *
 * (Moving a render row to `pending` would be the worse bug — the crawl would
 * lease and re-fetch a page it has already fetched — which is why the fix is a
 * separate function rather than widening `releaseLeases`'s state filter.)
 *
 * This clears the lease fields and leaves the state alone, which is all a
 * render row's lease ever was.
 *
 * `leaseId` is the worker's own on a graceful shutdown; `null` is every live
 * render lease in the crawl, an operator action for a pass whose worker is
 * known dead. Returns the number of rows released.
 */
export async function releaseRenderLeases(
  db: Db,
  crawlId: string,
  leaseId: string | null,
): Promise<number> {
  const scope = leaseId === null ? sql`` : sql` and lease_id = ${leaseId}`;
  const res = await db.execute(sql`
    update frontier set lease_id = null, leased_until = null
    where crawl_id = ${crawlId}
      and state = 'render_pending'
      and leased_until is not null${scope}
    returning url`);
  return res.rows.length;
}

/**
 * URLs per completion statement — the same 16-bit parameter ceiling that shapes
 * `INSERT_CHUNK_ROWS`, read for an `IN` list: one URL is one parameter, plus
 * the crawl id. The wall is far away at one parameter per row, but the driver's
 * stack-overflow-while-assembling failure is not, and a caller completing a
 * whole flush's worth of URLs should never have to know either number.
 */
const COMPLETE_CHUNK_URLS = 1_000;

/**
 * What `completeUrls` needs of its connection. Deliberately wider than `Db`:
 * `PageWriter` calls this *inside* `db.transaction`, and the `tx` it is handed
 * is not a `Db`. That call is the whole point of the batch form — a page row
 * and its frontier completion land together or not at all, so a process killed
 * outright can never leave a URL marked `done` whose page row was still sitting
 * in a buffer (build plan §7, "hard-kill durability").
 */
type Executor = Pick<Db, "execute">;

/**
 * Mark URLs finished. Their leases are cleared; they are never leased again.
 * Returns the number of frontier rows actually moved to `done` — a URL with no
 * row in this crawl updates nothing and is counted as nothing.
 *
 * A URL is completed only once its evidence is durable. The crawl loop no
 * longer calls this: `PageWriter.flushPages` does, in the transaction that
 * inserts the page rows, which is what makes "the frontier says done" and "the
 * page row exists" the same fact rather than two facts a SIGKILL can separate.
 *
 * A call larger than `COMPLETE_CHUNK_URLS` becomes several statements. Unlike
 * `enqueueUrls`, those statements are not independent: the caller runs them in
 * one transaction, so a chunk that fails takes the whole completion with it.
 *
 * The list is sorted first, and that is a lock-ordering rule rather than
 * tidiness. This holds row locks on many frontier rows until the transaction
 * commits, where the single-row autocommit UPDATE it replaced held one at a
 * time and could not deadlock. Two workers completing overlapping sets in
 * opposite orders would deadlock — and overlap is not hypothetical: it is
 * exactly what an expired lease and its double-fetch produce. Sorting gives
 * every caller the same direction: chunk k always covers URLs below chunk
 * k + 1, so two transactions walk the same ranges the same way instead of
 * head-on. (The copy is bounded by the caller's batch, not by the crawl.)
 */
export async function completeUrls(
  db: Executor,
  crawlId: string,
  urls: readonly string[],
): Promise<number> {
  if (urls.length === 0) return 0;

  const ordered = [...urls].sort();

  let completed = 0;
  for (let i = 0; i < ordered.length; i += COMPLETE_CHUNK_URLS) {
    const chunk = ordered.slice(i, i + COMPLETE_CHUNK_URLS);
    const list = sql.join(
      chunk.map((url) => sql`${url}`),
      sql`, `,
    );
    const res = await db.execute(sql`
      update frontier set state = 'done', lease_id = null, leased_until = null
      where crawl_id = ${crawlId} and url in (${list})
      returning url`);
    completed += res.rows.length;
  }
  return completed;
}

/**
 * Record a failed attempt: back to `pending` while retries remain, `failed`
 * once they are spent.
 *
 * The retry decision is made inside the statement, against the row's own
 * `attempts`, rather than from a number the caller read a moment ago — a
 * read-then-write would let two workers each see "one attempt left" and grant
 * themselves one more.
 *
 * `requeue: false` is for failures that will not change on a retry (a 404, a
 * refused URL): asking the site again would be rude and would still fail.
 */
export async function failUrl(
  db: Db,
  crawlId: string,
  url: string,
  opts: { requeue: boolean; maxAttempts: number },
): Promise<void> {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new RangeError(
      `failUrl: maxAttempts must be an integer ≥ 1, got ${opts.maxAttempts}`,
    );
  }

  await db.execute(sql`
    update frontier set
      state = case
        when ${opts.requeue} and attempts < ${opts.maxAttempts} then 'pending'
        else 'failed' end,
      lease_id = null, leased_until = null
    where crawl_id = ${crawlId} and url = ${url}`);
}

/**
 * Release leases back to `pending` so they can be picked up immediately.
 *
 * `leaseId` is the worker's own id on a graceful shutdown — never someone
 * else's. `null` means *every* live lease in the crawl, which is an operator
 * action for a crawl whose workers are known dead (a resume after a crash):
 * used while another worker is genuinely running, it hands that worker's URLs
 * to a second crawler. Returns the number of rows released.
 */
export async function releaseLeases(
  db: Db,
  crawlId: string,
  leaseId: string | null,
): Promise<number> {
  const scope =
    leaseId === null ? sql`` : sql` and lease_id = ${leaseId}`;
  const res = await db.execute(sql`
    update frontier set state = 'pending', lease_id = null, leased_until = null
    where crawl_id = ${crawlId} and state = 'leased'${scope}
    returning url`);
  return res.rows.length;
}

/**
 * How much of the crawl is left, as four numbers. One grouped query — a
 * per-state `count(*)` is the loop's "am I done" check and runs once per empty
 * lease, so it stays a single round trip.
 *
 * An unrecognised state throws rather than being counted into nothing: a row
 * in a state no one writes means the schema and this file have diverged, and
 * silently reporting a smaller frontier than exists is the kind of quiet
 * wrongness that ends a crawl early (hard rule 7).
 */
export async function frontierCounts(
  db: Db,
  crawlId: string,
): Promise<FrontierCounts> {
  const rows = await db
    .select({ state: frontier.state, n: sql<number>`count(*)::int` })
    .from(frontier)
    .where(eq(frontier.crawlId, crawlId))
    .groupBy(frontier.state);

  const counts: FrontierCounts = {
    pending: 0, leased: 0, done: 0, failed: 0, renderPending: 0,
  };
  for (const row of rows) {
    const state = STATES.find((s) => STATE_COLUMN[s] === row.state);
    if (state === undefined) {
      throw new Error(
        `frontierCounts: crawl ${crawlId} has ${row.n} row(s) in unknown state "${row.state}"`,
      );
    }
    counts[state] = row.n;
  }
  return counts;
}
