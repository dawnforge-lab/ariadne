/**
 * Setting a crawl's judgement (Phase 27a T6): `crawl_start`'s `judgement`
 * field, `crawl_config_get` (`GET /crawls/:id/config`) and `crawl_config_set`
 * (`PATCH /crawls/:id/config`, an RFC 7396 merge-patch of the block), and the
 * `judgementStale` flag on `crawl_status`, `metrics_get` and `metric_table`,
 * plus `crawl_compare`'s `judgement-overrides` caveat.
 *
 * Over the wire, as test/api/http.test.ts is: a real HTTP server on an
 * ephemeral port and a real MCP server over a linked in-memory transport, so
 * the two transports are held to one refusal text.
 *
 * THE ONE SEAM. `ApiService` builds its own registry, so a rules run cannot be
 * held in flight by a slow rule. `runRules` is wrapped instead (below): it is
 * the real function, run unchanged, except that while a test holds the gate it
 * waits on a promise the test controls before it starts. That is what lets the
 * "refused while the rules are running" case be asserted without a race.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues, pages } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, TOOL_NAMES, type AriadneMcpServer } from "../../src/api/mcp.js";
import { mergePatch } from "../../src/api/judgement-view.js";
import { DEFAULT_THRESHOLDS, OVERRIDABLE_THRESHOLDS } from "../../src/rules/judgement.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { mkPage } from "../rules/mk-page.js";

/** The test-controlled hold on a rules run (see the module header). */
const gate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));

vi.mock("../../src/rules/run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/rules/run.js")>();
  return {
    ...real,
    runRules: async (...args: Parameters<typeof real.runRules>) => {
      if (gate.hold !== null) {
        gate.entered?.();
        await gate.hold;
      }
      return await real.runRules(...args);
    },
  };
});

const TOKEN = "test-token-judgement-config-0123456789";
const SITE = "https://judgement-config.example";
const LONG_TITLE = "A page title written well past the sixty characters a result shows"; // 66

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let exportDir: string;
let siteServer: Server;
let site: string;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;

const createdCrawls: string[] = [];
/** Judged with no overrides in `beforeAll`; the patch and refusal tests use it. */
const judgedId = `crawl_judgement_config_${randomUUID()}`;
/** The same site, judged once and never overridden: the compare's base. */
const compareBaseId = `crawl_judgement_config_base_${randomUUID()}`;
/** Its own crawl for the disable → run → re-enable walk. */
const walkId = `crawl_judgement_config_walk_${randomUUID()}`;
/** Never judged. */
const unjudgedId = `crawl_judgement_config_unjudged_${randomUUID()}`;

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function tool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (first === undefined) throw new Error(`${name} answered with no content`);
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

async function patch(crawlId: string, body: unknown): Promise<Res> {
  return await call("PATCH", `/crawls/${crawlId}/config`, body);
}

async function storedRow(crawlId: string): Promise<{ judgement: unknown; config: unknown }> {
  const rows = await db
    .select({ judgement: crawls.judgement, config: crawls.config })
    .from(crawls)
    .where(eq(crawls.id, crawlId));
  const row = rows[0];
  if (row === undefined) throw new Error(`no crawl row ${crawlId}`);
  return row;
}

async function seedJudgeable(crawlId: string): Promise<void> {
  await db.insert(crawls).values({
    id: crawlId,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 2,
  });
  createdCrawls.push(crawlId);
  const page = (path: string, overrides: Parameters<typeof mkPage>[0] = {}) => {
    const url = `${SITE}${path}`;
    return mkPage({ id: `page_${randomUUID()}`, crawlId, url, urlNormalised: url, ...overrides });
  };
  await db.insert(pages).values([
    page("/", { depth: 0, clickDepth: 0, discoveredVia: "seed" }),
    page("/long", { title: LONG_TITLE }),
  ]);
}

function groups(body: Record<string, unknown>): { ruleId: string; count: number }[] {
  return body["items"] as { ruleId: string; count: number }[];
}

