/**
 * The schedules store (Phase 28c): every read and write of `schedules`, each
 * filtered on the tenant in SQL. A schedule of another tenant is a schedule
 * that does not exist — `getSchedule` answers null, `updateSchedule` null,
 * `deleteSchedule` false — so a caller answers a foreign id exactly as a
 * missing one (404 `NOT_FOUND`) without a second code path.
 *
 * What a schedule stores is call C2's: the effective crawl config, its
 * judgement and its listed URLs, as `crawl_start`'s `planStart` produced them
 * (`ScheduleCrawl`). The credential values are in `schedule_credentials`,
 * through `CredentialVault.writeSchedule`, never here.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";

import { ServiceError } from "../api/errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/paging.js";
// Type only (erased): the surface's page shape is declared with the other response shapes.
import type { Page } from "../api/service.js";
import type { ChainRender, StoredConfig } from "../crawl/insert-crawl.js";
import { crawlEvents, crawls, schedules } from "../db/schema.js";
import type { JudgementBlock } from "../rules/judgement.js";
import type { TenantId } from "../tenant.js";
import type { Reader, Writer } from "../worker/jobs.js";

/**
 * `schedules.config` (call C2): what a fire inserts, planned once at create or
 * update. `config` is what `crawls.config_jsonb` stores, `judgement` is
 * `storableBlock()`'s output or null, `listed` a list crawl's distinct URLs in
 * list order or null on a spider crawl.
 */
export interface ScheduleCrawl {
  config: StoredConfig;
  judgement: JudgementBlock | null;
  listed: string[] | null;
}

/** A `schedules` row, as drizzle reads it: every column, the full `config` with it. */
export type ScheduleRow = typeof schedules.$inferSelect;

/**
 * A schedule as the surface reads it (final review M2): every column but
 * `config`, and of `config` only its crawl config (`config->'config'`). The
 * judgement and — for a list crawl — the listed URLs (up to a megabyte a row)
 * stay in the database: `schedule_list` reads up to 200 rows a page, and
 * nothing it answers needs them. Only a fire reads the full row (`ScheduleRow`,
 * src/schedule/fire.ts).
 */
export type ScheduleView = Omit<ScheduleRow, "config"> & { crawlConfig: StoredConfig };

/** The selection that reads a `ScheduleView`, for a select or a `returning`. */
export const scheduleViewColumns = {
  id: schedules.id,
  tenantId: schedules.tenantId,
  siteUrl: schedules.siteUrl,
  crawlConfig: sql<StoredConfig>`${schedules.config}->'config'`,
  render: schedules.render,
  cron: schedules.cron,
  timezone: schedules.timezone,
  enabled: schedules.enabled,
  nextRunAt: schedules.nextRunAt,
  lastCrawlId: schedules.lastCrawlId,
  credentialGeneration: schedules.credentialGeneration,
  createdAt: schedules.createdAt,
  updatedAt: schedules.updatedAt,
};

/** What `insertSchedule` writes; `created_at` and `updated_at` are the database's. */
export interface NewSchedule {
  id: string;
  tenant: TenantId;
  siteUrl: string;
  crawl: ScheduleCrawl;
  render: ChainRender | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** The first slot; null exactly when `enabled` is false (the table's check). */
  nextRunAt: Date | null;
}

/** The columns `updateSchedule` may change; any it is not given stay as they are. */
export interface SchedulePatch {
  siteUrl?: string;
  crawl?: ScheduleCrawl;
  render?: ChainRender | null;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  nextRunAt?: Date | null;
  lastCrawlId?: string | null;
}

/** A new schedule's id. */
export function newScheduleId(): string {
  return `sched_${randomUUID()}`;
}

export async function insertSchedule(tx: Writer, s: NewSchedule): Promise<ScheduleView> {
  const [row] = await tx
    .insert(schedules)
    .values({
      id: s.id,
      tenantId: s.tenant,
      siteUrl: s.siteUrl,
      config: s.crawl,
      render: s.render,
      cron: s.cron,
      timezone: s.timezone,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt,
    })
    .returning(scheduleViewColumns);
  if (row === undefined) throw new Error(`insertSchedule: the insert of ${s.id} returned no row`);
  return row;
}

/** The tenant's schedule `id`, or null when it is missing or another tenant's. */
export async function getSchedule(db: Reader, tenant: TenantId, id: string): Promise<ScheduleView | null> {
  const [row] = await db
    .select(scheduleViewColumns)
    .from(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.tenantId, tenant)));
  return row ?? null;
}

