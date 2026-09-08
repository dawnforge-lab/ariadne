# Phase 15 — Demo Web Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-only demo web page (`npm run demo`) where the owner types ANY public URL, starts a bounded audit, watches it run live, and sees issues/metrics — on top of the existing JSON API, with the SSRF line intact.

**Architecture:** One new entrypoint runs two servers in one process: the real `ApiServer` on an ephemeral loopback port (random token, new code-only `allowAnyPublicHost` posture) and a thin front server on `127.0.0.1:8484` that serves a single self-contained HTML page and proxies `/api/*` to the API with the Bearer header injected. The browser is same-origin and never holds the token. The only engine change is the allowlist posture; url-policy and politeness are untouched.

**Tech Stack:** Node 22, TypeScript strict ESM, `node:http` (no framework, no new dependencies), vitest, existing drizzle/Postgres dev DB (port 5440).

**Spec:** `docs/superpowers/specs/2026-09-03-phase-15-demo-web-surface-design.md` — read it first; it records the owner's three decisions (local-only / open-allowlist-in-demo / capped-default) and the two rejected architectures.

## Global Constraints

- CLAUDE.md hard rules apply, above all: **no silent fallbacks** (rule 7 — a refused URL or failed step is a visible classified state, never a blank), **never skip url-policy** (rule 5), **politeness untouched** (rule 9).
- `allowPrivate` stays OFF everywhere outside tests. The demo entrypoint must NEVER set it. Tests set it only via `crawlDefaults` in test code, the seam the whole suite already uses (`test/api/http.test.ts` header comment explains it).
- `allowAnyPublicHost` is code-only: `loadApiConfig` never reads it, no env var maps to it, no request field becomes it.
- The prod surface does not change: `src/api/serve.ts`, `src/api/http.ts` routes, `src/api/mcp*.ts` are NOT modified (T1 touches `config.ts` + `service.ts` only; nothing tenant-visible moves — no `docs/talos-surface.md` route changes, just a one-line config note in T4).
- No new npm dependencies. No build step for the page — one HTML file with inline CSS/JS, no CDN, read at boot.
- TypeScript strict must stay clean: `npx tsc --noEmit` after every task. Full suite `npm test` must stay green (baseline: 1,797 tests / 71 files).
- Tests need `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` and follow the house pattern: real servers on ephemeral ports, real DB, `createdCrawls` cleanup, no mocks.
- Commits: conventional, small, after each green cycle, ending with the Co-Authored-By trailer from CLAUDE.md.
- Comment style: match the codebase — comments state constraints and reasons, never narrate the next line.

---

### Task 1: The `allowAnyPublicHost` posture

**Files:**
- Modify: `src/api/config.ts` (~line 50, inside `ServiceConfig`)
- Modify: `src/api/service.ts` (the four `isHostAllowed` call sites: ~1614 start, ~2183 resume, ~3803 legacyHosts, ~3922 sitemapUrls, plus one new private helper near `startCrawl`)
- Test: `test/api/open-posture.test.ts` (new)

**Interfaces:**
- Consumes: `isHostAllowed(host, allowed)` (`src/api/config.ts:379`), `createApiServer` (`src/api/http.ts`), the test-rig patterns from `test/api/http.test.ts`.
- Produces: `ServiceConfig.allowAnyPublicHost?: boolean` — the field Task 2's `createDemoServer` sets to `true`. Behaviour: when `true`, the crawl-trigger ALLOWLIST gate accepts any host at all four call sites; `isUrlAllowed` (url-policy) still runs on every URL with `allowPrivate` from `crawlDefaults` only.

