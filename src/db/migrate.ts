import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, closeDb, type Db } from "./client.js";

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: "drizzle" });
}

// CLI entrypoint: npm run db:migrate
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const db = createDb(url);
  await runMigrations(db);
  await closeDb(db);
  console.log("migrations applied");
}
