/**
 * The schedule surface (Phase 28c T4): `schedule_create/list/get/update/delete/
 * history` and `POST/GET /schedules`, `GET/PATCH/DELETE /schedules/:id`,
 * `GET /schedules/:id/history`, tenant-scoped, over the storage Task 3 built.
 * Nothing fires here: the scheduler is Task 5's.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawlEvents, scheduleCredentials, schedules } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import { parseTenant, type TenantId } from "../../src/tenant.js";
import { nextSlot } from "../../src/schedule/cron.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const TOKEN = "test-token-schedules-0123456789abcdef";
const RUN = randomUUID().slice(0, 8);
const ACME: TenantId = parseTenant(`sched-acme-${RUN}`);
const SECRET = "s3cr3t-value-never-echoed";
const SITE = "http://127.0.0.1:9/";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;

interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function http(method: string, path: string, body?: unknown): Promise<HttpAnswer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-ariadne-tenant": ACME,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>), text };
}

async function tool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown>; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { text: string }[])[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown>, text: first.text };
}

const created: string[] = [];
async function create(
  extra: Record<string, unknown> = {},
  crawl: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await http("POST", "/schedules", {
    crawl: { siteUrl: SITE, ...crawl },
    cron: "30 1 * * *",
    timezone: "Europe/London",
    ...extra,
  });
  expect(res.status, res.text).toBe(201);
  created.push(String(res.body["scheduleId"]));
  return res.body;
}

/** The schedule row and its credential rows: everything a refused update could have touched. */
async function snapshot(id: string): Promise<unknown> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
  const credentials = await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id));
  return { row, credentials };
}

