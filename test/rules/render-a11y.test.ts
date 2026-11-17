/**
 * The accessibility rules `a11y.<axe-id>` (CHECK-89) and the render family's
 * NOT MEASURED marker `render.not-recorded` (CHECK-49, CHECK-51, CHECK-89),
 * against a real database.
 *
 * Rows are inserted directly — a page row with its `render_a11y_status` and the
 * `render_a11y` rows beside it — the way render-images.test.ts inserts image
 * captures: what the browser contributed is rows in two tables, and what is
 * under test is what the rules make of them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { hostKeyOf } from "../../src/crawl/host-key.js";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { A11Y_RULES, A11Y_TARGETS_MAX, type A11yStatus } from "../../src/crawl/render/a11y.js";
import { RENDER_CAPTURE_VERSION } from "../../src/crawl/versions.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, renderA11y } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { A11Y_BATCH, renderA11yRules } from "../../src/rules/query/render-a11y.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { databaseUrl } from "./metric-db.js";

const SITE = "https://a11y.example";
const MARKER_ID = "render.not-recorded";
const url = (path: string): string => `${SITE}${path}`;

function ruleById(id: string): QueryRule {
  const r = renderA11yRules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule '${id}' in renderA11yRules`);
  return r;
}

/** A clean capture-3 console, as the renderer writes it for a quiet page. */
const QUIET_CONSOLE = {
  console: [],
  consoleTotal: 0,
  exceptions: [],
  exceptionsTotal: 0,
  failedRequests: [],
  failedRequestsTotal: 0,
  blockedByRenderer: { thirdParty: 0, sameOriginAssets: 0 },
};

/** A capture-3 image measurement of a page with no images. */
const NO_IMAGES = {
  total: 0,
  examined: 0,
  measured: 0,
  hidden: 0,
  lazyUnloaded: 0,
  notRequested: 0,
  noDimensions: 0,
  broken: 0,
  widerThanDisplayed: 0,
  standIns: 0,
  kept: [],
};

describe("renderA11yRules metadata", () => {
  const a11y = renderA11yRules.filter((r) => r.id.startsWith("a11y."));

  it("holds one a11y rule per A11Y_RULES row, in table order, and nothing retyped", () => {
    expect(a11y.map((r) => r.id)).toEqual(A11Y_RULES.map((row) => `a11y.${row.axeId}`));
    expect(a11y).toHaveLength(25);
  });

  it("the registry holds exactly those 25 a11y rules", () => {
    const registered = buildRegistry()
      .all()
      .filter((r) => r.id.startsWith("a11y."))
      .map((r) => r.id)
      .sort();
    expect(registered).toEqual(A11Y_RULES.map((row) => `a11y.${row.axeId}`).sort());
  });

  it("takes each rule's severity from the table: meta-viewport is info, the rest warning", () => {
    for (const row of A11Y_RULES) {
      expect(ruleById(`a11y.${row.axeId}`).severity, row.axeId).toBe(row.severity);
    }
    expect(ruleById("a11y.meta-viewport").severity).toBe("info");
    expect(ruleById("a11y.image-alt").severity).toBe("warning");
  });

  it("files every a11y rule as an accessibility query rule on CHECK-89, issue / low", () => {
    for (const r of a11y) {
      expect([r.kind, r.category, r.checkIds, r.type, r.priority], r.id).toEqual([
        "query",
        "accessibility",
        ["CHECK-89"],
        "issue",
        "low",
      ]);
      expect(r.marker, r.id).toBeUndefined();
      expect(r.title.startsWith("Accessibility: "), r.title).toBe(true);
    }
  });

  it("each explanation names its WCAG level and the rendered sample", () => {
    for (const row of A11Y_RULES) {
      const r = ruleById(`a11y.${row.axeId}`);
      expect(r.explanation, row.axeId).toContain(`level ${row.wcag}`);
      expect(r.explanation, row.axeId).toMatch(/rendered sample/);
      expect(r.howToFix, row.axeId).toMatch(/template/);
    }
  });

  it("the marker is an info crawl rule on CHECK-49, CHECK-51 and CHECK-89, warning / low", () => {
    const m = ruleById(MARKER_ID);
    expect([m.kind, m.severity, m.category, m.checkIds, m.type, m.priority]).toEqual([
      "query",
      "info",
      "crawl",
      ["CHECK-49", "CHECK-51", "CHECK-89"],
      "warning",
      "low",
    ]);
    expect(m.marker).toBeTruthy();
  });
});

