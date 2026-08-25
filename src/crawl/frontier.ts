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
 * Concurrency safety lives in one statement, `leaseBatch`: an `UPDATE` whose
 * row set comes from a `SELECT … FOR UPDATE SKIP LOCKED` sub-select. Two
 * workers leasing at the same instant get disjoint batches because the second
 * one skips the rows the first has locked, rather than blocking on them or —
 * far worse — reading them as available. Do not reshape it into a read then a
 * write: that gap is exactly where two workers crawl the same URL twice.
 *
 * The URL a row is keyed by is `normalizeUrl` output (url-utils), which is the
 * single frontier-key authority. This module does not normalise: it stores the
 * key it is given, so a caller that skips normalisation gets duplicate rows
 * rather than a silently rewritten URL.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { frontier } from "../db/schema.js";

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
}

/** The states a frontier row may be in. Anything else is a defect. */
const STATES = ["pending", "leased", "done", "failed"] as const;

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
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`leaseBatch: n must be an integer ≥ 1, got ${n}`);
  }
  if (!Number.isFinite(leaseSeconds) || leaseSeconds < 0) {
    throw new RangeError(
      `leaseBatch: leaseSeconds must be ≥ 0, got ${leaseSeconds}`,
    );
  }

  const res = await db.execute(sql`
    update frontier set state = 'leased', lease_id = ${leaseId},
      leased_until = now() + make_interval(secs => ${leaseSeconds}::double precision),
      attempts = attempts + 1
    where (crawl_id, url) in (
      select crawl_id, url from frontier
      where crawl_id = ${crawlId}
        and (state = 'pending' or (state = 'leased' and leased_until < now()))
      order by depth asc, discovered_at asc
      limit ${n}
      for update skip locked)
    returning url, depth, discovered_via, attempts`);

  return res.rows.map((r) => ({
    url: r["url"] as string,
    depth: Number(r["depth"]),
    discoveredVia: r["discovered_via"] as string,
    attempts: Number(r["attempts"]),
  }));
}

/** Mark one URL finished. Its lease is cleared; it is never leased again. */
export async function completeUrl(
  db: Db,
  crawlId: string,
  url: string,
): Promise<void> {
  await db.execute(sql`
    update frontier set state = 'done', lease_id = null, leased_until = null
    where crawl_id = ${crawlId} and url = ${url}`);
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

  const counts: FrontierCounts = { pending: 0, leased: 0, done: 0, failed: 0 };
  for (const row of rows) {
    const state = STATES.find((s) => s === row.state);
    if (state === undefined) {
      throw new Error(
        `frontierCounts: crawl ${crawlId} has ${row.n} row(s) in unknown state "${row.state}"`,
      );
    }
    counts[state] = row.n;
  }
  return counts;
}
