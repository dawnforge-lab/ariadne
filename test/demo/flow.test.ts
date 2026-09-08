/**
 * The demo, end to end, through the door a browser uses.
 *
 * `serve.test.ts` proves the seam — the proxy signs, the internal port does
 * not, a refusal crosses back whole. This file proves the JOURNEY: the exact
 * sequence of calls the page makes, in the order it makes them, against the
 * proxy base and never against the API directly. Start a crawl on a fixture
 * site, poll `/api/crawls/:id` until it settles, judge it, then read the three
 * result surfaces the page renders — issues, the rule catalog it joins copy
 * from, and metrics. If any of those five routes changes shape, the demo page
 * breaks silently in a browser and loudly here.
 *
 * THE PAGE ITSELF IS PART OF THE SAME CONTRACT. The second test asserts that
 * every element id the flow above corresponds to is present in the served HTML,
 * and that the fourth section sits after the three bands. There is no browser in
 * this suite, so that list is the only thing standing between "the page renders
 * results" and a renamed id that nobody notices until an operator sees a blank
 * panel. Renaming an id is a red test, not a drift.
 *
 * THE FOURTH SECTION'S ROUTING IS ASSERTED AT THIS FILE'S OWN LEVEL. A NOT
 * MEASURED marker reports that a check could not be answered on this crawl, and
 * every marker is `info` — so without a key of its own the page would file them
 * under Notices as findings. The key is the catalog's `marker`, and no browser
 * is needed to check the decision it drives: the first test reads the same two
 * answers the page reads, and asserts which groups the page must route out of
 * Notices and what the Notices count is left with.
 *
 * The last describe is the SSRF line, seen from the browser's side. The demo's
 * real posture — `allowAnyPublicHost` with no `allowPrivate` — refuses a
 * loopback target, and what this asserts is that the refusal's own sentence
 * arrives at the page as a 403 body with `error` on it. That is the string the
 * page writes into `#start-error`: the API's sentence is the UI's sentence
 * (hard rule 7).
 *
 * Between the two sits the export-abort test, which lives here rather than in
 * `serve.test.ts` because it needs findings — see its own docblock for what it
 * proves that the earlier abort test could not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { connect } from "node:net";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, issues } from "../../src/db/schema.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { createDemoServer, type DemoServer } from "../../src/demo/server.js";

let db: Db;

/**
 * The site the demo crawls: two pages that link to each other, permissive
 * robots, and a sitemap that 404s.
 *
 * The 404 is deliberate rather than lazy — most sites a demo operator types in
 * have no sitemap at the guessed path, and a fixture that always serves one
 * would hide the discovery path every real first-run takes.
 */
let siteServer: Server;
let site: string;

/** The demo as the suite drives it: private targets crawlable, no pacing. */
let demo: DemoServer;
let base: string;
/** The demo as an operator runs it: the posture only. Loopback is refused here. */
let strict: DemoServer;
let strictBase: string;

/**
 * Where the render pass would serialise documents if a test asked for one.
 *
 * No test here does, but the demo page offers the pass and this server would
 * honour it, so the directory is named rather than left to default into the
 * repository (the house rule the API suite follows).
 */
let renderDir: string;

const createdCrawls: string[] = [];

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/** `test/api/http.test.ts`'s helper, with an async predicate — every check is a fetch. */
async function waitFor(
  what: string,
  predicate: () => Promise<boolean>,
  deadlineMs = 45_000,
): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > until) throw new Error(`waitFor: ${what} never happened`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Read a proxied JSON body, failing loudly with the API's own words. */
async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>` +
    `<meta name="description" content="a fixture page for the demo flow test"></head>` +
    `<body><h1>${title}</h1>${body}</body></html>`
  );
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  renderDir = await mkdtemp(join(tmpdir(), "ariadne-demo-flow-"));

  siteServer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/sitemap.xml") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no sitemap here");
      return;
    }
    const bodies: Record<string, string> = {
      "/": page("demo fixture home", `<a href="/two">two</a><p>the page a demo run starts at</p>`),
      "/two": page("demo fixture two", `<a href="/">home</a><p>the second page, linking back</p>`),
    };
    const body = bodies[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("not found", "<p>gone</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  const addr = siteServer.address();
  site = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;

  demo = createDemoServer({
    db,
    // PROCESS TRUST, not wire trust: the fixture is on loopback and the wire
    // cannot ask for that at any value. The `npm run demo` entrypoint passes
    // none of this, which is what the strict server below stands for.
    crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 },
    renderDir,
  });
  const bound = await demo.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${bound.port}`;

  strict = createDemoServer({ db });
  const strictBound = await strict.listen(0, "127.0.0.1");
  strictBase = `http://127.0.0.1:${strictBound.port}`;
}, 60_000);

