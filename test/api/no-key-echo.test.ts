/**
 * Phase 27d Task 6 (spec §4, gate clause 2): no error, in any transport, ever
 * quotes a key the client sent.
 *
 * A key can be a value pasted into the wrong place — a secret under
 * `judgement.rules`, an API key as a query parameter name. An error names such
 * a key by its POSITION ("key 3 in the order sent") and may suggest the
 * ACCEPTED name it most likely meant, but the sent text never comes back: not
 * in an HTTP body, not in an MCP result or SDK refusal, not in the log.
 *
 * Every case sends `SENTINEL` as an unknown key — at the top level, inside
 * `crawl`, inside `judgement.rules.<a valid id>`, as a `judgement.rules` key
 * with a valid and with an invalid value, as a `judgement.thresholds` key, as a
 * query parameter name — and asserts the whole answer does not contain it and
 * does name the position. Credential header and cookie NAMES that are valid
 * tokens are out of scope (plan Deviation 6); the nested credential case here
 * is an unknown key inside `httpAuth`, which 27c already names by position.
 *
 * The allowlist is empty, so a body that is wrongly accepted is refused 403
 * rather than starting a crawl — and the status check says which happened.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { createMcpServer, type AriadneMcpServer } from "../../src/api/mcp.js";
import type { ServiceConfig } from "../../src/api/config.js";
import { z } from "zod";
import { parseStartBody, startBodySchema } from "../../src/api/config-schema.js";
import { nearestAccepted, unknownKeyMessage } from "../../src/api/errors.js";
import { strictInput } from "../../src/api/mcp-input.js";
import { parseRenderCrawlInput, parseResumeCrawlInput } from "../../src/api/service.js";
import { buildRegistry } from "../../src/rules/index.js";
import { JudgementError, parseJudgement, readStoredJudgement } from "../../src/rules/judgement.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { mkDiscovery } from "../rules/mk-discovery.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

const SENTINEL = "sk_live_27d_SENTINEL";
const TOKEN = "test-token-no-key-echo-0123456789";
const SITE = "https://no-key-echo.example";
/** A page rule the ruleset defines. */
const RULE = "title.too-long";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let exportDir: string;
let renderDir: string;
let api: ApiServer;
let base: string;
let mcp: AriadneMcpServer;
let client: Client;
/** `ServiceConfig.log`: the one sink the service and both transports write to. */
const logLines: string[] = [];
/** Anything that reached the console instead, while this file ran — expected none. */
const consoleLines: string[] = [];
const consoleSpies: MockInstance[] = [];
const crawlId = `crawl_no_key_echo_${randomUUID()}`;
/**
 * A crawl whose STORED judgement block carries SENTINEL as an unknown
 * threshold — a row no request could write today. Reading it is a defect
 * (500), which the transports log: so the log assertion below is about a
 * sink that demonstrably received a line carrying the refusal.
 */
const brokenId = `crawl_no_key_echo_broken_${randomUUID()}`;

