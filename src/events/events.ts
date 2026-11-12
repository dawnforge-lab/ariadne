/**
 * Crawl events (Phase 28c): a crawl's history, one row per lifecycle event in
 * `crawl_events` (src/db/schema.ts), read by `crawl_history`.
 *
 * ## Who writes what (call C1)
 *
 * The LIFECYCLE kinds are written by the database: `ariadne_crawl_event()` and
 * `ariadne_job_event()` (migration 0046) fire on every write of a crawl's or a
 * job's status, so no writer of either can forget one. The application writes
 * only `APP_EVENT_KINDS`, the schedule's own, through `recordEvent` — which
 * refuses any other kind, so a lifecycle event is never written twice.
 *
 * The trigger SQL repeats the lifecycle kinds as literals; the events test
 * reads them back from `pg_proc` and pins them to `EVENT_KINDS`.
 *
 * ## Detail
 *
 * `EVENT_DETAIL_KEYS[kind]` is the closed set of keys an event of that kind may
 * carry. The triggers build detail from named columns only; `recordEvent`
 * refuses a key outside the set, naming the kind and the key's POSITION, never
 * the key (27d spec §4: a key may be a value pasted into the wrong place). No
 * detail ever carries a credential name or value, or a key a client sent.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";

import { crawlEvents } from "../db/schema.js";
import { ServiceError } from "../api/errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/paging.js";
// Type only (erased): the surface's page shape is declared with the other response shapes.
import type { Page } from "../api/service.js";
import type { Writer } from "../worker/jobs.js";
import type { TenantId } from "../tenant.js";

/** Every kind an event can have — the triggers' and the application's together. */
export const EVENT_KINDS = [
  "queued",
  "claimed",
  "started",
  "paused",
  "resumed",
  "cancelled",
  "finished",
  "failed",
  "render_queued",
  "render_started",
  "render_finished",
  "rules_queued",
  "rules_started",
  "rules_finished",
  "worker_lost",
  "schedule_fired",
  "schedule_skipped",
  "schedule_chain_failed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** The kinds the application writes (`recordEvent`); the triggers write every other one. */
export const APP_EVENT_KINDS = ["schedule_fired", "schedule_skipped", "schedule_chain_failed"] as const satisfies readonly EventKind[];

export type AppEventKind = (typeof APP_EVENT_KINDS)[number];

/**
 * The keys each kind's `detail` may carry, and no others.
 *
 *  - `claimed`: the claiming instance and its role (`instances.role`).
 *  - `paused`, `failed`: the crawl's `pause_reason` / `failure_reason`.
 *  - `resumed.auto`: true when the reaper requeued the crawl (a `worker_lost`
 *    or a `shutdown` pause), false when an agent's `crawl_resume` did.
 *  - `finished.pagesCrawled`; `*_finished.outcome`: the job's settled status.
 *  - `schedule_fired.crawlId`: the crawl it started (C9: the event's own
 *    `crawl_id` is null, so the record outlives a deleted crawl).
 *  - `schedule_skipped`: `reason` (`overlap | not-allowed |
 *    credentials_unreadable`), and on `overlap` the holding crawl's `crawlId`.
 *  - `schedule_chain_failed`: the chain `link` and the `reason`.
 */
export const EVENT_DETAIL_KEYS: Record<EventKind, readonly string[]> = {
  queued: [],
  claimed: ["instanceId", "role"],
  started: [],
  paused: ["reason"],
  resumed: ["auto"],
  cancelled: [],
  finished: ["pagesCrawled"],
  failed: ["reason"],
  render_queued: [],
  render_started: [],
  render_finished: ["outcome"],
  rules_queued: [],
  rules_started: [],
  rules_finished: ["outcome"],
  worker_lost: [],
  schedule_fired: ["crawlId"],
  schedule_skipped: ["reason", "crawlId"],
  schedule_chain_failed: ["link", "reason"],
};

/** One event, as `crawl_history` answers it. */
export interface CrawlEvent {
  /** The event's id: its place in the order, as a decimal string. */
  id: string;
  /** When it was written (ISO 8601). */
  at: string;
  kind: EventKind;
  scheduleId: string | null;
  crawlId: string | null;
  detail: Record<string, unknown>;
}

/**
 * Write one application event (a schedule kind), inside the caller's
 * transaction when given one. Throws — writing nothing — on a lifecycle kind
 * (the triggers' to write), or a detail key outside `EVENT_DETAIL_KEYS[kind]`,
 * named by its position in the order sent and never by its text.
 */
export async function recordEvent(
  tx: Writer,
  e: {
    tenant: TenantId;
    crawlId: string | null;
    scheduleId: string | null;
    kind: AppEventKind;
    detail: Record<string, string | number | boolean>;
  },
): Promise<void> {
  if (!(APP_EVENT_KINDS as readonly string[]).includes(e.kind)) {
    throw new Error(
      `recordEvent: '${String(e.kind)}' is written by the database's triggers, not the application ` +
        `(the application writes ${APP_EVENT_KINDS.join(", ")})`,
    );
  }
  const allowed = EVENT_DETAIL_KEYS[e.kind];
  Object.entries(e.detail).forEach(([key, value], index) => {
    if (!allowed.includes(key)) {
      throw new Error(
        `recordEvent: a '${e.kind}' event's detail key ${index + 1} in the order sent is not one it ` +
          `may carry (allowed: ${allowed.length === 0 ? "none" : allowed.join(", ")})`,
      );
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(
        `recordEvent: a '${e.kind}' event's detail key ${index + 1} in the order sent has a value of ` +
          `type ${value === null ? "null" : typeof value}; a detail value is a string, a number or a boolean`,
      );
    }
  });
  await tx.insert(crawlEvents).values({
    tenantId: e.tenant,
    crawlId: e.crawlId,
    scheduleId: e.scheduleId,
    kind: e.kind,
    detail: e.detail,
  });
}

/**
 * A crawl's or a schedule's events, oldest first, a page at a time: keyset on
 * `id`, with the surface's `limit` and opaque cursor (src/api/paging.ts). The
 * tenant is always a predicate. A missing or foreign crawl or schedule is the
 * caller's to refuse first: this answers an empty page for one.
 */
export async function listEvents(
  db: Writer,
  where: { tenant: TenantId; crawlId: string } | { tenant: TenantId; scheduleId: string },
  page: { limit?: number; cursor?: string },
): Promise<Page<CrawlEvent>> {
  const limit = parseLimit(page.limit);
  const after = page.cursor === undefined ? null : decodeEventCursor(page.cursor);
  const predicates: SQL[] = [
    eq(crawlEvents.tenantId, where.tenant),
    "crawlId" in where ? eq(crawlEvents.crawlId, where.crawlId) : eq(crawlEvents.scheduleId, where.scheduleId),
  ];
  if (after !== null) predicates.push(gt(crawlEvents.id, sql`${after}::bigint`));
  const rows = await db
    .select({
      id: sql<string>`${crawlEvents.id}::text`,
      at: crawlEvents.at,
      kind: crawlEvents.kind,
      scheduleId: crawlEvents.scheduleId,
      crawlId: crawlEvents.crawlId,
      detail: crawlEvents.detail,
    })
    .from(crawlEvents)
    .where(and(...predicates))
    .orderBy(asc(crawlEvents.id))
    .limit(limit + 1);
  // One row past the page says whether there is a next one; it is dropped.
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    kind: readKind(row.kind, row.id),
    scheduleId: row.scheduleId,
    crawlId: row.crawlId,
    detail: row.detail,
  }));
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { items, nextCursor: last === undefined ? null : encodeCursor(last.id) };
}

/** The events cursor: one event id, a positive whole number. */
function decodeEventCursor(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  if (!/^[1-9][0-9]{0,17}$/.test(id)) {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  }
  return id;
}

/** A stored kind this code does not know is a defect, not an event to pass on. */
function readKind(value: string, id: string): EventKind {
  const kind = EVENT_KINDS.find((k) => k === value);
  if (kind === undefined) {
    throw new Error(`crawl event ${id} has kind '${value}', which this engine never writes`);
  }
  return kind;
}
