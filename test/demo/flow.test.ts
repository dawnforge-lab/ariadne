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
 * THE DRILL-DOWN IS A TABLE (Phase 20), and it is asserted at both levels for
 * that reason. On the API side: the listing carries `columns`, the four standard
 * headings lead it, and the keys beyond them are on the row's `evidence` and
 * never on the row — which is exactly the split the page reads a cell by. On the
 * page side: the header is built by walking `columns`, no column LABEL is
 * spelled in the source at all, and the CSV link is built at the shape the
 * export route answers — the same URL this file fetches through the proxy a few
 * lines earlier. The inlinks control is the one place the page carries a list of
 * rule ids, and the test pins both halves of why: the map has two entries, and
 * the engine 404s every other rule by name.
 *
 * A METRIC IS A TABLE TOO (Phase 21), and it is asserted at the same two
 * levels. On the API side: the catalog's metric rules are what the section is a
 * block of, `GET /crawls/:id/metrics/:metricId` answers one block's copy,
 * header, summary and rows, every cell in them is a scalar, and the CSV the
 * link points at is headed with the same labels. On the page side: the header
 * is the response's `columns`, not one of the labels the fourteen metrics
 * declare — every one of which is derived from the registry and asserted ABSENT
 * from the source — and the only decision the page makes about a metric is how
 * a number is spelled.
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
import { buildRegistry } from "../../src/rules/index.js";
import {
  METRIC_SCOPES,
  metricTableColumns,
  metricTableSummary,
  SITE_SCOPE_VALUE,
} from "../../src/rules/registry/registry.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

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

    // THE RECHECK BLOCK, on the same poll and through the same proxy. The page
    // renders its line only when `serverErrors` is above zero, and this fixture
    // site serves none — so what is asserted here is the shape the page reads
    // on EVERY poll (a missing block would make the panel throw on a healthy
    // crawl) and the partition it renders, which must hold at zero as well.
    const recheck = detail["recheck"] as Record<string, unknown>;
    expect(recheck, "the progress panel has no recheck block to read").toBeDefined();
    expect(recheck["serverErrors"]).toBe(0);
    expect(recheck["confirmed"]).toBe(0);
    expect(recheck["cleared"]).toBe(0);
    expect(recheck["inconclusive"]).toBe(0);
    expect(recheck["pending"]).toBe(0);
    expect(recheck["capped"]).toBe(false);
    // And the pass really ran over this crawl: zero server errors WITH a stamp
    // is "we looked and there was nothing", which is the reading the page's
    // silence is entitled to. A null here would mean nobody looked.
    expect(
      Number.isNaN(Date.parse(String(recheck["passAt"]))),
      "the demo crawl finished without a recheck pass stamp",
    ).toBe(false);
    expect(
      Number(recheck["confirmed"]) + Number(recheck["cleared"]) +
        Number(recheck["inconclusive"]) + Number(recheck["pending"]),
    ).toBe(Number(recheck["serverErrors"]));

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
        kind: string;
        title: string;
        explanation: string;
        howToFix: string;
        marker?: string;
        table?: {
          columns: { key: string; label: string }[];
          summary: { key: string; label: string }[];
        };
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
      const reason = String(copy.get(group.ruleId)?.marker);
      expect(reason.length).toBeGreaterThan(0);
      // What the page renders after "Why:" — a plain sentence a client reads,
      // not the noun phrase with a build-task number in it that used to reach
      // this screen ("a crawl that recorded no resources (P11-T3)"). The rubric
      // itself is pinned over the whole registry in test/rules/copy.test.ts;
      // this asserts the shape SURVIVES the API that serves it.
      expect(reason[0], `${group.ruleId} marker reason is not a sentence`).toBe(
        reason[0]!.toUpperCase(),
      );
      expect(reason.endsWith("."), `${group.ruleId} marker reason is not a sentence`).toBe(true);
      expect(reason, `${group.ruleId} marker reason cites a build task`).not.toMatch(
        /\bP\d+-T\d+\b/,
      );
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

    // The drill-down the "Show URLs" toggle fetches, first page only — and
    // since Phase 20 a TABLE, whose header the engine hands over with the rows.
    const first = issues.items[0];
    if (first === undefined) throw new Error("no issue group to drill into");
    const urls = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/issues/${encodeURIComponent(first.ruleId)}/urls?limit=25`),
      "issue urls",
    )) as unknown as {
      columns: { key: string; label: string; optional?: boolean }[];
      items: {
        url: string | null;
        address: string | null;
        statusCode: number | null;
        indexability: string | null;
        indexabilityStatus: string | null;
        evidence: Record<string, unknown>;
      }[];
    };
    expect(urls.items.length).toBeGreaterThan(0);
    expect(typeof urls.items[0]?.evidence).toBe("object");

    // THE HEADER IS ON THE RESPONSE. The page prints these labels in this
    // order and invents none, so a listing without them is a table the demo
    // cannot draw.
    expect(Array.isArray(urls.columns), "the listing carries no columns").toBe(true);
    for (const column of urls.columns) {
      expect(typeof column.key).toBe("string");
      expect(column.label.length).toBeGreaterThan(0);
    }
    expect(urls.columns.slice(0, 4).map((column) => column.label)).toEqual([
      "Address",
      "Status Code",
      "Indexability",
      "Indexability Status",
    ]);

    // …and the SPLIT the page reads cells by: the four standard keys are on the
    // row itself, every other column's key is on the row's `evidence` and never
    // on the row. That is the whole of `issueCellText`, and if the surface ever
    // flattened evidence into the row the page would read a rule's own
    // `statusCode` under a heading derived from the page table (§4.4).
    const standard = ["address", "statusCode", "indexability", "indexabilityStatus"];
    const row = urls.items[0];
    if (row === undefined) throw new Error("no finding row to read cells off");
    for (const key of standard) expect(row).toHaveProperty(key);
    for (const column of urls.columns) {
      if (standard.includes(column.key)) continue;
      expect(row, `${column.key} is on the row, not in the evidence`).not.toHaveProperty(
        column.key,
      );
    }

    // THE CSV LINK BESIDE THE TABLE, at the URL the page builds (`exportHref`),
    // headed with the same labels. A link shape that drifts from the route is a
    // download that 400s in a browser and nowhere else.
    const csv = await fetch(
      `${base}/api/crawls/${crawlId}/export?format=csv&view=issue_urls&ruleId=${encodeURIComponent(first.ruleId)}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    // Named for the rule, not for the view — what a Downloads folder shows.
    expect(csv.headers.get("content-disposition")).toContain(`${first.ruleId}.csv`);
    const header = (await csv.text()).split("\r\n")[0];
    expect(header).toBe([...urls.columns.map((column) => column.label), "Truncated"].join(","));

    // THE INLINKS CONTROL IS SHOWN FOR TWO RULES, and this is why the page
    // decides from a list of its own rather than by asking: every other rule is
    // a 404, and offering the control everywhere would be one refusal per rule
    // on every results page. The refusal names the two the page carries.
    const noReport = issues.items.find(
      (group) =>
        group.ruleId !== "links.broken-internal" && group.ruleId !== "links.to-server-error",
    );
    if (noReport === undefined) throw new Error("no rule without an inlinks report");
    const refused = await fetch(
      `${base}/api/crawls/${crawlId}/issues/${encodeURIComponent(noReport.ruleId)}/inlinks`,
    );
    expect(refused.status).toBe(404);
    const refusal = String(((await refused.json()) as Record<string, unknown>)["error"]);
    expect(refusal).toContain("has no inlinks report");
    expect(refusal).toContain("links.broken-internal");
    expect(refusal).toContain("links.to-server-error");

    const metrics = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/metrics`),
      "metrics",
    )) as unknown as {
      items: { metricId: string; scope: string; scopeValue: string; value: unknown }[];
    };
    expect(metrics.items.length).toBeGreaterThan(0);
    for (const row of metrics.items) {
      expect(row.metricId.length).toBeGreaterThan(0);
      expect(METRIC_SCOPES).toContain(row.scope);
    }

    // THE METRICS SECTION IS ONE BLOCK PER METRIC (Phase 21), and this is where
    // the blocks come from: the catalog's metric rules, in the catalog's own
    // order, each carrying the copy the page heads its block with. `kind` is
    // the flag the page filters on, so a metric that stopped answering to it
    // would drop off the page silently and off this list loudly.
    const metricRules = catalog.rules.filter((rule) => rule.kind === "metric");
    expect(metricRules.length).toBeGreaterThan(0);
    // AND THE ORDER IS THE CATALOG'S, which the metric rules DECLARE: the site
    // health rollup is the census every other table is a part of, so it heads
    // the section rather than sitting tenth where the alphabet put it. The page
    // sorts nothing; the full sequence is pinned in test/api/query.test.ts.
    expect(metricRules[0]?.id, "the metric section does not lead with site.health").toBe(
      "site.health",
    );
    for (const rule of metricRules) {
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.explanation.length).toBeGreaterThan(0);
      // The "How to read" paragraph above each table.
      expect(rule.howToFix.length).toBeGreaterThan(0);
      // The header is on the catalog too. The page draws from the response, but
      // a metric rule with no table declaration has no block to draw at all.
      expect(rule.table?.columns.length, `${rule.id} has no table header`).toBeGreaterThan(0);
    }

    // …and the request that fills one block (§4.4b): one per metric, made
    // sequentially after the rules pass.
    const table = (await json(
      await fetch(`${base}/api/crawls/${crawlId}/metrics/site.health`),
      "metric table",
    )) as unknown as {
      metricId: string;
      title: string;
      explanation: string;
      howToFix: string;
      summary: { key: string; label: string; value: unknown }[];
      columns: { key: string; label: string }[];
      rows: Record<string, unknown>[];
      note?: string;
    };
    expect(table.metricId).toBe("site.health");
    expect(table.title.length).toBeGreaterThan(0);
    expect(table.explanation.length).toBeGreaterThan(0);
    expect(table.howToFix.length).toBeGreaterThan(0);
    expect(Array.isArray(table.summary)).toBe(true);
    // The header the page prints, in this order, the scope column leading it.
    expect(table.columns[0]).toEqual({ key: "scope", label: "Scope" });
    for (const column of table.columns) {
      expect(typeof column.key).toBe("string");
      expect(column.label.length).toBeGreaterThan(0);
    }
    // A row is drawn by walking the columns, and every cell is a scalar this
    // page can spell. An object would be a JSON blob under a heading — which is
    // exactly what Phase 21 removed — and `metricCellText` throws on one rather
    // than stringify it into a cell nobody reads.
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(Object.keys(row).length).toBeGreaterThan(0);
      for (const value of Object.values(row)) {
        expect(
          ["string", "number", "boolean"],
          `a metric cell is a ${typeof value}`,
        ).toContain(value === null ? "string" : typeof value);
      }
    }
    // `note` is present exactly when `rows` is empty — the block prints it
    // INSTEAD of the table, so a filled table carrying one would be two answers.
    expect(table).not.toHaveProperty("note");
    // The site row leads, and its identity cell is the engine's word for it.
    expect(table.rows[0]?.["scope"]).toBe("Site");

    // THE CSV BESIDE THE TABLE, at the URL the page builds (`metricExportHref`):
    // the metric rides as `metricId`, the parameter this view takes, and the
    // summary labels lead the header because a CSV has nowhere above the rows.
    const metricCsv = await fetch(
      `${base}/api/crawls/${crawlId}/export?format=csv&view=metric_table&metricId=site.health`,
    );
    expect(metricCsv.status).toBe(200);
    expect(metricCsv.headers.get("content-type")).toContain("text/csv");
    // Named for the metric, as the issue export is named for its rule.
    expect(metricCsv.headers.get("content-disposition")).toContain("site.health.csv");
    const metricHeader = (await metricCsv.text()).split("\r\n")[0];
    expect(metricHeader).toBe(
      [
        ...table.summary.map((column) => column.label),
        ...table.columns.map((column) => column.label),
      ].join(","),
    );
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

    // THE FOURTH SECTION SAYS WHAT IT MEANS (Phase 19 §6). The owner read the
    // heading and asked "what does not checked mean? why hasn't it been
    // checked?", so the definition is written into the page rather than left
    // to whoever wrote the engine. There is no browser here, so what is
    // asserted is the source of the sentence and where the code puts it: the
    // definition is appended before the empty-state branch returns, which is
    // what makes it show on a crawl with no markers as well as one with them.
    expect(html, "the definition sentence").toContain(
      "A check is 'not checked' when the engine could not answer it on this crawl",
    );
    expect(html, "and what it rules out").toContain("Nothing here is a site problem.");
    const definitionAt = html.indexOf("A check is 'not checked' when");
    const emptyStateAt = html.indexOf("Every check the engine can make was made on this crawl.");
    expect(emptyStateAt, "the empty-state line is still there").toBeGreaterThan(-1);
    expect(definitionAt, "the definition is written above the empty-state line")
      .toBeLessThan(emptyStateAt);

    // The per-row prefix. "Not measured:" was the engine's own label for the
    // state the heading had already named; the row now says why.
    expect(html, "the row prefix").toContain('"why", "Why: " + rule.marker');
    // The engine's old label for the state, asserted at the call rather than
    // anywhere in the file: the comment above that line still names it, which
    // is where the reason for the change belongs.
    expect(html, "the old label is gone").not.toContain('"Not measured: " + rule.marker');
  });

  /**
   * The drill-down as a TABLE, read out of the source it is built by.
   *
   * There is no browser here, so the assertions are on the CODE PATHS — the same
   * discipline the id contract above follows. The new controls carry classes
   * rather than ids on purpose: there is one of each per rule in a results
   * panel, and an id has to be unique, so `.drill`, `.dl`, `.scroll` and
   * `table.report` are what a change would have to rename. The one thing worth
   * asserting negatively is a header this page wrote itself: the labels live in
   * the registry and reach the page on the response, and a column list spelled
   * here would be the demo deciding what a rule reports.
   */
  it("builds the findings table from the engine's columns, and never from a list of its own", async () => {
    const html = await (await fetch(`${base}/`)).text();

    // The header comes from `columns`, cell by cell, in the engine's order.
    expect(html, "the header cell is read off the column").toContain(
      'head.appendChild(el("th", null, String(columns[c].label)));',
    );
    expect(html, "a row's cells are read by the column's key").toContain(
      'tr.appendChild(el("td", null, cellText(items[i], String(columns[k].key))));',
    );
    // And the listing has to bring them: a table this page headed itself would
    // be a heading nobody can trace to a rule (hard rule 7).
    expect(html, "a listing without columns is a shape error").toContain(
      "without a columns array",
    );

    // NO COLUMN LIST IN THE PAGE. The four standard KEYS are here — they are the
    // reading rule, row versus evidence — but not one LABEL, which is what a
    // hard-coded header would look like.
    for (const label of ["Address", "Status Code", "Indexability", "Indexability Status"]) {
      expect(html, `the page spells the column label ${label}`).not.toContain(`"${label}"`);
    }
    expect(html, "the standard keys, as the reading rule").toContain(
      'var STANDARD_ISSUE_KEYS = ["address", "statusCode", "indexability", "indexabilityStatus"];',
    );
    expect(html, "standard off the row, everything else off the evidence").toContain(
      'STANDARD_ISSUE_KEYS.indexOf(key) === -1 ? item.evidence[key] : item[key]',
    );

    // The table, its class, and the box that scrolls INSTEAD OF THE PAGE. These
    // four classes are the id contract's counterpart for the drill-down — one of
    // each per rule, so a class rather than an id — and each is asserted at the
    // element that builds it AND at the rule that styles it, because a rename on
    // one side alone is a control that still works and no longer looks like one.
    expect(html).toContain('el("div", "drill")');
    expect(html).toContain('el("a", "dl", linkText)');
    expect(html).toContain('el("table", "report")');
    expect(html).toContain('el("div", "scroll")');
    expect(html).toContain(".drill { overflow: hidden;");
    expect(html).toContain(".drill .dl { float: right;");
    expect(html).toContain("table.report td {");
    expect(html).toContain(".scroll { overflow-x: auto; }");
    // A site-scoped finding names no page, and the Address cell says so.
    expect(html).toContain('if (key === "address" && item.address === null) return "(site-wide)";');
    // The paging note the list version had, kept: a slice presented as the whole
    // is the failure this page exists not to make.
    expect(html).toContain('"The first " + items.length + " of more');

    // THE CSV LINK, at the shape the API serves (asserted against the live route
    // in the flow test above): the export route, `format=csv`, the view, and a
    // rule only where the view takes one.
    expect(html).toContain('"/export?format=csv&view=" + encodeURIComponent(view)');
    expect(html).toContain('"&ruleId=" + encodeURIComponent(ruleId)');
    expect(html).toContain('"Download CSV"');
    expect(html).toContain('"Download inlinks CSV"');

    // THE INLINKS CONTROL, on two rules and by name. The engine 404s every other
    // rule, so the page asks only where there is an answer — and the gate is
    // membership in this two-entry map, not a request per rule.
    expect(html).toContain('"links.broken-internal": "links_to_4xx"');
    expect(html).toContain('"links.to-server-error": "links_to_5xx"');
    expect(html).toContain("var inlinkView = INLINK_VIEWS[group.ruleId];");
    expect(html).toContain("if (inlinkView !== undefined) {");
    // And no third inlinks view is named anywhere in the page — prose included:
    // the map is the whole list, and a rule that gains a report is a line in it.
    expect(new Set(html.match(/links_to_\dxx/g))).toEqual(
      new Set(["links_to_4xx", "links_to_5xx"]),
    );
  });

  /**
   * THE METRICS SECTION, read out of the source that builds it (Phase 21).
   *
   * Same discipline as the findings table above, one surface along. A metric's
   * block is the catalog's copy over a table the ENGINE shaped, so the only
   * thing this page may decide about it is how a number is spelled: every
   * heading, every label and every cell comes off the response, and the list
   * below is the whole of the engine's metric vocabulary asserted ABSENT from
   * the page. The raw-rows renderer it replaced — metric id, scope and the
   * `value` object as JSON — is asserted gone for the same reason: a JSON blob
   * under a heading is a table nobody can read.
   */
  it("builds every metric's table from the engine's own header, and spells only its numbers", async () => {
    const html = await (await fetch(`${base}/`)).text();

    // ONE BLOCK PER METRIC, in the catalog's order and from the catalog's flag.
    // The page keeps no list of which rules measure and no order of its own.
    expect(html, "the blocks are the catalog's metric rules").toContain(
      'if (rules[r].kind === "metric") metricRules.push(rules[r]);',
    );
    expect(html, "the heading is the catalog's title").toContain(
      'block.appendChild(el("h3", null, String(rule.title)));',
    );
    expect(html, "the explanation under it").toContain(
      'block.appendChild(el("p", null, String(rule.explanation)));',
    );
    // A metric is a measurement, so its `howToFix` is a reading instruction and
    // the label says so.
    expect(html, "how to READ a metric, not how to fix it").toContain(
      '"How to read: " + String(rule.howToFix)',
    );

    // ONE REQUEST PER BLOCK, awaited one at a time — fourteen at once is this
    // page being impolite to the engine on the operator's own machine.
    expect(html).toContain('"/metrics/" + encodeURIComponent(metricId)');
    expect(html).toContain(
      "await loadMetricTable(forCrawl, slots[s].metricId, slots[s].slot);",
    );

    // THE TABLE IS THE FINDINGS TABLE'S BUILDER, over the engine's own columns
    // and rows — the same `.scroll` box, so a metric with fourteen columns
    // scrolls in its container and never widens the page.
    expect(html, "the same table builder, over the served header").toContain(
      "box.appendChild(reportTable(body.columns, body.rows, metricCell(labels)));",
    );
    expect(html, "the labels are read off the response").toContain(
      'labels[String(body.columns[c].key)] = String(body.columns[c].label);',
    );
    // …and a response that does not bring them is a shape error, not a blank.
    expect(html).toContain('" without a columns array"');
    expect(html).toContain('" without a rows array"');
    // An empty table prints the ENGINE's note saying which empty it is.
    expect(html).toContain('box.appendChild(el("p", "note", body.note));');
    expect(html, "an empty table with no note is a shape error").toContain(
      '" without the note that says which kind of empty it is"',
    );

    // THE NUMBER FORMATTER, and the cell path that uses it. This is the ONE
    // thing the page decides about a metric: grouping, one decimal for a
    // percentage column, four places below one, one decimal otherwise, Yes/No
    // for a boolean, an empty cell for a null. WHAT it produces is not readable
    // from the source — test/demo/metric-number.test.ts runs it.
    expect(html).toContain("function metricNumber(value, label) {");
    expect(html, "the cell path spells its numbers here").toContain(
      'if (typeof value === "number") return metricNumber(value, label);',
    );
    expect(html, "a percentage is one its LABEL declares").toContain(
      String.raw`/\(%\)$/.test(label)`,
    );
    // A ratio below one keeps its digits. One decimal would print `Text Ratio`'s
    // 0.0106 as 0.0 — a measurement shown as zero, which is the failure the
    // fourth-decimal branch exists to prevent.
    expect(html, "a value below one is not rounded to one decimal").toContain(
      String.raw`Math.abs(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")`,
    );
    expect(html, "a whole number stays whole").toContain(
      "Number.isInteger(value)",
    );
    expect(html, "thousands, grouped by hand rather than by the browser's locale").toContain(
      String.raw`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")`,
    );
    // The CALL, not the phrase: the docblock above that helper names
    // `toLocaleString` as what it is deliberately not using.
    expect(html, "the page never asks the browser to decide what a number looks like")
      .not.toContain("toLocaleString(");
    expect(html).toContain('if (typeof value === "boolean") return value ? "Yes" : "No";');
    expect(html, "a null cell is empty, never a zero").toContain(
      'if (value === null || value === undefined) return "";',
    );
    // A cell that is not a scalar is thrown, not stringified: the block's own
    // error box is where a change of shape belongs (rule 7).
    expect(html).toContain(
      '"a boolean nor null: " + JSON.stringify(value)',
    );

    // THE SUMMARY, as one line of the engine's own `label: value` pairs, and
    // omitted rather than printed empty on the twelve metrics that have none.
    expect(html).toContain('label + ": " + metricCellText(summary[i].value, label)');
    expect(html).toContain('if (body.summary.length > 0) {');

    // THE CSV LINK, at the shape the export route answers (asserted live in the
    // flow test above): the `metric_table` view, whose subject is a `metricId`
    // and not `exportHref`'s `ruleId`.
    expect(html).toContain(
      'return exportHref(forCrawl, "metric_table", null) + "&metricId=" + encodeURIComponent(metricId);',
    );

    // A FAILED BLOCK IS LOUD AND LOCAL: the error box every other step uses,
    // inside the block whose table is missing.
    expect(html).toContain(
      'errorBox.appendChild(el("span", "step", "the table for " + metricId + " could not be read"));',
    );

    // NO METRIC LABEL IN THE PAGE. Every word the fourteen metric declarations
    // put in a header or a summary, asserted absent as a string literal — the
    // form a hard-coded header would take. The engine owns these words; a page
    // that spelled one would be renaming a measurement.
    //
    // THE LIST IS DERIVED FROM THE REGISTRY, not typed out: a hand list stops
    // covering a label the moment a metric declares a new column, and the point
    // of the assertion is that the page never spells ANY of them. The four
    // shapers between them put a label in four places — the header
    // (`metricTableColumns`, which folds in the scope heading and `Measure`),
    // the summary (`metricTableSummary`), a `perScopeMeasure`'s measure cells,
    // and an `expandList` tag's value — plus `Site`, the cell every site row
    // carries in its scope column. The floor below is the count at Phase 21 and
    // is what stops a derivation that broke from passing vacuously.
    const metricLabels = new Set<string>([SITE_SCOPE_VALUE]);
    for (const rule of buildRegistry().byKind("metric")) {
      for (const column of metricTableColumns(rule.table)) metricLabels.add(column.label);
      for (const column of metricTableSummary(rule.table)) metricLabels.add(column.label);
      if (rule.table.shape === "perScopeMeasure") {
        for (const measure of rule.table.measures) metricLabels.add(measure.label);
      }
      if (rule.table.shape === "expandList") {
        for (const source of rule.table.lists) {
          if (source.tag !== undefined) metricLabels.add(source.tag.value);
        }
      }
    }
    expect(metricLabels.size, "the metric label derivation went vacuous").toBeGreaterThanOrEqual(
      67,
    );
    for (const label of metricLabels) {
      expect(html, `the page spells the metric label ${label}`).not.toContain(`"${label}"`);
    }

    // THE RAW ROWS ARE GONE: no metric id, scope and JSON `value` table, and no
    // paging note for a listing the section no longer walks.
    expect(html, "the raw metric value").not.toContain("JSON.stringify(row.value)");
    expect(html, "the old three-column header").not.toContain('el("th", null, "metric")');
    expect(html, "the old metrics paging note").not.toContain("pages of metrics");

    // The new classes, at the element that builds each and the rule that styles
    // it — the class contract Phase 20 started, two entries longer.
    expect(html).toContain('el("div", "metric")');
    expect(html).toContain('el("p", "sums"');
    expect(html).toContain(".metric { border-top:");
    expect(html).toContain(".sums { color: var(--muted);");
    // …over the SAME box and scroller a finding's table uses.
    expect(html).toContain('var box = el("div", "drill");');
    expect(html).toContain('var link = el("a", "dl", "Download CSV");');
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
 * backpressure wait it would have wedged in (fixed since: `drainOrGone`). Both
 * assertions passed with the handler and without it.
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
      tenantId: LOCAL_TENANT,
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
    // cancelled never does: `sendCsv` breaks when its own client leaves (fixed
    // since), but only this handler makes it leave — so a hang here IS the bug.
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