async function siteHealth(crawlId: string): Promise<unknown> {
  const res = await call("GET", `/crawls/${crawlId}/metrics?metricId=site.health`);
  expect(res.status).toBe(200);
  const items = res.body["items"] as { value: unknown }[];
  expect(items).toHaveLength(1);
  return items[0]?.value;
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-judgement-config-"));

  siteServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><head><title>Judgement config fixture</title>` +
        `<meta name="description" content="a fixture page"></head>` +
        `<body><h1>Judgement config fixture</h1></body></html>`,
    );
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", () => r()));
  const address = siteServer.address();
  if (address === null || typeof address === "string") throw new Error("site server bound oddly");
  site = `http://127.0.0.1:${address.port}`;

  api = createApiServer({
    db,
    config: {
      token: TOKEN,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0, maxResources: 1000 },
      exportDir,
      log: () => {},
    },
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;

  mcp = createMcpServer({ db, config: { allowedDomains: [], exportDir, log: () => {} } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-judgement-config", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);

  for (const id of [judgedId, compareBaseId, walkId, unjudgedId]) await seedJudgeable(id);
  for (const id of [judgedId, compareBaseId, walkId]) {
    const res = await call("POST", `/crawls/${id}/rules`);
    if (res.status !== 200) throw new Error(`judging ${id}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}, 120_000);

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await closeFetchAgents();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (createdCrawls.length > 0) await db.delete(crawls).where(inArray(crawls.id, createdCrawls));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
});

describe("mergePatch (RFC 7396)", () => {
  it("merges nested objects key by key", () => {
    expect(
      mergePatch(
        { rules: { a: { disabled: true } }, thresholds: { SLOW_MS: 800 } },
        { rules: { a: { priority: "low" }, b: { type: "issue" } } },
      ),
    ).toEqual({
      rules: { a: { disabled: true, priority: "low" }, b: { type: "issue" } },
      thresholds: { SLOW_MS: 800 },
    });
  });

  it("deletes a key the patch sets to null, at any depth", () => {
    expect(
      mergePatch(
        { rules: { a: { disabled: true, priority: "low" }, b: { type: "issue" } }, thresholds: { SLOW_MS: 800 } },
        { rules: { a: { disabled: null }, b: null }, thresholds: null },
      ),
    ).toEqual({ rules: { a: { priority: "low" } } });
    // Deleting a key that is not there is not an error.
    expect(mergePatch({}, { rules: { missing: null } })).toEqual({ rules: {} });
  });

  it("replaces rather than merges arrays and other non-objects", () => {
    expect(mergePatch({ rules: { a: { disabled: true } } }, { rules: ["a"] })).toEqual({
      rules: ["a"],
    });
    expect(mergePatch({ rules: ["a", "b"] }, { rules: { a: { disabled: true } } })).toEqual({
      rules: { a: { disabled: true } },
    });
    expect(mergePatch({ thresholds: { SLOW_MS: 800 } }, { thresholds: 5 })).toEqual({ thresholds: 5 });
    // A patch that is not an object replaces the whole target (RFC 7396 §2).
    expect(mergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  it("never mutates its inputs", () => {
    const target = { rules: { a: { disabled: true } } };
    const patchDoc = { rules: { a: { disabled: null }, b: { type: "issue" } } };
    const targetCopy = structuredClone(target);
    const patchCopy = structuredClone(patchDoc);
    mergePatch(target, patchDoc);
    expect(target).toEqual(targetCopy);
    expect(patchDoc).toEqual(patchCopy);
  });
});

describe("crawl_start's judgement", () => {
  it("is accepted, stored, and read back by GET /crawls/:id/config", async () => {
    const res = await call("POST", "/crawls", {
      siteUrl: `${site}/`,
      maxPages: 1,
      judgement: { thresholds: { SLOW_MS: 800 } },
    });
    expect(res.status).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);

    const config = await call("GET", `/crawls/${id}/config`);
    expect(config.status).toBe(200);
    expect(config.body["crawlId"]).toBe(id);
    expect(config.body["judgement"]).toEqual({ thresholds: { SLOW_MS: 800 } });
    const thresholds = config.body["thresholds"] as Record<string, Record<string, unknown>>;
    expect(thresholds["SLOW_MS"]).toMatchObject({ value: 800, default: 1500, overridden: true });
    expect(thresholds["SLOW_MS"]).toEqual({
      value: 800,
      default: 1500,
      min: OVERRIDABLE_THRESHOLDS.SLOW_MS.min,
      max: OVERRIDABLE_THRESHOLDS.SLOW_MS.max,
      overridden: true,
    });
    // Every overridable threshold is listed, the untouched ones at their default.
    expect(Object.keys(thresholds).sort()).toEqual(Object.keys(OVERRIDABLE_THRESHOLDS).sort());
    expect(thresholds["TITLE_MAX"]).toMatchObject({ value: 60, default: 60, overridden: false });
    // Not judged yet: no stamp, and nothing to be stale.
    expect(config.body["judgedWith"]).toBeNull();
    expect(config.body["judgementStale"]).toEqual({ stale: false, reasons: [] });

    const row = await storedRow(id);
    expect(row.judgement).toEqual({ thresholds: { SLOW_MS: 800 } });
    // The block never reaches the crawl config.
    expect(row.config).not.toHaveProperty("judgement");
  });

  it("stores judgement.findingCap in config_jsonb, never in judgement_jsonb", async () => {
    const res = await call("POST", "/crawls", {
      siteUrl: `${site}/`,
      maxPages: 1,
      judgement: { findingCap: 50, rules: { "title.too-long": { priority: "low" } } },
    });
    expect(res.status).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);

    const row = await storedRow(id);
    expect(row.judgement).toEqual({ rules: { "title.too-long": { priority: "low" } } });
    expect((row.config as Record<string, unknown>)["findingCap"]).toBe(50);

    const config = await call("GET", `/crawls/${id}/config`);
    expect(config.body["judgement"]).toEqual({
      rules: { "title.too-long": { priority: "low" } },
      findingCap: 50,
    });
    const status = await call("GET", `/crawls/${id}`);
    expect(status.body["findingCap"]).toBe(50);
  });

  it("accepts findingCap at both levels when they agree", async () => {
    const res = await call("POST", "/crawls", {
      siteUrl: `${site}/`,
      maxPages: 1,
      findingCap: null,
      judgement: { findingCap: null },
    });
    expect(res.status).toBe(202);
    const id = String(res.body["crawlId"]);
    createdCrawls.push(id);
    const row = await storedRow(id);
    expect((row.config as Record<string, unknown>)["findingCap"]).toBeNull();
    expect(row.judgement).toEqual({});
  });

  it("refuses findingCap at both levels when they disagree, naming both", async () => {
    const res = await call("POST", "/crawls", {
      siteUrl: `${site}/`,
      maxPages: 1,
      findingCap: 100,
      judgement: { findingCap: 200 },
    });
    expect(res.status).toBe(400);
    const error = String(res.body["error"]);
    expect(error).toContain("findingCap (100)");
    expect(error).toContain("judgement.findingCap (200)");
  });

  it("refuses a block parseJudgement refuses, naming the path", async () => {
    const res = await call("POST", "/crawls", {
      siteUrl: `${site}/`,
      judgement: { rules: { "title.too-long": { severity: "info" } } },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("rules.title.too-long.severity");
  });

  it("refuses a judgement that is not an object", async () => {
    for (const judgement of [null, ["rules"], "none"]) {
      const res = await call("POST", "/crawls", { siteUrl: `${site}/`, judgement });
      expect(res.status, JSON.stringify(judgement)).toBe(400);
      expect(String(res.body["error"])).toContain("judgement");
    }
  });
});

describe("crawl_config_set — PATCH /crawls/:id/config", () => {
  it("sets an override and returns the config with it", async () => {
    const res = await patch(judgedId, {
      judgement: { rules: { "title.too-long": { disabled: true } } },
    });
    expect(res.status).toBe(200);
    expect(res.body["crawlId"]).toBe(judgedId);
    expect(res.body["judgement"]).toEqual({ rules: { "title.too-long": { disabled: true } } });
    // Judged with nothing disabled; the block now disables one rule.
    expect(res.body["judgedWith"]).toEqual({
      disabledRules: [],
      thresholds: { ...DEFAULT_THRESHOLDS },
    });
    expect(res.body["judgementStale"]).toEqual({ stale: true, reasons: ["overrides"] });
  });

  it("removes an override with null, leaving the stored block {}", async () => {
    const res = await patch(judgedId, { judgement: { rules: { "title.too-long": null } } });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({});
    expect(res.body["judgementStale"]).toEqual({ stale: false, reasons: [] });
    expect((await storedRow(judgedId)).judgement).toEqual({});
  });

  it("merges nested overrides and removes thresholds with null", async () => {
    await patch(judgedId, { judgement: { rules: { "title.too-long": { disabled: true } } } });
    let res = await patch(judgedId, {
      judgement: { rules: { "title.too-long": { priority: "low" } }, thresholds: { SLOW_MS: 900 } },
    });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({
      rules: { "title.too-long": { disabled: true, priority: "low" } },
      thresholds: { SLOW_MS: 900 },
    });

    res = await patch(judgedId, {
      judgement: { rules: { "title.too-long": { disabled: null } }, thresholds: { SLOW_MS: null } },
    });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({ rules: { "title.too-long": { priority: "low" } } });

    res = await patch(judgedId, { judgement: { rules: null } });
    expect(res.body["judgement"]).toEqual({});
    expect((await storedRow(judgedId)).judgement).toEqual({});
  });

  it("an empty judgement patch changes nothing and answers the config", async () => {
    const res = await patch(judgedId, { judgement: {} });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({});
  });

  it("refuses every key other than judgement", async () => {
    const res = await patch(judgedId, { maxPages: 10 });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("only `crawl` and `judgement` can be set");
    expect(String(res.body["error"])).toContain("maxPages");
    // Beside a judgement too: nothing is half-applied.
    const both = await patch(judgedId, {
      judgement: { rules: { "title.too-long": { disabled: true } } },
      maxPages: 10,
    });
    expect(both.status).toBe(400);
    expect((await storedRow(judgedId)).judgement).toEqual({});
  });

  it("refuses severity, naming the path", async () => {
    const res = await patch(judgedId, {
      judgement: { rules: { "title.too-long": { severity: "info" } } },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("rules.title.too-long.severity");
    expect((await storedRow(judgedId)).judgement).toEqual({});
  });

  it("refuses an unknown rule as a bad request, not a conflict", async () => {
    const res = await patch(judgedId, { judgement: { rules: { "no.such-rule": { disabled: true } } } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("rules.no.such-rule");
  });

  it("refuses a body with no judgement, a null judgement and a non-object one", async () => {
    for (const body of [undefined, {}, { judgement: null }, { judgement: [] }, { judgement: 5 }]) {
      const res = await patch(judgedId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("404s an unknown crawl", async () => {
    const res = await patch("crawl_missing", { judgement: {} });
    expect(res.status).toBe(404);
    expect((await call("GET", "/crawls/crawl_missing/config")).status).toBe(404);
  });

  it("can repair a stored override naming a rule the ruleset no longer has", async () => {
    await db.update(crawls).set({ judgement: { rules: { "gone.rule": { disabled: true } } } }).where(eq(crawls.id, judgedId));
    // Read surfaces refuse it (T5) …
    expect((await call("GET", `/crawls/${judgedId}/config`)).status).toBe(409);
    // … and the setter is how it is fixed.
    const res = await patch(judgedId, { judgement: { rules: { "gone.rule": null } } });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({});
  });

  it("crawl_rules 409s a stored override of a removed rule, touching nothing", async () => {
    const judged = async () => {
      const rows = await db
        .select({ rulesRunAt: crawls.rulesRunAt, rulesJudgedWith: crawls.rulesJudgedWith })
        .from(crawls)
        .where(eq(crawls.id, judgedId));
      const findings = await db
        .select({ key: issues.dedupeKey, ruleId: issues.ruleId, details: issues.details })
        .from(issues)
        .where(eq(issues.crawlId, judgedId));
      return { row: rows[0], findings: findings.map((f) => JSON.stringify(f)).sort() };
    };
    const before = await judged();
    expect(before.row?.rulesRunAt).not.toBeNull();
    expect(before.findings.length).toBeGreaterThan(0);
    await db
      .update(crawls)
      .set({ judgement: { rules: { "gone.rule": { disabled: true } } } })
      .where(eq(crawls.id, judgedId));
    try {
      const res = await call("POST", `/crawls/${judgedId}/rules`);
      expect(res.status).toBe(409);
      const error = String(res.body["error"]);
      expect(error).toContain(`crawl ${judgedId}'s stored judgement overrides rule 'gone.rule'`);
      expect(error).toContain("crawl_config_set");
      // The read surfaces answer the same text.
      expect((await call("GET", `/crawls/${judgedId}/config`)).body["error"]).toBe(error);
      // Refused before anything was claimed or written: the findings, the
      // judged marker and the stamp are exactly as they were.
      expect(await judged()).toEqual(before);
    } finally {
      await db.update(crawls).set({ judgement: {} }).where(eq(crawls.id, judgedId));
    }
    // And the crawl is not left held: once repaired, a run goes through.
    expect((await call("POST", `/crawls/${judgedId}/rules`)).status).toBe(200);
  });

  it("409s while a rules run is in flight for the crawl, and not after", async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    gate.hold = new Promise<void>((r) => {
      release = r;
    });
    gate.entered = entered;
    const run = call("POST", `/crawls/${judgedId}/rules`);
    try {
      await inFlight;
      const refused = await patch(judgedId, {
        judgement: { rules: { "title.too-long": { disabled: true } } },
      });
      expect(refused.status).toBe(409);
      expect(String(refused.body["error"])).toContain(`rules are running for crawl ${judgedId}`);
      expect((await storedRow(judgedId)).judgement).toEqual({});
    } finally {
      gate.hold = null;
      gate.entered = null;
      release();
    }
    expect((await run).status).toBe(200);
    const after = await patch(judgedId, { judgement: {} });
    expect(after.status).toBe(200);
  });
});