/** The whole answer as text: status line plus the body, exactly as sent. */
async function http(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

/** The whole JSON-RPC result — or, if the call throws, the error — as text. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: JSON.stringify(result) };
  } catch (error) {
    return { isError: true, text: `${String(error)} ${JSON.stringify(error)}` };
  }
}

function refusedWithoutEcho(label: string, text: string, position: number): void {
  expect.soft(text, `${label} echoed the sent key`).not.toContain(SENTINEL);
  expect.soft(text, `${label} does not name the position`).toContain(`key ${position} in the order sent`);
}

/**
 * The start-body cases, shared by `POST /crawls`, `POST /config/validate`,
 * `crawl_start` and `config_validate`: [label, body, the position named].
 */
const START_CASES: [string, Record<string, unknown>, number][] = [
  ["unknown top-level key", { siteUrl: `${SITE}/`, [SENTINEL]: 1 }, 2],
  ["unknown judgement block key", { siteUrl: `${SITE}/`, judgement: { [SENTINEL]: 1 } }, 1],
  [
    "unknown key inside judgement.rules.<valid id>",
    { siteUrl: `${SITE}/`, judgement: { rules: { [RULE]: { disabled: true, [SENTINEL]: 1 } } } },
    2,
  ],
  [
    "judgement.rules key with a valid value",
    { siteUrl: `${SITE}/`, judgement: { rules: { [SENTINEL]: { disabled: true } } } },
    1,
  ],
  [
    "judgement.rules key with an invalid value",
    { siteUrl: `${SITE}/`, judgement: { rules: { [RULE]: { disabled: true }, [SENTINEL]: { bogus: 3 } } } },
    2,
  ],
  [
    "judgement.rules key whose value is not an object",
    { siteUrl: `${SITE}/`, judgement: { rules: { [SENTINEL]: "all" } } },
    1,
  ],
  ["judgement.thresholds key", { siteUrl: `${SITE}/`, judgement: { thresholds: { SLOW_MS: 2000, [SENTINEL]: 3 } } }, 2],
];

/** The `judgement` halves of a config patch: [label, judgement patch, position]. */
const PATCH_JUDGEMENT_CASES: [string, Record<string, unknown>, number][] = [
  ["unknown judgement block key", { [SENTINEL]: 1 }, 1],
  ["unknown key inside judgement.rules.<valid id>", { rules: { [RULE]: { [SENTINEL]: 1 } } }, 1],
  ["judgement.rules key with a valid value", { rules: { [SENTINEL]: { disabled: true } } }, 1],
  ["judgement.rules key with an invalid value", { rules: { [RULE]: { disabled: true }, [SENTINEL]: { bogus: 3 } } }, 2],
  ["judgement.thresholds key", { thresholds: { [SENTINEL]: 3 } }, 1],
];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-no-key-echo-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-no-key-echo-render-"));
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id: crawlId,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 0,
  });
  await db.insert(crawls).values({
    tenantId: LOCAL_TENANT,
    id: brokenId,
    siteUrl: `${SITE}/`,
    config: { siteUrl: `${SITE}/`, maxPages: 100, userAgent: "AriadneBot-test" },
    discovery: mkDiscovery(),
    judgement: { thresholds: { [SENTINEL]: 3 } },
    rulesetVersion: "test",
    status: "finished",
    pagesCrawled: 0,
  });
  for (const method of ["error", "warn", "log", "info"] as const) {
    consoleSpies.push(
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      }),
    );
  }

  const config: ServiceConfig = {
    allowedDomains: [],
    exportDir,
    renderDir,
    log: (line: string) => {
      logLines.push(line);
    },
  };
  api = createApiServer({ db, config: { ...config, token: TOKEN } });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  mcp = createMcpServer({ db, config });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "ariadne-test-no-key-echo", version: "0.0.1" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await mcp.close();
  await api.close();
  await closeFetchAgents();
  await db.delete(crawls).where(inArray(crawls.id, [crawlId, brokenId]));
  await closeDb(db);
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
  for (const spy of consoleSpies) spy.mockRestore();
  // Nothing the test sent reached the log, on any path — and the log is live:
  // the stored-block reads below wrote to it.
  expect(logLines.length).toBeGreaterThanOrEqual(2);
  expect(logLines.join("\n")).not.toContain(SENTINEL);
  expect(consoleLines.join("\n")).not.toContain(SENTINEL);
});

describe("the log: a refusal that IS logged does not carry the key", () => {
  it("a stored block with an unknown key is a logged 500 on both transports, positional in the log", async () => {
    const before = logLines.length;
    const res = await http("GET", `/crawls/${brokenId}/config`);
    expect(res.status, res.text).toBe(500);
    expect(res.text).not.toContain(SENTINEL);

    const answer = await tool("crawl_config_get", { crawlId: brokenId });
    expect(answer.isError, answer.text).toBe(true);
    expect(answer.text).not.toContain(SENTINEL);

    const logged = logLines.slice(before).join("\n");
    expect(logLines.length - before).toBe(2);
    // The lines carry the refusal itself — the crawl and the key's position —
    // so this is a sink the sentence reached, not an empty one.
    expect(logged).toContain(`crawl ${brokenId}: stored judgement block is refused`);
    expect(logged).toContain("thresholds: unknown field (key 1 in the order sent)");
    expect(logged).not.toContain(SENTINEL);
  });
});

