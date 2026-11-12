/**
 * The scheduler (Phase 28c): ONE leader among every process that runs one,
 * by a Postgres advisory lock, firing the due schedules (`fireDue`,
 * src/schedule/fire.ts) once per `timing.scheduleEvery`.
 *
 * WHO RUNS ONE (call C3). `ServiceConfig.scheduler` and `StartWorkerOptions.
 * scheduler` are off by default; `api:serve` and `worker:serve` turn them on,
 * so every long-lived deployed process is a candidate. The stdio MCP entry is
 * not one: it lives as long as one agent session, and a leader that exits
 * strands the crawls pinned to it.
 *
 * LEADERSHIP. A candidate opens a dedicated `pg.Client` — not a pool
 * connection: a session-level advisory lock belongs to the session — whose
 * `application_name` is `ariadne-scheduler:<instanceId>` (the gate finds the
 * leader through it), and tries `pg_try_advisory_lock(SCHEDULER_LOCK)` on it
 * every `scheduleEvery`; a try that fails ends that client. The one that gets
 * the lock keeps its client and leads: at each tick it confirms its session
 * still holds the lock and runs `fireDue` (on the pool). The lock is the
 * session's, so a leader whose process or connection dies releases it with the
 * session, and another candidate leads at its next tick.
 *
 * A LOST CONNECTION. An error on the dedicated client — the leader's backend
 * terminated, the network gone — is logged (`scheduler: lost the leader lock
 * — …`), the client is ended, and the process is a candidate again, on a fresh
 * client, after one tick's pause — so another candidate, if there is one,
 * takes over within one `scheduleEvery` (Review Focus 3) rather than the
 * process whose connection just failed racing it back. It fires nothing until
 * it leads again.
 *
 * NO SILENT HANG, ON THIS SIDE. The client has TCP keepalive on, and every
 * connect and query on it is bounded by `queryTimeoutMs`
 * (`SCHEDULER_QUERY_TIMEOUT_MS`): a half-open connection — a query that is
 * never answered — is a timeout, which takes the lost-connection path above
 * and is logged like any other loss. So every query on the dedicated client
 * ends within that bound, and `stop()`'s release does too. `fireDue` is not
 * bounded here: it runs on the pool, which sets no query timeout, so a tick —
 * and `stop()`, which waits for the tick in flight — lasts as long as that
 * fire's transactions do.
 *
 * NO ZOMBIE LEADER, ON THE SERVER'S SIDE (final review I3). A network partition
 * ends the leader's view of its session at once (the timeout above), but the
 * SERVER keeps the session — and with it the lock — until its own TCP stack
 * calls the peer dead: by the server's defaults, over two hours, during which
 * no candidate can lead. So the session is opened with server-side keepalives
 * (`SCHEDULER_SESSION_OPTIONS`: idle 30 s, then 3 probes 10 s apart), and the
 * server ends a partitioned leader's session — freeing the lock — about a
 * minute after its last traffic; another candidate leads at its next try.
 * (`idle_session_timeout` is not set: a leader's session is idle while a long
 * `fireDue` runs on the pool, and a timeout there would end a healthy lead.)
 *
 * WHO HOLDS IT. A candidate whose try fails reads the holder's
 * `application_name` and backend pid (`pg_locks` ⨝ `pg_stat_activity`) and
 * logs it once per change of holder, so an operator sees which process leads
 * — or that something other than a scheduler holds the key.
 *
 * NO SLOT FIRES TWICE, whatever leadership does: two processes may both
 * believe they lead for the instant between a leader's session dying and its
 * error arriving, and `fireDue`'s claim (`FOR NO KEY UPDATE SKIP LOCKED`, with
 * the slot moved in the same transaction) fires each slot once regardless.
 * The lock saves work; the claim is the guarantee.
 *
 * A FAILED TICK is logged and tried again at the next one. Nothing here throws
 * into the void or ends the process.
 *
 * THE FIRST TRY is one `scheduleEvery` after `start()`, as the reaper's first
 * tick is: a process that boots and stops at once (the entry points' boot
 * tests) never leads.
 */
