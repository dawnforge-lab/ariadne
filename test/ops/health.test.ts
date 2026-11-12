/**
 * Health and readiness (Phase 28b Task 6), on the API and on the worker.
 *
 * `/healthz` is liveness: no auth, no tenant, no database. `/readyz` is a
 * database round trip plus the migration count. The unreachable-database cases
 * use a pool pointed at a port nothing listens on. The 503 count-mismatch case
 * runs INSIDE A TRANSACTION THAT IS ROLLED BACK: one migration row is deleted in
 * it, `readyz` reads it, and the transaction is aborted.
 *
 * THE WHOLE FILE RUNS ON A SCRATCH DATABASE (created from the dev server in
 * `beforeAll`, migrated by `runMigrations`, dropped in `afterAll`), never the
 * shared dev database: its `__drizzle_migrations` is other branches' and other
 * suites', and readiness is exactly a statement about the migration table, so
 * a neighbour's migration must not decide this file's answer. The worker
 * started here claims from the scratch database's own (empty) pool, so it needs
 * no pool lock.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { readyz } from "../../src/ops/health.js";
import { assertMetricsTokenDistinct } from "../../src/ops/serve.js";
import { startWorker, type RunningWorker } from "../../src/worker/main.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const API_TOKEN = "health-api-token-0123456789abcdef";
const METRICS_TOKEN = "health-metrics-token-0123456789abcdef";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let scratchName: string | undefined;
const deadLog: string[] = [];
let deadDb: Db | undefined;
let api: ApiServer | undefined;
let apiBase: string;
let deadApi: ApiServer | undefined;
let deadApiBase: string;
let worker: RunningWorker | undefined;
let workerBase: string;
const quiet = { log: () => undefined };

beforeAll(async () => {
  const name = `ariadne_t6_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: databaseUrl() });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
    // Recorded the moment it exists, so afterAll drops it however the rest of
    // this setup fails.
    scratchName = name;
  } finally {
    await admin.end();
  }
  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${name}`;
  db = createDb(scratchUrl.toString());
  await runMigrations(db);
  // Port 1: nothing listens; connecting is refused at once.
  deadDb = createDb("postgresql://ariadne:ariadne@127.0.0.1:1/ariadne");
  const config = { credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], token: API_TOKEN, metricsToken: METRICS_TOKEN, ...quiet };
  api = createApiServer({ db, config });
  apiBase = `http://127.0.0.1:${(await api.listen(0)).port}`;
  deadApi = createApiServer({ db: deadDb, config: { ...config, log: (l: string) => deadLog.push(l) } });
  deadApiBase = `http://127.0.0.1:${(await deadApi.listen(0)).port}`;
  worker = await startWorker({
    db,
    credentialKeys: TEST_CREDENTIAL_KEYS,
    concurrency: 1,
    maxRunningPerTenant: 1,
    httpPort: 0,
    httpHost: "127.0.0.1",
    metricsToken: METRICS_TOKEN,
    allowedDomains: [],
    reaperOnlyInstances: (id) => [id],
    log: () => undefined,
  });
  workerBase = `http://127.0.0.1:${worker.port}`;
}, 60_000);

afterAll(async () => {
  // Every step is independent: one that throws (or whose subject was never
  // built because beforeAll failed) must not stop the rest, and the scratch
  // database is dropped last, in a finally.
  const errors: unknown[] = [];
  const step = async (what: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      await what();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await step(() => worker?.stop());
    await step(() => api?.close());
    await step(() => deadApi?.close());
    await step(() => closeFetchAgents());
    await step(() => ((db as Db | undefined) === undefined ? undefined : closeDb(db)));
    await step(() => (deadDb === undefined ? undefined : closeDb(deadDb)));
  } finally {
    if (scratchName !== undefined) {
      const admin = new pg.Client({ connectionString: databaseUrl() });
      try {
        await admin.connect();
        await admin.query(`drop database if exists ${scratchName} with (force)`);
      } finally {
        await admin.end();
      }
    }
  }
  if (errors.length > 0) throw errors[0];
});

/** Bases are known only after `beforeAll`, so each case resolves its own by name. */
const SURFACES = ["api", "worker"] as const;
const baseOf = (name: (typeof SURFACES)[number]): string => (name === "api" ? apiBase : workerBase);