afterAll(async () => {
  await demo.close();
  await strict.close();
  for (const id of createdCrawls) {
    await db.delete(crawls).where(eq(crawls.id, id));
  }
  await closeDb(db);
  await closeFetchAgents();
  await rm(renderDir, { recursive: true, force: true });
  await new Promise<void>((r) => siteServer.close(() => r()));
});

describe("the demo flow", () => {
  it("runs the whole demo flow through the proxy: start, watch, judge, results", async () => {
    const started = await fetch(`${base}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: `${site}/`, maxPages: 50 }),
    });
    expect(started.status).toBe(202);
    const accepted = (await started.json()) as Record<string, unknown>;
    const crawlId = String(accepted["crawlId"]);
    createdCrawls.push(crawlId);
    // What the start panel hands to the progress panel: an id and a status.
    expect(accepted["status"]).toBe("queued");

    // WATCH — the same route the page polls, read the same way.
    let detail: Record<string, unknown> = {};
    await waitFor("the crawl to leave queued/running", async () => {
      const res = await fetch(`${base}/api/crawls/${crawlId}`);
      expect(res.status).toBe(200);
      detail = (await res.json()) as Record<string, unknown>;
      return detail["status"] !== "queued" && detail["status"] !== "running";
    });
    expect(detail["status"]).toBe("finished");
    expect(Number(detail["pagesCrawled"])).toBeGreaterThan(0);
    expect(detail["blockedPages"]).toBe(0);
    // The politeness pair and the frontier block the progress panel renders.
    expect(typeof detail["hostSpacingMs"]).toBe("number");
    const frontier = detail["frontier"] as Record<string, unknown>;
    expect(Number(frontier["done"])).toBeGreaterThan(0);
    expect(frontier["pending"]).toBe(0);
    expect(typeof detail["startedAt"]).toBe("string");
    // The resources block the panel shows when the box was ticked; the shape is
    // present either way, which is what lets the page read it without guarding.
    const resources = detail["resources"] as Record<string, unknown>;
    expect(typeof resources["seen"]).toBe("number");

    // JUDGE — 200, not 202: the rules run synchronously and answer the summary.
    const judgedRes = await fetch(`${base}/api/crawls/${crawlId}/rules`, { method: "POST" });
    expect(judgedRes.status).toBe(200);
    const judged = (await judgedRes.json()) as Record<string, unknown>;
    expect(Number(judged["pagesScanned"])).toBeGreaterThan(0);

    // RESULTS, surface by surface, exactly as the page reads them.
    const issues = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/issues`),
      "issues",
    )) as unknown as {
      items: { ruleId: string; severity: string; title: string; count: number }[];
      nextCursor: string | null;
    };
    expect(Array.isArray(issues.items)).toBe(true);
    expect(issues.items.length).toBeGreaterThan(0);
    for (const group of issues.items) {
      // The band split IS engine severity — there is no priority logic in the page.
      expect(["critical", "warning", "info"]).toContain(group.severity);
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.count).toBeGreaterThan(0);
    }

    // The catalog is `{rulesetVersion, rules}` keyed by `id` — NOT the
    // `{items}` + `ruleId` shape every other listing here uses, and the page's
    // copy join is built on that difference (docs/talos-surface.md §5.1).
    const catalog = (await json(
      await fetch(`${base}/api/rules?crawlId=${crawlId}`),
      "catalog",
    )) as unknown as {
      rulesetVersion: string;
      rules: {
        id: string;
        title: string;
        explanation: string;
        howToFix: string;
        marker?: string;
      }[];
    };
    expect(catalog.rulesetVersion.length).toBeGreaterThan(0);
    const copy = new Map(catalog.rules.map((rule) => [rule.id, rule]));
    for (const group of issues.items) {
      const joined = copy.get(group.ruleId);
      expect(joined, `catalog has no copy for ${group.ruleId}`).toBeDefined();
      expect(joined?.howToFix.length).toBeGreaterThan(0);
      expect(joined?.explanation.length).toBeGreaterThan(0);
    }

    // THE FOURTH SECTION, at the level this file works at.
    //
    // There is no browser here, so what is asserted is the DECISION the page
    // makes and the two answers it makes it from: a group belongs under
    // `#band-not-checked` when its catalog row carries `marker`, and under its
    // severity band otherwise. `renderBands` computes exactly this predicate
    // (`isMarker`), so a change to the routing key on either side lands here.
    const marked = issues.items.filter((g) => typeof copy.get(g.ruleId)?.marker === "string");
    // This crawl carries at least one, or everything below is vacuous: the demo
    // server runs with `probeHosts: false`, so `host.probe-skipped` reports the
    // host checks nobody asked.
    expect(marked.map((g) => g.ruleId)).toContain("host.probe-skipped");
    for (const group of marked) {
      // Why severity cannot do this job: every marker is `info`, so Notices is
      // exactly where these would sit if the page banded on severity alone.
      expect(group.severity, `${group.ruleId} is a marker at a band severity`).toBe("info");
      expect(String(copy.get(group.ruleId)?.marker).length).toBeGreaterThan(0);
    }

    // …and the Notices band is what is LEFT of the info groups: strictly fewer,
    // and not one of them carrying a marker key. The count under that heading no
    // longer includes a check the crawl could not answer.
    const info = issues.items.filter((g) => g.severity === "info");
    const notices = info.filter((g) => typeof copy.get(g.ruleId)?.marker !== "string");
    expect(notices.length).toBe(info.length - marked.length);
    expect(notices.length).toBeLessThan(info.length);
    for (const group of notices) {
      expect(copy.get(group.ruleId), `${group.ruleId} kept a marker key`).not.toHaveProperty(
        "marker",
      );
    }

    // The drill-down the "show URLs" toggle fetches, first page only.
    const first = issues.items[0];
    if (first === undefined) throw new Error("no issue group to drill into");
    const urls = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/issues/${encodeURIComponent(first.ruleId)}/urls?limit=25`),
      "issue urls",
    )) as unknown as { items: { url: string | null; evidence: Record<string, unknown> }[] };
    expect(urls.items.length).toBeGreaterThan(0);
    expect(typeof urls.items[0]?.evidence).toBe("object");

    const metrics = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/metrics`),
      "metrics",
    )) as unknown as {
      items: { metricId: string; scope: string; scopeValue: string; value: unknown }[];
    };
    expect(metrics.items.length).toBeGreaterThan(0);
    for (const row of metrics.items) {
      expect(row.metricId.length).toBeGreaterThan(0);
      expect(["site", "page_type", "rule"]).toContain(row.scope);
    }
  }, 90_000);

  it("serves a page whose element ids match the flow the test just drove", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const id of [
      "site-url",
      "max-pages",
      "fetch-resources",
      "render-pass",
      "start",
      "start-error",
      "progress",
      "results",
      "band-critical",
      "band-warning",
      "band-info",
      // The fourth section, which is not a band: the checks this crawl could
      // not answer, routed here by the catalog's `marker` (see the first test).
      "band-not-checked",
      "metrics",
      "summary",
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }

    // And it is rendered AFTER the three bands. A section that says "not
    // checked" above the findings would read as the headline of the run.
    const at = (id: string): number => html.indexOf(`id="${id}"`);
    expect(at("band-not-checked")).toBeGreaterThan(at("band-info"));
    expect(at("band-info")).toBeGreaterThan(at("band-warning"));
    expect(at("band-warning")).toBeGreaterThan(at("band-critical"));
  });

  it("asks for nothing off this origin: no external URL in the page", async () => {
    // The demo is a local surface an operator opens against their own machine.
    // A font, a CDN script or a favicon on somebody else's host would make an
    // outbound request per page load from an operator who typed a URL in.
    const html = await (await fetch(`${base}/`)).text();
    const external = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//gi);
    expect(external, `the page reaches off-origin: ${String(external)}`).toBeNull();
  });
});

