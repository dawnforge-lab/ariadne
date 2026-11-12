/**
 * `healthz` and `readyz` (Phase 28b Task 6).
 *
 * LIVENESS (`healthz`) is "the process answers": no database, no auth. It must
 * keep answering while the database is down, or an orchestrator would restart
 * every process for a fault no restart fixes.
 *
 * READINESS (`readyz`) is "this process can do its job": a database round trip
 * and the migration count. The count compares the rows applied in
 * `drizzle.__drizzle_migrations` with the entries of this code's
 * `drizzle/meta/_journal.json`. Fewer applied means a migration has not run;
 * more means the database is ahead of this code, which is the NORMAL state of
 * a migrate-then-roll deploy (migrations are additive; Ruling R19) and is
 * READY, with one log line naming the counts. Behind is "not ready". A failed
 * query is not ready either: nothing here swallows an error into a green
 * answer.
 *
 * THE ANSWER IS UNAUTHENTICATED, so its reasons are FIXED, CLASSIFIED strings:
 * a pg error carries the server's host and port, relation names and detail,
 * none of which a caller without a token may read. The migration counts are
 * ours and are fine to say. The full error goes to `log`, for the operator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";

export type Healthz = { status: 200; body: { status: "ok" } };
export type Readyz =
  | { status: 200; body: { status: "ready" } }
  | { status: 503; body: { status: "not_ready"; reason: string } };

export function healthz(): Healthz {
  return { status: 200, body: { status: "ok" } };
}

let journalEntries: number | null = null;

/** The migrations this code ships: entries of `drizzle/meta/_journal.json`. */
export function journalMigrationCount(): number {
  if (journalEntries === null) {
    const path = join(import.meta.dirname, "..", "..", "drizzle", "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    if (!Array.isArray(journal.entries)) throw new Error(`${path} has no entries array`);
    journalEntries = journal.entries.length;
  }
  return journalEntries;
}

/** The error and its `cause` chain (drizzle wraps the driver's error in one), for the operator's log. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    parts.push(current instanceof Error ? (current.stack ?? current.message) : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n  caused by: ");
}

/** The applied count last logged as "ahead", so a probe loop logs the transition once. */
let aheadLogged: number | null = null;

export async function readyz(db: Pick<Db, "execute">, log: (line: string) => void): Promise<Readyz> {
  let applied: number;
  try {
    const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    applied = result.rows[0]?.n ?? 0;
  } catch (error) {
    log(`ops: /readyz database check failed — ${describeError(error)}`);
    return { status: 503, body: { status: "not_ready", reason: "database unreachable" } };
  }
  const expected = journalMigrationCount();
  if (applied < expected) {
    return {
      status: 503,
      body: { status: "not_ready", reason: `schema behind: ${applied} of ${expected} migrations applied` },
    };
  }
  if (applied > expected) {
    // Ruling R19: migrate-then-roll means old replicas run against a newer,
    // additive schema. Ready; said once per transition, not once per probe.
    if (aheadLogged !== applied) {
      aheadLogged = applied;
      log(`ops: /readyz schema ahead — ${applied} migrations applied, this code knows ${expected}; ready (additive newer schema)`);
    }
  } else {
    aheadLogged = null;
  }
  return { status: 200, body: { status: "ready" } };
}