/**
 * The tenant's schedules, newest first — `(created_at, id)` descending, a total
 * order — a page at a time, with the surface's `limit` and opaque cursor
 * (src/api/paging.ts). A cursor that does not decode is a 400 `VALIDATION`.
 */
export async function listSchedules(
  db: Reader,
  tenant: TenantId,
  page: { limit?: number; cursor?: string },
): Promise<Page<ScheduleView>> {
  const limit = parseLimit(page.limit);
  const after = page.cursor === undefined ? null : decodeScheduleCursor(page.cursor);
  const predicates: SQL[] = [eq(schedules.tenantId, tenant)];
  if (after !== null) {
    predicates.push(
      sql`(${schedules.createdAt}, ${schedules.id}) < (${after.createdAt}::timestamptz, ${after.id}::text)`,
    );
  }
  const rows = await db
    .select({
      row: scheduleViewColumns,
      // THE CURSOR'S HALF OF THE SORT KEY, AND IT IS NOT `createdAt`: a JS
      // `Date` has milliseconds and the column has microseconds, so a cursor
      // built from the Date would skip or repeat rows created in the same
      // millisecond. The exact value, as text, is what the cursor carries
      // (the `listCrawls` precedent).
      createdAtExact: sql<string>`to_char(${schedules.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(schedules)
    .where(and(...predicates))
    .orderBy(sql`${schedules.createdAt} desc`, sql`${schedules.id} desc`)
    .limit(limit + 1);
  // One row past the page says whether there is a next one; it is dropped.
  const items = rows.slice(0, limit).map((r) => r.row);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { items, nextCursor: last === undefined ? null : encodeCursor(last.createdAtExact, last.row.id) };
}

/** The schedules cursor: the exact `created_at` (microseconds, UTC) and the id of the last row. */
function decodeScheduleCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = decodeCursor(cursor, 2);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) || !id.startsWith("sched_")) {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  }
  return { createdAt, id };
}

/**
 * Change the tenant's schedule `id` and stamp `updated_at`; the row as it now
 * is, or null when it is missing or another tenant's (nothing is written).
 */
export async function updateSchedule(
  tx: Writer,
  tenant: TenantId,
  id: string,
  patch: SchedulePatch,
): Promise<ScheduleView | null> {
  const [row] = await tx
    .update(schedules)
    .set({
      ...(patch.siteUrl === undefined ? {} : { siteUrl: patch.siteUrl }),
      ...(patch.crawl === undefined ? {} : { config: patch.crawl }),
      ...(patch.render === undefined ? {} : { render: patch.render }),
      ...(patch.cron === undefined ? {} : { cron: patch.cron }),
      ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.nextRunAt === undefined ? {} : { nextRunAt: patch.nextRunAt }),
      ...(patch.lastCrawlId === undefined ? {} : { lastCrawlId: patch.lastCrawlId }),
      // `clock_timestamp()`, not `now()`: a create and an update in one
      // transaction still order.
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(schedules.id, id), eq(schedules.tenantId, tenant)))
    .returning(scheduleViewColumns);
  return row ?? null;
}

/**
 * Delete the tenant's schedule `id`, in one transaction (a savepoint inside
 * the caller's): its own fire and skip events first — the `crawl_events` rows
 * with its id and no crawl, readable only through the schedule's history,
 * which is gone with it (Ruling P2) — then the row. Its credentials go with it
 * (cascade); its fired crawls, and their events, stay with `schedule_id`
 * nulled (ON DELETE SET NULL), so a chain in flight runs to its end (Review
 * Focus 4). True when a schedule was deleted, false when it was missing or
 * another tenant's (nothing is written).
 *
 * THE LOCK ORDER, AND WHY IT HAS NO CYCLE. Every other writer takes a crawl
 * row before the schedule row, or the schedule alone:
 *
 *  - a crawl status writer: its crawl row, then KEY SHARE on the schedule
 *    (the event's foreign key);
 *  - `crawl_delete`: its crawl `FOR UPDATE`, then — deleting the row — NO KEY
 *    UPDATE on the schedule (`last_crawl_id` ON DELETE SET NULL);
 *  - the fire (src/schedule/fire.ts): the schedule NO KEY UPDATE, then it
 *    INSERTS a crawl — it never waits on an existing crawl row;
 *  - `schedule_update`: the schedule alone; a job's trigger: KEY SHARE on the
 *    schedule alone (migration 0049); the job claim: KEY SHARE on a crawl,
 *    SKIP LOCKED.
 *
 * So this delete takes them in that order, and never WAITS on a crawl while it
 * holds the schedule:
 *
 *  1. the schedule's crawls, `FOR NO KEY UPDATE` (as every crawl-row lock,
 *     src/worker/reaper.ts), waiting as any crawl writer would;
 *  2. the schedule `FOR UPDATE` — which waits out a fire in flight, after
 *     which no fire can start (its claim skips a locked row) and no crawl can
 *     be inserted with this `schedule_id` (its foreign key needs KEY SHARE);
 *  3. the schedule's crawls again, `SKIP LOCKED`: a crawl fired between 1 and
 *     2 is committed by now and is locked here too — unless another writer
 *     holds it (a runner's status write, a `crawl_delete`), which may itself
 *     be waiting on this schedule. Then nothing is waited on: the attempt
 *     rolls back, releasing the schedule, and starts again, when step 1 waits
 *     for that crawl in order. Fires are one a slot, so a second attempt is
 *     the rare case; a `DELETE_ATTEMPTS`th that still meets one throws.
 *
 * With every crawl of the schedule held, the delete's ON DELETE SET NULL waits
 * on nothing, and a status write that waited on a crawl here runs after the
 * delete on a row whose `schedule_id` is null.
 */
export async function deleteSchedule(db: Writer, tenant: TenantId, id: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => deleteScheduleOnce(tx, tenant, id));
    } catch (error) {
      if (!(error instanceof FiredCrawlHeld)) throw error;
      if (attempt >= DELETE_ATTEMPTS) {
        throw new Error(
          `deleteSchedule: ${id}: on each of ${DELETE_ATTEMPTS} attempts a crawl it fired during the delete ` +
            `was held by another writer (last: ${error.crawlIds.join(", ")}); nothing was deleted`,
          { cause: error },
        );
      }
    }
  }
}

/** How many times `deleteSchedule` starts again when a crawl fired mid-delete is held by another writer. */
const DELETE_ATTEMPTS = 5;

/** A crawl this schedule fired while the delete waited could not be locked without waiting: start again. */
class FiredCrawlHeld extends Error {
  constructor(readonly crawlIds: readonly string[]) {
    super(`fired crawl(s) ${crawlIds.join(", ")} held by another writer`);
    this.name = "FiredCrawlHeld";
  }
}

type WriterTx = Parameters<Parameters<Writer["transaction"]>[0]>[0];

/** One attempt of `deleteSchedule` (its docblock has the order); throws `FiredCrawlHeld` to start again. */
async function deleteScheduleOnce(tx: WriterTx, tenant: TenantId, id: string): Promise<boolean> {
  const ofSchedule = and(eq(crawls.scheduleId, id), eq(crawls.tenantId, tenant));
  // 1. Its crawls, waiting for them in order.
  await tx.select({ id: crawls.id }).from(crawls).where(ofSchedule).orderBy(asc(crawls.id)).for("no key update");
  // 2. The schedule, locked, before anything is deleted: an event deleted for
  // a schedule that then turned out to be foreign would be another tenant's
  // history lost.
  const [held] = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.tenantId, tenant)))
    .for("update");
  if (held === undefined) return false;
  // 3. Its crawls again — now including any fired between 1 and 2 — without waiting.
  const locked = await tx
    .select({ id: crawls.id })
    .from(crawls)
    .where(ofSchedule)
    .orderBy(asc(crawls.id))
    .for("no key update", { skipLocked: true });
  const all = await tx.select({ id: crawls.id }).from(crawls).where(ofSchedule);
  const lockedIds = new Set(locked.map((c) => c.id));
  const busy = all.map((c) => c.id).filter((crawlId) => !lockedIds.has(crawlId));
  if (busy.length > 0) throw new FiredCrawlHeld(busy);
  await tx
    .delete(crawlEvents)
    .where(and(eq(crawlEvents.scheduleId, id), eq(crawlEvents.tenantId, tenant), isNull(crawlEvents.crawlId)));
  const gone = await tx.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.tenantId, tenant)));
  if (gone.rowCount !== 1) {
    throw new Error(`deleteSchedule: deleting ${id} removed ${String(gone.rowCount)} rows, not 1`);
  }
  return true;
}
