/**
 * A schedule's fire (Phase 28c): `fireDue` fires, or skips, every schedule
 * whose `next_run_at` has come, one transaction per schedule. The scheduler's
 * leader calls it each tick (src/schedule/scheduler.ts); a test calls it with
 * the instant it wants.
 *
 * ONE SCHEDULE, ONE TRANSACTION:
 *
 *  1. CLAIM the earliest due schedule `FOR NO KEY UPDATE SKIP LOCKED`. Not
 *     `FOR UPDATE`: every event of a fired crawl takes KEY SHARE on its
 *     schedule through `crawl_events.schedule_id`'s foreign key, and
 *     `FOR UPDATE` would hold those status writes until the fire commits. NO
 *     KEY UPDATE still serialises two claimers, `schedule_update` (which locks
 *     the row the same way) and `schedule_delete` (which takes it the same way
 *     first). SKIP LOCKED: a second `fireDue` — another leader for a moment, or
 *     a test — passes over a schedule being fired and finds it not due once
 *     the first commits, so a slot fires once.
 *  2. SKIP, in this order (globals "Skip reasons"):
 *     - `overlap`: a crawl this schedule fired is `queued | running | paused`,
 *       or has a `queued | running` job (a chain link). The event names it.
 *     - `not-allowed`: the process's allowlist refuses a host the crawl would
 *       fetch (`crawlAllowlistRefusal`, as a worker re-checks it at claim).
 *     - `credentials_unreadable` (C5): the schedule's stored copy cannot be
 *       decrypted with this process's keys. Nothing fires without them.
 *  3. Or FIRE: the stored crawl (call C2: no re-plan) through `insertCrawl`,
 *     with the schedule's id and chain, this process's pin (C4), and the
 *     credentials re-encrypted under the new crawl. `last_crawl_id` is set.
 *  4. Record `schedule_fired{crawlId}` or `schedule_skipped{reason[, crawlId]}`
 *     (C9: `crawl_id` null, `schedule_id` set), and move `next_run_at` to the
 *     first slot strictly after `now` — so slots missed while nobody led fire
 *     once, not once each.
 *
 * NO SLOT LEFT. A schedule whose cron has no slot within the horizon any more
 * (a leap day, a year on) cannot keep `enabled` with a null `next_run_at`
 * (the table's check), so the fire or skip that finds it so disables it in the
 * same transaction — `enabled` false, `next_run_at` null — and says so in the
 * log, naming the schedule. `schedule_get` answers `enabled: false`.
 *
 * A DEFECT IS LOUD, AND STARVES NOTHING. A schedule whose fire throws (a stored
 * row this engine never writes) rolls back alone: it stays due, the remaining
 * due schedules are fired, and `fireDue` then throws naming every schedule
 * that failed. The scheduler logs that and tries again at its next tick.
 *
 * `updated_at` is not stamped by a fire: it records changes to the schedule's
 * definition (`schedule_update`); a fire's record is its event.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { schedules } from "../db/schema.js";
import type { CredentialVault } from "../crawl/credential-vault.js";
import { sameShape, shapeOf, type CrawlCredentials } from "../crawl/credentials.js";
import { insertCrawl } from "../crawl/insert-crawl.js";
import { storedCredentialShape } from "../crawl/loop.js";
import { recordEvent } from "../events/events.js";
import type { TenantId } from "../tenant.js";
import { crawlAllowlistRefusal } from "../worker/crawl-job.js";
import { NoCronSlotError, nextSlot } from "./cron.js";
import type { ScheduleRow } from "./store.js";

export interface FireDeps {
  vault: CredentialVault;
  /** This process's crawl allowlist: the API's own gate, or a worker's. */
  hostAllowed: (host: string) => boolean;
  /** The fired crawl job's pin (C4): an in-process service's own instance; null in a worker or `workers` mode. */
  pin: string | null;
  log: (line: string) => void;
  /**
   * TEST ONLY (call C3, like the reaper's `onlyInstances`, R11): fire only
   * these tenants' schedules. Code-only — never read from the environment;
   * production never passes it.
   */
  onlyTenants?: readonly string[];
}

