/**
 * Phase 25 added columns and page facts that are evidence for rules, not
 * surface. This pins the outputs a client sees: no new key leaks through
 * `crawl_status`, `crawl_list` or the `pages` field allowlist.
 * (`render_launch_error` gets its one surface in Task 4, inside the
 * `render.coverage` metric value, never as a crawl key.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { PAGE_FIELDS } from "../../src/api/service.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

const TOKEN = "test-token-0123456789abcdef";
const SITE = "https://surface-unchanged.test";
const FORBIDDEN_CRAWL_KEYS = [
  "request_headers", "requestHeaders",
  "engine_version", "engineVersion",
  "render_launch_error", "renderLaunchError",
];

let db: Db;
let api: ApiServer;
let base: string;
const id = `crawl_surface_${Date.now()}`;

beforeAll(async () => {
  db = createDb(process.env["DATABASE_URL"]!);
  await runMigrations(db);
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/` },
    rulesetVersion: "0.0.0-test",
    status: "finished",
    requestHeaders: { "user-agent": "x" },
    engineVersion: "0.0.1+abc",
    renderLaunchError: "boom",
  });
  api = createApiServer({
    db,
    config: { token: TOKEN, allowedDomains: [], exportDir: "/tmp", log: () => {} },
  });
  const bound = await api.listen(0);
  base = `http://127.0.0.1:${bound.port}`;
});

afterAll(async () => {
  await api.close();
  await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
});

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-ariadne-tenant": "local" } });
  expect(res.status).toBe(200);
  return res.json();
}

describe("the surface is unchanged by Phase 25", () => {
  it("crawl_status and crawl_list carry no request_headers, engine_version or render_launch_error key", async () => {
    const status = JSON.stringify(await get(`/crawls/${id}`));
    const list = JSON.stringify(await get(`/crawls?siteUrl=${encodeURIComponent(`${SITE}/`)}`));
    expect(list).toContain(id);
    for (const key of FORBIDDEN_CRAWL_KEYS) {
      expect(status).not.toContain(`"${key}"`);
      expect(list).not.toContain(`"${key}"`);
    }
  });

  it("the pages field allowlist has no response_headers, render_console, extraction_version or render_version", () => {
    const keys = Object.keys(PAGE_FIELDS);
    for (const key of [
      "responseHeaders", "response_headers", "renderConsole", "render_console",
      "extractionVersion", "extraction_version", "renderVersion", "render_version",
    ]) {
      expect(keys).not.toContain(key);
    }
  });
});