describe("HTTP: no route quotes a key it was sent", () => {
  it("POST /crawls and POST /config/validate", async () => {
    for (const [label, body, position] of START_CASES) {
      const started = await http("POST", "/crawls", body);
      expect(started.status, `POST /crawls ${label}: ${started.text}`).toBe(400);
      refusedWithoutEcho(`POST /crawls ${label}`, started.text, position);

      const checked = await http("POST", "/config/validate", body);
      expect(checked.status, `POST /config/validate ${label}`).toBe(200);
      expect(JSON.parse(checked.text)["valid"], label).toBe(false);
      refusedWithoutEcho(`POST /config/validate ${label}`, checked.text, position);
    }
  });

  it("POST /crawls/:id/resume and POST /crawls/:id/render", async () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["unknown top-level key", { requestHeaders: {}, [SENTINEL]: 1 }, 2],
      ["unknown key inside httpAuth", { httpAuth: { username: "u", password: "p", [SENTINEL]: "x" } }, 3],
    ];
    for (const route of ["resume", "render"]) {
      for (const [label, body, position] of cases) {
        const res = await http("POST", `/crawls/${crawlId}/${route}`, body);
        expect(res.status, `${route} ${label}: ${res.text}`).toBe(400);
        refusedWithoutEcho(`POST /${route} ${label}`, res.text, position);
      }
    }
  });

  it("PATCH /crawls/:id/config", async () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["unknown top-level key", { judgement: {}, [SENTINEL]: 1 }, 2],
      ["unknown key inside crawl", { crawl: { maxPages: 50, [SENTINEL]: 1 } }, 2],
      ...PATCH_JUDGEMENT_CASES.map(
        ([label, judgement, position]): [string, Record<string, unknown>, number] => [label, { judgement }, position],
      ),
    ];
    for (const [label, body, position] of cases) {
      const res = await http("PATCH", `/crawls/${crawlId}/config`, body);
      expect(res.status, `PATCH config ${label}: ${res.text}`).toBe(400);
      refusedWithoutEcho(`PATCH config ${label}`, res.text, position);
    }
  });

  it("a query parameter name, on any route", async () => {
    const first = await http("GET", `/crawls/${crawlId}/issues?${SENTINEL}=1`);
    expect(first.status).toBe(400);
    refusedWithoutEcho("issues ?SENTINEL", first.text, 1);

    const second = await http("GET", `/crawls/${crawlId}/issues?limit=5&${SENTINEL}=1`);
    expect(second.status).toBe(400);
    refusedWithoutEcho("issues ?limit&SENTINEL", second.text, 2);

    // A route that takes no query string at all.
    const none = await http("GET", `/crawls/${crawlId}/config?${SENTINEL}=1`);
    expect(none.status).toBe(400);
    refusedWithoutEcho("config ?SENTINEL", none.text, 1);
  });
});

