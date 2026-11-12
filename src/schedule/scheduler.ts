/**
 * The scheduler (Phase 28c): ONE leader among every process that runs one,
 * by a Postgres advisory lock, firing the due schedules (`fireDue`,
 * src/schedule/fire.ts) once per `timing.scheduleEvery`.
 *
 * WHO RUNS ONE (call C3). `ServiceConfig.scheduler` and `StartWorkerOptions.
 * scheduler` are off by default; `api:serve`, the stdio MCP entry and
 * `worker:serve` turn them on, so every deployed process is a candidate.
 *
 * LEADERSHIP. A candidate holds a dedicated `pg.Client` — not a pool
 * connection: a session-level advisory lock belongs to the session — whose
 * `application_name` is `ariadne-scheduler:<instanceId>` (the gate finds the
 * leader through it), and tries `pg_try_advisory_lock(SCHEDULER_LOCK)` on it
 * every `scheduleEvery`. The one that gets it leads: at each tick it confirms
 * its session still holds the lock and runs `fireDue` (on the pool). The lock
 * is the session's, so a leader whose process or connection dies releases it
 * with the session, and another candidate leads at its next tick.
 *
 * A LOST CONNECTION. An error on the dedicated client — the leader's backend
 * terminated, the network gone — is logged (`scheduler: lost the leader lock
 * — …`), the client is ended, and the process is a candidate again, on a fresh
 * client, at its next tick. It fires nothing until it leads again.
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
  private readonly applicationName: string;
  /** The dedicated session; null between a lost one and the next tick. */
  private client: pg.Client | null = null;
  private leading = false;
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
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      if (this.ticking !== null) await this.ticking;
      const client = this.client;
      const wasLeading = this.leading;
      // Detached first: a late error event from it is not a loss to report.
      this.client = null;
      this.leading = false;
      if (client === null) return;
      try {
        if (wasLeading) {
          const result = await client.query<{ unlocked: boolean }>("select pg_advisory_unlock($1::bigint) as unlocked", [
            this.lockKey,
          ]);
          if (result.rows[0]?.unlocked !== true) {
            throw new Error(`scheduler ${this.instanceId}: stopping, its session did not hold the leader lock`);
          }
          this.deps.log(`scheduler ${this.instanceId}: released the leader lock`);
        }
      } finally {
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

  /** Try the lock on the dedicated client (a fresh one if there is none); true when this process now leads. */
  private async tryLead(): Promise<boolean> {
    let client = this.client;
    try {
      if (client === null) {
        const fresh = new pg.Client({ connectionString: this.databaseUrl, application_name: this.applicationName });
        // Without a listener an idle client's error would end the process.
        fresh.on("error", (error) => this.lose(fresh, error));
        client = fresh;
        this.client = fresh;
        await fresh.connect();
      }
      const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1::bigint) as locked", [
        this.lockKey,
      ]);
      if (result.rows[0]?.locked !== true) return false;
      this.leading = true;
      this.deps.log(`scheduler ${this.instanceId}: leading (advisory lock ${this.lockKey})`);
      return true;
    } catch (error) {
      if (client !== null) this.lose(client, error);
      return false;
    }
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
      this.deps.log(
        `scheduler: lost the leader lock — ${messageOf(error)} (instance ${this.instanceId}); it fires ` +
          "nothing until it leads again, and tries for the lock on a fresh connection at the next tick",
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