export interface FireSummary {
  fired: number;
  skipped: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type SkipReason = "overlap" | "not-allowed" | "credentials_unreadable";

/**
 * Fire or skip every schedule due at `now` (module header), and answer how
 * many of each. Throws, after the others are done, when any schedule's own
 * transaction threw — naming each one.
 */
export async function fireDue(db: Db, deps: FireDeps, now: Date): Promise<FireSummary> {
  if (Number.isNaN(now.getTime())) throw new Error("fireDue: `now` is not a valid instant");
  if (deps.onlyTenants !== undefined && deps.onlyTenants.length === 0) {
    throw new Error("fireDue: onlyTenants is empty, which confines the scheduler to nothing (omit it instead)");
  }
  const summary: FireSummary = { fired: 0, skipped: 0 };
  // The schedules whose transaction threw in this call, by id: passed over so
  // the next claim finds the next one, not the same one again.
  const failed = new Map<string, unknown>();
  for (;;) {
    const claimed: { id: string | null } = { id: null };
    let outcome: "fired" | "skipped" | null;
    try {
      outcome = await db.transaction(async (tx) => {
        const schedule = await claimDue(tx, now, deps.onlyTenants, [...failed.keys()]);
        if (schedule === null) return null;
        claimed.id = schedule.id;
        return await fireOrSkip(tx, deps, schedule, now);
      });
    } catch (error) {
      // The claim itself failed: there is nothing to pass over, and nothing
      // more this call can do.
      if (claimed.id === null) throw error;
      failed.set(claimed.id, error);
      continue;
    }
    if (outcome === null) break;
    summary[outcome] += 1;
  }
  if (failed.size > 0) {
    const each = [...failed].map(([id, error]) => `${id}: ${messageOf(error)}`).join("; ");
    throw new Error(
      `fireDue: ${failed.size} due schedule(s) could not be fired or skipped, and stay due ` +
        `(${summary.fired} fired, ${summary.skipped} skipped besides) — ${each}`,
      { cause: [...failed.values()][0] },
    );
  }
  return summary;
}

/** The earliest due schedule, locked `FOR NO KEY UPDATE SKIP LOCKED`, or null. */
async function claimDue(
  tx: Tx,
  now: Date,
  onlyTenants: readonly string[] | undefined,
  passOver: readonly string[],
): Promise<ScheduleRow | null> {
  const predicates: SQL[] = [eq(schedules.enabled, true), lte(schedules.nextRunAt, now)];
  if (onlyTenants !== undefined) predicates.push(inArray(schedules.tenantId, [...onlyTenants]));
  if (passOver.length > 0) predicates.push(notInArray(schedules.id, [...passOver]));
  const [row] = await tx
    .select()
    .from(schedules)
    .where(and(...predicates))
    .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
    .limit(1)
    .for("no key update", { skipLocked: true });
  return row ?? null;
}

async function fireOrSkip(tx: Tx, deps: FireDeps, schedule: ScheduleRow, now: Date): Promise<"fired" | "skipped"> {
  // The claim's own predicate, which Postgres re-evaluates on the row it
  // locks: a row that is not due here is a defect, not a slot to fire.
  if (schedule.nextRunAt === null || schedule.nextRunAt.getTime() > now.getTime() || !schedule.enabled) {
    throw new Error(
      `schedule ${schedule.id}: claimed as due at ${now.toISOString()}, and its row is ` +
        `${schedule.enabled ? "enabled" : "disabled"} with next_run_at ${schedule.nextRunAt?.toISOString() ?? "null"}`,
    );
  }
  const tenant = schedule.tenantId as TenantId;
  const stored = schedule.config;

  const holder = await overlapHolder(tx, schedule);
  if (holder !== null) return await skip(tx, deps, schedule, now, "overlap", holder);

  const refusal = crawlAllowlistRefusal(stored.config, deps.hostAllowed);
  if (refusal !== null) {
    deps.log(`scheduler: schedule ${schedule.id} skipped its slot (not-allowed) — ${refusal}`);
    return await skip(tx, deps, schedule, now, "not-allowed", null);
  }

  const credentials = await credentialsOf(tx, deps, schedule);
  if (credentials === "unreadable") return await skip(tx, deps, schedule, now, "credentials_unreadable", null);

  const crawlId = `crawl_${randomUUID()}`;
  await insertCrawl(tx, deps.vault, {
    tenant,
    crawlId,
    config: stored.config,
    judgement: stored.judgement,
    ...(credentials === null ? {} : { credentials }),
    listed: stored.listed,
    ...(deps.pin === null ? {} : { pinnedTo: deps.pin }),
    scheduleId: schedule.id,
    chain: { render: schedule.render },
  });
  await recordEvent(tx, {
    tenant,
    crawlId: null,
    scheduleId: schedule.id,
    kind: "schedule_fired",
    detail: { crawlId },
  });
  await advance(tx, deps, schedule, now, crawlId);
  return "fired";
}

/**
 * The newest crawl this schedule fired that still holds its slot: `queued |
 * running | paused`, or with a `queued | running` job on it. Null when none.
 */
async function overlapHolder(tx: Tx, schedule: ScheduleRow): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`
    select c.id from crawls c
     where c.schedule_id = ${schedule.id} and c.tenant_id = ${schedule.tenantId}
       and (c.status in ('queued', 'running', 'paused')
            or exists (select 1 from jobs j where j.crawl_id = c.id and j.status in ('queued', 'running')))
     order by c.started_at desc, c.id desc
     limit 1`);
  return result.rows[0]?.id ?? null;
}

