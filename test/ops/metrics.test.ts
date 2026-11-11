/**
 * The metric set (Phase 28b Task 6): every name is exposed, and no label value
 * is ever a tenant, a crawl id, a host or a URL.
 *
 * The database is shared by parallel suites, so nothing here asserts an exact
 * gauge value of a table other suites write; it asserts presence, the forbidden
 * labels, and positive counts only for what this file's own crawl produced
 * (counters are process-local and this file's process runs one crawl).
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createApiServer, type ApiServer } from "../../src/api/http.js";
import { parseTenant } from "../../src/tenant.js";
import { TEST_CREDENTIAL_KEYS } from "../helpers/credential-keys.js";

const API_TOKEN = "metrics-api-token-0123456789abcdef";
const METRICS_TOKEN = "metrics-metrics-token-0123456789abcdef";
const TENANT = parseTenant(`metrics-${randomUUID().slice(0, 8)}`);

const NAMES = [
  "ariadne_jobs",
  "ariadne_job_claim_wait_seconds",
  "ariadne_job_duration_seconds",
  "ariadne_pages_fetched_total",
  "ariadne_fetch_duration_seconds",
  "ariadne_host_escalations_total",
  "ariadne_instances_alive",
  "ariadne_crawl_peak_rss_bytes",
];

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

let db: Db;
let api: ApiServer;
let base: string;
let site: string;
let siteServer: Server;
let exportDir: string;
let renderDir: string;
let crawlId: string;
const created: string[] = [];

async function scrape(): Promise<string> {
  const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  expect(res.status).toBe(200);
  return res.text();
}

/** Every `label="value"` value in an exposition text. */
function labelValues(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    if (open < 0 || close < open) continue;
    for (const m of line.slice(open + 1, close).matchAll(/="((?:[^"\\]|\\.)*)"/g)) out.push(m[1] ?? "");
  }
  return out;
}

function sampleValue(text: string, name: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  if (line === undefined) throw new Error(`no sample for ${name}`);
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  exportDir = await mkdtemp(join(tmpdir(), "ariadne-metrics-export-"));
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-metrics-renders-"));
  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const page = (t: string, b: string): string =>
      `<!doctype html><html lang="en"><head><title>${t}</title></head><body><h1>${t}</h1>${b}</body></html>`;
    res.writeHead(path === "/" || path === "/a" ? 200 : 404, { "content-type": "text/html" });
    if (path === "/") res.end(page("Home of the metrics fixture", `<a href="/a">A</a><a href="/gone">Gone</a>`));
    else if (path === "/a") res.end(page("Page A of the metrics fixture", `<a href="/">Home</a>`));
    else res.end("missing");
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const address = siteServer.address();
  site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  api = createApiServer({
    db,
    config: {
      credentialKeys: TEST_CREDENTIAL_KEYS,
      allowedDomains: ["127.0.0.1"],
      crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
      exportDir,
      renderDir,
      token: API_TOKEN,
      metricsToken: METRICS_TOKEN,
      log: () => undefined,
    },
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;

  const started = await fetch(`${base}/crawls`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}`, "x-ariadne-tenant": TENANT, "content-type": "application/json" },
    body: JSON.stringify({ siteUrl: `${site}/`, maxPages: 5, maxConcurrency: 1 }),
  });
  expect(started.status).toBe(202);
  crawlId = String(((await started.json()) as Record<string, unknown>)["crawlId"]);
  created.push(crawlId);
  const until = Date.now() + 30_000;
  for (;;) {
    const res = await fetch(`${base}/crawls/${crawlId}`, {
      headers: { authorization: `Bearer ${API_TOKEN}`, "x-ariadne-tenant": TENANT },
    });
    const status = String(((await res.json()) as Record<string, unknown>)["status"]);
    if (status === "finished") break;
    if (status === "failed" || status === "cancelled") throw new Error(`crawl ended ${status}`);
    if (Date.now() > until) throw new Error(`crawl still ${status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}, 120_000);

afterAll(async () => {
  await api.close();
  await new Promise<void>((r) => siteServer.close(() => r()));
  if (created.length > 0) await db.delete(crawls).where(inArray(crawls.id, created));
  await rm(exportDir, { recursive: true, force: true });
  await rm(renderDir, { recursive: true, force: true });
  await closeFetchAgents();
  await closeDb(db);
});

describe("the exposition after a crawl", () => {
  it("names every metric of the set and the process defaults", async () => {
    const text = await scrape();
    for (const name of NAMES) expect(text, name).toContain(`# TYPE ${name} `);
    expect(text).toContain("process_cpu_user_seconds_total");
  });

  it("counted this file's crawl: pages by fetch class, fetch durations, a job duration, a claim wait", async () => {
    const text = await scrape();
    expect(text).toMatch(/ariadne_pages_fetched_total\{fetch_class="ok"\} [1-9]/);
    expect(text).toMatch(/ariadne_fetch_duration_seconds_count [1-9]/);
    expect(text).toMatch(/ariadne_job_duration_seconds_count\{kind="crawl",outcome="done"\} [1-9]/);
    expect(text).toMatch(/ariadne_job_claim_wait_seconds_count [1-9]/);
    expect(sampleValue(text, "ariadne_crawl_peak_rss_bytes")).toBeGreaterThan(0);
  });

  it("reads the job gauge from the database at scrape time (a finished crawl job is counted)", async () => {
    const text = await scrape();
    expect(text).toMatch(/ariadne_jobs\{kind="crawl",status="done"\} [1-9]/);
  });

  it("never carries a tenant, a crawl id, a host or a URL in any label value", async () => {
    const text = await scrape();
    const forbidden = [TENANT, crawlId, "127.0.0.1", site, `${site}/`, `${site}/a`, `${site}/gone`, new URL(site).host];
    const values = labelValues(text);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      for (const bad of forbidden) expect(value.includes(bad), `label value ${JSON.stringify(value)} carries ${bad}`).toBe(false);
    }
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain(crawlId);
  });
});