/**
 * The wedge `serve.test.ts` could describe but not reach.
 *
 * That file's abort test says so itself: the failure the proxy's disconnect
 * handling exists for is a response still being WRITTEN when the client goes,
 * and the largest body that suite had — the ~108KB rule catalog — is swallowed
 * whole by the loopback socket buffers, so `sendCsv` never reaches the
 * `once(res, "drain")` it would wedge in. Both assertions passed with the
 * handler and without it.
 *
 * A CSV export big enough to exceed those buffers does reach it, and this is
 * where one can be had. The crawl is SEEDED rather than crawled — a fixture
 * site that produced fifty megabytes of findings would be a crawl, not a setup
 * — with a long `pageUrl` per finding, because `url` is the one CSV cell the
 * view does not cap (evidence stops at 500 characters). What the seeded rows
 * have to be is real enough for the view: a rule id this ruleset defines, since
 * `assertViewAnswerable` refuses a row it cannot join copy for before a byte is
 * written.
 *
 * WHY THE BODY IS THIS BIG, and how to re-derive it. Everything the wedge needs
 * is for the API's `res.write` to return false, and between it and the paused
 * reader sit three buffers: the API's socket send buffer, the proxy's socket
 * receive buffer, and Node's own stream buffers. On Linux defaults that is
 * `net.ipv4.tcp_wmem` max (4MB) plus `tcp_rmem` max (6MB) — about 10MB, which a
 * 12MB body clears by too little to trust. Measured on this machine at three
 * sizes, handler removed: 3,000 rows (~12MB) closed in 6.9s — absorbed, no
 * wedge, PASSING for the wrong reason; 12,000 rows (~48MB) hung past the 10s
 * race and FAILED, which is the bug being visible. With the handler, the same
 * 12,000 rows close in ~2.3s. The five-fold margin over the buffer sum is what
 * makes that a test rather than a coin flip; if a future kernel absorbs 50MB,
 * this number goes up, and the way to check is to delete the `res.on("close")`
 * handler in `src/demo/server.ts` and watch this test hang.
 */
