/**
 * Phase 28c Task 6: schedule chains — a fired crawl's finish enqueues its chain
 * (`render` when the schedule asked for one, then `rules`), and runners execute
 * those links (src/worker/chain-job.ts).
 *
 *  (a) Two fires of one schedule, run by an in-process service, are each judged
 *      (`rules_finished{outcome:"done"}` last) and compare `comparable: true`.
 *  (b) `render: {}`: crawl → render → rules, events in that order. On a worker
 *      the render keeps no documents (`rendered_html_path` null, `renderDocuments`
 *      "not kept"), and every link runs unpinned.
 *  (c) A render link whose browser cannot launch: `schedule_chain_failed{link:
 *      "render"}`, the render job failed, no rules job, the crawl `finished`.
 *  (d) A fired crawl that closes `paused`, `cancelled` or `failed` enqueues
 *      nothing and records no chain failure; one that closes `finished` enqueues
 *      its first link with the crawl job's pin (C4).
 *  (e) Review Focus 4: the schedule deleted after the fire — the chain runs to
 *      its end, its events carry `schedule_id` null, no job is left live.
 *  (f) A crawl from `crawl_start` (no chain) enqueues nothing on finish.
 *
 * ISOLATION. No unconfined scheduler runs here. Fires go through `fireDue`,
 * confined to this file's tenants (`onlyTenants`) and called with a `now` a year
 * or more ahead — so no schedule of this file is ever due by the real clock, and
 * no other process's scheduler (an entry point another suite spawned, on the
 * production key) can fire one. The services' own scheduler candidates run on a
 * lock key of their own, confined to their tenant: they are there only to start
 * the in-process runner (C3's seam). The worker test holds the pool lock.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlEvents, crawls, jobs, pages, schedules } from "../../src/db/schema.js";
import { CredentialVault } from "../../src/crawl/credential-vault.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { PageRenderer } from "../../src/crawl/render/renderer.js";
import { ApiService } from "../../src/api/service.js";
import { fireDue } from "../../src/schedule/fire.js";
import { crawlJobCloseHook } from "../../src/worker/crawl-job.js";
import { claimNextJob } from "../../src/worker/jobs.js";
import { startWorker } from "../../src/worker/main.js";
import { parseTenant, type TenantId } from "../../src/tenant.js";
import { startFixtureApp, type FixtureApp } from "../fixtures/app.js";
import { startAssetHost, type AssetHost } from "../fixtures/assets.js";
import { allFixtures } from "../fixtures/fixture.js";
import { startOffsiteHost, type OffsiteHost } from "../fixtures/pages/render-p5.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";
import { acquirePoolLock } from "../helpers/pool-lock.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let vault: CredentialVault;
let site: FixtureApp;
let assetHost: AssetHost;
let offsite: OffsiteHost;
let seed: string;
let renderRoot: string;
const RUN = randomUUID().slice(0, 8);
const tenants: TenantId[] = [];
/** A key of its own per service, clear of the production key and of other files'. */
let nextKey = 2_028_200_000 + Math.floor(Math.random() * 1_000_000) * 10;
const lockKey = (): number => (nextKey += 1);
/** The schedules' cron: once a year, so the real clock never makes one due (module header). */
const YEARLY = "0 0 1 1 *";

function tenant(): TenantId {
  const t = parseTenant(`chain-t6-${RUN}-${tenants.length}`);
  tenants.push(t);
  return t;
}

const SERVICE_BASE = {
  credentialKeys: TEST_CREDENTIAL_KEYS,
  allowedDomains: ["127.0.0.1"],
  crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
};

