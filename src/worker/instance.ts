/**
 * Engine processes (Phase 28b item 8): one `instances` row per process, and
 * its heartbeat.
 *
 * An instance is registered at boot with a fresh id. Its heartbeat stamps the
 * row and the jobs it is running; the reaper (src/worker/reaper.ts) reads the
 * instance's to tell a dead process's jobs from a live one's.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { instances, jobs } from "../db/schema.js";
import { engineVersion } from "../crawl/versions.js";

/** `api`: HTTP, runs only its own pinned render and rules jobs. `worker`: claims crawls. `all`: both, one process (local MCP, tests). */
export type InstanceRole = "api" | "worker" | "all";

/** Register this process and answer its instance id. */
export async function registerInstance(db: Db, role: InstanceRole): Promise<string> {
  const id = `instance_${randomUUID()}`;
  await db.insert(instances).values({
    id,
    role,
    hostname: hostname(),
    pid: process.pid,
    // Package version + ARIADNE_GIT_SHA, as `crawls.engine_version` records it.
    version: engineVersion(),
  });
  return id;
}

/**
 * The instance a heartbeat named is gone (the reaper deleted its row as dead)
 * or stopped: the jobs it held are no longer its own, and its runner aborts
 * them (src/worker/runner.ts). Matched on the type, never the sentence.
 */
export class InstanceGoneError extends Error {
  constructor(readonly instanceId: string) {
    super(
      `heartbeat: no instance ${instanceId} that is still running — its row was removed as ` +
        "dead or it was stopped, and the jobs it held are no longer its own",
    );
    this.name = "InstanceGoneError";
  }
}

/**
 * Stamp the instance and the jobs it is running (only those it holds and that
 * are still running: a job the reaper took is not revived by a late beat), and
 * answer the ids it stamped — the ones of `runningJobIds` still this
 * instance's. One named but not answered was taken from it (the reaper
 * abandoned it, or `crawl_resume` adopted it), and its runner stops it.
 *
 * Stamped with the DATABASE's clock, as the liveness test that reads it is
 * (`liveHolderSql`), so app/database clock skew cannot make a live process
 * look dead. An instance whose row is gone (the reaper deleted it as dead) or
 * that is stopped throws `InstanceGoneError`: its jobs are no longer its own,
 * and carrying on as if they were would be two runners on one crawl.
 */
export async function heartbeat(db: Db, instanceId: string, runningJobIds: readonly string[]): Promise<string[]> {
  const beat = await db
    .update(instances)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(instances.id, instanceId), isNull(instances.stoppedAt)))
    .returning({ id: instances.id });
  if (beat.length === 0) throw new InstanceGoneError(instanceId);
  if (runningJobIds.length === 0) return [];
  const stamped = await db
    .update(jobs)
    .set({ heartbeatAt: sql`now()` })
    .where(
      and(
        inArray(jobs.id, [...runningJobIds]),
        eq(jobs.claimedBy, instanceId),
        eq(jobs.status, "running"),
      ),
    )
    .returning({ id: jobs.id });
  return stamped.map((row) => row.id);
}

/**
 * Mark the instance stopped (graceful shutdown). From this moment it is not
 * live (`liveHolderSql`): the work still pinned to it is nobody's, and
 * `crawl_resume` from any process adopts it. Idempotent.
 */
export async function stopInstance(db: Db, instanceId: string): Promise<void> {
  const stopped = await db
    .update(instances)
    .set({ stoppedAt: sql`coalesce(${instances.stoppedAt}, now())` })
    .where(eq(instances.id, instanceId))
    .returning({ id: instances.id });
  if (stopped.length === 0) throw new Error(`stopInstance: no instance ${instanceId}`);
}
