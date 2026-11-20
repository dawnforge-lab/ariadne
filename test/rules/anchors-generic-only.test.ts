/**
 * `links.anchors-generic-only` (Phase 29c T4, CHECK-86) and its threshold
 * `GENERIC_ANCHOR_MIN_INLINKS`, against a real database.
 *
 * Rows are inserted directly, as the link-hygiene tests do. The rule reads
 * `pages.inlinks_internal`, so every test runs `deriveLinkCounts` first, as
 * `runRules` does before any query rule.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { hostKeyOf } from "../../src/crawl/host-key.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { deriveLinkCounts } from "../../src/rules/derive/link-counts.js";
import { DEFAULT_THRESHOLDS } from "../../src/rules/judgement.js";
import { linkHygieneRules } from "../../src/rules/query/link-hygiene.js";
import { SAMPLE_SOURCES } from "../../src/rules/query/link-targets.js";
import { THRESHOLD_ROWS } from "../../src/rules/threshold-table.js";
import { GENERIC_ANCHOR_MIN_INLINKS } from "../../src/rules/thresholds.js";
import type { Finding, JudgementContext, QueryRule } from "../../src/rules/registry/types.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const ID = "links.anchors-generic-only";
const SITE = "https://generic-only.example";
const url = (path: string): string => `${SITE}${path}`;

const rule: QueryRule = (() => {
  const r = linkHygieneRules.find((x) => x.id === ID);
  if (!r) throw new Error(`no rule '${ID}' in linkHygieneRules`);
  return r;
})();

const ctxWith = (min: number): JudgementContext => ({
  thresholds: { ...DEFAULT_THRESHOLDS, GENERIC_ANCHOR_MIN_INLINKS: min },
  disabledRules: new Set(),
});
const DEFAULT_CTX = ctxWith(GENERIC_ANCHOR_MIN_INLINKS);

describe("the GENERIC_ANCHOR_MIN_INLINKS threshold", () => {
  it("defaults to 3 and is overridable from 1 to 1000", () => {
    expect(GENERIC_ANCHOR_MIN_INLINKS).toBe(3);
    expect(THRESHOLD_ROWS.GENERIC_ANCHOR_MIN_INLINKS).toEqual({ min: 1, max: 1000, default: 3 });
    expect(DEFAULT_THRESHOLDS.GENERIC_ANCHOR_MIN_INLINKS).toBe(3);
  });
});

describe("links.anchors-generic-only metadata", () => {
  it("is one info rule claiming CHECK-86 in the links category, with copy that names its neighbours", () => {
    expect([rule.checkIds, rule.severity, rule.category, rule.kind]).toEqual([
      ["CHECK-86"],
      "info",
      "links",
      "query",
    ]);
    expect(rule.explanation).toContain("links.no-anchor-text");
    expect(rule.explanation).toContain("links.aria-label-only");
    expect(rule.explanation).toMatch(/aria-label/);
    expect(rule.explanation).toContain("3 or more");
    expect(rule.explanation).not.toContain("{GENERIC_ANCHOR_MIN_INLINKS}");
    expect(rule.columns?.map((c) => c.key)).toEqual(["inlinks", "minInlinks", "anchors"]);
  });
});

describe("links.anchors-generic-only against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

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
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  interface PageSpec extends IndexabilitySpec {
    path: string;
    canonical?: string | null;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: full,
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode === undefined ? 200 : s.statusCode,
        isIndexable: writerIndexable(s),
        robotsMeta: s.robotsMeta ?? null,
        xRobotsTag: s.xRobotsTag ?? null,
        canonicalHtml: s.canonical === undefined ? full : s.canonical,
        canonicalCount: s.canonical === null ? 0 : 1,
        depth: 1,
        discoveredVia: "link",
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  /** One internal link per spec, from `source` to `target`, in order. */
  async function addLinks(
    crawlId: string,
    source: string,
    specs: { target: string; anchor: string | null; nofollow?: boolean }[],
  ): Promise<void> {
    await db.insert(links).values(
      specs.map((s, position) => ({
        crawlId,
        sourcePageId: source,
        targetUrl: url(s.target),
        targetPageId: null,
        anchor: s.anchor,
        ariaLabel: null,
        nameHint: null,
        nameHintSource: null,
        rel: s.nofollow === true ? "nofollow" : null,
        isInternal: true,
        isNofollow: s.nofollow ?? false,
        position,
      })),
    );
  }

  /**
   * A crawl holding `/t` (the target) and one hub page per anchor, each linking
   * to `/t` with that anchor. Derives the counts, as the runner does.
   */
  async function hubCrawl(
    anchors: (string | null)[],
    target: PageSpec = { path: "/t" },
  ): Promise<string> {
    const crawlId = await newCrawl();
    const hubs = anchors.map((_, i) => ({ path: `/hub${i}` }));
    const ids = await addPages(crawlId, [target, ...hubs]);
    for (const [i, anchor] of anchors.entries()) {
      await addLinks(crawlId, ids.get(`/hub${i}`)!, [{ target: target.path, anchor }]);
    }
    await deriveLinkCounts(db, crawlId);
    return crawlId;
  }

  const run = (crawlId: string, ctx: JudgementContext = DEFAULT_CTX): Promise<Finding[]> =>
    rule.run(db, crawlId, undefined, ctx);

  const firedUrls = async (crawlId: string, ctx?: JudgementContext): Promise<string[]> =>
    (await run(crawlId, ctx)).map((f) => f.pageUrl ?? "");

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("fires once on a page whose three inlinks are all generic or empty, with normalised anchors", async () => {
    const crawlId = await hubCrawl(["  Click HERE ", "read more", ""]);
    const found = await run(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ruleId: ID, severity: "info", pageUrl: url("/t") });
    expect(found[0]!.evidence).toEqual({
      inlinks: 3,
      minInlinks: 3,
      anchors: ["", "click here", "read more"],
    });
  });

  it("counts a null anchor as empty", async () => {
    const crawlId = await hubCrawl([null, "here", "Read  More"]);
    const found = await run(crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({
      inlinks: 3,
      minInlinks: 3,
      anchors: ["", "here", "read more"],
    });
  });

  it("is silent when the same page has only 2 inlinks", async () => {
    expect(await firedUrls(await hubCrawl(["click here", "read more"]))).toEqual([]);
  });

  it("is silent when one of three anchors is descriptive", async () => {
    expect(await firedUrls(await hubCrawl(["click here", "read more", "Blue widgets"]))).toEqual([]);
  });

  it("is silent on a non-indexable page and on a 404 target", async () => {
    const anchors = ["click here", "read more", ""];
    expect(
      await firedUrls(await hubCrawl(anchors, { path: "/t", robotsMeta: "noindex" })),
    ).toEqual([]);
    expect(await firedUrls(await hubCrawl(anchors, { path: "/t", statusCode: 404 }))).toEqual([]);
  });

  it("is silent on a page canonicalised elsewhere", async () => {
    const crawlId = await hubCrawl(["click here", "read more", ""], {
      path: "/t",
      canonical: url("/elsewhere"),
    });
    expect(await firedUrls(crawlId)).toEqual([]);
  });

  it("with the override GENERIC_ANCHOR_MIN_INLINKS = 2, the 2-inlink page fires", async () => {
    const crawlId = await hubCrawl(["click here", "read more"]);
    expect(await firedUrls(crawlId, DEFAULT_CTX)).toEqual([]);
    const found = await run(crawlId, ctxWith(2));
    expect(found.map((f) => f.pageUrl)).toEqual([url("/t")]);
    expect(found[0]!.evidence).toMatchObject({ inlinks: 2, minInlinks: 2 });
  });

  it("with a larger override, the 3-inlink page falls silent", async () => {
    const crawlId = await hubCrawl(["click here", "read more", ""]);
    expect(await firedUrls(crawlId, ctxWith(4))).toEqual([]);
  });

  it("a source linking twice, once descriptively, keeps the page silent; twice generically counts once", async () => {
    // Every anchor of every inlink must be generic: one descriptive link from
    // one source is enough to name the page.
    const mixed = await newCrawl();
    const m = await addPages(mixed, [{ path: "/t" }, { path: "/a" }, { path: "/b" }, { path: "/c" }]);
    await addLinks(mixed, m.get("/a")!, [
      { target: "/t", anchor: "click here" },
      { target: "/t", anchor: "Blue widgets" },
    ]);
    await addLinks(mixed, m.get("/b")!, [{ target: "/t", anchor: "read more" }]);
    await addLinks(mixed, m.get("/c")!, [{ target: "/t", anchor: "" }]);
    await deriveLinkCounts(db, mixed);
    expect(await firedUrls(mixed)).toEqual([]);

    const generic = await newCrawl();
    const g = await addPages(generic, [{ path: "/t" }, { path: "/a" }, { path: "/b" }]);
    await addLinks(generic, g.get("/a")!, [
      { target: "/t", anchor: "click here" },
      { target: "/t", anchor: "here" },
    ]);
    await addLinks(generic, g.get("/b")!, [{ target: "/t", anchor: "read more" }]);
    await deriveLinkCounts(db, generic);
    // Two distinct source pages (R1), three link rows: 2 < 3, silent; at 2, fires with inlinks 2.
    expect(await firedUrls(generic)).toEqual([]);
    const found = await run(generic, ctxWith(2));
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toEqual({
      inlinks: 2,
      minInlinks: 2,
      anchors: ["click here", "here", "read more"],
    });
  });

  it("ignores the page's own links and counts nofollow inlinks, as R1 does", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [{ path: "/t" }, { path: "/a" }, { path: "/b" }, { path: "/c" }]);
    // A descriptive self-link would name the page, but a page's own links are not inlinks.
    await addLinks(crawlId, ids.get("/t")!, [{ target: "/t", anchor: "Back to the top" }]);
    await addLinks(crawlId, ids.get("/a")!, [{ target: "/t", anchor: "click here", nofollow: true }]);
    await addLinks(crawlId, ids.get("/b")!, [{ target: "/t", anchor: "read more" }]);
    await addLinks(crawlId, ids.get("/c")!, [{ target: "/t", anchor: "" }]);
    await deriveLinkCounts(db, crawlId);
    const found = await run(crawlId);
    expect(found.map((f) => f.pageUrl)).toEqual([url("/t")]);
    expect(found[0]!.evidence).toMatchObject({ inlinks: 3 });
  });

  it(`lists at most ${SAMPLE_SOURCES} distinct anchors`, async () => {
    const generic = [
      "click here", "click", "here", "read more", "more", "learn more", "find out more",
      "continue reading", "continue", "see more", "view more", "more info",
    ];
    const crawlId = await hubCrawl(generic);
    const found = await run(crawlId);
    expect(found).toHaveLength(1);
    const evidence = found[0]!.evidence as { inlinks: number; anchors: string[] };
    expect(evidence.inlinks).toBe(12);
    expect(evidence.anchors).toHaveLength(SAMPLE_SOURCES);
    expect(evidence.anchors).toEqual([...evidence.anchors].sort());
  });

  it("throws, naming deriveLinkCounts, when the counts have not been derived", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [{ path: "/t" }]);
    await expect(run(crawlId)).rejects.toThrow(/links\.anchors-generic-only.*deriveLinkCounts/);
  });
});