/** An in-process service whose runner runs the jobs pinned to it (its scheduler only starts the runner). */
function inProcessService(t: TenantId, log: (line: string) => void = () => undefined): ApiService {
  return new ApiService(db, {
    ...SERVICE_BASE,
    renderDir: renderRoot,
    timing: { claimPoll: 50 },
    log,
    scheduler: { lockKey: lockKey(), onlyTenants: [t] },
  });
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Ev {
  kind: string;
  scheduleId: string | null;
  detail: Record<string, unknown>;
}

async function eventsOf(crawlId: string): Promise<Ev[]> {
  const rows = await db.select().from(crawlEvents).where(eq(crawlEvents.crawlId, crawlId)).orderBy(asc(crawlEvents.id));
  return rows.map((r) => ({ kind: r.kind, scheduleId: r.scheduleId, detail: r.detail }));
}

async function jobsOf(crawlId: string): Promise<(typeof jobs.$inferSelect)[]> {
  return db.select().from(jobs).where(eq(jobs.crawlId, crawlId)).orderBy(asc(jobs.queuedAt), asc(jobs.id));
}

async function crawlRow(crawlId: string): Promise<typeof crawls.$inferSelect> {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  if (row === undefined) throw new Error(`no crawl ${crawlId}`);
  return row;
}

/** The crawl `fireDue` just fired for `scheduleId`: its `last_crawl_id`. */
async function firedCrawl(scheduleId: string): Promise<string> {
  const [row] = await db.select({ last: schedules.lastCrawlId }).from(schedules).where(eq(schedules.id, scheduleId));
  if (row?.last == null) throw new Error(`schedule ${scheduleId} fired nothing`);
  return row.last;
}

/** Fire `scheduleId` (its tenant only) at `now`, which must be its slot or later; answer the crawl. */
async function fire(t: TenantId, scheduleId: string, pin: string | null, now: Date): Promise<string> {
  expect(
    await fireDue(db, { vault, hostAllowed: () => true, pin, log: () => undefined, onlyTenants: [t] }, now),
  ).toEqual({ fired: 1, skipped: 0 });
  return firedCrawl(scheduleId);
}

/** The chain's end: a `rules_finished` or a `schedule_chain_failed` event on the crawl. */
async function chainEnd(crawlId: string): Promise<void> {
  await until(`crawl ${crawlId}'s chain to end`, async () =>
    (await eventsOf(crawlId)).some((e) => e.kind === "rules_finished" || e.kind === "schedule_chain_failed"),
  );
}

async function createSchedule(
  service: ApiService,
  t: TenantId,
  render: Record<string, unknown> | null,
): Promise<{ scheduleId: string; nextRunAt: Date }> {
  const made = await service.createSchedule(t, {
    crawl: { siteUrl: seed, maxPages: 8, maxDepth: 2 },
    cron: YEARLY,
    timezone: "UTC",
    render,
  });
  if (made.nextRunAt === null) throw new Error("an enabled schedule with no next slot");
  return { scheduleId: made.scheduleId, nextRunAt: new Date(made.nextRunAt) };
}

/** Thirty seconds past `slot`: the instant a fire of that slot is asked for. */
const after = (slot: Date): Date => new Date(slot.getTime() + 30_000);

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  vault = new CredentialVault(db, TEST_CREDENTIAL_KEYS);
  // The fixture site's two neighbours, which its pages reference (as test/crawl/control.test.ts starts them).
  offsite = await startOffsiteHost();
  assetHost = await startAssetHost();
  site = await startFixtureApp(allFixtures());
  seed = `${site.base}/`;
  renderRoot = await mkdtemp(join(tmpdir(), "ariadne-chain-"));
}, 60_000);

afterAll(async () => {
  if (tenants.length > 0) {
    await db.delete(crawls).where(inArray(crawls.tenantId, tenants));
    await db.delete(crawlEvents).where(inArray(crawlEvents.tenantId, tenants));
    await db.delete(schedules).where(inArray(schedules.tenantId, tenants));
  }
  await site.close();
  await offsite.close();
  await assetHost.close();
  await rm(renderRoot, { recursive: true, force: true });
  await closeFetchAgents();
  await closeDb(db);
}, 60_000);