- [ ] **Step 1: Read the context.** Read `src/api/config.ts` lines 1–130 (the `ServiceConfig` docblock — your new field's docblock must match its register), `src/api/service.ts` lines 1595–1660 and 2175–2230 (the two main gate sites), and `test/api/http.test.ts` lines 1–260 (the rig: `call`, `settle`, `createdCrawls`, the `afterAll` cleanup — copy its cleanup exactly, do not invent your own).

- [ ] **Step 2: Write the failing tests** in `test/api/open-posture.test.ts`. Structure: `beforeAll` connects the DB (`createDb` + `runMigrations`), starts ONE tiny fixture site on `127.0.0.1:0` (two pages is enough):

```ts
// The fixture site: enough for a crawl to accept, fetch and finish.
siteServer = createServer((req, res) => {
  if (req.url === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nAllow: /\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><html lang="en"><head><title>open posture fixture</title>` +
      `<meta name="description" content="fixture"></head>` +
      `<body><h1>fixture</h1><a href="/two">two</a></body></html>`,
  );
});
```

and THREE API servers on ephemeral ports:
- `openApi` — `allowedDomains: []`, `allowAnyPublicHost: true`, `crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 }` (the test seam, so the fixture on loopback is crawlable).
- `openNoPrivateApi` — `allowedDomains: []`, `allowAnyPublicHost: true`, NO `crawlDefaults` (proves the SSRF line holds under the posture).
- `controlApi` — `allowedDomains: []`, no posture field (today's refuse-everything behaviour).

The tests:

```ts
it("accepts a host no allowlist names when the posture is set", async () => {
  const res = await call(openBase, "POST", "/crawls", {
    siteUrl: `${site}/`, maxPages: 5,
  });
  expect(res.status).toBe(202);
  // settle it so the row is complete and cleanup is orderly
  const done = await settle(openBase, String(res.body["crawlId"]));
  expect(done["status"]).toBe("finished");
});

it("still refuses everything on an empty allowlist without the posture", async () => {
  const res = await call(controlBase, "POST", "/crawls", { siteUrl: `${site}/` });
  expect(res.status).toBe(403);
  expect(String(res.body["error"])).toContain("allowlist is empty");
});

it("the posture does not touch url-policy: loopback is refused with the policy's own reason", async () => {
  const res = await call(openNoPrivateBase, "POST", "/crawls", {
    siteUrl: "http://127.0.0.1:9/",
  });
  expect(res.status).toBe(403);
  expect(String(res.body["error"])).toContain("refused by the URL policy");
  expect(String(res.body["error"])).not.toContain("allowlist");
});

it("legacyHosts and sitemapUrls pass the allowlist gate under the posture", async () => {
  const res = await call(openBase, "POST", "/crawls", {
    siteUrl: `${site}/`, maxPages: 5,
    legacyHosts: ["www.localhost"],
    sitemapUrls: [`${site}/sitemap.xml`],
  });
  expect(res.status).toBe(202); // without the posture these hosts would be the 403
  await settle(openBase, String(res.body["crawlId"]));
});

it("the resume gate answers the policy question, not the allowlist question", async () => {
  // A seeded cancelled crawl on a host nobody allowlisted: under the posture
  // the allowlist gate passes and the URL POLICY is what answers (NXDOMAIN
  // on the reserved .example TLD -> refused). Without the posture the same
  // request dies at the allowlist. Two servers, two different 403 texts.
  const id = await seedCancelledCrawl("http://seeded.example/");
  const open = await call(openBase, "POST", `/crawls/${id}/resume`);
  expect(open.status).toBe(403);
  expect(String(open.body["error"])).toContain("URL policy");
  const control = await call(controlBase, "POST", `/crawls/${id}/resume`);
  expect(control.status).toBe(403);
  expect(String(control.body["error"])).toContain("allowlist");
});

it("loadApiConfig can never set the posture from the environment", () => {
  const cfg = loadApiConfig({
    ...minimalEnv(), // token + DATABASE_URL, per loadApiConfig's requirements
    ARIADNE_ALLOW_ANY_PUBLIC_HOST: "true",
  });
  expect("allowAnyPublicHost" in cfg).toBe(false);
});
```

Adapt the helpers from `test/api/http.test.ts`: `call` gains a `base` first parameter (three servers in this file), `settle` likewise; `seedCancelledCrawl` follows the `seedCrawl` pattern there (insert a `crawls` row with `status: "cancelled"`, push the id onto `createdCrawls`). Check `loadApiConfig`'s actual signature in `src/api/config.ts` — it takes an env record; build `minimalEnv()` from what it requires (it throws on missing token/database URL; give it dummies).

- [ ] **Step 3: Run the tests, verify they fail** for the right reason: `npx vitest run test/api/open-posture.test.ts`. Expected: TypeScript refuses `allowAnyPublicHost` as an unknown field of `ServiceConfig` (compile error) — that IS the failure; note it.

- [ ] **Step 4: Add the field to `ServiceConfig`** in `src/api/config.ts`, directly after `allowedDomains`:

```ts
  /**
   * Accept ANY host at the crawl-trigger allowlist gate.
   *
   * THE SECOND PROCESS-TRUST SEAM, beside `crawlDefaults` below, and bound by
   * the same rule: code-level only, never wired to env or wire. `loadApiConfig`
   * does not read it, `serve.ts`/`mcp-serve.ts` never set it, and no request
   * field maps to it. It exists for the demo entrypoint (`src/demo/serve.ts`),
   * a local-only page whose point is "type any URL".
   *
   * It answers the ALLOWLIST question and nothing else. `isUrlAllowed` still
   * runs on every URL with `allowPrivate` from `crawlDefaults` alone, so
   * loopback and RFC1918 targets stay refused under this posture.
   */
  allowAnyPublicHost?: boolean;
