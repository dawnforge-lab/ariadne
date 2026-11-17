/**
 * `images.larger-than-displayed` and `render.image-measurement` (CHECK-49),
 * against a real database.
 *
 * Rows are inserted directly with a `render_images` blob, the way
 * render-console.test.ts inserts console captures: the browser's contribution
 * is a JSON value in a column, and what is under test is what the rule and the
 * metric make of it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { RENDER_CAPTURE_VERSION } from "../../src/crawl/versions.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import {
  RENDER_IMAGES_KEPT,
  type RenderImage,
  type RenderImages,
} from "../../src/crawl/render/image-stand-in.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { DEFAULT_THRESHOLDS } from "../../src/rules/judgement.js";
import { renderMetrics } from "../../src/rules/metric/render-metrics.js";
import {
  IMAGES_BATCH,
  renderImageRules,
} from "../../src/rules/query/render-images.js";
import type { JudgementContext, QueryRule } from "../../src/rules/registry/types.js";
import { IMAGE_OVERSIZE_PERCENT } from "../../src/rules/thresholds.js";
import { THRESHOLD_ROWS } from "../../src/rules/threshold-table.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { databaseUrl, metricLookup, metricRowsByScope } from "./metric-db.js";

const SITE = "https://images.example";
const ID = "images.larger-than-displayed";
const url = (path: string): string => `${SITE}${path}`;

const rule: QueryRule = (() => {
  const r = renderImageRules.find((x) => x.id === ID);
  if (!r) throw new Error(`no rule '${ID}' in renderImageRules`);
  return r;
})();
const metric = metricLookup(renderMetrics, "renderMetrics")("render.image-measurement");

/** One kept image at the given intrinsic and displayed widths. */
function image(intrinsicWidth: number, displayedWidth: number, name = "a"): RenderImage {
  const intrinsicHeight = intrinsicWidth;
  const displayedHeight = displayedWidth;
  return {
    url: url(`/img/${name}.jpg`),
    cut: false,
    intrinsicWidth,
    intrinsicHeight,
    displayedWidth,
    displayedHeight,
    wastedPixels: Math.max(
      0,
      intrinsicWidth * intrinsicHeight - displayedWidth * displayedHeight,
    ),
    bytes: 1000,
    widthFrom: "stored",
  };
}

/** A capture that measured nothing; `over` states what the case is about. */
function capture(over: Partial<RenderImages> = {}): RenderImages {
  const kept = over.kept ?? [];
  return {
    total: 0,
    examined: 0,
    measured: 0,
    hidden: 0,
    lazyUnloaded: 0,
    notRequested: 0,
    noDimensions: 0,
    broken: 0,
    widerThanDisplayed: kept.length,
    standIns: 0,
    kept,
    ...over,
  };
}

const ctxWith = (overrides: { IMAGE_OVERSIZE_PERCENT: number }): JudgementContext => ({
  thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
  disabledRules: new Set(),
});

describe("the IMAGE_OVERSIZE_PERCENT threshold", () => {
  it("defaults to 200 and is overridable from 101 to 1000", () => {
    expect(IMAGE_OVERSIZE_PERCENT).toBe(200);
    expect(THRESHOLD_ROWS.IMAGE_OVERSIZE_PERCENT).toEqual({ min: 101, max: 1000, default: 200 });
  });
});

describe("renderImageRules metadata", () => {
  it("is one warning rule claiming CHECK-49 in the technical category", () => {
    expect(renderImageRules.map((r) => [r.id, r.checkIds, r.severity, r.category])).toEqual([
      [ID, ["CHECK-49"], "warning", "technical"],
    ]);
  });

  it("carries copy naming the default threshold, the viewport and columns", () => {
    // `copyFor` fills the placeholder with the default (200) the way every rule's copy is.
    expect(rule.explanation).toContain("more than 200%");
    expect(rule.explanation).not.toContain("{IMAGE_OVERSIZE_PERCENT}");
    expect(rule.explanation).toContain("1280");
    expect(rule.explanation).toContain("template");
    expect(rule.columns?.length).toBeGreaterThan(1);
    expect(rule.rulesetVersion).toBeTruthy();
  });

  it("declares the metric for CHECK-49", () => {
    expect([metric.kind, metric.checkIds]).toEqual(["metric", ["CHECK-49"]]);
  });
});

