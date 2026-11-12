/**
 * The `click_depth` derivation, against a real database.
 *
 * A derivation is not a rule: it accuses nobody and fills a column. What is
 * under test is therefore the SEARCH — that the number written on each page is
 * the minimum number of internal links between the home page and it — and the
 * two properties that make the column safe to read: a page no link path reaches
 * is null and never 0, and re-deriving a crawl replaces its answer rather than
 * adding to it.
 *
 * EVERY DEPTH BELOW IS HAND-DERIVED from the graph drawn beside it. A test whose
 * expectations came out of the query would assert only that the search is
 * deterministic; these assert that it is a breadth-first search.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import {
  deriveClickDepth,
  MAX_CLICK_DEPTH,
  ROOT_REDIRECT_HOPS,
} from "../../src/rules/derive/click-depth.js";
import { mkDiscovery } from "./mk-discovery.js";
import { LOCAL_TENANT } from "../../src/tenant.js";
import { hostKeyOf } from "../../src/crawl/host-key.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://click-depth.example";
const url = (path: string): string => `${SITE}${path}`;

interface PageSpec {
  path: string;
  /** `redirect` rows carry a target; everything else is a plain 200. */
  redirectTo?: string;
  discoveredVia?: string;
}

describe("deriveClickDepth against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  // `hostKey` is passed for a site URL with no host (a row no writer of ours
  // makes), which `hostKeyOf` rightly refuses.
  async function newCrawl(siteUrl = SITE, hostKey = hostKeyOf(siteUrl)): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id,
      siteUrl, hostKey,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
  }

  /** Insert the pages, returning path -> page id. */
  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: url(s.path),
      urlNormalised: url(s.path),
      fetchClass: s.redirectTo === undefined ? "ok" : "redirect",
      statusCode: s.redirectTo === undefined ? 200 : 301,
      isIndexable: s.redirectTo === undefined,
      redirectUrl: s.redirectTo === undefined ? null : url(s.redirectTo),
      redirectUrlNormalised: s.redirectTo === undefined ? null : url(s.redirectTo),
      // DISCOVERY depth, and deliberately the lie this whole task is about: the
      // crawler enqueues every sitemap entry as a seed, so a page nothing links
      // to still arrives here at 0. The assertions below never read it — they
      // read `click_depth`, and the difference between the two columns is the
      // point.
      depth: 0,
      discoveredVia: s.discoveredVia ?? "sitemap",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLinks(
    crawlId: string,
    ids: Map<string, string>,
    edges: [from: string, to: string][],
    external: [from: string, to: string][] = [],
  ): Promise<void> {
    const sourceId = (path: string): string => {
      const id = ids.get(path);
      if (id === undefined) throw new Error(`no page for ${path}`);
      return id;
    };
    const row = (from: string, to: string, position: number, isInternal: boolean) => ({
      crawlId,
      sourcePageId: sourceId(from),
      targetUrl: isInternal ? url(to) : to,
      targetPageId: null,
      anchor: "see this",
      rel: null,
      isInternal,
      isNofollow: false,
      position,
    });
    await db.insert(links).values([
      ...edges.map(([from, to], i) => row(from, to, i, true)),
      ...external.map(([from, to], i) => row(from, to, 900 + i, false)),
    ]);
  }

  /** path -> click_depth, for every page of the crawl. */
  async function depths(crawlId: string): Promise<Record<string, number | null>> {
    const rows = await db
      .select({ url: pages.url, clickDepth: pages.clickDepth })
      .from(pages)
      .where(eq(pages.crawlId, crawlId));
    return Object.fromEntries(
      rows.map((r) => [r.url.slice(SITE.length), r.clickDepth]),
    );
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  /**
   * THE GRAPH, drawn once and hand-solved beside it.
   *
   *      /  ──▶ /a ──▶ /c ──▶ /d ──▶ /e ─┐
   *      │      │       ▲               │
   *      │      ▼       └───────────────┘   (cycle: /e ──▶ /c)
   *      └──▶ /b ──▶ /d
   *              /self ◀── /                (and /self ──▶ /self)
   *              /island-1 ⇄ /island-2      (linked to each other, by nobody else)
   *              /sitemap-only              (in `pages`, in no link)
   *
   * Minimum hops from `/`:
   *   /            0   the entry point
   *   /a           1   /  ──▶ /a
   *   /b           1   /  ──▶ /b
   *   /self        1   /  ──▶ /self; its link to ITSELF adds nothing
   *   /c           2   / ─ /a ─ /c            (the cycle back from /e is longer)
   *   /d           2   / ─ /b ─ /d            THE DIAMOND: the other path
   *                    (/ ─ /a ─ /c ─ /d) is 3, and the minimum is what is written
   *   /e           3   / ─ /b ─ /d ─ /e
   *   /island-1  null  nothing outside the island links into it
   *   /island-2  null  ditto — an island is unreachable however connected it is
   *   /sitemap-only null  THE LAVISHALICE SHAPE: discovery depth 0, click depth
   *                       null. It is in `pages` because the sitemap named it and
   *                       the crawler fetched it, and no link on the site reaches
   *                       it.
   */
  const SPECS: PageSpec[] = [
    { path: "/", discoveredVia: "seed" },
    { path: "/a" },
    { path: "/b" },
    { path: "/c" },
    { path: "/d" },
    { path: "/e" },
    { path: "/self" },
    { path: "/island-1" },
    { path: "/island-2" },
    { path: "/sitemap-only" },
  ];

  const EDGES: [string, string][] = [
    ["/", "/a"],
    ["/", "/b"],
    ["/", "/self"],
    ["/self", "/self"],
    ["/a", "/c"],
    ["/a", "/b"],
    ["/b", "/d"],
    ["/c", "/d"],
    ["/d", "/e"],
    ["/e", "/c"],
    ["/island-1", "/island-2"],
    ["/island-2", "/island-1"],
  ];

  it("writes the minimum number of hops, and null for what no link path reaches", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, SPECS);
    await addLinks(crawlId, ids, EDGES, [["/a", "https://elsewhere.example/x"]]);

    const summary = await deriveClickDepth(db, crawlId);

    expect(await depths(crawlId)).toEqual({
      "/": 0,
      "/a": 1,
      "/b": 1,
      "/self": 1,
      "/c": 2,
      "/d": 2,
      "/e": 3,
      "/island-1": null,
      "/island-2": null,
      "/sitemap-only": null,
    });

    // The summary is the derivation's own account of what it did: seven pages
    // reached (the entry point and six others), three left null, deepest 3.
    expect(summary).toEqual({
      root: 1,
      rootRedirects: 0,
      reachable: 7,
      unreachable: 3,
      maxDepth: 3,
      capped: 0,
    });
  });

  it("is idempotent, and forgets a page that has LOST its link path", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, SPECS);
    await addLinks(crawlId, ids, EDGES);

    const first = await deriveClickDepth(db, crawlId);
    const again = await deriveClickDepth(db, crawlId);
    expect(again).toEqual(first);

    // Now the site drops BOTH links into /b — the hub's and /a's. Nothing else
    // changes, and /b's own outbound link to /d survives, which is what makes
    // this the interesting case: /b is still a linking page, it is simply no
    // longer a linked-to one.
    //
    //   /b        null   nothing reaches it any more
    //   /d           3   / ─ /a ─ /c ─ /d, the long side of the diamond, which is
    //                    now the only side
    //   /e           4   one further
    //
    // An UPDATE-only derivation would leave /b carrying the 1 it was written on
    // the first pass: a depth for a path the site no longer publishes.
    await db.delete(links).where(eq(links.crawlId, crawlId));
    await addLinks(
      crawlId,
      ids,
      EDGES.filter(([, to]) => to !== "/b"),
    );

    expect(await deriveClickDepth(db, crawlId)).toEqual({
      root: 1,
      rootRedirects: 0,
      reachable: 6,
      unreachable: 4,
      maxDepth: 4,
      capped: 0,
    });
    expect(await depths(crawlId)).toEqual({
      "/": 0,
      "/a": 1,
      "/self": 1,
      "/c": 2,
      "/b": null,
      "/d": 3,
      "/e": 4,
      "/island-1": null,
      "/island-2": null,
      "/sitemap-only": null,
    });
  });

  it("follows an external link nowhere: an off-site target is not a click path", async () => {
    const crawlId = await newCrawl();
    // The off-site host happens to serve a URL that, written as a path, exists
    // on this site too. The join is on `pages.url`, and `is_internal` is what
    // keeps the two apart — without it this would be a link into /island-1.
    const ids = await addPages(crawlId, [{ path: "/", discoveredVia: "seed" }, { path: "/island-1" }]);
    await addLinks(crawlId, ids, [], [["/", url("/island-1")]]);

    const summary = await deriveClickDepth(db, crawlId);
    expect(await depths(crawlId)).toEqual({ "/": 0, "/island-1": null });
    expect(summary.reachable).toBe(1);
    expect(summary.maxDepth).toBe(0);
  });

  it("starts at the home page the seed redirects to, not at the redirect", async () => {
    // The client gave us `https://click-depth.example` and the site answers it
    // with a 301 to `/home`, which is where every link lives. Starting at the
    // redirect row would find no links at all and report the WHOLE SITE as
    // unreachable — the failure this resolution exists to prevent.
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/", redirectTo: "/landing", discoveredVia: "seed" },
      { path: "/landing", redirectTo: "/home" },
      { path: "/home" },
      { path: "/a" },
    ]);
    await addLinks(crawlId, ids, [["/home", "/a"]]);

    const summary = await deriveClickDepth(db, crawlId);
    expect(summary.root).toBe(1);
    expect(summary.rootRedirects).toBe(2);
    // The two redirect rows are null: a redirect is not a page a click lands on,
    // and neither is in the cohort any metric measures.
    expect(await depths(crawlId)).toEqual({
      "/": null,
      "/landing": null,
      "/home": 0,
      "/a": 1,
    });
  });

  it("gives up on a seed that redirects in a circle rather than looping", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/", redirectTo: "/loop", discoveredVia: "seed" },
      { path: "/loop", redirectTo: "/" },
      { path: "/a" },
    ]);
    await addLinks(crawlId, ids, [["/a", "/"]]);

    const summary = await deriveClickDepth(db, crawlId);
    // No entry point could be resolved, so nothing has a depth — and `root: 0`
    // is what says the site is not being called an orphan estate.
    expect(summary.root).toBe(0);
    expect(summary.rootRedirects).toBe(ROOT_REDIRECT_HOPS);
    expect(summary.reachable).toBe(0);
    expect(summary.unreachable).toBe(3);
    expect(summary.maxDepth).toBe(-1);
    expect(await depths(crawlId)).toEqual({ "/": null, "/loop": null, "/a": null });
  });

  it("reports root: 0 when the crawl never fetched its own entry point", async () => {
    const crawlId = await newCrawl();
    // Every page but the home page — a crawl whose seed was refused, or one
    // that died before the first fetch landed.
    const ids = await addPages(crawlId, [{ path: "/a" }, { path: "/b" }]);
    await addLinks(crawlId, ids, [["/a", "/b"]]);

    expect(await deriveClickDepth(db, crawlId)).toEqual({
      root: 0,
      rootRedirects: 0,
      reachable: 0,
      unreachable: 2,
      maxDepth: -1,
      capped: 0,
    });
  });

  it("matches the seed's NORMALISED spelling, the one the frontier used", async () => {
    // The config's site URL as a client might hand it over: no trailing slash,
    // an uppercase host, a fragment and unsorted params. `normalizeUrl` is what
    // the crawler put it through before enqueueing it, so the page row is
    // spelled the way that function returns — and the derivation has to ask the
    // same question or it finds no entry point at all.
    const crawlId = await newCrawl(`${SITE.replace("click-depth", "CLICK-DEPTH")}?b=2&a=1#top`);
    const ids = await addPages(crawlId, [
      { path: "/?a=1&b=2", discoveredVia: "seed" },
      { path: "/a" },
    ]);
    await addLinks(crawlId, ids, [["/?a=1&b=2", "/a"]]);

    const summary = await deriveClickDepth(db, crawlId);
    expect(summary.root).toBe(1);
    expect(await depths(crawlId)).toEqual({ "/?a=1&b=2": 0, "/a": 1 });
  });

  it("stops at the depth cap and says so rather than searching forever", async () => {
    // A chain one rung longer than the cap can assign: the rungs past it are
    // null, which is indistinguishable IN THE COLUMN from a page nothing
    // reaches — so `capped: 1` is the derivation saying which of the two this
    // crawl's nulls might be.
    const crawlId = await newCrawl();
    const chain: PageSpec[] = [{ path: "/", discoveredVia: "seed" }];
    for (let i = 1; i <= MAX_CLICK_DEPTH + 1; i += 1) chain.push({ path: `/r${i}` });
    const ids = await addPages(crawlId, chain);
    const edges: [string, string][] = [["/", "/r1"]];
    for (let i = 1; i <= MAX_CLICK_DEPTH; i += 1) edges.push([`/r${i}`, `/r${i + 1}`]);
    await addLinks(crawlId, ids, edges);

    const summary = await deriveClickDepth(db, crawlId);
    expect(summary.capped).toBe(1);
    expect(summary.maxDepth).toBe(MAX_CLICK_DEPTH);
    expect(summary.reachable).toBe(MAX_CLICK_DEPTH + 1);
    // The last rung is exactly one hop past what the cap permits.
    const written = await depths(crawlId);
    expect(written[`/r${MAX_CLICK_DEPTH}`]).toBe(MAX_CLICK_DEPTH);
    expect(written[`/r${MAX_CLICK_DEPTH + 1}`]).toBeNull();
  });

  it("refuses a crawl id nothing knows, and a site URL no crawl could have used", async () => {
    const missing = `crawl_${randomUUID()}`;
    await expect(deriveClickDepth(db, missing)).rejects.toThrow(/no such crawl/);

    const crawlId = await newCrawl("mailto:someone@example.com", "mailto-row.invalid");
    await expect(deriveClickDepth(db, crawlId)).rejects.toThrow(/could have used as a seed/);
  });
});
