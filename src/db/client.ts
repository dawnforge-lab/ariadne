import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> & { $pool: pg.Pool };

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // drizzle-orm 0.45 returns `NodePgDatabase<schema> & { $client: Pool }`; we attach
  // `$pool` (the contract name the rest of the codebase uses) without an unsafe cast.
  return Object.assign(drizzle(pool, { schema }), { $pool: pool });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$pool.end();
}