/**
 * A failed crawl, as the page sees it (migration 0017).
 *
 * The Phase 17 gate ran the demo against a host whose robots.txt answered 502.
 * The crawl closed `failed` in fourteen seconds, the progress panel said
 * "failed" and nothing else, and the sentence explaining it was in the engine's
 * process log — a place an operator watching a browser cannot read
 * (docs/gates/phase-17.md §5, clause 5). This is that run, on loopback, with
 * the field the panel now renders.
 *
 * TWO LEVELS, which is this file's own discipline: the reason has to CROSS the
 * proxy (the API half), and the page has to have somewhere to put it and a
 * sentence for the case where the engine has none (the static half). There is
 * no browser in this suite, so the second half is read out of the served HTML.
 */
describe("a crawl that fails, as the page sees it", () => {
  /** A site that is perfectly healthy behind a robots.txt its CDN cannot serve. */
  let downRobots: Server;
  let downBase: string;

  beforeAll(async () => {
    downRobots = createServer((req, res) => {
      if ((req.url ?? "") === "/robots.txt") {
        res.writeHead(502, { "content-type": "text/html" });
        res.end(page("bad gateway", "<p>the CDN, not the origin</p>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page("a page nobody may ask for", "<p>behind an unreadable robots.txt</p>"));
    });
    await new Promise<void>((r) => downRobots.listen(0, "127.0.0.1", r));
    const addr = downRobots.address();
    downBase = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => downRobots.close(() => r()));
  });

  it("hands the browser the engine's own sentence for why the crawl failed", async () => {
    const started = await fetch(`${base}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: `${downBase}/`, maxPages: 10 }),
    });
    expect(started.status).toBe(202);
    const crawlId = String(((await started.json()) as Record<string, unknown>)["crawlId"]);
    createdCrawls.push(crawlId);

    let detail: Record<string, unknown> = {};
    await waitFor("the failing crawl to settle", async () => {
      const res = await fetch(`${base}/api/crawls/${crawlId}`);
      expect(res.status).toBe(200);
      detail = (await res.json()) as Record<string, unknown>;
      return detail["status"] !== "queued" && detail["status"] !== "running";
    });

    // RFC 9309 §2.3.1.4: a robots.txt nobody can read is a complete disallow,
    // so this crawl is refused rather than run. That is the outcome the page
    // renders, and the run stops there — nothing is judged.
    expect(detail["status"]).toBe("failed");
    expect(Number(detail["pagesCrawled"])).toBe(0);

    // THE FIELD THE GATE WAS MISSING, through the proxy, on the same poll the
    // page makes. Not just present: it names what was unreachable, that we
    // asked more than once, and what the host answered — the three things that
    // stop an operator re-running a crawl that cannot succeed.
    const reason = detail["failureReason"];
    expect(typeof reason, "the failed crawl carries no reason").toBe("string");
    expect(String(reason)).toContain("robots.txt unreachable");
    expect(String(reason)).toContain("502");
    // The panel prints it with `textContent` into a one-line box, and it is a
    // served field: a sentence, never a stack (hard rule 7, obligation 6).
    expect(String(reason)).not.toContain("\n");
    expect(String(reason)).not.toMatch(/\s+at /);
  }, 60_000);

  it("has a step, a box and a null sentence for it in the page it serves", async () => {
    const html = await (await fetch(`${base}/`)).text();
    // The box the reason is written into is the one every other failed step
    // uses — there is no second error surface to keep in sync.
    expect(html).toContain(`id="progress-error"`);
    // The CALL, not the phrase: this page's head comment discusses the same
    // words, and a `toContain("the crawl failed")` would go green off the
    // prose the day the code stopped making the call.
    expect(html).toContain(`showError(progressError, "the crawl failed",`);
    // And the one case the page cannot get a sentence for. It says so instead
    // of inventing a cause — a `failed` row with no reason is a crawl this
    // engine closed before the column existed. Quoted with the branch it is the
    // else of, for the reason above.
    expect(html).toContain(
      `: "the engine recorded no reason — a crawl closed before migration 0017")`,
    );
    // The routing: the reason is read off `failureReason` and nothing else.
    expect(html).toContain(`typeof detail.failureReason === "string"`);
  });
});
