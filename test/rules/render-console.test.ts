/**
 * The render console rules, against a real database.
 *
 * Rows are inserted directly with a `render_console` blob, the way the
 * render-diff tests insert counts: the browser's contribution is a JSON value
 * in a column, and what is under test is what the rules make of it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { RenderConsole } from "../../src/crawl/render/console-capture.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { CONSOLE_BATCH, renderConsoleRules } from "../../src/rules/query/render-console.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { databaseUrl } from "./metric-db.js";

const SITE = "https://console.example";
const url = (path: string): string => `${SITE}${path}`;

function rule(id: string): QueryRule {
  const r = renderConsoleRules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule '${id}' in renderConsoleRules`);
  return r;
}

/** A clean capture: a console that said nothing and requests that all worked. */
function capture(over: Partial<RenderConsole> = {}): RenderConsole {
  return {
    console: [],
    consoleTotal: 0,
    exceptions: [],
    exceptionsTotal: 0,
    failedRequests: [],
    failedRequestsTotal: 0,
    blockedByRenderer: { thirdParty: 0, sameOriginAssets: 0 },
    ...over,
  };
}

describe("renderConsoleRules metadata", () => {
  it("defines the three rules, all claiming CHECK-51 in the technical category", () => {
    expect(
      Object.fromEntries(renderConsoleRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "render.js-exception": [["CHECK-51"], "warning", "technical"],
      "render.console-error": [["CHECK-51"], "info", "technical"],
      "render.failed-request": [["CHECK-51"], "warning", "technical"],
    });
  });

  it("carries copy, columns and a ruleset version", () => {
    for (const r of renderConsoleRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.explanation, r.id).toContain("Template");
      expect(r.columns?.length, r.id).toBeGreaterThan(1);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("the render console rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec {
    path: string;
    rendered?: boolean;
    pageType?: string | null;
    /** `undefined` is a clean capture; `null` is no capture at all. */
    console?: unknown;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl: SITE,
      hostKey: hostKeyOf(SITE),
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<void> {
    await db.insert(pages).values(
      specs.map((s) => {
        const full = url(s.path);
        const normalised = normalizeUrl(full);
        if (normalised === null) throw new Error(`${full} does not normalise`);
        return {
          id: `page_${randomUUID()}`,
          crawlId,
          url: full,
          urlNormalised: normalised,
          fetchClass: "ok",
          statusCode: 200,
          isIndexable: true,
          depth: 1,
          discoveredVia: "link",
          pageType: s.pageType === undefined ? "product" : s.pageType,
          rendered: s.rendered ?? true,
          renderConsole:
            s.console === undefined ? capture() : (s.console as RenderConsole | null),
        };
      }),
    );
  }

  async function fired(ruleId: string, crawlId: string): Promise<string[]> {
    const findings = await rule(ruleId).run(db, crawlId);
    for (const f of findings) expect(f.ruleId).toBe(ruleId);
    return findings.map((f) => (f.pageUrl ?? "").slice(SITE.length));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("an exception fires only render.js-exception, with its evidence", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/boom",
        console: capture({
          exceptions: [{ text: "TypeError: x is undefined", cut: false }],
          exceptionsTotal: 3,
          blockedByRenderer: { thirdParty: 2, sameOriginAssets: 1 },
        }),
      },
      { path: "/clean" },
    ]);
    expect(await fired("render.js-exception", crawlId)).toEqual(["/boom"]);
    expect(await fired("render.console-error", crawlId)).toEqual([]);
    expect(await fired("render.failed-request", crawlId)).toEqual([]);

    const [f] = await rule("render.js-exception").run(db, crawlId);
    expect(f!.evidence).toMatchObject({
      template: "product",
      rendered: true,
      exceptionsTotal: 3,
      firstException: "TypeError: x is undefined",
      blockedByRenderer: { thirdParty: 2, sameOriginAssets: 1 },
    });
  });

  it("an error-level console entry fires render.console-error, with consoleTotal", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/err",
        pageType: null,
        console: capture({
          console: [
            { level: "warning", text: "deprecated", cut: false },
            { level: "error", text: "gtag is not defined", cut: false },
          ],
          consoleTotal: 31,
          blockedByRenderer: { thirdParty: 4, sameOriginAssets: 0 },
        }),
      },
    ]);
    expect(await fired("render.console-error", crawlId)).toEqual(["/err"]);
    expect(await fired("render.js-exception", crawlId)).toEqual([]);
    const [f] = await rule("render.console-error").run(db, crawlId);
    expect(f!.evidence).toMatchObject({
      template: null,
      rendered: true,
      consoleTotal: 31,
      firstError: "gtag is not defined",
      blockedByRenderer: { thirdParty: 4, sameOriginAssets: 0 },
    });
    expect((f!.evidence as { console: unknown[] }).console).toHaveLength(2);
  });

  it("warnings alone never fire, however many were logged", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/warn",
        console: capture({
          console: [{ level: "warning", text: "w", cut: false }],
          consoleTotal: 50,
        }),
      },
    ]);
    expect(await fired("render.console-error", crawlId)).toEqual([]);
  });

  it("a failed request fires render.failed-request", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/404",
        console: capture({
          failedRequests: [
            { url: url("/app.js"), status: 404, reason: "http 404", cut: false },
          ],
          failedRequestsTotal: 1,
        }),
      },
    ]);
    expect(await fired("render.failed-request", crawlId)).toEqual(["/404"]);
    const [f] = await rule("render.failed-request").run(db, crawlId);
    expect(f!.evidence).toMatchObject({
      failedRequestsTotal: 1,
      firstFailedUrl: url("/app.js"),
      firstFailedReason: "http 404",
    });
  });

  it("a rendered = false row with a captured exception still fires", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/timeout",
        rendered: false,
        console: capture({
          exceptions: [{ text: "boom", cut: false }],
          exceptionsTotal: 1,
        }),
      },
    ]);
    expect(await fired("render.js-exception", crawlId)).toEqual(["/timeout"]);
    const [f] = await rule("render.js-exception").run(db, crawlId);
    expect(f!.evidence).toMatchObject({ rendered: false });
  });

  it("a null render_console is no candidate for any rule", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/never", rendered: false, console: null }]);
    for (const r of renderConsoleRules) expect(await fired(r.id, crawlId), r.id).toEqual([]);
  });

  it("a render_console that is not a RenderConsole throws, naming the crawl and page", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/alien", console: { exceptionsTotal: "many" } }]);
    for (const r of renderConsoleRules) {
      await expect(r.run(db, crawlId), r.id).rejects.toThrow(
        new RegExp(`${r.id}: crawl '${crawlId}', page '${SITE}/alien'`),
      );
    }
  });

  it("throws on a malformed row even when no rule would have fired on it", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/ok" },
      { path: "/bad-level", console: capture({ console: [{ level: "info", text: "x", cut: false }] as never }) },
    ]);
    await expect(rule("render.failed-request").run(db, crawlId)).rejects.toThrow(/bad-level/);
  });

  it("reads past one batch and notes a capped listing", async () => {
    const crawlId = await newCrawl();
    const n = CONSOLE_BATCH + 5;
    await addPages(
      crawlId,
      Array.from({ length: n }, (_, i) => ({
        path: `/p${String(i).padStart(4, "0")}`,
        console: capture({ exceptions: [{ text: "e", cut: false }], exceptionsTotal: 1 }),
      })),
    );
    // Uncapped, the cursor's second batch is read too.
    const all = await rule("render.js-exception").run(db, crawlId, { listing: null });
    expect(all).toHaveLength(n);
    const capped = await rule("render.js-exception").run(db, crawlId, { listing: 3 });
    // Three findings plus the truncation note.
    expect(capped.filter((f) => f.pageUrl !== null)).toHaveLength(3);
    expect(JSON.stringify(capped)).toContain(String(n));
  });

  it("an unknown crawl throws rather than reading as clean", async () => {
    await expect(rule("render.js-exception").run(db, "crawl_missing")).rejects.toThrow(
      /no such crawl/,
    );
  });
});