/**
 * `findingCap` in a merge-patch. RFC 7396 reads `null` as "remove the key",
 * but for this key null is a VALUE — uncapped — everywhere else on the surface
 * (`crawl_start`, `crawl_status`). Reading it as a deletion would turn an
 * agent's "make this a billed, uncapped audit" into the engine default of 200
 * without a word. So in `crawl_config_set` `judgement.findingCap: null` sets
 * uncapped, exactly as at `crawl_start`, and the default is restored by sending
 * it (200, which judges exactly as an absent key does).
 */
describe("findingCap through crawl_config_set", () => {
  it("a number is stored in config_jsonb and is a findingCap staleness", async () => {
    const res = await patch(judgedId, { judgement: { findingCap: 50 } });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({ findingCap: 50 });
    expect(res.body["judgementStale"]).toEqual({ stale: true, reasons: ["findingCap"] });
    const row = await storedRow(judgedId);
    expect((row.config as Record<string, unknown>)["findingCap"]).toBe(50);
    expect(row.judgement).toEqual({});
    expect((await call("GET", `/crawls/${judgedId}`)).body["findingCap"]).toBe(50);
  });

  it("null is uncapped, as at crawl_start — never a silent return to the default", async () => {
    const res = await patch(judgedId, { judgement: { findingCap: null } });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({ findingCap: null });
    const row = await storedRow(judgedId);
    expect(row.config).toHaveProperty("findingCap", null);
    expect(row.judgement).toEqual({});
    expect((await call("GET", `/crawls/${judgedId}`)).body["findingCap"]).toBeNull();
  });

  it("the engine default is restored by naming it, and is not stale", async () => {
    const res = await patch(judgedId, { judgement: { findingCap: 200 } });
    expect(res.status).toBe(200);
    expect(res.body["judgement"]).toEqual({ findingCap: 200 });
    expect(res.body["judgementStale"]).toEqual({ stale: false, reasons: [] });
  });

  it("refuses a findingCap that is not a positive integer", async () => {
    const res = await patch(judgedId, { judgement: { findingCap: 0 } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("findingCap");
  });
});

describe("judgementStale on crawl_status, metrics_get and metric_table", () => {
  it("is false on a crawl nobody has judged", async () => {
    const res = await call("GET", `/crawls/${unjudgedId}`);
    expect(res.status).toBe(200);
    expect(res.body["judgementStale"]).toEqual({ stale: false, reasons: [] });
  });

  it("is false on a judged crawl whose block has not moved", async () => {
    const res = await call("GET", `/crawls/${compareBaseId}`);
    expect(res.body["judgementStale"]).toEqual({ stale: false, reasons: [] });
    const metrics = await call("GET", `/crawls/${compareBaseId}/metrics`);
    expect(metrics.body["judgementStale"]).toEqual({ stale: false, reasons: [] });
  });

  it("reports a threshold patch on a judged crawl until the rules re-run", async () => {
    await patch(judgedId, { judgement: { thresholds: { SLOW_MS: 900 } } });
    const stale = { stale: true, reasons: ["thresholds"] };

    expect((await call("GET", `/crawls/${judgedId}`)).body["judgementStale"]).toEqual(stale);
    const metrics = await call("GET", `/crawls/${judgedId}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.body["judgementStale"]).toEqual(stale);
    const table = await call("GET", `/crawls/${judgedId}/metrics/site.health`);
    expect(table.status).toBe(200);
    expect(table.body["judgementStale"]).toEqual(stale);
    // The MCP tools answer the same flag.
    expect((await tool("crawl_status", { crawlId: judgedId })).body["judgementStale"]).toEqual(stale);
    expect((await tool("metrics_get", { crawlId: judgedId })).body["judgementStale"]).toEqual(stale);
    expect(
      (await tool("metric_table", { crawlId: judgedId, metricId: "site.health" })).body["judgementStale"],
    ).toEqual(stale);

    expect((await call("POST", `/crawls/${judgedId}/rules`)).status).toBe(200);
    expect((await call("GET", `/crawls/${judgedId}`)).body["judgementStale"]).toEqual({
      stale: false,
      reasons: [],
    });
    const config = await call("GET", `/crawls/${judgedId}/config`);
    // The stamp holds every threshold at the value the run USED.
    expect(config.body["judgedWith"]).toEqual({
      disabledRules: [],
      thresholds: { ...DEFAULT_THRESHOLDS, SLOW_MS: 900 },
      findingCap: 200,
    });

    await patch(judgedId, { judgement: { thresholds: null } });
  });
});

describe("over MCP", () => {
  it("lists crawl_config_get and crawl_config_set", async () => {
    expect(TOOL_NAMES).toContain("crawl_config_get");
    expect(TOOL_NAMES).toContain("crawl_config_set");
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain("crawl_config_get");
    expect(listed).toContain("crawl_config_set");
  });

  it("crawl_config_get answers what GET /crawls/:id/config answers", async () => {
    const viaMcp = await tool("crawl_config_get", { crawlId: judgedId });
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.body).toEqual((await call("GET", `/crawls/${judgedId}/config`)).body);
  });

  it("crawl_config_set refuses severity with the HTTP route's text", async () => {
    const judgement = { rules: { "title.too-long": { severity: "info" } } };
    const viaMcp = await tool("crawl_config_set", { crawlId: judgedId, judgement });
    const viaHttp = await patch(judgedId, { judgement });
    expect(viaMcp.isError).toBe(true);
    expect(viaHttp.status).toBe(400);
    expect(viaMcp.body["error"]).toBe(viaHttp.body["error"]);
    expect(String(viaMcp.body["error"])).toContain("rules.title.too-long.severity");
  });

  it("crawl_start takes the judgement field", async () => {
    const refused = await tool("crawl_start", {
      siteUrl: `${SITE}/`,
      judgement: { rules: { "title.too-long": { priority: "low" } } },
    });
    // A valid block passes the tool's schema; the MCP server's allowlist is
    // empty, so the handler refuses it — the schema admits the field at all.
    expect(refused.isError).toBe(true);
    expect(String(refused.body["error"])).toContain("allowlist");
  });
});

describe("crawl_compare", () => {
  it("adds a judgement-overrides caveat naming the crawl and the count", async () => {
    const path = `/compare?baseCrawlId=${compareBaseId}&headCrawlId=${judgedId}`;
    const before = await call("GET", path);
    expect(before.status).toBe(200);
    const codes = (body: Record<string, unknown>) =>
      (body["caveats"] as { code: string }[]).map((c) => c.code);
    expect(codes(before.body)).not.toContain("judgement-overrides");

    await patch(judgedId, { judgement: { rules: { "title.too-long": { disabled: true } } } });
    try {
      const after = await call("GET", path);
      expect(after.status).toBe(200);
      const caveat = (after.body["caveats"] as { code: string; message: string }[]).find(
        (c) => c.code === "judgement-overrides",
      );
      expect(caveat).toBeDefined();
      expect(caveat?.message).toContain(judgedId);
      expect(caveat?.message).toContain("1 rule");
      expect(caveat?.message).not.toContain(compareBaseId);
      // It does not decide comparability.
      expect(after.body["comparable"]).toBe(before.body["comparable"]);
    } finally {
      await patch(judgedId, { judgement: { rules: null } });
    }
  });
});

/**
 * Review focus 2 of Task 5, end to end: rule overrides act at READ time, the
 * stored aggregate does not. Disable a rule that fires, judge, re-enable with
 * no further run: the group is back at once, the listing says the judgement is
 * stale on the overrides (the stamp records the disabled set, the block is now
 * empty), and `site.health` still holds what the disabled run computed.
 */
describe("disable, judge, re-enable", () => {
  // `links.orphan` is the one WARNING on /long (whose other finding is
  // title.too-long, an info), so disabling it moves /long from "warning only"
  // to "info only" in `site.health` — a change the stored value must show.
  const RULE = "links.orphan";

  it("brings the group back at once while site.health keeps the disabled run's value", async () => {
    const enabledHealth = (await siteHealth(walkId)) as Record<string, number>;
    expect(enabledHealth["urlsWithWarningOnly"]).toBe(1);
    expect(enabledHealth["urlsWithInfoOnly"]).toBe(0);

    const disabled = await tool("crawl_config_set", {
      crawlId: walkId,
      judgement: { rules: { [RULE]: { disabled: true } } },
    });
    expect(disabled.isError).toBe(false);
    const run = await tool("crawl_rules", { crawlId: walkId });
    expect(run.isError).toBe(false);
    const disabledHealth = (await siteHealth(walkId)) as Record<string, number>;
    // The disabled run left /long's warning out of the census.
    expect(disabledHealth["urlsWithWarningOnly"]).toBe(0);
    expect(disabledHealth["urlsWithInfoOnly"]).toBe(1);

    const listedWhileDisabled = await tool("issues_list", { crawlId: walkId, limit: 200 });
    expect(groups(listedWhileDisabled.body).map((g) => g.ruleId)).not.toContain(RULE);

    const reenabled = await tool("crawl_config_set", {
      crawlId: walkId,
      judgement: { rules: { [RULE]: null } },
    });
    expect(reenabled.isError).toBe(false);
    expect(reenabled.body["judgement"]).toEqual({});

    const listed = await tool("issues_list", { crawlId: walkId, limit: 200 });
    expect(listed.isError).toBe(false);
    const group = groups(listed.body).find((g) => g.ruleId === RULE);
    expect(group?.count).toBeGreaterThan(0);
    expect(listed.body["disabledRules"]).toEqual([]);
    expect(listed.body["judgementStale"]).toEqual({ stale: true, reasons: ["overrides"] });

    // The stored aggregate is the run's, not the reader's.
    expect(await siteHealth(walkId)).toEqual(disabledHealth);
  });
});

/**
 * Phase 27b T7: `crawl_config_get` shows the crawl part and `crawl_config_set`
 * changes it while the crawl is queued or paused. The queue and pacing cases
 * (a queued crawl's change applying, a resume never beating earned spacing, a
 * render pass in flight) are in lifecycle.test.ts, which has the running site.
 */
describe("the crawl part of crawl_config_get / crawl_config_set (27b T7)", () => {
  const seedStatus = async (
    status: string,
    config: Record<string, unknown> = {},
    extra: Partial<typeof crawls.$inferInsert> = {},
  ): Promise<string> => {
    const id = `crawl_config_part_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: `${SITE}/`,
      config: {
        siteUrl: `${SITE}/`,
        maxPages: 100,
        maxDepth: 5,
        userAgent: "AriadneBot-test",
        perHostDelayMs: 1000,
        maxConcurrency: 4,
        probeHosts: false,
        ...config,
      },
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status,
      ...(status === "paused" ? { pauseReason: "request" } : {}),
      pagesCrawled: 5,
      ...extra,
    });
    createdCrawls.push(id);
    return id;
  };

  const storedConfig = async (id: string): Promise<Record<string, unknown>> =>
    (await storedRow(id)).config as Record<string, unknown>;

  it("shows every stored key with its mutability, and equals what config_validate promised", async () => {
    const body = { siteUrl: `${site}/`, maxPages: 3, findingCap: 50 };
    const checked = await call("POST", "/config/validate", body);
    expect(checked.status).toBe(200);
    const { judgement: _judgement, ...effective } = checked.body["effective"] as Record<string, unknown>;

    const started = await call("POST", "/crawls", body);
    expect(started.status).toBe(202);
    const id = String(started.body["crawlId"]);
    createdCrawls.push(id);

    const got = await call("GET", `/crawls/${id}/config`);
    expect(got.status).toBe(200);
    const { findingCap, ...storedLess } = await storedConfig(id);
    expect(findingCap).toBe(50);
    // The equality chain (Ruling 1): validate's effective, the stored row and
    // the read all say the same thing.
    expect(got.body["crawl"]).toEqual(storedLess);
    const { findingCap: _cap, ...effectiveLess } = effective;
    expect(got.body["crawl"]).toEqual(effectiveLess);
    expect(got.body["crawl"]).not.toHaveProperty("findingCap");
    expect((got.body["judgement"] as Record<string, unknown>)["findingCap"]).toBe(50);

    const crawl = got.body["crawl"] as Record<string, unknown>;
    expect(crawl["maxPages"]).toBe(3);
    expect(crawl["maxResources"]).toBe(1000);
    const mutability = got.body["mutability"] as Record<string, string>;
    expect(mutability["siteUrl"]).toBe("never");
    expect(mutability["maxPages"]).toBe("whenPaused");
    expect(mutability["perHostDelayMs"]).toBe("whenPaused");
    expect(mutability["judgement"]).toBe("always");
    expect(mutability["maxResources"]).toBe("never");
    for (const key of Object.keys(crawl)) expect(mutability, key).toHaveProperty(key);
    expect(mutability).not.toHaveProperty("findingCap");

    // Let the run close before the suite deletes its row.
    for (let i = 0; i < 600; i += 1) {
      const status = (await call("GET", `/crawls/${id}`)).body["status"];
      if (status !== "queued" && status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 60_000);

  it("changes maxPages on a paused crawl, stores it and reports it", async () => {
    const id = await seedStatus("paused");
    const res = await patch(id, { crawl: { maxPages: 900 } });
    expect(res.status).toBe(200);
    expect((res.body["crawl"] as Record<string, unknown>)["maxPages"]).toBe(900);
    expect((await storedConfig(id))["maxPages"]).toBe(900);
    expect((await storedConfig(id))["maxDepth"]).toBe(5);
    const viaMcp = await tool("crawl_config_set", { crawlId: id, crawl: { maxDepth: 7 } });
    expect(viaMcp.isError).toBe(false);
    expect((viaMcp.body["crawl"] as Record<string, unknown>)["maxDepth"]).toBe(7);
    expect((await call("GET", `/crawls/${id}/config`)).body["crawl"]).toEqual(viaMcp.body["crawl"]);
  });

  it("changes a queued crawl's settings too", async () => {
    const id = await seedStatus("queued");
    const res = await patch(id, { crawl: { perHostDelayMs: 500, maxConcurrency: 2 } });
    expect(res.status).toBe(200);
    expect(await storedConfig(id)).toMatchObject({ perHostDelayMs: 500, maxConcurrency: 2 });
  });

  it("refuses a whenPaused field on a running, finished or failed crawl, naming status and mutability", async () => {
    for (const status of ["running", "finished", "failed"]) {
      const id = await seedStatus(status);
      const res = await patch(id, { crawl: { maxPages: 900 } });
      expect(res.status, status).toBe(409);
      expect(String(res.body["error"]), status).toContain(status);
      expect(String(res.body["error"]), status).toContain("whenPaused");
      expect((await storedConfig(id))["maxPages"], status).toBe(100);
    }
  });

  it("refuses a never field with 409", async () => {
    const id = await seedStatus("paused");
    const res = await patch(id, { crawl: { siteUrl: "https://elsewhere.example/" } });
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("never mutable");
    expect(String(res.body["error"])).toContain("(mutability: never)");
    expect((await storedConfig(id))["siteUrl"]).toBe(`${SITE}/`);
  });

  it("refuses maxPages below the pages already crawled, naming both numbers", async () => {
    const id = await seedStatus("paused");
    const res = await patch(id, { crawl: { maxPages: 4 } });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("4");
    expect(String(res.body["error"])).toContain("5 pages");
    expect((await patch(id, { crawl: { maxPages: 5 } })).status).toBe(200);
  });

  it("refuses a bad value with start's own message, a null, an operator-only key and an unknown one", async () => {
    const id = await seedStatus("paused");
    const floor = await patch(id, { crawl: { perHostDelayMs: 100 } });
    expect(floor.status).toBe(400);
    expect(String(floor.body["error"])).toContain("politeness floor of 250ms");
    const asStart = await call("POST", "/config/validate", { siteUrl: `${site}/`, perHostDelayMs: 100 });
    expect(floor.body["error"]).toBe(
      ((asStart.body["errors"] as { message: string }[])[0] as { message: string }).message,
    );

    const nulled = await patch(id, { crawl: { maxPages: null } });
    expect(nulled.status).toBe(400);
    expect(String(nulled.body["error"])).toContain("no unset");

    const operator = await patch(id, { crawl: { maxResources: 5 } });
    expect(operator.status).toBe(400);
    expect(String(operator.body["error"])).toContain("set by the operator, not over the API");

    expect((await patch(id, { crawl: { nope: 1 } })).status).toBe(400);
    expect((await patch(id, { crawl: { allowPrivate: true } })).status).toBe(400);
    expect((await patch(id, { crawl: { findingCap: 5 } })).status).toBe(400);
    expect((await patch(id, { crawl: { maxPages: "9" } })).status).toBe(400);
    expect((await patch(id, { crawl: { renderMaxPages: -1 } })).status).toBe(400);
    expect((await patch(id, { crawl: "maxPages" })).status).toBe(400);
    expect((await patch(id, { other: {} })).status).toBe(400);
    expect((await patch(id, {})).status).toBe(400);
    expect((await storedConfig(id))["maxPages"]).toBe(100);
  });

  it("writes nothing when the judgement half is refused: crawl and judgement are one transaction", async () => {
    // A VALID crawl half (maxPages 900 on a paused crawl, which alone is
    // accepted) and a judgement half that only `parseJudgement` refuses, and
    // only AFTER the merge is built: the patch empties the stored override, so
    // the merged `{}` is refused. Both halves pass every check made before the
    // transaction, so only the one transaction keeps maxPages at 100.
    const id = await seedStatus("paused", {}, { judgement: { rules: { "title.too-long": { disabled: true } } } });
    const before = await storedRow(id);
    const res = await patch(id, {
      crawl: { maxPages: 900 },
      judgement: { rules: { "title.too-long": { disabled: null } } },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("rules.title.too-long");
    expect((await storedConfig(id))["maxPages"]).toBe(100);
    expect(await storedRow(id)).toEqual(before);
  });

  it("applies the crawl and judgement halves together", async () => {
    const id = await seedStatus("paused");
    const res = await patch(id, {
      crawl: { maxPages: 900 },
      judgement: { rules: { "title.too-long": { disabled: true } }, findingCap: 25 },
    });
    expect(res.status).toBe(200);
    expect(await storedConfig(id)).toMatchObject({ maxPages: 900, findingCap: 25 });
    expect((await storedRow(id)).judgement).toEqual({
      rules: { "title.too-long": { disabled: true } },
    });
  });

  it("still changes a running crawl's judgement alone", async () => {
    const id = await seedStatus("running");
    const res = await patch(id, { judgement: { thresholds: { SLOW_MS: 900 } } });
    expect(res.status).toBe(200);
  });
});

describe("judgement refusal wording: the start body and crawl_config_set say the same sentence (27b final M10)", () => {
  /** The sentence after the path, so the start body's `judgement.` prefix does not matter. */
  const detailAfter = (message: string, path: string): string => {
    const at = message.indexOf(`${path}: `);
    if (at === -1) throw new Error(`'${message}' does not name ${path}`);
    return message.slice(at + path.length + 2);
  };

  it("an out-of-range threshold", async () => {
    const { min, max } = OVERRIDABLE_THRESHOLDS.SLOW_MS;
    const judgement = { thresholds: { SLOW_MS: max + 1 } };
    const started = await call("POST", "/crawls", { siteUrl: `${site}/`, maxPages: 1, judgement });
    expect(started.status).toBe(400);
    const id = `crawl_wording_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: `${SITE}/`,
      config: { siteUrl: `${SITE}/`, maxPages: 10, maxDepth: 3, userAgent: "AriadneBot-test", perHostDelayMs: 1000, maxConcurrency: 1 },
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    const set = await patch(id, { judgement });
    expect(set.status).toBe(400);

    const sentence = `must be an integer in [${min}, ${max}]`;
    const fromStart = detailAfter(String(started.body["error"]), "thresholds.SLOW_MS");
    const fromSet = detailAfter(String(set.body["error"]), "thresholds.SLOW_MS");
    expect(fromStart).toBe(sentence);
    expect(fromSet).toBe(sentence);
  });

  it("a non-object rule override", async () => {
    const judgement = { rules: { "title.too-long": "off" } };
    const started = await call("POST", "/crawls", { siteUrl: `${site}/`, maxPages: 1, judgement });
    expect(started.status).toBe(400);
    const id = `crawl_wording_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: `${SITE}/`,
      config: { siteUrl: `${SITE}/`, maxPages: 10, maxDepth: 3, userAgent: "AriadneBot-test", perHostDelayMs: 1000, maxConcurrency: 1 },
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    const set = await patch(id, { judgement });
    expect(set.status).toBe(400);
    const fromStart = detailAfter(String(started.body["error"]), "rules.title.too-long");
    const fromSet = detailAfter(String(set.body["error"]), "rules.title.too-long");
    expect(fromSet).toBe(fromStart);
  });
});