import pg from "pg";

import type { Db } from "../db/client.js";
import type { Timing } from "../worker/timing.js";
import { fireDue, type FireDeps } from "./fire.js";

/** The advisory lock key every production scheduler contends for. */
export const SCHEDULER_LOCK = 2_028_004_002;

/**
 * How long a connect or a query on the scheduler's own client may take before
 * the connection is called lost (module header, "No silent hang"). Its queries
 * are a lock try and a `pg_locks` read, answered in milliseconds by a live
 * server.
 */
export const SCHEDULER_QUERY_TIMEOUT_MS = 5_000;

/**
 * The scheduler session's server-side TCP keepalives (module header, "No
 * zombie leader"): the server probes a silent peer after 30 s and calls it dead
 * after 3 unanswered probes 10 s apart, ending the session and its lock.
 */
export const SCHEDULER_SESSION_OPTIONS =
  "-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3";

/** Postgres keeps this many bytes of an `application_name` (NAMEDATALEN - 1) and silently drops the rest. */
const APPLICATION_NAME_MAX_BYTES = 63;

/**
 * TEST ONLY (call C3): a lock key of the test's own, and the tenants whose
 * schedules it fires. Code-only, like the reaper's `onlyInstances` (R11):
 * nothing reads either from the environment, and production passes neither
 * (`scheduler: true`).
 */
export interface SchedulerTestSeam {
  lockKey?: number;
  onlyTenants?: readonly string[];
}

export interface SchedulerDeps extends FireDeps {
  /** This process's instance: its connection's `application_name`, and its log lines. */
  instanceId: string;
  timing: Timing;
  /** TEST ONLY (`SchedulerTestSeam`): `SCHEDULER_LOCK` when absent. */
  lockKey?: number;
  /** TEST ONLY: `SCHEDULER_QUERY_TIMEOUT_MS` when absent. Code-only. */
  queryTimeoutMs?: number;
}

/**
 * The URL the pool of `db` connects with, for the scheduler's own client.
 * `createDb` always gives one; a pool built without one is refused, by name,
 * rather than a scheduler connecting to some default database.
 */
export function connectionStringOf(db: Db): string {
  const url = db.$pool.options.connectionString;
  if (typeof url !== "string" || url === "") {
    throw new Error(
      "scheduler: the database pool has no connectionString, so the scheduler cannot open its own " +
        "connection to the same database (build the Db with createDb)",
    );
  }
  return url;
}