describe("chains run by an in-process service", () => {
  it("(a) two fires of a render-less schedule are each judged last, and compare comparable: true", async () => {
    const t = tenant();
    const service = inProcessService(t);
    try {
      const pin = await service.instanceId();
      const { scheduleId, nextRunAt } = await createSchedule(service, t, null);

      const first = await fire(t, scheduleId, pin, after(nextRunAt));
      await chainEnd(first);
      const slot2 = (await service.getSchedule(t, scheduleId)).nextRunAt;
      const second = await fire(t, scheduleId, pin, after(new Date(slot2!)));
      await chainEnd(second);

      for (const crawlId of [first, second]) {
        const events = await eventsOf(crawlId);
        expect(events.at(-1)).toMatchObject({ kind: "rules_finished", detail: { outcome: "done" } });
        expect(events.map((e) => e.kind)).not.toContain("render_queued");
        expect(events.every((e) => e.scheduleId === scheduleId)).toBe(true);
        expect((await crawlRow(crawlId)).status).toBe("finished");
        // The rules link ran under a job pinned as its crawl job was (C4).
        expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status, j.pinnedTo])).toEqual([
          ["crawl", "done", pin],
          ["rules", "done", pin],
        ]);
      }
      const compared = await service.compareCrawls(t, first, second);
      expect(compared.comparable).toBe(true);
    } finally {
      await service.close();
    }
  }, 240_000);

  it("(b) render: {} runs crawl → render → rules, the events in that order", async () => {
    const t = tenant();
    const service = inProcessService(t);
    try {
      const pin = await service.instanceId();
      const { scheduleId, nextRunAt } = await createSchedule(service, t, {});
      const crawlId = await fire(t, scheduleId, pin, after(nextRunAt));
      await chainEnd(crawlId);

      const events = await eventsOf(crawlId);
      expect(events.map((e) => e.kind)).toEqual([
        "queued",
        "claimed",
        "started",
        "finished",
        "render_queued",
        "render_started",
        "render_finished",
        "rules_queued",
        "rules_started",
        "rules_finished",
      ]);
      expect(events.find((e) => e.kind === "render_finished")?.detail).toEqual({ outcome: "done" });
      expect(events.find((e) => e.kind === "rules_finished")?.detail).toEqual({ outcome: "done" });
      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status, j.pinnedTo])).toEqual([
        ["crawl", "done", pin],
        ["render", "done", pin],
        ["rules", "done", pin],
      ]);
    } finally {
      await service.close();
    }
  }, 240_000);

  it("(c) a render link whose browser cannot launch: schedule_chain_failed{link: render}, no rules job, the crawl finished", async () => {
    const t = tenant();
    const lines: string[] = [];
    const service = inProcessService(t, (line) => lines.push(line));
    // The launch-error seam the render tests use (test/crawl/renderer.test.ts,
    // "a pass that cannot launch"): Chromium's own message for a missing binary.
    const spy = vi
      .spyOn(PageRenderer, "launch")
      .mockRejectedValue(
        new Error("browserType.launch: Executable doesn't exist at /nonexistent/ms-playwright/chromium/chrome"),
      );
    try {
      const pin = await service.instanceId();
      const { scheduleId, nextRunAt } = await createSchedule(service, t, { urls: [seed] });
      const crawlId = await fire(t, scheduleId, pin, after(nextRunAt));
      await chainEnd(crawlId);

      const events = await eventsOf(crawlId);
      const failed = events.filter((e) => e.kind === "schedule_chain_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.scheduleId).toBe(scheduleId);
      expect(failed[0]!.detail["link"]).toBe("render");
      const reason = String(failed[0]!.detail["reason"]);
      // A defect's text stays in the log, under the id the event names: the
      // event is the tenant's to read (crawl_history), and a raw launch error
      // carries a path on this machine.
      expect(reason).not.toContain("/nonexistent");
      const id = /logged under ([0-9a-f-]{36})/.exec(reason)?.[1];
      expect(id, reason).toBeDefined();
      expect(lines.some((l) => l.includes(id!) && l.includes("Executable doesn't exist"))).toBe(true);
      expect(events.map((e) => e.kind)).not.toContain("rules_queued");
      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status])).toEqual([
        ["crawl", "done"],
        ["render", "failed"],
      ]);
      const renderJob = (await jobsOf(crawlId))[1]!;
      expect(renderJob.error).toContain("Executable doesn't exist");
      expect((await crawlRow(crawlId)).status).toBe("finished");
      // The order: the render job settled failed, then the chain failure.
      const kinds = events.map((e) => e.kind);
      expect(kinds.indexOf("render_finished")).toBeLessThan(kinds.indexOf("schedule_chain_failed"));
      expect(events.find((e) => e.kind === "render_finished")?.detail).toEqual({ outcome: "failed" });
    } finally {
      spy.mockRestore();
      await service.close();
    }
  }, 240_000);

  it("(c) the chain's render.urls are checked as crawl_render checks a caller's list: a URL the crawl never fetched fails the link VALIDATION, unfetched", async () => {
    const t = tenant();
    const service = inProcessService(t);
    const launch = vi.spyOn(PageRenderer, "launch");
    try {
      const pin = await service.instanceId();
      const never = `${site.base}/never-linked-${RUN}`;
      const { scheduleId, nextRunAt } = await createSchedule(service, t, { urls: [never] });
      const crawlId = await fire(t, scheduleId, pin, after(nextRunAt));
      await chainEnd(crawlId);

      const failed = (await eventsOf(crawlId)).filter((e) => e.kind === "schedule_chain_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.detail["link"]).toBe("render");
      expect(String(failed[0]!.detail["reason"])).toMatch(/^VALIDATION: urls names 1 page\(s\) this crawl cannot render/);
      expect(launch).not.toHaveBeenCalled();
      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status])).toEqual([
        ["crawl", "done"],
        ["render", "failed"],
      ]);
    } finally {
      launch.mockRestore();
      await service.close();
    }
  }, 240_000);

  it("(e) the schedule deleted after the fire: the chain runs to its end, its events carry schedule_id null, no job is left live", async () => {
    const t = tenant();
    const service = inProcessService(t);
    try {
      const pin = await service.instanceId();
      const { scheduleId, nextRunAt } = await createSchedule(service, t, {});
      const crawlId = await fire(t, scheduleId, pin, after(nextRunAt));
      await service.deleteSchedule(t, scheduleId);
      await chainEnd(crawlId);

      const events = await eventsOf(crawlId);
      expect(events.at(-1)).toMatchObject({ kind: "rules_finished", detail: { outcome: "done" } });
      expect(events.map((e) => e.kind)).toContain("render_finished");
      expect(events.every((e) => e.scheduleId === null)).toBe(true);
      const row = await crawlRow(crawlId);
      expect(row.scheduleId).toBeNull();
      expect(row.scheduleChain).toEqual({ render: {} });
      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status])).toEqual([
        ["crawl", "done"],
        ["render", "done"],
        ["rules", "done"],
      ]);
    } finally {
      await service.close();
    }
  }, 240_000);

  it("(f) a crawl from crawl_start (no chain) enqueues nothing on finish", async () => {
    const t = tenant();
    const service = inProcessService(t);
    try {
      const { crawlId } = await service.startCrawl(t, { siteUrl: seed, maxPages: 3, maxDepth: 1 });
      await until("the crawl to finish", async () => (await crawlRow(crawlId)).status === "finished");
      // The close and any first link commit together, so this read is final.
      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status])).toEqual([["crawl", "done"]]);
      expect((await eventsOf(crawlId)).map((e) => e.kind)).not.toContain("schedule_chain_failed");
    } finally {
      await service.close();
    }
  }, 120_000);
});