describe("MCP: no tool quotes a key it was sent", () => {
  it("crawl_start and config_validate", async () => {
    for (const [label, body, position] of START_CASES) {
      const started = await tool("crawl_start", body);
      expect(started.isError, `crawl_start ${label}: ${started.text}`).toBe(true);
      refusedWithoutEcho(`crawl_start ${label}`, started.text, position);

      const checked = await tool("config_validate", { config: body });
      expect(checked.isError, `config_validate ${label}`).toBe(false);
      refusedWithoutEcho(`config_validate ${label}`, checked.text, position);
    }
    const extra = await tool("config_validate", { config: { siteUrl: `${SITE}/` }, [SENTINEL]: 1 });
    expect(extra.isError).toBe(true);
    refusedWithoutEcho("config_validate top-level", extra.text, 2);
  });

  it("crawl_config_set", async () => {
    const cases: [string, Record<string, unknown>, number][] = [
      ["unknown top-level key", { crawlId, judgement: {}, [SENTINEL]: 1 }, 3],
      ["unknown key inside crawl", { crawlId, crawl: { maxPages: 50, [SENTINEL]: 1 } }, 2],
      ...PATCH_JUDGEMENT_CASES.map(
        ([label, judgement, position]): [string, Record<string, unknown>, number] => [
          label,
          { crawlId, judgement },
          position,
        ],
      ),
    ];
    for (const [label, args, position] of cases) {
      const answer = await tool("crawl_config_set", args);
      expect(answer.isError, `crawl_config_set ${label}: ${answer.text}`).toBe(true);
      refusedWithoutEcho(`crawl_config_set ${label}`, answer.text, position);
    }
  });

  it("crawl_resume, crawl_render and a read tool", async () => {
    for (const name of ["crawl_resume", "crawl_render"]) {
      const top = await tool(name, { crawlId, [SENTINEL]: 1 });
      expect(top.isError, `${name}: ${top.text}`).toBe(true);
      refusedWithoutEcho(`${name} top-level`, top.text, 2);

      const nested = await tool(name, { crawlId, httpAuth: { username: "u", password: "p", [SENTINEL]: "x" } });
      expect(nested.isError, `${name}: ${nested.text}`).toBe(true);
      refusedWithoutEcho(`${name} httpAuth`, nested.text, 3);
    }
    const read = await tool("issues_list", { crawlId, [SENTINEL]: 1 });
    expect(read.isError).toBe(true);
    refusedWithoutEcho("issues_list", read.text, 2);
  });
});