describe("images.larger-than-displayed and render.image-measurement against the database", () => {
  let db: Db;
  const created: string[] = [];

  interface PageSpec {
    path: string;
    pageType?: string | null;
    renderVersion?: number | null;
    /** `undefined` is a clean capture; `null` is no capture at all. */
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
          rendered: true,
          renderVersion: s.renderVersion === undefined ? RENDER_CAPTURE_VERSION : s.renderVersion,
          renderImages: s.images === undefined ? capture() : (s.images as RenderImages | null),
        };
      }),
    );
  }

  async function fired(crawlId: string, ctx?: JudgementContext): Promise<string[]> {
    const findings = await rule.run(db, crawlId, undefined, ctx);
    for (const f of findings) expect(f.ruleId).toBe(ID);
    return findings.map((f) => (f.pageUrl ?? "").slice(SITE.length));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("the render capture is 3 or later, which the rule's version filter relies on", () => {
    expect(RENDER_CAPTURE_VERSION).toBeGreaterThanOrEqual(3);
  });

  it("fires on 1600 shown at 400 and not on 800 shown at 800", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/big", images: capture({ total: 1, examined: 1, measured: 1, kept: [image(1600, 400)] }) },
      // 800 at 800 is not wider than its box, so the renderer keeps nothing.
      { path: "/fine", images: capture({ total: 1, examined: 1, measured: 1, kept: [], widerThanDisplayed: 0 }) },
    ]);
    expect(await fired(crawlId)).toEqual(["/big"]);
  });

  it("applies the ratio over kept: 800 shown at 800 and 1000 shown at 800 are silent", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/same", images: capture({ kept: [image(800, 800)] }) },
      { path: "/125", images: capture({ kept: [image(1000, 800)] }) },
    ]);
    expect(await fired(crawlId)).toEqual([]);
  });

  it("is strictly above the threshold: exactly 200% is silent, 201% fires", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/exact", images: capture({ kept: [image(800, 400)] }) },
      { path: "/over", images: capture({ kept: [image(804, 400)] }) },
    ]);
    expect(await fired(crawlId)).toEqual(["/over"]);
  });

  it("450 shown at 200 (225%) fires at the default and not at an override of 250", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/p", images: capture({ kept: [image(450, 200)] }) }]);
    expect(await fired(crawlId)).toEqual(["/p"]);
    expect(await fired(crawlId, ctxWith({ IMAGE_OVERSIZE_PERCENT: 250 }))).toEqual([]);
    expect(await fired(crawlId, ctxWith({ IMAGE_OVERSIZE_PERCENT: 224 }))).toEqual(["/p"]);
  });

  it("never fires on a displayed width under 1", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/zero", images: capture({ kept: [image(1600, 0)] }) }]);
    expect(await fired(crawlId)).toEqual([]);
  });

  it("evidence: the count, the matching images in kept order, the measured share", async () => {
    const crawlId = await newCrawl();
    const kept = [image(3000, 300, "x"), image(900, 800, "y"), image(1200, 300, "z")];
    await addPages(crawlId, [
      {
        path: "/e",
        images: capture({
          total: 10,
          examined: 10,
          measured: 6,
          hidden: 1,
          noDimensions: 2,
          broken: 1,
          widerThanDisplayed: 3,
          standIns: 7,
          kept,
        }),
      },
    ]);
    const [f] = await rule.run(db, crawlId);
    const ev = f!.evidence as Record<string, unknown>;
    expect(ev).toMatchObject({
      template: "product",
      oversizedCount: 2,
      atLeast: false,
      measured: 6,
      // 6 / (6 + 2 noDimensions + 1 broken): broken was requested and not measured.
      measuredShare: 0.667,
    });
    expect((ev["images"] as RenderImage[]).map((i) => i.url)).toEqual([
      url("/img/x.jpg"),
      url("/img/z.jpg"),
    ]);
  });

  it("lists at most 20 images", async () => {
    const crawlId = await newCrawl();
    const kept = Array.from({ length: 30 }, (_, i) => image(2000, 100, `i${i}`));
    await addPages(crawlId, [
      { path: "/many", images: capture({ measured: 30, widerThanDisplayed: 30, kept }) },
    ]);
    const [f] = await rule.run(db, crawlId);
    const ev = f!.evidence as { images: unknown[]; oversizedCount: number };
    expect(ev.images).toHaveLength(20);
    expect(ev.oversizedCount).toBe(30);
  });

  it("says atLeast when kept was truncated: widerThanDisplayed exceeds kept", async () => {
    const crawlId = await newCrawl();
    const kept = Array.from({ length: RENDER_IMAGES_KEPT }, (_, i) => image(2000, 100, `k${i}`));
    await addPages(crawlId, [
      {
        path: "/trunc",
        images: capture({ measured: 80, widerThanDisplayed: 80, kept }),
      },
    ]);
    const [f] = await rule.run(db, crawlId);
    expect(f!.evidence).toMatchObject({ atLeast: true, oversizedCount: RENDER_IMAGES_KEPT });
  });

  it("measuredShare is null when nothing was measured or unmeasured", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/n", images: capture({ kept: [image(2000, 100)] }) }]);
    const [f] = await rule.run(db, crawlId);
    expect(f!.evidence).toMatchObject({ measured: 0, measuredShare: null });
  });

  it("render_version 2 and a null capture are silent", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/v2", renderVersion: 2, images: capture({ kept: [image(1600, 400)] }) },
      { path: "/none", images: null },
    ]);
    expect(await fired(crawlId)).toEqual([]);
  });

  it("a render_images that is not a RenderImages throws, naming the crawl and page", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/alien", images: { total: "many" } }]);
    await expect(rule.run(db, crawlId)).rejects.toThrow(
      new RegExp(`${ID}: crawl '${crawlId}', page '${SITE}/alien'`),
    );
  });

  it("throws on a kept entry of the wrong shape even when nothing would fire", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      { path: "/bad", images: capture({ kept: [{ url: 3 }] as never }) },
    ]);
    await expect(rule.run(db, crawlId)).rejects.toThrow(/bad/);
  });

  it("reads past one batch and notes a capped listing", async () => {
    const crawlId = await newCrawl();
    const n = IMAGES_BATCH + 5;
    await addPages(
      crawlId,
      Array.from({ length: n }, (_, i) => ({
        path: `/p${String(i).padStart(4, "0")}`,
        images: capture({ kept: [image(1600, 400)] }),
      })),
    );
    expect(await rule.run(db, crawlId, { listing: null })).toHaveLength(n);
    const capped = await rule.run(db, crawlId, { listing: 3 });
    expect(capped.filter((f) => f.pageUrl !== null)).toHaveLength(3);
    expect(JSON.stringify(capped)).toContain(String(n));
  });

  it("an unknown crawl throws rather than reading as clean", async () => {
    await expect(rule.run(db, "crawl_missing")).rejects.toThrow(/no such crawl/);
  });

  describe("the render.image-measurement metric", () => {
    it("sums the counts over two templates and the whole crawl", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [
        {
          path: "/a1",
          pageType: "product",
          images: capture({
            total: 10, examined: 10, measured: 6, hidden: 1, lazyUnloaded: 1,
            notRequested: 1, noDimensions: 1, broken: 0, standIns: 5,
          }),
        },
        {
          path: "/a2",
          pageType: "product",
          images: capture({
            total: 4, examined: 4, measured: 2, hidden: 0, lazyUnloaded: 0,
            notRequested: 0, noDimensions: 1, broken: 1, standIns: 3,
          }),
        },
        {
          path: "/b1",
          pageType: "blog",
          images: capture({
            total: 5, examined: 5, measured: 5, standIns: 5,
          }),
        },
        // Not counted: capture 2, no capture, and a null page type is a template of its own.
        { path: "/old", pageType: "blog", renderVersion: 2, images: capture({ total: 99, measured: 99 }) },
        { path: "/null", pageType: "blog", images: null },
        { path: "/u", pageType: null, images: capture({ total: 1, examined: 1, measured: 1, standIns: 1 }) },
      ]);
      const rows = await metricRowsByScope(db, metric, crawlId);
      expect(rows["page_type|product"]).toEqual({
        pages: 2,
        total: 14,
        measured: 8,
        hidden: 1,
        lazyUnloaded: 1,
        notRequested: 1,
        noDimensions: 2,
        broken: 1,
        standIns: 8,
        // 8 / (8 + 2 + 1)
        measuredShare: 0.727,
      });
      expect(rows["page_type|blog"]).toMatchObject({
        pages: 1, total: 5, measured: 5, noDimensions: 0, broken: 0, measuredShare: 1,
      });
      expect(rows["page_type|(untyped)"]).toMatchObject({ pages: 1, total: 1, measured: 1 });
      expect(rows["site|"]).toEqual({
        pages: 4,
        total: 20,
        measured: 14,
        hidden: 1,
        lazyUnloaded: 1,
        notRequested: 1,
        noDimensions: 2,
        broken: 1,
        standIns: 14,
        // 14 / (14 + 2 + 1)
        measuredShare: 0.824,
      });
    });

    it("has a site row of zeroes and a null share on a crawl with no capture", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/x", images: null }]);
      const rows = await metricRowsByScope(db, metric, crawlId);
      expect(Object.keys(rows)).toEqual(["site|"]);
      expect(rows["site|"]).toMatchObject({ pages: 0, total: 0, measured: 0, measuredShare: null });
    });

    it("throws on a capture that is not a RenderImages", async () => {
      const crawlId = await newCrawl();
      await addPages(crawlId, [{ path: "/alien", images: { total: "many" } }]);
      await expect(metric.run(db, crawlId)).rejects.toThrow(
        new RegExp(`render.image-measurement: crawl '${crawlId}', page '${SITE}/alien'`),
      );
    });

    it("an unknown crawl throws", async () => {
      await expect(metric.run(db, "crawl_missing")).rejects.toThrow(/no such crawl/);
    });
  });
});