describe("(d) the close hook", () => {
  /** A fired crawl whose crawl job this test claimed, pinned to an instance nobody runs. */
  async function claimedFiredCrawl(render: { urls?: string[] } | null): Promise<{
    crawlId: string;
    jobId: string;
    pin: string;
  }> {
    const t = tenant();
    const service = new ApiService(db, { ...SERVICE_BASE, log: () => undefined });
    let made: { scheduleId: string; nextRunAt: Date };
    try {
      made = await createSchedule(service, t, render);
    } finally {
      await service.close();
    }
    const pin = `test-chain-${randomUUID()}`;
    const crawlId = await fire(t, made.scheduleId, pin, after(made.nextRunAt));
    const claimed = await claimNextJob(db, { instanceId: pin, kinds: ["crawl"], pinnedTo: pin });
    expect(claimed?.crawlId).toBe(crawlId);
    return { crawlId, jobId: claimed!.id, pin };
  }

  /** Close the crawl as the loop does, with the hook in the close's transaction. */
  async function close(
    crawlId: string,
    jobId: string,
    pin: string,
    closed: { status: "finished" | "paused" | "cancelled" | "failed"; pauseReason: "request" | null; failureReason: string | null },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(crawls)
        .set({
          status: closed.status,
          finishedAt: new Date(),
          pauseReason: closed.pauseReason,
          failureReason: closed.failureReason,
          ...(closed.status === "cancelled" ? { cancelledAt: new Date() } : {}),
        })
        .where(eq(crawls.id, crawlId));
      await crawlJobCloseHook(jobId, pin)(tx, closed);
    });
  }

  for (const closed of [
    { status: "paused", pauseReason: "request", failureReason: null },
    { status: "cancelled", pauseReason: null, failureReason: null },
    { status: "failed", pauseReason: null, failureReason: "robots.txt refused the crawl" },
  ] as const) {
    it(`a fired crawl that closes '${closed.status}' enqueues nothing and records no chain failure`, async () => {
      const { crawlId, jobId, pin } = await claimedFiredCrawl({});
      await close(crawlId, jobId, pin, closed);
      expect((await jobsOf(crawlId)).map((j) => j.kind)).toEqual(["crawl"]);
      expect((await jobsOf(crawlId))[0]!.status).not.toMatch(/^(queued|running)$/);
      expect((await eventsOf(crawlId)).map((e) => e.kind)).not.toContain("schedule_chain_failed");
    });
  }

  it("a fired crawl that closes 'finished' enqueues render when the chain renders, with the crawl job's pin, in the close's transaction", async () => {
    const { crawlId, jobId, pin } = await claimedFiredCrawl({ urls: [seed] });
    await close(crawlId, jobId, pin, { status: "finished", pauseReason: null, failureReason: null });
    expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status, j.pinnedTo])).toEqual([
      ["crawl", "done", pin],
      ["render", "queued", pin],
    ]);
  });

  it("…and rules when it does not", async () => {
    const { crawlId, jobId, pin } = await claimedFiredCrawl(null);
    await close(crawlId, jobId, pin, { status: "finished", pauseReason: null, failureReason: null });
    expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status, j.pinnedTo])).toEqual([
      ["crawl", "done", pin],
      ["rules", "queued", pin],
    ]);
  });

  it("a close whose enqueue fails rolls back with it: the crawl is not left finished with no chain", async () => {
    const { crawlId, jobId, pin } = await claimedFiredCrawl(null);
    // A chain this engine never writes: the hook refuses it, loudly, and the close goes with it.
    await db.update(crawls).set({ scheduleChain: { render: "all" } as never }).where(eq(crawls.id, crawlId));
    const before = (await crawlRow(crawlId)).status;
    await expect(
      close(crawlId, jobId, pin, { status: "finished", pauseReason: null, failureReason: null }),
    ).rejects.toThrow(/schedule_chain/);
    expect((await crawlRow(crawlId)).status).toBe(before);
    expect(before).not.toBe("finished");
    expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status])).toEqual([["crawl", "running"]]);
  });
});