describe("a near miss is answered with the accepted name it most likely meant", () => {
  it("resume: requestHeaderz → did you mean 'requestHeaders'?", async () => {
    const res = await http("POST", `/crawls/${crawlId}/resume`, { requestHeaderz: {} });
    expect(res.status).toBe(400);
    expect(res.text).toContain("did you mean 'requestHeaders'?");
    expect(res.text).not.toContain("requestHeaderz");

    const answer = await tool("crawl_resume", { crawlId, requestHeaderz: {} });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("did you mean 'requestHeaders'?");
    expect(answer.text).not.toContain("requestHeaderz");
  });

  it("a rule id one edit away names the rule and the ruleset", async () => {
    const res = await http("POST", "/crawls", {
      siteUrl: `${SITE}/`,
      judgement: { rules: { "title.too-lnog": { disabled: true } } },
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain(`names no rule in ruleset ${RULESET_VERSION}`);
    expect(res.text).toContain(`did you mean '${RULE}'?`);
    expect(res.text).not.toContain("too-lnog");
  });
});

describe("the helpers", () => {
  it("nearestAccepted: case-insensitive, at most two edits, a swap is one, ties to the first", () => {
    expect(nearestAccepted("REQUESTHEADERS", ["requestHeaders"])).toBe("requestHeaders");
    expect(nearestAccepted("maxPgaes", ["maxDepth", "maxPages"])).toBe("maxPages");
    expect(nearestAccepted("cokie", ["cookies"])).toBe("cookies");
    expect(nearestAccepted("abcdef", ["ghijkl"])).toBeNull();
    // A closer name wins wherever it is; equally close, the first wins.
    expect(nearestAccepted("abcd", ["abxy", "abcx"])).toBe("abcx");
    expect(nearestAccepted("abcd", ["abxy", "abyx"])).toBe("abxy");
    // A megabyte key is skipped on length alone.
    expect(nearestAccepted("x".repeat(1_000_000), ["requestHeaders"])).toBeNull();
  });

  it("unknownKeyMessage: the position, the suggestion, the list, and never the key", () => {
    expect(unknownKeyMessage("body", 3, "requestHeaderz", ["requestHeaders", "httpAuth"])).toBe(
      "body has an unknown field (key 3 in the order sent); did you mean 'requestHeaders'? " +
        "Accepted: requestHeaders, httpAuth",
    );
    expect(unknownKeyMessage("crawl", 1, SENTINEL, ["maxPages"], 2)).toBe(
      "crawl has an unknown field (key 1 in the order sent) (and 2 more). Accepted: maxPages",
    );
  });

  it("parseJudgement counts a merged block's positions in the patch as sent", () => {
    const registry = buildRegistry();
    const stored = { rules: { [RULE]: { disabled: true }, "title.missing": { priority: "low" } } };
    const patch = { rules: { [SENTINEL]: { disabled: true } } };
    const merged = { rules: { ...stored.rules, ...patch.rules } };
    let caught: unknown;
    try {
      parseJudgement(merged, registry, patch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JudgementError);
    const error = caught as JudgementError;
    expect(error.path).toBe("rules");
    expect(error.reason).toBe("unknown-rule");
    // Key 1 of the patch's rules, though key 3 of the merged block's.
    expect(error.message).toBe(`rules: key 1 in the order sent names no rule in ruleset ${RULESET_VERSION}`);
  });

  it("a stored override of a removed rule is named: it was a rule id when it was stored", () => {
    const registry = buildRegistry();
    expect(() => readStoredJudgement({ rules: { "gone.rule": { disabled: true } } }, "crawl_z", registry)).toThrow(
      "crawl crawl_z: stored judgement block is refused: rules.gone.rule: the stored override of rule " +
        `'gone.rule' names no rule in ruleset ${RULESET_VERSION}; remove it by sending it as null`,
    );
  });
});

/**
 * Many unknown keys are ONE refusal — the first by position, the rest counted —
 * built in time linear in the keys: a refusal per key, each finding its key's
 * position by scanning the object, was quadratic (a 1 MiB body of short keys
 * cost ~10^10 steps) and repeated the accepted list once per key.
 */
describe("100,000 unknown keys", () => {
  // 5 s still discriminates: the old per-key scan was quadratic and takes minutes at 100k keys; linear takes well under a second.
  const MANY = 100_000;
  const many = (head: Record<string, unknown>): Record<string, unknown> => {
    const body: Record<string, unknown> = { ...head };
    for (let i = 0; i < MANY; i++) body[`k${i}`] = 1;
    return body;
  };
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
  };
  const thrown = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };

  it("crawl_start / config_validate (parseStartBody) and the MCP start schema", () => {
    const registry = buildRegistry();
    const body = many({ siteUrl: `${SITE}/` });
    const parsed = timed(() => parseStartBody(body, registry));
    expect(parsed.ms).toBeLessThan(5_000);
    expect(parsed.value.ok).toBe(false);
    const errors = parsed.value.ok ? [] : parsed.value.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(`(key 2 in the order sent) (and ${MANY - 1} more)`);

    const viaSdk = timed(() => startBodySchema(registry).safeParse(body));
    expect(viaSdk.ms).toBeLessThan(5_000);
    expect(viaSdk.value.error?.issues).toHaveLength(1);
    expect(viaSdk.value.error?.issues[0]?.message).toContain(`(key 2 in the order sent) (and ${MANY - 1} more)`);
  });

  it("resume, render and every other MCP tool's arguments", () => {
    const resume = timed(() => thrown(() => parseResumeCrawlInput(many({}))));
    expect(resume.ms).toBeLessThan(5_000);
    expect(resume.value).toContain(`(key 1 in the order sent) (and ${MANY - 1} more)`);

    const render = timed(() => thrown(() => parseRenderCrawlInput(many({ urls: [] }))));
    expect(render.ms).toBeLessThan(5_000);
    expect(render.value).toContain(`(key 2 in the order sent) (and ${MANY - 1} more)`);

    const args = timed(() => strictInput({ crawlId: z.string() }).safeParse(many({ crawlId: "c" })));
    expect(args.ms).toBeLessThan(5_000);
    expect(args.value.error?.issues).toHaveLength(1);
    expect(args.value.error?.issues[0]?.message).toContain(`(key 2 in the order sent) (and ${MANY - 1} more)`);
  });
});
