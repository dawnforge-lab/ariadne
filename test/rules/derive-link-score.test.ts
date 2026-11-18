/**
 * The internal link score derivation (Phase 29c), against a real database.
 *
 * The expected raw values are the EXACT solution of the linear system for the
 * graph drawn on `fixture` (rational solve, denominator 241193), not read back
 * out of the query.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import {
  deriveLinkScore,
  LINK_SCORE_DAMPING,
  LINK_SCORE_EQUAL_TOLERANCE,
  LINK_SCORE_MAX_ITERATIONS,
  LINK_SCORE_TOLERANCE,
  LINK_SCORE_SCALE,
} from "../../src/rules/derive/link-score.js";
import { buildRegistry } from "../../src/rules/index.js";
import { runRules } from "../../src/rules/run.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { mkDiscovery } from "./mk-discovery.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://link-score.example";
const url = (path: string): string => `${SITE}${path}`;

type Kind = "ok" | "gone" | "redirect";
interface LinkSpec {
  from: string;
  to: string;
  nofollow?: boolean;
}

const EXACT: Record<string, number> = {
  "/a": 79080 / 241193,
  "/b": 35713 / 241193,
  "/c": 77380 / 241193,
  "/d": 35713 / 241193,
  "/e": 13307 / 241193,
};

describe("deriveLinkScore against the database", () => {
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

  async function addPages(crawlId: string, specs: [path: string, kind: Kind][]) {
    const rows = specs.map(([path, kind]) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(path),
      urlNormalised: url(path),
      fetchClass: kind === "redirect" ? "redirect" : kind === "gone" ? "http_error" : "ok",
      statusCode: kind === "redirect" ? 301 : kind === "gone" ? 404 : 200,
      isIndexable: kind === "ok",
      depth: 0,
      discoveredVia: "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]![0], r.id]));
  }

  async function addLinks(crawlId: string, ids: Map<string, string>, specs: LinkSpec[]) {
    await db.insert(links).values(
      specs.map((l, position) => {
        const sourcePageId = ids.get(l.from);
        if (sourcePageId === undefined) throw new Error(`no page for ${l.from}`);
        const external = l.to.startsWith("http");
        return {
          crawlId,
          sourcePageId,
          targetUrl: external ? l.to : url(l.to),
          targetPageId: null,
          anchor: "see this",
          rel: null,
          isInternal: !external,
          isNofollow: l.nofollow === true,
          position,
        };
      }),
    );
  }

  async function scores(crawlId: string) {
    const rows = await db
      .select({ url: pages.url, raw: pages.linkScoreRaw, score: pages.linkScore })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    return Object.fromEntries(rows.map((r) => [r.url.slice(SITE.length), r]));
  }

  /** Edges that survive: A→B A→C A→D B→C C→A E→C. D has none. The rest is noise. */
  async function fixture(extra: [string, Kind][] = []) {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      ["/a", "ok"],
      ["/b", "ok"],
      ["/c", "ok"],
      ["/d", "ok"],
      ["/e", "ok"],
      ["/f", "gone"],
      ["/r", "redirect"],
      ...extra,
    ]);
    await addLinks(crawlId, ids, [
      { from: "/a", to: "/b" },
      { from: "/a", to: "/b" }, // duplicate
      { from: "/a", to: "/c" },
      { from: "/a", to: "/d" },
      { from: "/b", to: "/c" },
      { from: "/b", to: "/b" }, // self
      { from: "/a", to: "/f" }, // 404 target
      { from: "/c", to: "/a" },
      { from: "/e", to: "/c" },
      { from: "/e", to: "/a", nofollow: true }, // nofollow
      { from: "/d", to: "https://ext.example/" }, // external
      { from: "/c", to: "/r" }, // redirect target
    ]);
    return crawlId;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("pins the constants", () => {
    expect(LINK_SCORE_DAMPING).toBe(0.85);
    expect(LINK_SCORE_MAX_ITERATIONS).toBe(20);
    expect(LINK_SCORE_TOLERANCE).toBe(1e-6);
  });

  it("matches the exact solution within 1e-6 and scores 0-100 on a log scale", async () => {
    const crawlId = await fixture();
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived).toMatchObject({ nodes: 5, edges: 6, dangling: 1, iterations: 18, converged: 1 });
    const got = await scores(crawlId);
    let sum = 0;
    for (const [path, exact] of Object.entries(EXACT)) {
      expect(Math.abs(got[path]!.raw! - exact), path).toBeLessThan(1e-6);
      sum += got[path]!.raw!;
    }
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(
      Object.fromEntries(Object.keys(EXACT).map((p) => [p, got[p]!.score])),
    ).toEqual({ "/a": 100, "/b": 55, "/c": 99, "/d": 55, "/e": 0 });
    expect(got["/f"]).toMatchObject({ raw: null, score: null });
    expect(got["/r"]).toMatchObject({ raw: null, score: null });
  });

  it("gives an isolated sixth page the same floor score as E", async () => {
    const crawlId = await fixture([["/g", "ok"]]);
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived.nodes).toBe(6);
    const got = await scores(crawlId);
    const sum = Object.values(got).reduce((s, r) => s + (r.raw ?? 0), 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(got["/e"]!.score).toBe(0);
    expect(got["/g"]!.score).toBe(0);
  });

  it("writes nothing for a crawl with no OK page", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [["/gone", "gone"]]);
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived).toEqual({ nodes: 0, edges: 0, dangling: 0, iterations: 0, converged: 1 });
    expect((await scores(crawlId))["/gone"]).toMatchObject({ raw: null, score: null });
  });

  it("scores a single page raw 1, score 100", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [["/", "ok"]]);
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived.iterations).toBeLessThanOrEqual(LINK_SCORE_MAX_ITERATIONS);
    const got = await scores(crawlId);
    expect(got["/"]!.raw).toBeCloseTo(1, 12);
    expect(got["/"]!.score).toBe(100);
  });

  it("gives equal shares and score 100 when no page links out, converging at once", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [["/a", "ok"], ["/b", "ok"], ["/c", "ok"]]);
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived).toMatchObject({ nodes: 3, edges: 0, dangling: 3, iterations: 1, converged: 1 });
    for (const r of Object.values(await scores(crawlId))) {
      expect(r.raw).toBeCloseTo(1 / 3, 12);
      expect(r.score).toBe(100);
    }
  });

  it("scores two disconnected 2-cycles equally at 100", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [["/a", "ok"], ["/b", "ok"], ["/c", "ok"], ["/d", "ok"]]);
    await addLinks(crawlId, ids, [
      { from: "/a", to: "/b" },
      { from: "/b", to: "/a" },
      { from: "/c", to: "/d" },
      { from: "/d", to: "/c" },
    ]);
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived.iterations).toBeLessThanOrEqual(LINK_SCORE_MAX_ITERATIONS);
    for (const r of Object.values(await scores(crawlId))) {
      expect(Number.isNaN(r.raw)).toBe(false);
      expect(r.raw).toBeCloseTo(0.25, 12);
      expect(r.score).toBe(100);
    }
  });

  it("replaces junk on a re-run with identical values", async () => {
    const crawlId = await fixture();
    await deriveLinkScore(db, crawlId);
    const before = await scores(crawlId);
    await db.execute(
      sql`update pages set link_score_raw = 7, link_score = 77 where crawl_id = ${crawlId}`,
    );
    await deriveLinkScore(db, crawlId);
    expect(await scores(crawlId)).toEqual(before);
  });

  it("throws for a crawl nothing knows", async () => {
    await expect(deriveLinkScore(db, "crawl_does_not_exist")).rejects.toThrow(/no such crawl/);
  });

  it("runs in the derive step after deriveLinkCounts", async () => {
    const crawlId = await fixture();
    const summary = await runRules(db, crawlId, buildRegistry());
    expect(summary.derived["deriveLinkScore.nodes"]).toBe(5);
    expect(summary.derived["deriveLinkScore.edges"]).toBe(6);
    expect(summary.derived["deriveLinkScore.converged"]).toBe(1);
    expect(Object.keys(summary.derivedMs)).toContain("deriveLinkScore");
  });

  // ---- Page-level nofollow (owner change, 29c) ------------------------------
  //
  // Graph: A links to B and C; B and C each link back to A. Nodes 3, d = 0.85.
  //
  // With A's links DROPPED (A says nofollow) the kept edges are B->A and C->A
  // (outdeg 1 each) and A has none out, so A is dangling and its weight is spread
  // over all three pages. By symmetry b = c, and a + 2b = 1:
  //   a = 0.15/3 + 0.85*a/3 + 0.85*(b + c)
  //   a = 0.05 + (0.85/3)*a + 0.85*(1 - a)
  //   a * (1 + 0.85 - 0.85/3) = 0.05 + 0.85 = 0.9
  //   a * (47/30) = 9/10  =>  a = 27/47,  b = c = (1 - 27/47)/2 = 10/47.
  // Check b: 0.05 + 0.85*(27/47)/3 = 1/20 + 153/(20*47)... = (47 + 153)/(20*47)
  //   = 200/940 = 10/47. Scores: B = C = the minimum -> 0; A -> 100.
  //
  // With A's links KEPT (control, a "nofollowing" or noindex-only page) the edges
  // are A->B, A->C (outdeg 2), B->A, C->A; nobody is dangling:
  //   a = 0.05 + 0.85*(b + c),  b = c = 0.05 + 0.85*a/2,  a + 2b = 1
  //   a = 0.05 + 0.85*(1 - a)  =>  a * 1.85 = 0.9  =>  a = 18/37,  b = c = 19/74.
  //
  // The iteration cap (20) stops this graph before the 1e-6 tolerance (the error
  // contracts by 0.85 a step and the start is far from the answer: about 6e-3 left
  // at the cap), so the comparison uses RAW_SLACK. The two hypotheses differ by
  // 0.044 or more per page, so the slack cannot hide a wrong edge set.
  const RAW_SLACK = 1.5e-2;
  const DROPPED = { "/a": 27 / 47, "/b": 10 / 47, "/c": 10 / 47 };
  const KEPT = { "/a": 18 / 37, "/b": 19 / 74, "/c": 19 / 74 };

  async function triangle(
    marks: Partial<Record<"/a" | "/b" | "/c", { robotsMeta?: string; xRobotsTag?: string }>>,
  ) {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [["/a", "ok"], ["/b", "ok"], ["/c", "ok"]]);
    await addLinks(crawlId, ids, [
      { from: "/a", to: "/b" },
      { from: "/a", to: "/c" },
      { from: "/b", to: "/a" },
      { from: "/c", to: "/a" },
    ]);
    for (const [path, m] of Object.entries(marks)) {
      await db
        .update(pages)
        .set({ robotsMeta: m.robotsMeta ?? null, xRobotsTag: m.xRobotsTag ?? null })
        .where(eq(pages.id, ids.get(path)!));
    }
    return crawlId;
  }

  async function expectRaw(crawlId: string, want: Record<string, number>) {
    const got = await scores(crawlId);
    for (const [path, exact] of Object.entries(want)) {
      expect(Math.abs(got[path]!.raw! - exact), path).toBeLessThan(RAW_SLACK);
    }
    return got;
  }

  it("drops every outgoing edge of a page whose robots meta says nofollow", async () => {
    const crawlId = await triangle({ "/a": { robotsMeta: "index, nofollow" } });
    const derived = await deriveLinkScore(db, crawlId);
    expect(derived).toMatchObject({ nodes: 3, edges: 2, dangling: 1 });
    const got = await expectRaw(crawlId, DROPPED);
    expect(got["/a"]!.score).toBe(100);
    expect(got["/b"]!.score).toBe(0);
    expect(got["/c"]!.score).toBe(0);
  });

  it("drops the edges of a page whose X-Robots-Tag header says nofollow", async () => {
    const crawlId = await triangle({ "/a": { xRobotsTag: "nofollow" } });
    expect(await deriveLinkScore(db, crawlId)).toMatchObject({ edges: 2, dangling: 1 });
    await expectRaw(crawlId, DROPPED);
  });

  it("treats none (noindex, nofollow) as nofollow in either channel", async () => {
    for (const mark of [{ robotsMeta: "none" }, { xRobotsTag: "googlebot: none" }]) {
      const crawlId = await triangle({ "/a": mark });
      expect(await deriveLinkScore(db, crawlId)).toMatchObject({ edges: 2, dangling: 1 });
      await expectRaw(crawlId, DROPPED);
    }
  });

  it("keeps the edges for nofollowing, noindex alone, and noindex, follow", async () => {
    const crawlId = await triangle({
      "/a": { robotsMeta: "nofollowing" },
      "/b": { robotsMeta: "noindex" },
      "/c": { xRobotsTag: "noindex, follow" },
    });
    expect(await deriveLinkScore(db, crawlId)).toMatchObject({ edges: 4, dangling: 0 });
    await expectRaw(crawlId, KEPT);
  });

  // ---- max = min within a tolerance (owner change, 29c) ---------------------

  it("pins the equal-score tolerance", () => {
    expect(LINK_SCORE_EQUAL_TOLERANCE).toBe(1e-9);
  });

  it("scores 100 for a symmetric graph whose true scores are equal", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [["/a", "ok"], ["/b", "ok"], ["/c", "ok"]]);
    await addLinks(crawlId, ids, [
      { from: "/a", to: "/b" },
      { from: "/b", to: "/c" },
      { from: "/c", to: "/a" },
    ]);
    await deriveLinkScore(db, crawlId);
    for (const r of Object.values(await scores(crawlId))) expect(r.score).toBe(100);
  });

  it("the scaling expression treats float noise as equal and a real gap as a log scale", async () => {
    const run = async (v: number, lo: number, hi: number): Promise<number> => {
      const r = await db.execute<{ s: number }>(
        sql`select ${LINK_SCORE_SCALE(sql`${v}::float8`, sql`${lo}::float8`, sql`${hi}::float8`)} as s`,
      );
      return Number(r.rows[0]!.s);
    };
    const third = 1 / 3;
    const noisy = third + 1e-17; // under one ulp of 1/3: the same double
    const nudged = third * (1 + 4e-16); // a couple of ulps
    // Within tolerance: every page is 100, including the lowest.
    expect(await run(third, third, noisy)).toBe(100);
    expect(await run(third, third, nudged)).toBe(100);
    expect(await run(third, third, third * (1 + 0.9e-9))).toBe(100);
    // Beyond tolerance the log scale applies: lowest 0, highest 100.
    const hi = third * (1 + 2e-9);
    expect(await run(third, third, hi)).toBe(0);
    expect(await run(hi, third, hi)).toBe(100);
    expect(await run(0.2, 0.1, 0.4)).toBe(50);
  });
});