/**
 * The credentials the fired crawl takes: null when the stored config names
 * none, `unreadable` when the stored copy cannot be decrypted here (C5, logged
 * with the reason). The config's shape and the stored copy are written
 * together (`schedule_create`, `schedule_update`), so a copy without a shape,
 * a shape without a copy, or a copy of another shape is a defect, and throws.
 */
async function credentialsOf(
  tx: Tx,
  deps: FireDeps,
  schedule: ScheduleRow,
): Promise<CrawlCredentials | null | "unreadable"> {
  const required = storedCredentialShape(schedule.config.config, schedule.id);
  const read = await deps.vault.readSchedule(schedule.id, tx);
  if (required === null) {
    if (read.kind === "none") return null;
    throw new Error(
      `schedule ${schedule.id} names no credentials and has a stored copy; the two are written together, ` +
        "so this is a defect",
    );
  }
  switch (read.kind) {
    case "none":
      throw new Error(
        `schedule ${schedule.id} names credentials and has no stored copy of them; the two are written ` +
          "together, so this is a defect",
      );
    case "unreadable":
      deps.log(
        `scheduler: schedule ${schedule.id} skipped its slot (credentials_unreadable) — its stored ` +
          `credentials cannot be read with this process's keys (${read.reason}); schedule_update with the ` +
          "credentials again stores a copy this deployment can read",
      );
      return "unreadable";
    case "ok":
      if (!sameShape(shapeOf(read.credentials), required)) {
        throw new Error(
          `schedule ${schedule.id}: its stored credentials are not of the shape its config names; the two ` +
            "are written together, so this is a defect",
        );
      }
      return read.credentials;
  }
}

async function skip(
  tx: Tx,
  deps: FireDeps,
  schedule: ScheduleRow,
  now: Date,
  reason: SkipReason,
  holder: string | null,
): Promise<"skipped"> {
  await recordEvent(tx, {
    tenant: schedule.tenantId as TenantId,
    crawlId: null,
    scheduleId: schedule.id,
    kind: "schedule_skipped",
    detail: holder === null ? { reason } : { reason, crawlId: holder },
  });
  await advance(tx, deps, schedule, now, null);
  return "skipped";
}

/**
 * Move the schedule to its first slot strictly after `now`, and to the crawl
 * just fired when there is one; or, when its cron has no slot left within the
 * horizon, disable it (module header).
 */
async function advance(tx: Tx, deps: FireDeps, schedule: ScheduleRow, now: Date, firedCrawlId: string | null): Promise<void> {
  let next: Date | null;
  try {
    next = nextSlot(schedule.cron, schedule.timezone, now);
  } catch (error) {
    if (!(error instanceof NoCronSlotError)) throw error;
    next = null;
  }
  const where = and(eq(schedules.id, schedule.id), eq(schedules.tenantId, schedule.tenantId));
  const lastCrawl = firedCrawlId === null ? {} : { lastCrawlId: firedCrawlId };
  const updated = await tx
    .update(schedules)
    .set(next === null ? { enabled: false, nextRunAt: null, ...lastCrawl } : { nextRunAt: next, ...lastCrawl })
    .where(where);
  if (updated.rowCount !== 1) {
    throw new Error(`schedule ${schedule.id}: advancing its slot updated ${String(updated.rowCount)} rows, not 1`);
  }
  if (next === null) {
    deps.log(
      `scheduler: schedule ${schedule.id} is now DISABLED — its cron '${schedule.cron}' in ${schedule.timezone} ` +
        `has no slot within a year of ${now.toISOString()}; it fires again only once schedule_update gives ` +
        "it a cron with one and enables it",
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