describe("chains on a worker", () => {
  it("(b) every link runs unpinned on the worker, and its render keeps no documents", async () => {
    const pool = await acquirePoolLock(databaseUrl());
    const t = tenant();
    const planner = new ApiService(db, { ...SERVICE_BASE, log: () => undefined });
    const worker = await startWorker({
      db,
      credentialKeys: TEST_CREDENTIAL_KEYS,
      concurrency: 1,
      maxRunningPerTenant: 1,
      httpPort: 0,
      httpHost: "127.0.0.1",
      metricsToken: null,
      allowedDomains: ["127.0.0.1"],
      processTrust: { allowPrivate: true },
      timing: { claimPoll: 50 },
      log: () => undefined,
      reaperOnlyInstances: (id) => [id],
    });
    try {
      const { scheduleId, nextRunAt } = await createSchedule(planner, t, { urls: [seed] });
      // A worker fires into the pool (C4).
      const crawlId = await fire(t, scheduleId, null, after(nextRunAt));
      await chainEnd(crawlId);

      expect((await jobsOf(crawlId)).map((j) => [j.kind, j.status, j.pinnedTo, j.claimedBy])).toEqual([
        ["crawl", "done", null, worker.instanceId],
        ["render", "done", null, worker.instanceId],
        ["rules", "done", null, worker.instanceId],
      ]);
      // The page WAS rendered — and no document of it was kept.
      const rendered = await db
        .select({ url: pages.url, path: pages.renderedHtmlPath })
        .from(pages)
        .where(and(eq(pages.crawlId, crawlId), isNotNull(pages.renderedWordCount)));
      expect(rendered.map((r) => r.url)).toEqual([seed]);
      const kept = await db
        .select({ url: pages.url })
        .from(pages)
        .where(and(eq(pages.crawlId, crawlId), isNotNull(pages.renderedHtmlPath)));
      expect(kept).toEqual([]);
      expect((await planner.getCrawl(t, crawlId)).renderDocuments).toBe("not kept");
    } finally {
      await worker.stop();
      await planner.close();
      await pool.release();
    }
  }, 240_000);
});