```

- [ ] **Step 5: Route the four call sites through one helper** in `src/api/service.ts`. Add near `startCrawl`:

```ts
  /**
   * The crawl-trigger allowlist gate, in one place for its four callers
   * (start, resume, legacyHosts, sitemapUrls) so the demo posture cannot
   * drift per-site. `allowAnyPublicHost` short-circuits the ALLOWLIST only;
   * every caller runs the URL policy regardless.
   */
  private crawlHostAllowed(host: string): boolean {
    if (this.config.allowAnyPublicHost === true) return true;
    return isHostAllowed(host, this.config.allowedDomains);
  }
```

Replace all four `!isHostAllowed(<host>, this.config.allowedDomains)` occurrences with `!this.crawlHostAllowed(<host>)` (grep `isHostAllowed` in `service.ts` — after this step the import is used ONLY inside the helper; keep the import). Do not change any refusal message.

- [ ] **Step 6: Run the new tests to green, then the full suite.** `npx vitest run test/api/open-posture.test.ts` → all pass. Then `npx tsc --noEmit` and `npm test` → clean/green (the posture defaults off, so nothing existing moves).

- [ ] **Step 7: Commit.**

```bash
git add src/api/config.ts src/api/service.ts test/api/open-posture.test.ts
git commit -m "feat(api): allowAnyPublicHost — code-only open-allowlist posture for the demo entrypoint"
```

---

### Task 2: The demo server — page host + auth-injecting proxy

**Files:**
- Create: `src/demo/server.ts` (the testable factory)
- Create: `src/demo/serve.ts` (the `npm run demo` entrypoint)
- Create: `src/demo/index.html` (a MINIMAL placeholder this task; Task 3 replaces its body — but it must already carry `<title>Ariadne demo</title>` and `id="site-url"` so this task's page test is honest)
- Modify: `package.json` (add script `"demo": "tsx src/demo/serve.ts"`)
- Test: `test/demo/serve.test.ts` (new)

**Interfaces:**
- Consumes: `createApiServer` (`src/api/http.ts`), `ServiceConfig.allowAnyPublicHost` from Task 1, `createDb`/`closeDb` (`src/db/client.ts`).
- Produces: `createDemoServer(opts: CreateDemoServerOpts): DemoServer` with

```ts
export interface CreateDemoServerOpts {
  db: Db;
  /** Test seam only — the demo entrypoint never passes it. Same contract as ApiServerConfig.crawlDefaults. */
  crawlDefaults?: ServiceConfig["crawlDefaults"];
  renderDir?: string;
  exportDir?: string;
  log?: (line: string) => void;
}
export interface DemoServer {
  /** Starts the API on an ephemeral loopback port FIRST, then the front server. */
  listen(port?: number, host?: string): Promise<{ port: number; host: string; apiPort: number }>;
  /** Front server first, then the API (which stops the crawl queue). Safe to call twice. */
  close(): Promise<void>;
}
```

Task 3's flow test drives everything through `listen().port`; `apiPort` exists so a test can prove the internal API still 401s without the token.

- [ ] **Step 1: Write the failing tests** in `test/demo/serve.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createDemoServer, type DemoServer } from "../../src/demo/server.js";

