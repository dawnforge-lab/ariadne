/**
 * Phase 29d, Task 6: the crawl identity on the config surface. A start body
 * takes `userAgentPreset` / `robotsUserAgent` and the validated config carries
 * the resolved trio; `crawl_config_set` refuses to change them (`never`);
 * `crawl_config_get` echoes them; a conflict or a bad token is a 400.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { USER_AGENT_PRESETS } from "../../src/crawl/user-agents.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const TOKEN = "test-token-user-agent-config-0123456789";
const SITE = "http://127.0.0.1:9";

let db: Db;
let api: ApiServer;
let base: string;
const created: string[] = [];

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-ariadne-tenant": "local",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  const config: ServiceConfig = {
    credentialKeys: TEST_CREDENTIAL_KEYS,
    allowedDomains: ["127.0.0.1"],
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    log: () => undefined,
  };
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

afterAll(async () => {
  await api.close();
  if (created.length > 0) await db.delete(crawls).where(inArray(crawls.id, created));
  await closeDb(db);
});

describe("config_validate: the resolved identity", () => {
  it("the default body resolves to the branded trio", async () => {
    const res = await call("POST", "/config/validate", { siteUrl: `${SITE}/` });
    expect(res.status, res.text).toBe(200);
    expect(res.body["valid"], res.text).toBe(true);
    expect(res.body["effective"]).toMatchObject({
      userAgent: USER_AGENT_PRESETS.ariadne.userAgent,
      robotsUserAgent: "AriadneBot",
      userAgentPreset: "ariadne",
    });
  });

  it("a preset resolves to its header and token", async () => {
    const res = await call("POST", "/config/validate", { siteUrl: `${SITE}/`, userAgentPreset: "bingbot" });
    expect(res.body["valid"], res.text).toBe(true);
    expect(res.body["effective"]).toMatchObject({ ...USER_AGENT_PRESETS.bingbot, userAgentPreset: "bingbot" });
  });

  it("a custom agent derives its token, and stores no preset", async () => {
    const res = await call("POST", "/config/validate", { siteUrl: `${SITE}/`, userAgent: "Acme/1.0 (+https://acme.test)" });
    expect(res.body["effective"]).toMatchObject({ robotsUserAgent: "Acme", userAgentPreset: null });
  });

  it("refuses a preset with a userAgent, and a Mozilla/ agent with no token, as a 400-class refusal", async () => {
    const both = await call("POST", "/config/validate", { siteUrl: `${SITE}/`, userAgentPreset: "bingbot", userAgent: "x" });
    expect(both.body["valid"]).toBe(false);
    expect(JSON.stringify(both.body["errors"])).toContain("userAgentPreset and userAgent cannot both be set");
    const started = await call("POST", "/crawls", { siteUrl: `${SITE}/`, userAgent: "Mozilla/5.0 (compatible; Acme/1.0)" });
    expect(started.status).toBe(400);
    expect(String(started.body["error"])).toContain("Set robotsUserAgent.");
    const alone = await call("POST", "/crawls", { siteUrl: `${SITE}/`, robotsUserAgent: "Googlebot" });
    expect(alone.status).toBe(400);
    expect(String(alone.body["error"])).toContain("robotsUserAgent needs a custom userAgent");
  });
});

describe("a stored crawl's identity", () => {
  async function paused(config: Record<string, unknown>): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: `${SITE}/`,
      hostKey: hostKeyOf(`${SITE}/`),
      config,
      rulesetVersion: "test",
      status: "paused",
      pagesCrawled: 0,
    });
    created.push(id);
    return id;
  }

  const stored = {
    siteUrl: `${SITE}/`,
    maxPages: 10,
    maxDepth: 3,
    perHostDelayMs: 0,
    maxConcurrency: 1,
    ...USER_AGENT_PRESETS["googlebot-desktop"],
    userAgentPreset: "googlebot-desktop",
  };

  it("crawl_config_get echoes the trio, and crawl_config_set refuses to change any of them", async () => {
    const id = await paused(stored);
    const got = await call("GET", `/crawls/${id}/config`);
    expect(got.status, got.text).toBe(200);
    expect(got.body["crawl"]).toMatchObject({
      userAgent: stored.userAgent,
      robotsUserAgent: "Googlebot",
      userAgentPreset: "googlebot-desktop",
    });
    expect(got.body["mutability"]).toMatchObject({
      userAgent: "never",
      robotsUserAgent: "never",
      userAgentPreset: "never",
    });
    for (const change of [{ userAgentPreset: "bingbot" }, { robotsUserAgent: "Other" }]) {
      const set = await call("PATCH", `/crawls/${id}/config`, { crawl: change });
      expect(set.status, set.text).toBe(409);
    }
  });
});
