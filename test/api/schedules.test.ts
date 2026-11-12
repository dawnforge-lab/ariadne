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

  it("missing keys and a non-object body are 400s", async () => {
    for (const body of [{}, { crawl: { siteUrl: SITE } }, { crawl: { siteUrl: SITE }, cron: "0 * * * *" }, [], "x"]) {
      const res = await http("POST", "/schedules", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
