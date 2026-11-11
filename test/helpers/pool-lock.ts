/**
 * TEST ONLY: the unpinned job pool is one shared resource, and every suite that
 * runs a claimer over it (or clears it) holds this lock for the length of the
 * file — test/worker/runner.test.ts and test/worker/serve.test.ts. The in-
 * process services of every other suite claim only jobs pinned to themselves,
 * so they need no lock.
 *
 * A session-level Postgres advisory lock on a connection of its own, so it is
 * released if the test process dies. `acquirePoolLock` waits as long as the
 * other file runs.
 */
import pg from "pg";

/** Arbitrary, and the same in every file that takes the lock. */
const POOL_LOCK_KEY = 28110285;

export interface PoolLock {
  release(): Promise<void>;
}

export async function acquirePoolLock(databaseUrl: string): Promise<PoolLock> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("select pg_advisory_lock($1)", [POOL_LOCK_KEY]);
  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [POOL_LOCK_KEY]);
      } finally {
        await client.end();
      }
    },
  };
}