let db: Db;
let demo: DemoServer;
let base: string;
let apiPort = 0;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  db = createDb(url);
  await runMigrations(db);
  demo = createDemoServer({ db });
  const bound = await demo.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${bound.port}`;
  apiPort = bound.apiPort;
});

afterAll(async () => {
  await demo.close();
  await closeDb(db);
});

describe("the page", () => {
  it("serves the demo page at / as html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain('id="site-url"');
  });

  it("answers 404 for a path that is neither the page nor /api", async () => {
    const res = await fetch(`${base}/anything-else`);
    expect(res.status).toBe(404);
  });
});

describe("the proxy", () => {
  it("injects the bearer so /api reaches the real surface", async () => {
    const res = await fetch(`${base}/api/crawls`);
    expect(res.status).toBe(200); // crawl_list; 401 here means no injection
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body["items"])).toBe(true);
  });

  it("is the only door: the internal API port still refuses without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/crawls`);
    expect(res.status).toBe(401);
  });

  it("passes a refusal through untouched — transparent errors, no fallback", async () => {
    const res = await fetch(`${base}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: "not-a-url" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["error"])).toContain("siteUrl");
  });

  it("preserves the query string", async () => {
    const res = await fetch(`${base}/api/rules?crawlId=crawl_nope`);
    // 404/409 from the service, NOT a proxy-level 404 — the query survived
    expect([404, 409]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run test/demo/serve.test.ts` — fails: module `src/demo/server.js` not found.

- [ ] **Step 3: Write `src/demo/index.html`** — this task's minimal honest version:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ariadne demo</title></head>
<body>
  <h1>Ariadne demo</h1>
  <input id="site-url" placeholder="https://example.com/">
  <!-- Task 3 replaces this file with the full page. -->
</body>
</html>
```

- [ ] **Step 4: Write `src/demo/server.ts`.** The whole file, module docblock included (write one in the house register: what it is, why the token never reaches the page, why the API port is loopback-ephemeral):

```ts
import { createServer, request as httpRequest, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";

import type { Db } from "../db/client.js";
import { createApiServer, type ApiServer } from "../api/http.js";
import type { ServiceConfig } from "../api/config.js";

const PAGE = readFileSync(new URL("./index.html", import.meta.url));

export function createDemoServer(opts: CreateDemoServerOpts): DemoServer {
  // Never printed, never served, never in the page: the browser talks only
  // to this front server, which signs every /api call itself.
  const token = randomUUID();
  const api: ApiServer = createApiServer({
    db: opts.db,
    config: {
      token,
      allowedDomains: [],
      allowAnyPublicHost: true,
      ...(opts.crawlDefaults === undefined ? {} : { crawlDefaults: opts.crawlDefaults }),
      ...(opts.renderDir === undefined ? {} : { renderDir: opts.renderDir }),
      ...(opts.exportDir === undefined ? {} : { exportDir: opts.exportDir }),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    },
  });

  let apiPort = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (url.startsWith("/api/") || url === "/api") {
      const path = url.slice(4) === "" ? "/" : url.slice(4);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      const contentType = req.headers["content-type"];
      if (contentType !== undefined) headers["content-type"] = contentType;
      const upstream = httpRequest(
        { host: "127.0.0.1", port: apiPort, path, method: req.method, headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, {
            "content-type": answer.headers["content-type"] ?? "application/json",
          });
          answer.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        // rule 7: the proxy failing is a loud 502 with the reason, not a hang.
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `demo proxy: ${String(error)}` }));
        } else {
          res.destroy();
        }
      });
      req.pipe(upstream);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found: the demo serves / and /api/* only" }));
  });

  let closed = false;
  return {
    async listen(port = 8484, host = "127.0.0.1") {
      const boundApi = await api.listen(0, "127.0.0.1");
      apiPort = boundApi.port;
      server.listen(port, host);
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("demo server bound to a pipe, which cannot happen with a numeric port");
      }
      return { port: address.port, host, apiPort };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await api.close();
    },
  };
}
```

(Plus the two exported interfaces from the **Interfaces** block above, verbatim.) Check `createApiServer`'s actual opts against `src/api/http.ts:137` and adjust field spelling if it differs — the tests are the referee.

- [ ] **Step 5: Write `src/demo/serve.ts`** (mirror `src/api/serve.ts`'s shape — read it first):

```ts
import { closeDb, createDb } from "../db/client.js";
import { createDemoServer } from "./server.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL must be set (no fallback)");

const db = createDb(databaseUrl);
const demo = createDemoServer({ db });
const port = Number(process.env["ARIADNE_DEMO_PORT"] ?? 8484);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`ARIADNE_DEMO_PORT is not a port: ${process.env["ARIADNE_DEMO_PORT"]}`);
}
// 127.0.0.1 is a decision, not a default: the demo's open-allowlist posture is
// only acceptable because nobody but this machine can reach the page.
const bound = await demo.listen(port, "127.0.0.1");
console.error(`ariadne demo: http://127.0.0.1:${bound.port}/ — open allowlist, url-policy enforced, allowPrivate OFF`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`ariadne demo: ${signal} — closing (a running crawl is cancelled, not killed)`);
    demo
      .close()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne demo: shutdown failed — ${String(error)}`);
        process.exit(1);
      });
  });
}
```

- [ ] **Step 6: Add the npm script.** In `package.json` scripts: `"demo": "tsx src/demo/serve.ts"`.

- [ ] **Step 7: Green + full suite.** `npx vitest run test/demo/serve.test.ts` → pass. `npx tsc --noEmit` → clean. `npm test` → green.

- [ ] **Step 8: Commit.**

```bash
git add src/demo/ test/demo/serve.test.ts package.json
git commit -m "feat(demo): npm run demo — local page host + auth-injecting proxy over the in-process API"
```

---

### Task 3: The page, and the end-to-end demo flow

**Files:**
- Modify: `src/demo/index.html` (replace with the full page)
- Test: `test/demo/flow.test.ts` (new)

**Interfaces:**
- Consumes: the proxy from Task 2 (`createDemoServer(...).listen()`), and these contract shapes (verify field names against `docs/talos-surface.md` §4.1–4.5 and §5.1 before writing — the doc carries live samples):
  - `POST /api/crawls {siteUrl, maxPages?, fetchResources?}` → 202 `{crawlId, status, queuePosition}`; non-2xx → `{error}`.
  - `GET /api/crawls/:id` → `{status, pagesCrawled, frontier: {pending, leased, done, failed}, blockedPages, hostSpacingMs, startedAt, finishedAt, findingsCount, rulesRunAt, resources: {seen, fetched, failed, skipped}, fetchResources, ...}`.
  - `POST /api/crawls/:id/render {}` (optional pass), `POST /api/crawls/:id/rules {}` → the judged summary.
  - `GET /api/crawls/:id/issues` → `{items: [{ruleId, checkIds, severity, category, title, count, truncated?, total?, atLeast?, sampleUrls}], nextCursor}`.
  - `GET /api/crawls/:id/issues/:ruleId/urls` → `{items: [{url, evidence}], nextCursor}`.
  - `GET /api/rules?crawlId=` → catalog rows with `{ruleId, title, explanation, howToFix, severity, fired}` (join source for copy).
  - `GET /api/crawls/:id/metrics` → `{items: [{metricId, scope, scopeValue, value, title}], nextCursor}`.
- Produces: the final `index.html`. The flow test and the page share ONE contract: element ids `site-url`, `max-pages`, `fetch-resources`, `render-pass`, `start`, `start-error`, `progress`, `results`, `band-critical`, `band-warning`, `band-info`, `metrics`, `summary` — the test asserts every one of them is present in the served page, so renaming one is a red test, not a silent drift.

- [ ] **Step 1: Write the failing flow test** in `test/demo/flow.test.ts`. Rig: DB + migrations; ONE fixture site (copy Task 1's `siteServer`, add a second page at `/two` linking back, and `/sitemap.xml` returning 404 — a real site shape); `createDemoServer({ db, crawlDefaults: { allowPrivate: true, probeHosts: false, perHostDelayMs: 0 }, renderDir })` where `renderDir` is a `mkdtemp` dir removed in `afterAll` (house rule: a suite that could render says where documents go). `createdCrawls` cleanup copied from `test/api/http.test.ts`. Everything goes through the PROXY base — that is the point of the file:

```ts
it("runs the whole demo flow through the proxy: start, watch, judge, results", async () => {
  const started = await fetch(`${base}/api/crawls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteUrl: `${site}/`, maxPages: 50 }),
  });
  expect(started.status).toBe(202);
  const { crawlId } = (await started.json()) as { crawlId: string };
  createdCrawls.push(crawlId);

  // watch: poll the same route the page polls, until terminal
  let detail: Record<string, unknown> = {};
  await waitFor("crawl to finish", async () => {
    const res = await fetch(`${base}/api/crawls/${crawlId}`);
    expect(res.status).toBe(200);
    detail = (await res.json()) as Record<string, unknown>;
    return detail["status"] !== "queued" && detail["status"] !== "running";
  });
  expect(detail["status"]).toBe("finished");
  expect(Number(detail["pagesCrawled"])).toBeGreaterThan(0);
  expect(detail["blockedPages"]).toBe(0);

  // judge
  const judged = await fetch(`${base}/api/crawls/${crawlId}/rules`, { method: "POST" });
  expect(judged.status).toBe(200);

  // results: issues grouped with severities, catalog copy joinable, metrics
  const issues = (await (await fetch(`${base}/api/crawls/${crawlId}/issues`)).json()) as {
    items: { ruleId: string; severity: string; title: string; count: number }[];
  };
  expect(Array.isArray(issues.items)).toBe(true);
  for (const group of issues.items) {
    expect(["critical", "warning", "info"]).toContain(group.severity);
    expect(group.title.length).toBeGreaterThan(0);
  }
  const catalog = (await (await fetch(`${base}/api/rules?crawlId=${crawlId}`)).json()) as {
    items: { ruleId: string; howToFix: string }[];
  };
  const copy = new Map(catalog.items.map((r) => [r.ruleId, r]));
  for (const group of issues.items) expect(copy.has(group.ruleId)).toBe(true);
  const metrics = (await (await fetch(`${base}/api/crawls/${crawlId}/metrics`)).json()) as {
    items: unknown[];
  };
  expect(metrics.items.length).toBeGreaterThan(0);
}, 60_000);

it("serves a page whose element ids match the flow the test just drove", async () => {
  const page = await (await fetch(`${base}/`)).text();
  for (const id of [
    "site-url", "max-pages", "fetch-resources", "render-pass", "start",
    "start-error", "progress", "results", "band-critical", "band-warning",
    "band-info", "metrics", "summary",
  ]) {
    expect(page, `missing id="${id}"`).toContain(`id="${id}"`);
  }
});
```

(`waitFor` here takes an async predicate — adapt the one from `test/api/http.test.ts`; verify the actual `rules` response status/shape against `docs/talos-surface.md` and fix the assertion if it is 202/other.)

- [ ] **Step 2: Run to verify failure.** The flow test may already pass (it exercises Task 2's proxy) — the PAGE test must fail against the placeholder. Both red-or-green states are informative; record which.

- [ ] **Step 3: Write the full `src/demo/index.html`.** Requirements, all of them:
  - No external requests of any kind: inline `<style>`, inline `<script>`, no fonts, no CDN. Plain JS (`fetch`, `setInterval`/`setTimeout`), no framework.
  - **Start panel:** `#site-url` (text), `#max-pages` (number, `value="50"`, empty ⇒ omit the field so the engine default 500 applies), `#fetch-resources` (checkbox, unchecked), `#render-pass` (checkbox, unchecked), `#start` (button). On submit: `POST /api/crawls` with only the fields the user set. Non-2xx ⇒ render `body.error` verbatim into `#start-error` and stop. 2xx ⇒ show `#progress`, remember `crawlId`, start polling.
  - **Progress panel `#progress`:** poll `GET /api/crawls/{id}` every 2s. Render: status; `pagesCrawled` + frontier `pending/done/failed`; elapsed (from `startedAt`); the politeness pair `blockedPages` + `hostSpacingMs` labelled as such; the `resources` counts when `fetchResources` was on. When status leaves `queued`/`running`: stop polling. `finished` ⇒ proceed. `failed`/`cancelled` ⇒ render the terminal state prominently with the payload's own numbers and STOP — a refused or dead crawl is a result, not a retry loop.
  - **Judge step:** if `#render-pass` was checked, `POST /api/crawls/{id}/render` first and show "rendering…" until it answers (an error body renders and halts, verbatim). Then `POST /api/crawls/{id}/rules` with a "judging…" state; error ⇒ same treatment.
  - **Results `#results`:** fetch ALL pages of `/issues` (follow `nextCursor`, hard stop at 20 pages — say so on screen if hit), the catalog `/rules?crawlId=` once, ALL pages of `/metrics` (same bound). Group issues by severity into `#band-critical` ("Errors"), `#band-warning` ("Warnings"), `#band-info` ("Notices"), each band header carrying its group count and total finding count. Per rule row: `title`, `count` (append "+" and a note when `truncated` with `atLeast`), `explanation` + `howToFix` from the catalog join, and a "show URLs" toggle that lazily fetches `/issues/{ruleId}/urls` FIRST PAGE ONLY (say "first N of …" when `nextCursor` came back). `#metrics`: a table of `metricId` / `scope`+`scopeValue` / `JSON.stringify(value)`. `#summary`: crawlId, pages, duration, blocked, spacing.
  - Every fetch goes through one helper that throws on non-2xx with the response's own `error` string, and one top-level catch per step renders that string next to the step that failed. No retries, no defaults, no "something went wrong" — the API's sentence is the UI's sentence (rule 7).
  - Keep it plain and readable: system font stack, one column, `<details>` for URL drill-downs is fine. This is an engineering demo, not a brand exercise.

- [ ] **Step 4: Green + full suite.** `npx vitest run test/demo/` → both files pass. `npx tsc --noEmit`, `npm test` → clean/green.

- [ ] **Step 5: Manual smoke, recorded honestly.** Run `npm run demo` (needs the dev DB up and `DATABASE_URL` set), open `http://127.0.0.1:8484/`, and drive one crawl against a LOCAL throwaway fixture: keep a terminal `node -e` static server on a free port and enter `http://127.0.0.1:<port>/`… which url-policy will REFUSE (allowPrivate is off) — and that refusal ON SCREEN is the smoke test's first assertion (the SSRF line, visible). Then verify the start-panel renders, the error is the policy's own sentence, and the page did not blank. Do NOT crawl a real external site in this task — that is the gate's job, with the owner present. Note both observations in the task report.

- [ ] **Step 6: Commit.**

```bash
git add src/demo/index.html test/demo/flow.test.ts
git commit -m "feat(demo): the demo page — start/watch/judge/results, transparent errors end to end"
```

---

### Task 4: Docs, contract note, gate scaffold, full verification

**Files:**
- Modify: `docs/talos-surface.md` (§1 "Transports, auth and trust" — one short paragraph)
- Create: `docs/gates/phase-15.md`
- Test: none new — this task's deliverable is the verified record.

**Interfaces:**
- Consumes: everything T1–T3 built; the gate docs of prior phases (`docs/gates/phase-14.md` for register and structure).
- Produces: the gate doc the owner's real-run session fills in, and the contract note.

- [ ] **Step 1: The contract note.** In `docs/talos-surface.md` §1, beside where the config/trust seam is described, add one paragraph: `allowAnyPublicHost` exists on `ServiceConfig` as a second code-only process-trust seam (the first is `crawlDefaults`); it is not reachable from env or wire, `api:serve`/`mcp:serve` never set it, and it is set only by the demo entrypoint (`src/demo/serve.ts`), which binds 127.0.0.1. Nothing tenant-visible changes; the note exists so the field's discovery in `config.ts` leads a Talos reader here instead of to a wrong conclusion.

- [ ] **Step 2: The gate doc** `docs/gates/phase-15.md`, structured like phase-14's (summary table, per-clause sections, decisions, ledger). Fill NOW everything derivable in the worktree, each number measured fresh, not copied from this plan: full-suite count and wall time, tsc clean, the test-file inventory for the three new test files, migrations unchanged (0000–0015, none added), ruleset unchanged (0.11.0 — no rule changed), the posture's test evidence (name the tests). Leave §"The real run" with its structure in place and the values marked **[recorded at gate time — owner present]** (the house CI-placeholder precedent): site entered, pages/duration, blockedPages + hostSpacingMs at close, the severity-band counts on screen, and the demonstrated refusal (a private-IP URL typed into the page, refused with url-policy's reason on screen).

- [ ] **Step 3: Full verification, measured.** `npm test` (record count/files/wall), `npx tsc --noEmit`, `git status` clean. Confirm with `grep -rn "allowAnyPublicHost" src/` that exactly three files know the field: `config.ts` (definition), `service.ts` (the helper), `demo/server.ts` (the setter) — that grep line goes in the gate doc.

- [ ] **Step 4: Commit.**

```bash
git add docs/talos-surface.md docs/gates/phase-15.md
git commit -m "docs: phase-15 gate scaffold + talos-surface note on the code-only demo posture"
```

---

## After the tasks (controller, not a subagent)

Final review (fable, whole-branch), fix wave if needed, then the REAL GATE with the owner: `npm run demo`, a real site of the owner's choosing, the refusal demonstration, numbers into `docs/gates/phase-15.md`. Then push, PR #14, CI record, merge on the owner's word — the standing pattern.