describe("a11y.* and render.not-recorded against the database", () => {
  let db: Db;
  const created: string[] = [];

  interface PageSpec {
    path: string;
    pageType?: string | null;
    rendered?: boolean;
    renderVersion?: number | null;
    /** `undefined` is `ran`. */
    status?: A11yStatus | null;
    /** `undefined` is a quiet capture; `null` is none. */
    console?: unknown;
    /** `undefined` is an empty capture; `null` is none. */
    images?: unknown;
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
    created.push(id);
    return id;
  }

  /** Inserts the pages; returns their ids by path. */
  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    await db.insert(pages).values(
      specs.map((s) => {
        const full = url(s.path);
        const normalised = normalizeUrl(full);
        if (normalised === null) throw new Error(`${full} does not normalise`);
        const id = `page_${randomUUID()}`;
        ids.set(s.path, id);
        return {
          id,
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
          renderVersion: s.renderVersion === undefined ? RENDER_CAPTURE_VERSION : s.renderVersion,
          renderConsole: (s.console === undefined ? QUIET_CONSOLE : s.console) as never,
          renderImages: (s.images === undefined ? NO_IMAGES : s.images) as never,
          renderA11yStatus: s.status === undefined ? "ran" : s.status,
          renderA11yMs: s.status === "disabled" || s.status === null ? null : 120,
        };
      }),
    );
    return ids;
  }

  interface ViolationSpec {
    pageId: string;
    rule: string;
    impact?: string | null;
    nodeCount?: number;
    targets?: unknown;
  }

  async function addViolations(crawlId: string, specs: ViolationSpec[]): Promise<void> {
    await db.insert(renderA11y).values(
      specs.map((v) => ({
        crawlId,
        pageId: v.pageId,
        axeRule: v.rule,
        impact: v.impact === undefined ? "critical" : v.impact,
        nodeCount: v.nodeCount ?? 1,
        targets: (v.targets === undefined ? ["img.hero"] : v.targets) as string[],
      })),
    );
  }

  /** Every a11y rule's findings over a crawl, as `path rule` lines. */
  async function a11yFired(crawlId: string): Promise<string[]> {
    const out: string[] = [];
    for (const r of renderA11yRules.filter((x) => x.id.startsWith("a11y."))) {
      for (const f of await r.run(db, crawlId)) {
        if (f.pageUrl === null) continue;
        out.push(`${f.pageUrl.slice(SITE.length)} ${f.ruleId}`);
      }
    }
    return out.sort();
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("the render capture is 3 or later, which the marker's version count relies on", () => {
    expect(RENDER_CAPTURE_VERSION).toBeGreaterThanOrEqual(3);
  });

  describe("the a11y rules", () => {
    it("a ran page with an image-alt row fires exactly a11y.image-alt, with its evidence", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/p", pageType: "article" }]);
      await addViolations(crawlId, [
        {
          pageId: ids.get("/p")!,
          rule: "image-alt",
          impact: "critical",
          nodeCount: 7,
          targets: ["img.a", "img.b", "img.c", "img.d", "img.e"],
        },
      ]);
      expect(await a11yFired(crawlId)).toEqual(["/p a11y.image-alt"]);
      const [f] = await ruleById("a11y.image-alt").run(db, crawlId);
      expect(f!.severity).toBe("warning");
      expect(f!.pageId).toBe(ids.get("/p"));
      expect(f!.evidence).toEqual({
        template: "article",
        impact: "critical",
        nodeCount: 7,
        targets: ["img.a", "img.b", "img.c", "img.d", "img.e"],
        wcag: "A",
      });
    });

    it("rows on a page whose run did not finish are stale and never read", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/disabled", status: "disabled" },
        { path: "/timeout", status: "timeout" },
        { path: "/interrupted", status: "interrupted" },
        { path: "/error", status: "error" },
        { path: "/never", rendered: false, status: null, renderVersion: null, console: null, images: null },
      ]);
      await addViolations(
        crawlId,
        [...ids.values()].map((pageId) => ({ pageId, rule: "image-alt" })),
      );
      expect(await a11yFired(crawlId)).toEqual([]);
    });

    it("a meta-viewport row is an info finding with a level AA", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/zoom" }]);
      await addViolations(crawlId, [
        { pageId: ids.get("/zoom")!, rule: "meta-viewport", impact: "moderate", targets: ["meta"] },
      ]);
      const [f] = await ruleById("a11y.meta-viewport").run(db, crawlId);
      expect(f!.severity).toBe("info");
      expect(f!.evidence).toMatchObject({ impact: "moderate", wcag: "AA" });
    });

    it("each rule reads only its own rows: two rules on one page, one on another", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }, { path: "/b" }]);
      await addViolations(crawlId, [
        { pageId: ids.get("/a")!, rule: "link-name" },
        { pageId: ids.get("/a")!, rule: "color-contrast", impact: "serious" },
        { pageId: ids.get("/b")!, rule: "color-contrast", impact: "serious" },
      ]);
      expect(await a11yFired(crawlId)).toEqual([
        "/a a11y.color-contrast",
        "/a a11y.link-name",
        "/b a11y.color-contrast",
      ]);
    });

    it("a null impact is carried as null, not guessed", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/n" }]);
      await addViolations(crawlId, [{ pageId: ids.get("/n")!, rule: "list", impact: null }]);
      const [f] = await ruleById("a11y.list").run(db, crawlId);
      expect(f!.evidence).toMatchObject({ impact: null, nodeCount: 1 });
    });

    it("declares a column for every evidence key it writes", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/c" }]);
      await addViolations(crawlId, [{ pageId: ids.get("/c")!, rule: "label" }]);
      const rule = ruleById("a11y.label");
      const [f] = await rule.run(db, crawlId);
      const declared = new Set((rule.columns ?? []).map((c) => c.key));
      for (const key of Object.keys(f!.evidence as object)) {
        expect(declared.has(key), `evidence key '${key}' has no column`).toBe(true);
      }
    });

    it("an axe_rule outside A11Y_RULES on a ran page throws, naming the crawl and page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/alien" }]);
      await addViolations(crawlId, [{ pageId: ids.get("/alien")!, rule: "region" }]);
      await expect(ruleById("a11y.image-alt").run(db, crawlId)).rejects.toThrow(
        new RegExp(`a11y.image-alt: crawl '${crawlId}', page '${SITE}/alien'.*'region'`),
      );
    });

    it("a node_count below one throws, naming the crawl and page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/neg" }]);
      await addViolations(crawlId, [{ pageId: ids.get("/neg")!, rule: "image-alt", nodeCount: -1 }]);
      await expect(ruleById("a11y.image-alt").run(db, crawlId)).rejects.toThrow(
        new RegExp(`a11y.image-alt: crawl '${crawlId}', page '${SITE}/neg'.*node_count`),
      );
    });

    it("targets that are not a string array of at most five throw", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/six" }, { path: "/nums" }, { path: "/obj" }]);
      await addViolations(crawlId, [
        {
          pageId: ids.get("/six")!,
          rule: "image-alt",
          nodeCount: 9,
          targets: Array.from({ length: A11Y_TARGETS_MAX + 1 }, (_, i) => `img.n${i}`),
        },
        { pageId: ids.get("/nums")!, rule: "button-name", targets: [1, 2] },
        { pageId: ids.get("/obj")!, rule: "list", targets: { a: "b" } },
      ]);
      await expect(ruleById("a11y.image-alt").run(db, crawlId)).rejects.toThrow(/\/six.*targets/);
      await expect(ruleById("a11y.button-name").run(db, crawlId)).rejects.toThrow(/\/nums.*targets/);
      await expect(ruleById("a11y.list").run(db, crawlId)).rejects.toThrow(/\/obj.*targets/);
    });

    it("reads past one batch and notes a capped listing", async () => {
      const crawlId = await newCrawl();
      const n = A11Y_BATCH + 5;
      const specs = Array.from({ length: n }, (_, i) => ({ path: `/p${String(i).padStart(4, "0")}` }));
      const ids = await addPages(crawlId, specs);
      await addViolations(
        crawlId,
        [...ids.values()].map((pageId) => ({ pageId, rule: "document-title" })),
      );
      const rule = ruleById("a11y.document-title");
      expect(await rule.run(db, crawlId, { listing: null })).toHaveLength(n);
      const capped = await rule.run(db, crawlId, { listing: 3 });
      expect(capped.filter((f) => f.pageUrl !== null)).toHaveLength(3);
      expect(JSON.stringify(capped)).toContain(String(n));
    });

    it("an unknown crawl throws rather than reading as clean", async () => {
      await expect(ruleById("a11y.image-alt").run(db, "crawl_missing")).rejects.toThrow(
        /no such crawl/,
      );
    });
  });

  describe("render.not-recorded", () => {
    const marker = () => ruleById(MARKER_ID);

    it("is silent on a crawl with no rendered page (R4)", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/raw", rendered: false, status: null, renderVersion: null, console: null, images: null },
      ]);
      expect(await marker().run(db, crawlId)).toEqual([]);
    });

    it("is silent on a fully capture-3 crawl whose every run finished", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a" },
        { path: "/b" },
        // A failed render is not a rendered page: R4 leaves it to render.coverage.
        { path: "/failed", rendered: false, status: null, images: null },
      ]);
      expect(await marker().run(db, crawlId)).toEqual([]);
    });

    it("fires when a rendered page's console was not captured", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a" },
        // A pre-25 capture: no console, no stamp, nothing of capture 3.
        { path: "/old", renderVersion: null, console: null, images: null, status: null },
      ]);
      const [f] = await marker().run(db, crawlId);
      expect(f!.pageUrl).toBeNull();
      expect(f!.evidence).toEqual({
        renderedPages: 2,
        consoleNotCaptured: 1,
        capturedBeforeImagesAndA11y: 1,
        accessibilityDisabled: 0,
        accessibilityIncomplete: 0,
        families: ["console", "images", "accessibility"],
      });
    });

    it("fires on a capture-2 page, which has a console and no images or accessibility", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/a" },
        { path: "/v2", renderVersion: 2, images: null, status: null },
      ]);
      const [f] = await marker().run(db, crawlId);
      expect(f!.evidence).toEqual({
        renderedPages: 2,
        consoleNotCaptured: 0,
        capturedBeforeImagesAndA11y: 1,
        accessibilityDisabled: 0,
        accessibilityIncomplete: 0,
        families: ["images", "accessibility"],
      });
    });

    it("fires when the accessibility run was disabled", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/a", status: "disabled" }, { path: "/b", status: "disabled" }]);
      const [f] = await marker().run(db, crawlId);
      expect(f!.evidence).toMatchObject({
        renderedPages: 2,
        accessibilityDisabled: 2,
        accessibilityIncomplete: 0,
        families: ["accessibility"],
      });
    });

    it("fires when a run timed out, was interrupted or errored, counting all three", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        { path: "/ok" },
        { path: "/t", status: "timeout" },
        { path: "/i", status: "interrupted" },
        { path: "/e", status: "error" },
      ]);
      const [f] = await marker().run(db, crawlId);
      expect(f!.evidence).toEqual({
        renderedPages: 4,
        consoleNotCaptured: 0,
        capturedBeforeImagesAndA11y: 0,
        accessibilityDisabled: 0,
        accessibilityIncomplete: 3,
        families: ["accessibility"],
      });
    });

    it("declares a column for every evidence key it writes", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/t", status: "timeout" }]);
      const [f] = await marker().run(db, crawlId);
      const declared = new Set((marker().columns ?? []).map((c) => c.key));
      for (const key of Object.keys(f!.evidence as object)) {
        expect(declared.has(key), `evidence key '${key}' has no column`).toBe(true);
      }
    });

    it("a rendered capture-3 page with no accessibility status throws, naming it", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/hole", status: null }]);
      await expect(marker().run(db, crawlId)).rejects.toThrow(
        new RegExp(`${MARKER_ID}: crawl '${crawlId}', page '${SITE}/hole'`),
      );
    });

    it("an unknown crawl throws rather than reading as clean", async () => {
      await expect(marker().run(db, "crawl_missing")).rejects.toThrow(/no such crawl/);
    });
  });
});