describe("/healthz", () => {
  it.each(SURFACES)("%s answers 200 ok with no token and no tenant", async (name) => {
    const base = baseOf(name);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers the same while the database is unreachable", async () => {
    const res = await fetch(`${deadApiBase}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("/readyz", () => {
  it.each(SURFACES)("%s answers 200 ready on a migrated database, with no token and no tenant", async (name) => {
    const base = baseOf(name);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  it("answers 503 naming the count mismatch when a migration row is missing (rolled-back transaction)", async () => {
    const abort = new Error("rollback");
    let answer: Awaited<ReturnType<typeof readyz>> | undefined;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`,
        );
        answer = await readyz(tx, () => undefined);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(answer?.status).toBe(503);
    expect(answer?.body).toMatchObject({ status: "not_ready" });
    const reason = (answer?.body as { reason: string }).reason;
    expect(reason).toMatch(/^schema behind: \d+ of \d+ migrations applied$/);
    // The real table is untouched, as every other suite sees it.
    expect((await readyz(db, () => undefined)).status).toBe(200);
  });

  it("answers 200 ready and logs the counts once when the database is AHEAD (migrate-then-roll, R19)", async () => {
    const abort = new Error("rollback");
    const lines: string[] = [];
    const answers: Awaited<ReturnType<typeof readyz>>[] = [];
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('test-ahead-orphan', 9999999999999)`,
        );
        answers.push(await readyz(tx, (l) => lines.push(l)));
        answers.push(await readyz(tx, (l) => lines.push(l)));
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(answers[0]?.body).toEqual({ status: "ready" });
    // One line for the transition, not one per probe, and it names the counts.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/schema ahead — \d+ migrations applied, this code knows \d+/);
  });

  it("answers 503 when the database is unreachable", async () => {
    const res = await fetch(`${deadApiBase}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("not_ready");
    // A fixed, classified reason: no host, port or error text of the pg error.
    expect(body).toEqual({ status: "not_ready", reason: "database unreachable" });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|:1\b|connect/i);
    // The full error went to the server's log instead.
    expect(deadLog.some((l) => /readyz database check failed/.test(l) && /ECONNREFUSED/.test(l))).toBe(true);
  });
});

describe("/metrics auth", () => {
  it.each(SURFACES)("%s: no token is 401", async (name) => {
    const base = baseOf(name);
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
  });

  it.each(SURFACES)("%s: a wrong token is 401", async (name) => {
    const base = baseOf(name);
    const res = await fetch(`${base}/metrics`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("api: the API token is not the metrics token (401), the metrics token needs no tenant (200)", async () => {
    const asApi = await fetch(`${apiBase}/metrics`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(asApi.status).toBe(401);
    const ok = await fetch(`${apiBase}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("worker: the metrics token answers 200", async () => {
    const ok = await fetch(`${workerBase}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("ariadne_instances_alive");
  });

  it("with no ARIADNE_METRICS_TOKEN configured the route is 404 and nothing is served, on both surfaces", async () => {
    const bare = createApiServer({
      db,
      config: { credentialKeys: TEST_CREDENTIAL_KEYS, allowedDomains: [], token: API_TOKEN, ...quiet },
    });
    const bound = await bare.listen(0);
    try {
      const base = `http://127.0.0.1:${bound.port}`;
      expect((await fetch(`${base}/metrics`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${API_TOKEN}` } })).status).toBe(404);
    } finally {
      await bare.close();
    }
    const logged: string[] = [];
    const w = await startWorker({
      db,
      credentialKeys: TEST_CREDENTIAL_KEYS,
      concurrency: 1,
      maxRunningPerTenant: 1,
      httpPort: 0,
      httpHost: "127.0.0.1",
      metricsToken: null,
      allowedDomains: [],
      reaperOnlyInstances: (id) => [id],
      log: (l) => logged.push(l),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${w.port}/metrics`, { headers: { authorization: "Bearer x" } });
      expect(res.status).toBe(404);
      expect(logged.filter((l) => /ARIADNE_METRICS_TOKEN/.test(l))).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });
});

describe("the metrics token", () => {
  it("a wrong /metrics token is refused as a wrong METRICS token, not an API token", async () => {
    const res = await fetch(`${apiBase}/metrics`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid metrics token" });
  });

  it("boot refuses a metrics token equal to the API token, naming both variables and neither value", () => {
    let message = "";
    try {
      assertMetricsTokenDistinct(API_TOKEN, API_TOKEN);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ARIADNE_METRICS_TOKEN/);
    expect(message).toMatch(/ARIADNE_API_TOKEN/);
    expect(message).not.toContain(API_TOKEN);
    expect(() => assertMetricsTokenDistinct(METRICS_TOKEN, API_TOKEN)).not.toThrow();
    expect(() => assertMetricsTokenDistinct(null, API_TOKEN)).not.toThrow();
  });
});

describe("the worker's server", () => {
  it("answers 404 for any other path and for a non-GET on a health path", async () => {
    expect((await fetch(`${workerBase}/nope`)).status).toBe(404);
    expect((await fetch(`${workerBase}/healthz`, { method: "POST" })).status).toBe(404);
  });
});