describe("a client that leaves mid-export", () => {
  /** Rows × URL length ≈ 48MB of CSV — five times the buffers, per the docblock. */
  const WEDGE_ROWS = 12_000;
  const WEDGE_URL_CHARS = 3_800;
  /** A rule this ruleset defines, so the view can join its copy. */
  const WEDGE_RULE = "canonical.missing";

  async function seedFindings(): Promise<string> {
    const id = `crawl_wedge_${Date.now()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: "http://seeded.example/",
      config: {
        siteUrl: "http://seeded.example/",
        maxPages: 10,
        maxDepth: 3,
        userAgent: "AriadneBot/0.1 (test)",
        perHostDelayMs: 0,
        maxConcurrency: 2,
      },
      rulesetVersion: "0.0.0-test",
      status: "finished",
    });
    createdCrawls.push(id);
    const filler = "x".repeat(WEDGE_URL_CHARS);
    for (let start = 0; start < WEDGE_ROWS; start += 500) {
      const batch = [];
      for (let i = start; i < Math.min(start + 500, WEDGE_ROWS); i++) {
        const pageUrl = `http://seeded.example/${i}?q=${filler}`;
        batch.push({
          crawlId: id,
          ruleId: WEDGE_RULE,
          severity: "warning",
          dedupeKey: `wedge-${i}`,
          details: { pageUrl, note: "a seeded finding, for a body big enough to block a socket" },
        });
      }
      await db.insert(issues).values(batch);
    }
    return id;
  }

  /**
   * Ask for the export, read until the body is genuinely flowing, then hang up.
   *
   * The wait for bytes is what makes this an abort MID-BODY rather than
   * mid-request: by the time the socket dies the API is inside `sendCsv`'s
   * write loop, which is the only place the wedge lives.
   */
  function abortAfterFirstBytes(port: number, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let seen = 0;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        seen += chunk.length;
        if (seen < 64 * 1024) return;
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => {
        if (seen < 64 * 1024) reject(new Error(`the export sent only ${seen} bytes before closing`));
      });
    });
  }

  it("takes the streaming export down with it, so the demo still closes", async () => {
    const id = await seedFindings();
    // Its own server: the assertion is about close(), and the shared one has to
    // survive the rest of the file.
    const own = createDemoServer({ db });
    const bound = await own.listen(0, "127.0.0.1");
    await abortAfterFirstBytes(bound.port, `/api/crawls/${id}/export?format=csv&view=issues`);

    // Still serving: the abort took one request down, not the server.
    const after = await fetch(`http://127.0.0.1:${bound.port}/api/crawls`);
    expect(after.status).toBe(200);
    await after.text();

    // `close()` waits for connections to go idle. An upstream response nobody
    // cancelled never does — the API sits in `once(res, "drain")` holding its
    // database reader — so a hang here IS the bug.
    const closed = own.close().then(() => "closed" as const);
    const timer = new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 10_000).unref();
    });
    expect(await Promise.race([closed, timer])).toBe("closed");
  }, 60_000);
});

describe("a refused start, as the page sees it", () => {
  it("hands the browser the URL policy's own sentence when the target is loopback", async () => {
    // `strict` is the demo's real posture: the open allowlist and NOTHING else,
    // so a private target is refused by url-policy (hard rule 5). The status
    // and the body are what the page's start step renders into `#start-error`.
    const res = await fetch(`${strictBase}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: "http://127.0.0.1:9/" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["error"])).toContain("refused by the URL policy");
    // Not smoothed into the proxy's own words on the way out, and not empty:
    // there is a sentence for the page to show (rule 7).
    expect(String(body["error"])).not.toContain("demo proxy");
  });
});
