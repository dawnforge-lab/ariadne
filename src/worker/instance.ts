/**
 * Engine processes (Phase 28b item 8): one `instances` row per process, and
 * its heartbeat.
 *
 * An instance is registered at boot with a fresh id. Its heartbeat stamps the
 * row and the jobs it is running; the reaper (Task 4) reads both to tell a
 * dead process's jobs from a live one's.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

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
 * Stamp the instance and the jobs it is running (only those it holds and that
 * are still running: a job the reaper took is not revived by a late beat).
 * An instance whose row is gone throws: the reaper deleted it as dead, so
 * this process's jobs have been taken from it, and carrying on as if it held
 * them would be two runners on one crawl.
 */
export async function heartbeat(db: Db, instanceId: string, runningJobIds: readonly string[]): Promise<void> {
  const now = new Date();
  const beat = await db
    .update(instances)
    .set({ heartbeatAt: now })
    .where(eq(instances.id, instanceId))
    .returning({ id: instances.id });
  if (beat.length === 0) {
    throw new Error(
      `heartbeat: no instance ${instanceId} — its row was removed as dead, and the jobs it ` +
        "held are no longer its own",
    );
  }
  if (runningJobIds.length === 0) return;
  await db
    .update(jobs)
    .set({ heartbeatAt: now })
    .where(
      and(
        inArray(jobs.id, [...runningJobIds]),
        eq(jobs.claimedBy, instanceId),
        eq(jobs.status, "running"),
      ),
    );
}