const idsOf = (body: Record<string, unknown>): string[] =>
  (body["items"] as { scheduleId: string }[]).map((i) => i.scheduleId);

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  const service = {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    log: () => undefined,
  };
  api = createApiServer({ db, config: { ...service, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config: { ...service, tenant: ACME } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-schedules", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  if (created.length > 0) await db.delete(schedules).where(inArray(schedules.id, created));
  await closeFetchAgents();
  await closeDb(db);
});

describe("create, get, list, update, delete", () => {
  it("creates an enabled schedule with a next slot, and reads it back", async () => {
    const made = await create();
    expect(made).toMatchObject({
      siteUrl: SITE,
      cron: "30 1 * * *",
      timezone: "Europe/London",
      enabled: true,
      lastCrawlId: null,
      render: null,
      credentials: {},
    });
    expect(String(made["scheduleId"])).toMatch(/^sched_/);
    expect(new Date(String(made["nextRunAt"])).getTime()).toBeGreaterThan(Date.now());

    const got = await http("GET", `/schedules/${String(made["scheduleId"])}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(made);
    const viaMcp = await tool("schedule_get", { scheduleId: made["scheduleId"] });
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.body).toEqual(made);
  });

  it("creates through the MCP tool, disabled, with a render selection", async () => {
    const made = await tool("schedule_create", {
      crawl: { siteUrl: SITE },
      cron: "0 6 * * 1",
      timezone: "UTC",
      enabled: false,
      render: { urls: [`${SITE}a`] },
    });
    expect(made.isError, made.text).toBe(false);
    created.push(String(made.body["scheduleId"]));
    expect(made.body).toMatchObject({ enabled: false, nextRunAt: null, render: { urls: [`${SITE}a`] } });
  });

  it("lists the tenant's schedules newest first, with a working cursor", async () => {
    const a = await create();
    const b = await create();
    const first = await http("GET", "/schedules?limit=1");
    expect(first.status).toBe(200);
    expect(idsOf(first.body)).toEqual([b["scheduleId"]]);
    expect(typeof first.body["nextCursor"]).toBe("string");
    const second = await http(
      "GET",
      `/schedules?limit=1&cursor=${encodeURIComponent(String(first.body["nextCursor"]))}`,
    );
    expect(idsOf(second.body)).toEqual([a["scheduleId"]]);
    const viaMcp = await tool("schedule_list", { limit: 200 });
    expect(idsOf(viaMcp.body)).toContain(a["scheduleId"]);
  });

  it("a cron change recomputes nextRunAt; enabled:false nulls it; enabling computes it again", async () => {
    const made = await create({ cron: "0 0 1 1 *", timezone: "UTC" });
    const id = String(made["scheduleId"]);
    const moved = await http("PATCH", `/schedules/${id}`, { cron: "*/5 * * * *" });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body["cron"]).toBe("*/5 * * * *");
    expect(moved.body["nextRunAt"]).not.toBe(made["nextRunAt"]);
    expect(new Date(String(moved.body["nextRunAt"])).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const off = await http("PATCH", `/schedules/${id}`, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await tool("schedule_update", { scheduleId: id, enabled: true });
    expect(on.isError, on.text).toBe(false);
    expect(on.body["enabled"]).toBe(true);
    expect(on.body["nextRunAt"]).not.toBeNull();
    // A render change leaves the slot alone.
    const render = await http("PATCH", `/schedules/${id}`, { render: {} });
    expect(render.body["render"]).toEqual({});
    expect(render.body["nextRunAt"]).toBe(on.body["nextRunAt"]);
    const cleared = await http("PATCH", `/schedules/${id}`, { render: null });
    expect(cleared.body["render"]).toBeNull();
  });

  it("an update that names nothing, or a bad value, is a 400 and changes nothing", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    for (const body of [{}, { enabled: "yes" }, { cron: "* * * * * *" }, { timezone: "+05:00" }]) {
      const res = await http("PATCH", `/schedules/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await http("GET", `/schedules/${id}`)).body).toEqual(made);
  });

  it("deletes a schedule, and a second delete is a 404", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    const gone = await http("DELETE", `/schedules/${id}`);
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ scheduleId: id, deleted: true });
    expect((await http("GET", `/schedules/${id}`)).status).toBe(404);
    expect((await http("DELETE", `/schedules/${id}`)).status).toBe(404);
    const viaMcp = await tool("schedule_delete", { scheduleId: id });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("delete removes the schedule's own events and credentials", async () => {
    const made = await create({}, { requestHeaders: { "x-token": SECRET } });
    const id = String(made["scheduleId"]);
    await db
      .insert(crawlEvents)
      .values({ tenantId: ACME, crawlId: null, scheduleId: id, kind: "schedule_skipped", detail: { reason: "overlap" } });
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toHaveLength(1);
    expect((await http("DELETE", `/schedules/${id}`)).status).toBe(200);
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toHaveLength(0);
    expect(await db.select().from(crawlEvents).where(eq(crawlEvents.scheduleId, id))).toHaveLength(0);
  });

  it("history lists the schedule's events, oldest first, paged", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    expect((await http("GET", `/schedules/${id}/history`)).body).toEqual({ items: [], nextCursor: null });
    await db.insert(crawlEvents).values([
      { tenantId: ACME, crawlId: null, scheduleId: id, kind: "schedule_skipped", detail: { reason: "overlap" } },
      { tenantId: ACME, crawlId: null, scheduleId: id, kind: "schedule_skipped", detail: { reason: "not-allowed" } },
    ]);
    const res = await http("GET", `/schedules/${id}/history`);
    const items = res.body["items"] as { kind: string; detail: { reason: string }; scheduleId: string }[];
    expect(items.map((i) => i.detail.reason)).toEqual(["overlap", "not-allowed"]);
    expect(items[0]).toMatchObject({ kind: "schedule_skipped", scheduleId: id });
    const viaMcp = await tool("schedule_history", { scheduleId: id, limit: 1 });
    expect((viaMcp.body["items"] as unknown[]).length).toBe(1);
    expect(typeof viaMcp.body["nextCursor"]).toBe("string");
  });
});