export class Scheduler {
  readonly instanceId: string;
  private readonly lockKey: number;
  private readonly queryTimeoutMs: number;
  private readonly applicationName: string;
  /** The leader's session; null while this process does not lead. */
  private client: pg.Client | null = null;
  private leading = false;
  /** Set when the lead is lost: the next try is skipped (`tryLead`). */
  private pauseOneTry = false;
  /** The holder last logged by a failed try (`pid:application_name`), so a holder is logged once. */
  private lastHolder: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: ticks never overlap. */
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly db: Db,
    private readonly deps: SchedulerDeps,
  ) {
    if (databaseUrl === "") throw new Error("Scheduler: databaseUrl is empty");
    this.instanceId = deps.instanceId;
    this.lockKey = deps.lockKey ?? SCHEDULER_LOCK;
    if (!Number.isSafeInteger(this.lockKey)) {
      throw new Error(`Scheduler: lockKey must be a whole number, got ${String(this.lockKey)}`);
    }
    this.queryTimeoutMs = deps.queryTimeoutMs ?? SCHEDULER_QUERY_TIMEOUT_MS;
    if (!Number.isInteger(this.queryTimeoutMs) || this.queryTimeoutMs <= 0) {
      throw new Error(`Scheduler: queryTimeoutMs must be a positive whole number, got ${String(this.queryTimeoutMs)}`);
    }
    this.applicationName = `ariadne-scheduler:${deps.instanceId}`;
    // Truncated, the name would not find the leader (module header).
    if (Buffer.byteLength(this.applicationName, "utf8") > APPLICATION_NAME_MAX_BYTES) {
      throw new Error(
        `Scheduler: the application_name '${this.applicationName}' is longer than the ` +
          `${APPLICATION_NAME_MAX_BYTES} bytes Postgres keeps`,
      );
    }
  }

  /** Tick once per `timing.scheduleEvery`, the first one period from now. */
  start(): void {
    if (this.timer !== null || this.stopped) throw new Error(`scheduler ${this.instanceId}: already started or stopped`);
    this.timer = setInterval(() => {
      if (this.ticking === null) void this.tickOnce();
    }, this.deps.timing.scheduleEvery);
    // The scheduler alone never keeps a process alive.
    this.timer.unref();
  }

  isLeader(): boolean {
    return this.leading;
  }

  /**
   * One tick, after any tick in flight: a candidate tries the lock, and a
   * leader — including one that just took it — fires what is due at `now`
   * (the time the tick runs when absent). Never rejects: a failure is logged.
   */
  tickOnce(now?: Date): Promise<void> {
    const previous = this.ticking ?? Promise.resolve();
    const run = previous
      .then(() => this.tick(now ?? new Date()))
      .catch((error: unknown) => {
        this.deps.log(`scheduler ${this.instanceId}: a tick failed — ${messageOf(error)}; retrying at the next tick`);
      })
      .finally(() => {
        if (this.ticking === run) this.ticking = null;
      });
    this.ticking = run;
    return run;
  }

  /**
   * No tick after this; the one in flight finishes; the lock is released and
   * the dedicated client ended. Once; later calls return the same promise.
   * Rejects when the release fails (a timeout on a half-open connection, say):
   * the client is ended all the same, and the session's end frees the lock.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      if (this.ticking !== null) await this.ticking;
      const client = this.client;
      // Detached first: a late error event from it is not a loss to report.
      this.client = null;
      this.leading = false;
      if (client === null) return;
      try {
        const result = await client.query<{ unlocked: boolean }>("select pg_advisory_unlock($1::bigint) as unlocked", [
          this.lockKey,
        ]);
        if (result.rows[0]?.unlocked !== true) {
          throw new Error(`scheduler ${this.instanceId}: stopping, its session did not hold the leader lock`);
        }
        this.deps.log(`scheduler ${this.instanceId}: released the leader lock`);
      } finally {
        // After a timed-out query pg destroys the socket rather than wait for
        // a goodbye, so this returns on a half-open connection too.
        await client.end();
      }
    })();
    return this.stopping;
  }

  private async tick(now: Date): Promise<void> {
    if (this.stopped) return;
    const leads = this.leading ? await this.stillLeading() : await this.tryLead();
    if (!leads || this.stopped) return;
    try {
      const summary = await fireDue(this.db, this.deps, now);
      if (summary.fired + summary.skipped > 0) {
        this.deps.log(`scheduler ${this.instanceId}: fired ${summary.fired}, skipped ${summary.skipped}`);
      }
    } catch (error) {
      this.deps.log(
        `scheduler ${this.instanceId}: firing the due schedules failed — ${messageOf(error)}; retrying at the next tick`,
      );
    }
  }

  /** Try the lock on a fresh dedicated client; true when this process now leads (and keeps the client). */
  private async tryLead(): Promise<boolean> {
    if (this.pauseOneTry) {
      // Lost the lead at the last tick: one tick's pause, so another
      // candidate takes over (Review Focus 3) rather than this one, whose
      // connection just failed, racing to take it back.
      this.pauseOneTry = false;
      return false;
    }
    const fresh = new pg.Client({
      connectionString: this.databaseUrl,
      application_name: this.applicationName,
      options: SCHEDULER_SESSION_OPTIONS,
      keepAlive: true,
      connectionTimeoutMillis: this.queryTimeoutMs,
      query_timeout: this.queryTimeoutMs,
    });
    // Without a listener an idle client's error would end the process.
    fresh.on("error", (error) => this.lose(fresh, error));
    this.client = fresh;
    let locked: boolean;
    let holder: { pid: number; application_name: string } | null = null;
    try {
      await fresh.connect();
      const result = await fresh.query<{ locked: boolean }>("select pg_try_advisory_lock($1::bigint) as locked", [
        this.lockKey,
      ]);
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        // Who holds it (module header, "Who holds it"), on the same session.
        const held = await fresh.query<{ pid: number; application_name: string }>(
          `select a.pid, a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid
            where l.locktype = 'advisory' and l.granted
              and l.classid = ($1::bigint >> 32)::oid and l.objid = ($1::bigint & 4294967295)::oid
              and l.objsubid = 1`,
          [this.lockKey],
        );
        holder = held.rows[0] ?? null;
      }
    } catch (error) {
      this.lose(fresh, error);
      return false;
    }
    if (!locked) {
      // Another session leads. This one holds nothing; it is not kept open.
      this.client = null;
      await fresh.end();
      this.logHolder(holder);
      return false;
    }
    this.lastHolder = null;
    this.leading = true;
    this.deps.log(`scheduler ${this.instanceId}: leading (advisory lock ${this.lockKey})`);
    return true;
  }

  /** A failed try's holder, logged when it differs from the last one logged. */
  private logHolder(holder: { pid: number; application_name: string } | null): void {
    const key = holder === null ? "" : `${holder.pid}:${holder.application_name}`;
    if (key === this.lastHolder) return;
    this.lastHolder = key;
    this.deps.log(
      holder === null
        ? `scheduler ${this.instanceId}: does not lead: the leader lock (advisory ${this.lockKey}) was held at ` +
            "the try, and its holder ended before it could be read"
        : `scheduler ${this.instanceId}: does not lead: the leader lock is held by the session ` +
            `'${holder.application_name}' (backend pid ${holder.pid}, advisory ${this.lockKey})`,
    );
  }

  /** Whether the dedicated session still holds the lock; a session that does not, or cannot answer, is lost. */
  private async stillLeading(): Promise<boolean> {
    const client = this.client;
    if (client === null) {
      this.leading = false;
      return false;
    }
    try {
      const result = await client.query<{ held: boolean }>(
        `select exists (
           select 1 from pg_locks
            where locktype = 'advisory' and pid = pg_backend_pid() and granted
              and classid = ($1::bigint >> 32)::oid and objid = ($1::bigint & 4294967295)::oid
              and objsubid = 1) as held`,
        [this.lockKey],
      );
      if (result.rows[0]?.held === true) return true;
      this.lose(client, new Error("its session no longer holds the advisory lock"));
      return false;
    } catch (error) {
      this.lose(client, error);
      return false;
    }
  }

  /** `client` failed: drop it, stop leading, say so, end it. A client already replaced is ignored. */
  private lose(client: pg.Client, error: unknown): void {
    if (this.client !== client) return;
    this.client = null;
    const wasLeading = this.leading;
    this.leading = false;
    if (wasLeading) {
      this.pauseOneTry = true;
      this.deps.log(
        `scheduler: lost the leader lock — ${messageOf(error)} (instance ${this.instanceId}); it fires ` +
          "nothing until it leads again, and tries for the lock on a fresh connection after one tick's pause",
      );
    } else {
      this.deps.log(
        `scheduler ${this.instanceId}: its candidate connection failed — ${messageOf(error)}; a fresh one ` +
          "tries for the lock at the next tick",
      );
    }
    client.end().catch((endError: unknown) => {
      this.deps.log(`scheduler ${this.instanceId}: ending the failed connection failed — ${messageOf(endError)}`);
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