describe("credentials", () => {
  it("a credentialed create stores a schedule_credentials row and shows names only", async () => {
    const made = await create(
      {},
      {
        requestHeaders: { "X-Token": SECRET },
        httpAuth: { username: "bob-the-user", password: SECRET },
        cookies: [{ name: "sid", value: SECRET }],
      },
    );
    const id = String(made["scheduleId"]);
    expect(made["credentials"]).toEqual({
      requestHeaders: { "x-token": "[redacted]" },
      httpAuth: "[redacted]",
      cookies: [{ name: "sid", value: "[redacted]" }],
    });
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toHaveLength(1);
    for (const text of [
      JSON.stringify(made),
      (await http("GET", `/schedules/${id}`)).text,
      (await http("GET", "/schedules?limit=200")).text,
      (await tool("schedule_get", { scheduleId: id })).text,
      (await tool("schedule_list", {})).text,
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("bob-the-user");
    }
  });

  it("crawl in an update replaces the credentials with it; one without removes them (C8)", async () => {
    const made = await create({}, { requestHeaders: { "x-token": SECRET } });
    const id = String(made["scheduleId"]);
    const swapped = await http("PATCH", `/schedules/${id}`, {
      crawl: { siteUrl: SITE, cookies: [{ name: "sid", value: SECRET }] },
    });
    expect(swapped.status, swapped.text).toBe(200);
    expect(swapped.body["credentials"]).toEqual({ cookies: [{ name: "sid", value: "[redacted]" }] });
    expect(swapped.text).not.toContain(SECRET);
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toHaveLength(1);
    const bare = await http("PATCH", `/schedules/${id}`, { crawl: { siteUrl: SITE } });
    expect(bare.body["credentials"]).toEqual({});
    expect(await db.select().from(scheduleCredentials).where(eq(scheduleCredentials.scheduleId, id))).toHaveLength(0);
  });
});

describe("refusals", () => {
  it("a disallowed host is a 403 naming crawl.siteUrl, and stores nothing", async () => {
    const before = await http("GET", "/schedules?limit=200");
    const res = await http("POST", "/schedules", {
      crawl: { siteUrl: "http://not-allowed.example/" },
      cron: "0 * * * *",
      timezone: "UTC",
    });
    expect(res.status, res.text).toBe(403);
    expect(String(res.body["error"])).toContain("crawl.siteUrl");
    expect((await http("GET", "/schedules?limit=200")).body).toEqual(before.body);
    const viaMcp = await tool("schedule_create", {
      crawl: { siteUrl: "http://not-allowed.example/" },
      cron: "0 * * * *",
      timezone: "UTC",
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("a crawl_start refusal comes back with its path prefixed crawl.", async () => {
    const res = await http("POST", "/schedules", {
      crawl: { siteUrl: SITE, maxPages: 0 },
      cron: "0 * * * *",
      timezone: "UTC",
    });
    expect(res.status, res.text).toBe(400);
    expect(String(res.body["error"])).toMatch(/^crawl\.maxPages/);
  });

  it("a cron that never matches is a 400 naming cron, and stores nothing", async () => {
    const before = await http("GET", "/schedules?limit=200");
    const res = await http("POST", "/schedules", { crawl: { siteUrl: SITE }, cron: "0 0 30 2 *", timezone: "UTC" });
    expect(res.status, res.text).toBe(400);
    expect(String(res.body["error"])).toMatch(/^cron:/);
    const viaMcp = await tool("schedule_create", { crawl: { siteUrl: SITE }, cron: "0 0 30 2 *", timezone: "UTC" });
    expect(viaMcp.isError).toBe(true);
    expect(String(viaMcp.body["error"])).toMatch(/^cron:/);
    expect((await http("GET", "/schedules?limit=200")).body).toEqual(before.body);
  });

  it("six-field cron and a non-IANA timezone are 400s naming the field", async () => {
    const six = await http("POST", "/schedules", { crawl: { siteUrl: SITE }, cron: "0 */5 * * * *", timezone: "UTC" });
    expect(six.status).toBe(400);
    expect(String(six.body["error"])).toMatch(/^cron:/);
    const zone = await http("POST", "/schedules", { crawl: { siteUrl: SITE }, cron: "0 * * * *", timezone: "EST" });
    expect(zone.status).toBe(400);
    expect(String(zone.body["error"])).toMatch(/^timezone:/);
  });

  it("an update with a disallowed crawl host is a 403 with the crawl. prefix and changes nothing", async () => {
    const made = await create({}, { requestHeaders: { "x-token": SECRET } });
    const id = String(made["scheduleId"]);
    const before = await snapshot(id);
    const res = await http("PATCH", `/schedules/${id}`, { crawl: { siteUrl: "http://not-allowed.example/" } });
    expect(res.status, res.text).toBe(403);
    expect(String(res.body["error"])).toContain("crawl.siteUrl");
    expect(await snapshot(id)).toEqual(before);
    expect((await http("GET", `/schedules/${id}`)).body).toEqual(made);
  });

  it("an update with a bad cron is a 400 VALIDATION naming cron and changes nothing", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    const before = await snapshot(id);
    const res = await http("PATCH", `/schedules/${id}`, { cron: "0 0 30 2 *" });
    expect(res.status, res.text).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION" });
    expect(String(res.body["error"])).toMatch(/^cron:/);
    const viaMcp = await tool("schedule_update", { scheduleId: id, cron: "* * * * * *" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body).toMatchObject({ code: "VALIDATION" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("missing keys and a non-object body are 400s", async () => {
    for (const body of [{}, { crawl: { siteUrl: SITE } }, { crawl: { siteUrl: SITE }, cron: "0 * * * *" }, [], "x"]) {
      const res = await http("POST", "/schedules", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("render.urls is checked when the schedule is written (final review I2)", () => {
  /** A create refused with `status` and `code`, its message led by `render.urls`, that stores nothing. */
  async function refusedCreate(
    status: number,
    code: string,
    render: unknown,
    crawl: Record<string, unknown> = {},
  ): Promise<string> {
    const before = await http("GET", "/schedules?limit=200");
    const body = { crawl: { siteUrl: SITE, ...crawl }, cron: "0 * * * *", timezone: "UTC", render };
    const res = await http("POST", "/schedules", body);
    expect(res.status, res.text).toBe(status);
    expect(res.body).toMatchObject({ code });
    expect(String(res.body["error"])).toMatch(/^render\.urls /);
    const viaMcp = await tool("schedule_create", body);
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body).toMatchObject({ code });
    expect((await http("GET", "/schedules?limit=200")).body).toEqual(before.body);
    return String(res.body["error"]);
  }

  it("a URL the URL policy refuses is a 403 FORBIDDEN at create", async () => {
    const error = await refusedCreate(403, "FORBIDDEN", { urls: ["http://169.254.169.254/latest"] });
    expect(error).toContain("refused by the URL policy");
  });

  it("a URL on a host neither the crawl's own site nor in the allowlist is a 403 FORBIDDEN at create", async () => {
    const error = await refusedCreate(403, "FORBIDDEN", { urls: [`${SITE}a`, "http://elsewhere.example/a"] });
    expect(error).toContain("'elsewhere.example'");
  });

  it("more distinct URLs than the planned crawl's renderMaxPages is a 400 VALIDATION at create", async () => {
    const error = await refusedCreate(400, "VALIDATION", { urls: [`${SITE}a`, `${SITE}b`, `${SITE}c`] }, {
      renderMaxPages: 2,
    });
    expect(error).toContain("above this schedule's renderMaxPages of 2");
    // Duplicates are counted once, as crawl_render counts them: two distinct pages fit.
    const made = await create({ render: { urls: [`${SITE}a`, `${SITE}a`, `${SITE}b`] } }, { renderMaxPages: 2 });
    expect(made["render"]).toEqual({ urls: [`${SITE}a`, `${SITE}b`] });
  });

  it("an update's render is checked against the stored crawl, and changes nothing when refused", async () => {
    const made = await create({}, { renderMaxPages: 1 });
    const id = String(made["scheduleId"]);
    const before = await snapshot(id);
    const cap = await http("PATCH", `/schedules/${id}`, { render: { urls: [`${SITE}a`, `${SITE}b`] } });
    expect(cap.status, cap.text).toBe(400);
    expect(cap.body).toMatchObject({ code: "VALIDATION" });
    expect(String(cap.body["error"])).toMatch(/^render\.urls names 2 distinct pages/);
    const offSite = await tool("schedule_update", { scheduleId: id, render: { urls: ["http://elsewhere.example/"] } });
    expect(offSite.isError).toBe(true);
    expect(offSite.body).toMatchObject({ code: "FORBIDDEN" });
    expect(String(offSite.body["error"])).toMatch(/^render\.urls entry/);
    expect(await snapshot(id)).toEqual(before);
  });

  it("an update's crawl is checked against the stored render.urls, and changes nothing when refused", async () => {
    const made = await create({ render: { urls: [`${SITE}a`, `${SITE}b`] } });
    const id = String(made["scheduleId"]);
    const before = await snapshot(id);
    const res = await http("PATCH", `/schedules/${id}`, { crawl: { siteUrl: SITE, renderMaxPages: 1 } });
    expect(res.status, res.text).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION" });
    expect(String(res.body["error"])).toMatch(/^render\.urls names 2 distinct pages/);
    expect(await snapshot(id)).toEqual(before);
    // The same crawl with the render dropped in one update is accepted: the pair is checked as it will stand.
    const both = await http("PATCH", `/schedules/${id}`, { crawl: { siteUrl: SITE, renderMaxPages: 1 }, render: {} });
    expect(both.status, both.text).toBe(200);
    expect(both.body["render"]).toEqual({});
  });
});

describe("interleaved updates (the row is locked and read under the lock)", () => {
  /**
   * `first` runs in a transaction on its own connection that holds the row
   * (`FOR NO KEY UPDATE`, as the scheduler's claim does) and writes its change;
   * `PATCH second` is sent while it is open and must wait for it, then derive
   * its change from what `first` committed. Returns the PATCH's answer.
   */
  async function interleave(
    id: string,
    first: { enabled: boolean; nextRunAt: Date | null },
    second: Record<string, unknown>,
  ): Promise<HttpAnswer> {
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(schedules).where(eq(schedules.id, id)).for("no key update");
      await tx.update(schedules).set(first).where(eq(schedules.id, id));
      locked();
      await open;
    });
    await held;
    let settled = false;
    const patch = http("PATCH", `/schedules/${id}`, second).then((a) => {
      settled = true;
      return a;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "the PATCH did not wait for the row lock").toBe(false);
    release();
    await holder;
    return await patch;
  }

  const finalRowIsConsistent = async (id: string): Promise<typeof schedules.$inferSelect> => {
    const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
    if (row === undefined) throw new Error("schedule vanished");
    expect(row.enabled).toBe(row.nextRunAt !== null);
    if (row.nextRunAt !== null) {
      expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(row.nextRunAt).toEqual(nextSlot(row.cron, row.timezone, new Date(row.nextRunAt.getTime() - 1)));
    }
    return row;
  };

  it("a cron-only patch after a concurrent disable commits a disabled row with no slot, and answers 200", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    const res = await interleave(id, { enabled: false, nextRunAt: null }, { cron: "*/5 * * * *" });
    expect(res.status, res.text).toBe(200);
    const row = await finalRowIsConsistent(id);
    expect(row).toMatchObject({ enabled: false, nextRunAt: null, cron: "*/5 * * * *" });
  });

  it("a cron-only patch after a concurrent enable computes the slot of the committed state", async () => {
    const made = await create({ enabled: false });
    const id = String(made["scheduleId"]);
    const res = await interleave(id, { enabled: true, nextRunAt: new Date(Date.now() + 3_600_000) }, { cron: "*/5 * * * *" });
    expect(res.status, res.text).toBe(200);
    const row = await finalRowIsConsistent(id);
    expect(row).toMatchObject({ enabled: true, cron: "*/5 * * * *" });
    expect(row.nextRunAt).not.toBeNull();
    expect(row.nextRunAt!.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it("an enable after a concurrent disable-and-recron answers 200 with a slot of the final cron", async () => {
    const made = await create();
    const id = String(made["scheduleId"]);
    // The holder changes the cron and disables; the PATCH enables under the lock.
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(schedules).where(eq(schedules.id, id)).for("no key update");
      await tx.update(schedules).set({ enabled: false, nextRunAt: null, cron: "0 12 * * *" }).where(eq(schedules.id, id));
      locked();
      await open;
    });
    await held;
    const patch = http("PATCH", `/schedules/${id}`, { enabled: true });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const res = await patch;
    expect(res.status, res.text).toBe(200);
    const row = await finalRowIsConsistent(id);
    expect(row).toMatchObject({ enabled: true, cron: "0 12 * * *" });
  });
});
