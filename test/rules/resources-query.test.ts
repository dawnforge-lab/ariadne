/**
 * The resource rules, against a real database (P11-T3).
 *
 * Rows are inserted directly — the link-targets pattern — because what is under
 * test is what the rules make of the `resources` and `page_resources` tables the
 * crawl and the fetch pass wrote, not the crawling or the fetching.
 *
 * THE BOUNDARY THIS FILE EXISTS TO PIN, restated because every case below is a
 * corner of it: a resource the pass has not asked about (`fetch_class` null), one
 * our own policy refused, one robots disallowed, and one whose request never
 * completed are ALL UNKNOWN. None of them is broken, none of them is oversized,
 * and none of them may be counted as clean (hard rules 1 and 7). Each rule
 * excludes them from its verdict and says in its evidence how many there were.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages, resources } from "../../src/db/schema.js";
import {
  RESOURCE_CAP_REASON,
  RESOURCE_OFF_REASON,
} from "../../src/crawl/resources/fetch-resources.js";
import { DEFAULT_RULE_CAPS } from "../../src/rules/query/crawl-evidence.js";
import {
  BROKEN_SAMPLE_RESOURCES,
  IMAGE_WEIGHT_WARN,
  NOT_FETCHED_REASON,
  OVERSIZED_SAMPLE_PAGES,
  resourceRules,
  UNCACHED_SAMPLE_RESOURCES,
} from "../../src/rules/query/resources.js";
import type { Finding, QueryRule, RuleCaps } from "../../src/rules/registry/types.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://resources.example";

const byId = new Map(resourceRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in resourceRules`);
  return r;
}

/** `caps` with one field overridden, so a case can force the listing cap. */
function caps(listing: number | null): RuleCaps {
  return { ...DEFAULT_RULE_CAPS, listing };
}

describe("resourceRules metadata", () => {
  it("defines the five Phase 11 rules and the P12-T2 / P13-T2 / P14-T1 markers", () => {
    expect(resourceRules.map((r) => r.id).sort()).toEqual([
      "images.legacy-format",
      "images.oversized",
      "resources.all-unknown",
      "resources.bad-content-type",
      "resources.broken",
      "resources.not-fetched",
      "resources.not-recorded",
      "resources.partial-unknown",
      "resources.uncached",
    ]);
  });

  it("claims the checklist ids, severities and categories the task assigns", () => {
    expect(
      Object.fromEntries(resourceRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      // A resource that answered 4xx or 5xx is a failed network request, which
      // is what CHECK-51 asks for by name. See the module header for why the
      // plan's proposed CHECK-48/CHECK-49 split was not the honest filing.
      "resources.broken": [["CHECK-51"], "warning", "technical"],
      // Broken and wrong-typed files are one check (26a).
      "resources.bad-content-type": [["CHECK-51"], "info", "technical"],
      "images.oversized": [["CHECK-49"], "warning", "technical"],
      "images.legacy-format": [["CHECK-49"], "info", "technical"],
      "resources.uncached": [["CHECK-50"], "info", "technical"],
      // The marker claims every check whose silence it explains.
      "resources.not-recorded": [
        ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51", "CHECK-85"],
        "info",
        "technical",
      ],
      // Its sibling claims the same four, for the same reason: the silence it
      // explains is the same silence.
      "resources.not-fetched": [
        ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51"],
        "info",
        "technical",
      ],
      // The third and last marker (P13-T2). Same four checks, same reason: on a
      // crawl whose every row landed in an unknown class the same four judging
      // rules go quiet and `page.weight` counts HTML alone.
      "resources.all-unknown": [
        ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51"],
        "info",
        "technical",
      ],
      // The fourth and last marker (P14-T1). Same four checks, same reason: on a
      // partial pass whose decided rows are all unknown and the rest unasked —
      // no ok, no broken — the same four judging rules go quiet and `page.weight`
      // counts HTML alone.
      "resources.partial-unknown": [
        ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51"],
        "info",
        "technical",
      ],
    });
  });

  it("every rule is a query rule carrying copy and a ruleset version", () => {
    for (const r of resourceRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("the image threshold is the checklist's own 100KB line", () => {
    expect(IMAGE_WEIGHT_WARN).toBe(100_000);
  });
});

describe("resourceRules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec {
    path: string;
    imagesTotal?: number;
    htmlBytes?: number;
  }

  interface ResourceSpec {
    /** Absolute, or a site-relative path this helper resolves. */
    url: string;
    kind?: string;
    fetchClass?: string | null;
    fetchReason?: string | null;
    statusCode?: number | null;
    contentType?: string | null;
    bytes?: number | null;
    bytesSource?: string | null;
    cacheControl?: string | null;
    expires?: string | null;
    /** Paths of the pages that reference it. */
    on: string[];
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ id, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    createdCrawls.push(id);
    return id;
  }

  function abs(url: string): string {
    return url.startsWith("http") ? url : `${SITE}${url}`;
  }

  /**
   * A crawl with pages, resources and the edges between them — the three
   * tables every rule in this file reads, written the way the crawl writes
   * them (one resource row per URL, one edge per referencing page).
   */
  async function seed(
    pageSpecs: PageSpec[],
    resourceSpecs: ResourceSpec[],
  ): Promise<{ crawlId: string; pageIds: Map<string, string> }> {
    const crawlId = await newCrawl();
    const pageRows = pageSpecs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`,
      pageType: "content",
      fetchClass: "ok",
      statusCode: 200,
      isIndexable: true,
      depth: 1,
      discoveredVia: "link",
      imagesTotal: s.imagesTotal ?? 0,
      htmlBytes: s.htmlBytes ?? 20_000,
    }));
    if (pageRows.length > 0) await db.insert(pages).values(pageRows);
    const pageIds = new Map(pageSpecs.map((s, i) => [s.path, pageRows[i]!.id]));

    if (resourceSpecs.length > 0) {
      await db.insert(resources).values(
        resourceSpecs.map((s) => ({
          crawlId,
          url: abs(s.url),
          kind: s.kind ?? "image",
          fetchClass: s.fetchClass === undefined ? "ok" : s.fetchClass,
          fetchReason: s.fetchReason ?? null,
          statusCode: s.statusCode === undefined ? 200 : s.statusCode,
          contentType: s.contentType === undefined ? "image/svg+xml" : s.contentType,
          bytes: s.bytes === undefined ? 1_000 : s.bytes,
          bytesSource: s.bytesSource === undefined ? "header" : s.bytesSource,
          cacheControl: s.cacheControl === undefined ? "public, max-age=3600" : s.cacheControl,
          expires: s.expires ?? null,
        })),
      );
      const edges = resourceSpecs.flatMap((s) =>
        s.on.map((path) => ({
          crawlId,
          pageId: pageIds.get(path) ?? `page_missing_${randomUUID()}`,
          resourceUrl: abs(s.url),
        })),
      );
      if (edges.length > 0) await db.insert(pageResources).values(edges);
    }
    return { crawlId, pageIds };
  }

  async function run(id: string, crawlId: string, c?: RuleCaps): Promise<Finding[]> {
    return rule(id).run(db, crawlId, c);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("resources.broken", () => {
    it("reports the page, counts its broken references and samples them", async () => {
      const { crawlId, pageIds } = await seed(
        [{ path: "/a" }, { path: "/b" }],
        [
          {
            url: "/img/gone.png",
            fetchClass: "client_error",
            statusCode: 404,
            fetchReason: null,
            contentType: "text/html",
            bytes: null,
            bytesSource: null,
            on: ["/a"],
          },
          {
            url: "/js/broken.js",
            kind: "js",
            fetchClass: "server_error",
            statusCode: 503,
            bytes: null,
            bytesSource: null,
            on: ["/a"],
          },
          { url: "/img/fine.svg", on: ["/a", "/b"] },
        ],
      );

      const findings = await run("resources.broken", crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBe(pageIds.get("/a"));
      expect(f.pageUrl).toBe(`${SITE}/a`);
      expect(f.dedupeKey).toBe(`${SITE}/a`);
      expect(f.evidence.brokenCount).toBe(2);
      expect(f.evidence.unknownResources).toBe(0);
      expect(f.evidence.resources).toEqual([
        {
          url: `${SITE}/img/gone.png`,
          kind: "image",
          statusCode: 404,
          fetchClass: "client_error",
          fetchReason: null,
        },
        {
          url: `${SITE}/js/broken.js`,
          kind: "js",
          statusCode: 503,
          fetchClass: "server_error",
          fetchReason: null,
        },
      ]);
    });

    it("carries the fetch reason, so a refused 200 never reads as 'broken (HTTP 200)'", async () => {
      // The cf-mitigated shape (P11-T2): the server answered 200 and refused
      // the file all the same. Without the reason beside the status the copy
      // would print an absurdity.
      const reason = "refused by the server (HTTP 200)";
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          {
            url: "/js/challenged.js",
            kind: "js",
            fetchClass: "client_error",
            statusCode: 200,
            fetchReason: reason,
            bytes: null,
            bytesSource: null,
            on: ["/a"],
          },
        ],
      );
      const [f] = await run("resources.broken", crawlId);
      expect(f!.evidence.resources).toEqual([
        {
          url: `${SITE}/js/challenged.js`,
          kind: "js",
          statusCode: 200,
          fetchClass: "client_error",
          fetchReason: reason,
        },
      ]);
    });

    it("never calls an unasked, refused, disallowed or failed resource broken", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          // Seen and not yet asked — the null-vs-zero doctrine's newest citizen.
          {
            url: "/img/unfetched.png",
            fetchClass: null,
            statusCode: null,
            contentType: null,
            bytes: null,
            bytesSource: null,
            cacheControl: null,
            on: ["/a"],
          },
          {
            url: "/img/refused.png",
            fetchClass: "refused",
            fetchReason: "url-policy: reserved address",
            statusCode: null,
            bytes: null,
            bytesSource: null,
            cacheControl: null,
            on: ["/a"],
          },
          {
            url: "https://cdn.example/blocked.png",
            fetchClass: "robots_denied",
            fetchReason: "disallowed by robots.txt",
            statusCode: null,
            bytes: null,
            bytesSource: null,
            cacheControl: null,
            on: ["/a"],
          },
          {
            // P12-T1's class. A host that could not tell us its rules is a
            // complete disallow, so we never asked about this file either — and
            // calling it broken would report a third party's outage as the
            // client's broken site.
            url: "https://cdn.example/host-down.png",
            fetchClass: "robots_unreachable",
            fetchReason: "robots.txt unreachable (503): complete disallow",
            statusCode: null,
            bytes: null,
            bytesSource: null,
            cacheControl: null,
            on: ["/a"],
          },
          {
            url: "/img/timeout.png",
            fetchClass: "fetch_error",
            fetchReason: "timeout after 15000ms",
            statusCode: null,
            bytes: null,
            bytesSource: null,
            cacheControl: null,
            on: ["/a"],
          },
        ],
      );
      expect(await run("resources.broken", crawlId)).toEqual([]);
    });

    it("counts the unknowns beside the broken ones on a page that has both", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          {
            url: "/img/gone.png",
            fetchClass: "client_error",
            statusCode: 404,
            bytes: null,
            bytesSource: null,
            on: ["/a"],
          },
          { url: "/img/unfetched.png", fetchClass: null, statusCode: null, bytes: null, on: ["/a"] },
          {
            url: "/img/denied.png",
            fetchClass: "robots_denied",
            statusCode: null,
            bytes: null,
            on: ["/a"],
          },
          {
            url: "https://cdn.example/down.png",
            fetchClass: "robots_unreachable",
            statusCode: null,
            bytes: null,
            on: ["/a"],
          },
        ],
      );
      const [f] = await run("resources.broken", crawlId);
      expect(f!.evidence.brokenCount).toBe(1);
      // Three unknowns now, and the new class is one of them: a page with one
      // broken file and three we could not weigh is not a page with one problem.
      expect(f!.evidence.unknownResources).toBe(3);
    });

    it("caps the listing, counts every page exactly and says so on the last one", async () => {
      const paths = ["/p1", "/p2", "/p3"];
      const { crawlId } = await seed(
        paths.map((path) => ({ path })),
        paths.map((path) => ({
          url: `/img/gone${path}.png`,
          fetchClass: "client_error",
          statusCode: 404,
          bytes: null,
          on: [path],
        })),
      );
      const findings = await run("resources.broken", crawlId, caps(2));
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.pageUrl)).toEqual([`${SITE}/p1`, `${SITE}/p2`]);
      expect(findings[1]!.evidence.truncated).toEqual({ reported: 2, total: 3 });
      expect((await run("resources.broken", crawlId))[2]!.evidence.truncated).toBeUndefined();
    });

    it("samples at most BROKEN_SAMPLE_RESOURCES resources while counting them all", async () => {
      const n = BROKEN_SAMPLE_RESOURCES + 3;
      const { crawlId } = await seed(
        [{ path: "/a" }],
        Array.from({ length: n }, (_, i) => ({
          // Zero-padded so the URL order the sample is taken in is the order a
          // reader would expect.
          url: `/img/gone-${String(i).padStart(3, "0")}.png`,
          fetchClass: "client_error",
          statusCode: 404,
          bytes: null,
          on: ["/a"],
        })),
      );
      const [f] = await run("resources.broken", crawlId);
      expect(f!.evidence.brokenCount).toBe(n);
      expect(f!.evidence.resources).toHaveLength(BROKEN_SAMPLE_RESOURCES);
    });
  });

  describe("resources.bad-content-type", () => {
    it("fires on a stylesheet served as text/html, with the pages that carry it", async () => {
      const { crawlId, pageIds } = await seed(
        [{ path: "/a" }, { path: "/b" }],
        [
          {
            url: "/css/site.css",
            kind: "css",
            contentType: "text/html; charset=utf-8",
            on: ["/b", "/a"],
          },
        ],
      );
      const found = await run("resources.bad-content-type", crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: "resources.bad-content-type",
        severity: "info",
        pageId: pageIds.get("/a"),
        pageUrl: `${SITE}/a`,
        dedupeKey: `${SITE}/css/site.css`,
        evidence: {
          resourceUrl: `${SITE}/css/site.css`,
          kind: "css",
          contentType: "text/html; charset=utf-8",
          pageCount: 2,
          samplePages: [`${SITE}/a`, `${SITE}/b`],
        },
      });
    });

    it("does not fire on correctly typed files, whatever the parameters or case", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/css/a.css", kind: "css", contentType: "Text/CSS; charset=utf-8", on: ["/a"] },
          {
            url: "/js/a.js",
            kind: "js",
            contentType: "application/javascript; charset=utf-8",
            on: ["/a"],
          },
          { url: "/js/b.js", kind: "js", contentType: "text/javascript", on: ["/a"] },
          // Legacy spellings the Fetch standard still treats as JavaScript.
          { url: "/js/c.js", kind: "js", contentType: "text/x-javascript", on: ["/a"] },
          { url: "/js/d.js", kind: "js", contentType: "application/x-ecmascript", on: ["/a"] },
          { url: "/img/a.png", kind: "image", contentType: "image/png", on: ["/a"] },
        ],
      );
      expect(await run("resources.bad-content-type", crawlId)).toEqual([]);
    });

    it("fires on a script that is not JavaScript and an image that is not an image", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/js/a.js", kind: "js", contentType: "text/plain", on: ["/a"] },
          { url: "/img/a.png", kind: "image", contentType: "text/html", on: ["/a"] },
        ],
      );
      const found = await run("resources.bad-content-type", crawlId);
      expect(found.map((f) => f.evidence.kind)).toEqual(["image", "js"]);
    });

    it("never fires on a 404 stylesheet: that is resources.broken's job", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          {
            url: "/css/gone.css",
            kind: "css",
            fetchClass: "client_error",
            statusCode: 404,
            contentType: "text/html",
            on: ["/a"],
          },
        ],
      );
      expect(await run("resources.bad-content-type", crawlId)).toEqual([]);
      expect(await run("resources.broken", crawlId)).toHaveLength(1);
    });

    it("does not judge a file with no recorded type, or one never asked about", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/css/none.css", kind: "css", contentType: null, on: ["/a"] },
          {
            url: "/css/unasked.css",
            kind: "css",
            fetchClass: null,
            statusCode: null,
            contentType: null,
            on: ["/a"],
          },
        ],
      );
      expect(await run("resources.bad-content-type", crawlId)).toEqual([]);
    });

    it("samples at most the broken-resource limit of referencing pages, and counts them all", async () => {
      const paths = Array.from({ length: BROKEN_SAMPLE_RESOURCES + 2 }, (_, i) => `/p${String(i).padStart(2, "0")}`);
      const { crawlId } = await seed(
        paths.map((path) => ({ path })),
        [{ url: "/css/x.css", kind: "css", contentType: "text/html", on: paths }],
      );
      const [only] = await run("resources.bad-content-type", crawlId);
      expect(only!.evidence.pageCount).toBe(paths.length);
      expect(only!.evidence.samplePages).toEqual(
        paths.slice(0, BROKEN_SAMPLE_RESOURCES).map((p) => `${SITE}${p}`),
      );
    });

    it("reports the count past the listing cap", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        ["/css/1.css", "/css/2.css", "/css/3.css"].map((url) => ({
          url,
          kind: "css",
          contentType: "text/html",
          on: ["/a"],
        })),
      );
      const found = await run("resources.bad-content-type", crawlId, caps(2));
      expect(found).toHaveLength(2);
      expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    });
  });

  describe("images.oversized", () => {
    it("reports the file, its weight and how many pages carry it", async () => {
      const { crawlId, pageIds } = await seed(
        [{ path: "/a" }, { path: "/b" }],
        [
          {
            url: "/img/hero.png",
            contentType: "image/png",
            bytes: 250_000,
            bytesSource: "header",
            on: ["/b", "/a"],
          },
          { url: "/img/small.png", contentType: "image/png", bytes: 4_000, on: ["/a"] },
        ],
      );
      const findings = await run("images.oversized", crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      // The finding hangs on the first page that carries the file, so a client
      // reading `issue_urls` gets a page to look at; the file is the identity.
      expect(f.pageId).toBe(pageIds.get("/a"));
      expect(f.pageUrl).toBe(`${SITE}/a`);
      expect(f.dedupeKey).toBe(`${SITE}/img/hero.png`);
      expect(f.evidence).toMatchObject({
        resourceUrl: `${SITE}/img/hero.png`,
        bytes: 250_000,
        bytesSource: "header",
        contentType: "image/png",
        threshold: IMAGE_WEIGHT_WARN,
        referencingPages: 2,
        samplePages: [`${SITE}/a`, `${SITE}/b`],
      });
    });

    it("fires strictly above the threshold and never on the threshold itself", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/img/at.png", contentType: "image/png", bytes: IMAGE_WEIGHT_WARN, on: ["/a"] },
          {
            url: "/img/over.png",
            contentType: "image/png",
            bytes: IMAGE_WEIGHT_WARN + 1,
            on: ["/a"],
          },
        ],
      );
      const findings = await run("images.oversized", crawlId);
      expect(findings.map((f) => f.evidence.resourceUrl)).toEqual([`${SITE}/img/over.png`]);
    });

    it("judges only images the pass actually weighed", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          // A stylesheet and a script are heavy for other reasons; this rule is
          // about images and says so.
          { url: "/css/app.css", kind: "css", contentType: "text/css", bytes: 400_000, on: ["/a"] },
          {
            url: "/js/app.js",
            kind: "js",
            contentType: "application/javascript",
            bytes: 900_000,
            on: ["/a"],
          },
          // Unknown weight: never asked, and a resource nobody weighed is not
          // an oversized one.
          {
            url: "/img/unfetched.png",
            fetchClass: null,
            statusCode: null,
            bytes: null,
            bytesSource: null,
            on: ["/a"],
          },
          // A 404 has no weight to report — `resources.broken`'s subject.
          {
            url: "/img/gone.png",
            fetchClass: "client_error",
            statusCode: 404,
            bytes: null,
            on: ["/a"],
          },
        ],
      );
      expect(await run("images.oversized", crawlId)).toEqual([]);
    });

    it("does not weigh a file the server refused, even if a byte count is stored", async () => {
      // The fetch pass writes no `bytes` on a non-`ok` row (P11-T2 decision 5),
      // so this row shape does not occur today — and the rule does not depend on
      // that discipline holding. `fetch_class = 'ok'` is a condition of its own
      // beside `bytes is not null`, because the day a writer starts recording
      // the size of a 404's error page is the day every error page becomes an
      // oversized image finding.
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          {
            url: "/img/gone.png",
            fetchClass: "client_error",
            statusCode: 404,
            contentType: "image/png",
            bytes: 300_000,
            bytesSource: "header",
            on: ["/a"],
          },
        ],
      );
      expect(await run("images.oversized", crawlId)).toEqual([]);
      expect(await run("images.legacy-format", crawlId)).toEqual([]);
    });

    it("lists the heaviest first, caps the listing and keeps the count exact", async () => {
      const sizes = [500_000, 300_000, 200_000];
      const { crawlId } = await seed(
        [{ path: "/a" }],
        sizes.map((bytes, i) => ({
          url: `/img/heavy-${i}.png`,
          contentType: "image/png",
          bytes,
          on: ["/a"],
        })),
      );
      const findings = await run("images.oversized", crawlId, caps(2));
      expect(findings.map((f) => f.evidence.bytes)).toEqual([500_000, 300_000]);
      expect(findings[1]!.evidence.truncated).toEqual({ reported: 2, total: 3 });
    });

    it("samples the referencing pages while counting all of them", async () => {
      const n = OVERSIZED_SAMPLE_PAGES + 4;
      const paths = Array.from({ length: n }, (_, i) => `/p${String(i).padStart(3, "0")}`);
      const { crawlId } = await seed(
        paths.map((path) => ({ path })),
        [{ url: "/img/hero.png", contentType: "image/png", bytes: 300_000, on: paths }],
      );
      const [f] = await run("images.oversized", crawlId);
      expect(f!.evidence.referencingPages).toBe(n);
      expect(f!.evidence.samplePages).toHaveLength(OVERSIZED_SAMPLE_PAGES);
    });
  });

  describe("images.legacy-format", () => {
    it("names a heavy PNG or JPEG and nothing a modern format was already used for", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/img/a.png", contentType: "image/png", bytes: 300_000, on: ["/a"] },
          {
            url: "/img/b.jpg",
            contentType: "image/jpeg; charset=binary",
            bytes: 300_000,
            on: ["/a"],
          },
          { url: "/img/c.webp", contentType: "image/webp", bytes: 300_000, on: ["/a"] },
          { url: "/img/d.avif", contentType: "image/avif", bytes: 300_000, on: ["/a"] },
          { url: "/img/e.svg", contentType: "image/svg+xml", bytes: 300_000, on: ["/a"] },
          // Under the threshold: a format is a choice, and a small PNG costs
          // nobody anything.
          { url: "/img/f.png", contentType: "image/png", bytes: 9_000, on: ["/a"] },
        ],
      );
      const findings = await run("images.legacy-format", crawlId);
      expect(findings.map((f) => f.evidence.resourceUrl).sort()).toEqual([
        `${SITE}/img/a.png`,
        `${SITE}/img/b.jpg`,
      ]);
      expect(findings.every((f) => f.severity === "info")).toBe(true);
    });

    it("says nothing about an image whose type the pass never learned", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          {
            url: "/img/unfetched.png",
            fetchClass: null,
            statusCode: null,
            contentType: null,
            bytes: null,
            on: ["/a"],
          },
        ],
      );
      expect(await run("images.legacy-format", crawlId)).toEqual([]);
    });
  });

  describe("resources.uncached", () => {
    it("counts the fetched files that carried no caching header, once, for the site", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [
          { url: "/img/cached.svg", cacheControl: "public, max-age=3600", on: ["/a"] },
          { url: "/img/expires.svg", cacheControl: null, expires: "Wed, 21 Oct 2026 07:28:00 GMT", on: ["/a"] },
          { url: "/img/naked-a.svg", cacheControl: null, on: ["/a"] },
          // A header the server sent empty declares nothing (the `present`
          // doctrine): blank is absent, everywhere in the rule layer.
          { url: "/img/naked-b.svg", cacheControl: "   ", on: ["/a"] },
          // Never asked: not counted as uncached, counted as unknown.
          {
            url: "/img/unfetched.svg",
            fetchClass: null,
            statusCode: null,
            bytes: null,
            cacheControl: null,
            on: ["/a"],
          },
        ],
      );
      const findings = await run("resources.uncached", crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBeNull();
      expect(f.pageUrl).toBeNull();
      expect(f.dedupeKey).toBe("site");
      expect(f.evidence).toMatchObject({
        uncachedResources: 2,
        fetchedResources: 4,
        unknownResources: 1,
        sampleResources: [`${SITE}/img/naked-a.svg`, `${SITE}/img/naked-b.svg`],
      });
    });

    it("is silent when every fetched resource carries a header", async () => {
      const { crawlId } = await seed(
        [{ path: "/a" }],
        [{ url: "/img/cached.svg", cacheControl: "public, max-age=3600", on: ["/a"] }],
      );
      expect(await run("resources.uncached", crawlId)).toEqual([]);
    });

    it("samples at most UNCACHED_SAMPLE_RESOURCES URLs while counting them all", async () => {
      const n = UNCACHED_SAMPLE_RESOURCES + 5;
      const { crawlId } = await seed(
        [{ path: "/a" }],
        Array.from({ length: n }, (_, i) => ({
          url: `/img/naked-${String(i).padStart(3, "0")}.svg`,
          cacheControl: null,
          on: ["/a"],
        })),
      );
      const [f] = await run("resources.uncached", crawlId);
      expect(f!.evidence.uncachedResources).toBe(n);
      expect(f!.evidence.sampleResources).toHaveLength(UNCACHED_SAMPLE_RESOURCES);
    });
  });

  describe("resources.not-recorded", () => {
    it("reports a crawl that read images and stored no resource at all", async () => {
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 3 }, { path: "/b" }], []);
      const findings = await run("resources.not-recorded", crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBeNull();
      expect(f.severity).toBe("info");
      expect(f.dedupeKey).toBe("site");
      expect(f.evidence).toMatchObject({
        resourcesSeen: 0,
        pagesWithImages: 1,
        pagesCrawled: 2,
      });
    });

    it("is silent as soon as one resource row exists", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [{ url: "/img/a.svg", on: ["/a"] }],
      );
      expect(await run("resources.not-recorded", crawlId)).toEqual([]);
    });

    // THE OFF-SWITCH BOUNDARY (P11-T4), asserted so it is a decision rather
    // than a discovery. A crawl started with `fetchResources: false` records
    // every reference and asks about none of them, so the rows exist, THIS
    // marker's condition (`resourcesSeen == 0`) is false, and it stays silent —
    // while the four judging rules are silent too, because every row is
    // unfetched and an unfetched resource is unknown rather than fine.
    //
    // **THE WINDOW THIS TEST PINNED IS CLOSED (P12-T2).** What it used to pin
    // was four quiet rules and NO marker at all, safe only because the fact
    // lived one surface over — `fetch_reason: 'resource-fetch-off'` on the
    // rows, `crawl_status` echoing `fetchResources: false` beside
    // `resources.skipped == seen`, and CHECK-83 answered before any check these
    // rules claim. The gate doc (phase-11.md §10.3) ruled that a reader should
    // not have to change surfaces to learn it, and that widening THIS marker
    // would be a verdict change: the answer is a SIBLING, and it is
    // `resources.not-fetched`. So the silence below is now only this rule's,
    // and the crawl does get a marker — asserted here rather than only in the
    // sibling's own describe, because "which of the two speaks" is the boundary.
    it("stays silent when the operator turned the pass off — its sibling speaks", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [{ url: "/img/a.png", on: ["/a"], fetchClass: null, fetchReason: RESOURCE_OFF_REASON }],
      );
      expect(await run("resources.not-recorded", crawlId)).toEqual([]);
      // And the judging rules say nothing about a file nobody asked about.
      for (const id of [
        "resources.broken",
        "images.oversized",
        "images.legacy-format",
        "resources.uncached",
      ]) {
        expect(await run(id, crawlId), id).toEqual([]);
      }
      // The window: one marker, and it is the one whose fact this crawl is.
      const sibling = await run("resources.not-fetched", crawlId);
      expect(sibling).toHaveLength(1);
      expect(sibling[0]!.evidence.reason).toBe(NOT_FETCHED_REASON.off);
    });

    it("is silent on a crawl whose pages genuinely reference nothing", async () => {
      // No resource rows AND no page that counted an image: nothing is missing,
      // so there is nothing to mark. The marker reports a gap in the EVIDENCE,
      // never a site that ships no assets.
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 0 }], []);
      expect(await run("resources.not-recorded", crawlId)).toEqual([]);
    });
  });

  /**
   * THE SIBLING MARKER (P12-T2): the crawl saw the files and asked about none.
   *
   * Every case here seeds rows whose `fetch_class` is null, because that is the
   * whole population this rule speaks about — a row with a class is a row
   * somebody decided something about, and one of those anywhere in the crawl is
   * enough to make this a PARTIAL pass, which the judging rules report with
   * their unknown counts and this marker deliberately leaves alone.
   */
  describe("resources.not-fetched", () => {
    const ID = "resources.not-fetched";

    /** A row the pass never asked about: no class, no status, no headers. */
    function unasked(url: string, on: string[], fetchReason: string | null): ResourceSpec {
      return {
        url,
        on,
        fetchClass: null,
        fetchReason,
        statusCode: null,
        contentType: null,
        bytes: null,
        bytesSource: null,
        cacheControl: null,
      };
    }

    it("reports the operator's off switch, with the reason and the two counts", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }, { path: "/b" }],
        [
          unasked("/img/a.png", ["/a"], RESOURCE_OFF_REASON),
          unasked("/css/site.css", ["/a", "/b"], RESOURCE_OFF_REASON),
        ],
      );
      const findings = await run(ID, crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBeNull();
      expect(f.pageUrl).toBeNull();
      expect(f.severity).toBe("info");
      expect(f.dedupeKey).toBe("site");
      expect(f.evidence).toMatchObject({
        reason: NOT_FETCHED_REASON.off,
        // Seen and skipped are EQUAL, and that equality is the finding: the
        // census is real and nothing in it was asked about.
        resourcesSeen: 2,
        resourcesSkipped: 2,
        pagesCrawled: 2,
      });
      // The sentence a client reads has to name the switch, not just the count.
      expect(String(f.evidence.notAsked)).toContain("fetchResources");
    });

    it("reports a pass that never asked at all as the other reason", async () => {
      // No reason on the rows: nothing decided anything about them. A crawl
      // interrupted before the pass sent its first request, or one whose pass
      // never ran, on a database that has migration 0013's tables.
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 1 }],
        [unasked("/img/a.png", ["/a"], null), unasked("/js/app.js", ["/a"], null)],
      );
      const findings = await run(ID, crawlId);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.evidence).toMatchObject({
        reason: NOT_FETCHED_REASON.notRun,
        resourcesSeen: 2,
        resourcesSkipped: 2,
      });
      expect(String(findings[0]!.evidence.notAsked)).toMatch(/interrupted|never ran/i);
    });

    it("is silent as soon as one row was decided, however many were not", async () => {
      // A PARTIAL pass. One file was asked about; the rest were not. The
      // judging rules answer such a crawl with their `unknownResources` counts
      // beside their verdicts, so the reader is not left reading a silence —
      // and a marker here would be reporting "nothing was measured" over a
      // measurement.
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          { url: "/img/asked.svg", on: ["/a"] },
          unasked("/img/b.png", ["/a"], null),
          unasked("/img/c.png", ["/a"], RESOURCE_OFF_REASON),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a normal completed pass", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 1 }],
        [{ url: "/img/a.svg", on: ["/a"] }],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a crawl that recorded no resources at all", async () => {
      // Not this rule's fact. `resources.not-recorded` owns it, and the
      // exclusivity below is what proves the two cannot both speak.
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 2 }], []);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    // THE THIRD REASON (review C-1). A census where every row carries
    // `resource-cap` and nothing was decided says a BUDGET claimed the rows
    // before anything was asked. The pass no longer produces that shape — the
    // budget is claimed per slice and at least one row of the slice is asked
    // about unless the caller aborts, in which case the rows keep both nulls
    // (asserted in test/crawl/fetch-resources.test.ts) — but the rule reads a
    // TABLE, not a pass, and a marker that met the shape and threw would be the
    // silence this whole rule exists to end. It is recognised rather than
    // guessed at: the reason is on every row and it is the pass's own constant.
    it("recognises a budget that claimed every row before anything was asked", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          unasked("/img/a.png", ["/a"], RESOURCE_CAP_REASON),
          unasked("/img/b.png", ["/a"], RESOURCE_CAP_REASON),
        ],
      );
      const findings = await run(ID, crawlId);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.evidence).toMatchObject({
        reason: NOT_FETCHED_REASON.cap,
        resourcesSeen: 2,
        resourcesSkipped: 2,
      });
      expect(String(findings[0]!.evidence.notAsked)).toMatch(/budget|maxResources/i);
    });

    it("refuses to guess when the unfetched rows are a mixture", async () => {
      // Three reasons in one census, none of them true of the crawl as a whole.
      // No writer of ours produces it — `markResourcesNotAsked` stamps EVERY
      // undecided row, the cap statement stamps every undecided row, and an
      // abort stamps none — so the honest answer is a loud error naming the
      // counts rather than a reason picked out of three (hard rule 7).
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          unasked("/img/a.png", ["/a"], RESOURCE_OFF_REASON),
          unasked("/img/b.png", ["/a"], null),
          unasked("/img/c.png", ["/a"], RESOURCE_CAP_REASON),
        ],
      );
      await expect(run(ID, crawlId)).rejects.toThrow(/mixture of reasons/i);
    });
  });

  /**
   * THE LAST MARKER (P13-T2): the crawl asked (or tried) and every row landed
   * in an unknown class.
   *
   * Every case here seeds rows whose `fetch_class` is one of the four unknowns
   * a SERVER-OR-DECISION produced — `refused`, `robots_denied`,
   * `robots_unreachable`, `fetch_error` — and NONE null and NONE `ok`. A null
   * row is the not-fetched marker's population (seen, not asked); an `ok` row is
   * a measurement the judging rules speak to; a broken row (`client_error` /
   * `server_error`) is a finding `resources.broken` writes. So this marker fires
   * only when the crawl DID reach a verdict on every file and not one verdict
   * was usable — the exact silence phase-12.md §10.1 stated and left open.
   */
  describe("resources.all-unknown", () => {
    const ID = "resources.all-unknown";

    /** A decided-unknown row: a class, no bytes, no headers, the reason beside. */
    function unknown(url: string, on: string[], fetchClass: string, fetchReason: string): ResourceSpec {
      return {
        url,
        on,
        fetchClass,
        fetchReason,
        statusCode: null,
        contentType: null,
        bytes: null,
        bytesSource: null,
        cacheControl: null,
      };
    }

    it("reports a crawl whose every file was refused, blocked or unreachable, with the census and the dominant class", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }, { path: "/b" }],
        [
          unknown("https://cdn.example/1.png", ["/a"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("https://cdn.example/2.png", ["/a", "/b"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("https://cdn.example/3.css", ["/b"], "robots_denied", "disallowed by robots.txt"),
          unknown("/img/4.png", ["/a"], "refused", "url-policy: reserved address"),
          unknown("/js/5.js", ["/a"], "fetch_error", "timeout after 15000ms"),
        ],
      );
      const findings = await run(ID, crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBeNull();
      expect(f.pageUrl).toBeNull();
      expect(f.severity).toBe("info");
      expect(f.dedupeKey).toBe("site");
      expect(f.evidence).toMatchObject({
        resourcesSeen: 5,
        // The per-class census, every class named even at zero, and the largest
        // group called out so a reader knows which sentence to read first.
        census: {
          refused: 1,
          robots_denied: 1,
          robots_unreachable: 2,
          fetch_error: 1,
        },
        dominantClass: "robots_unreachable",
        pagesCrawled: 2,
      });
    });

    it("is silent as soon as one file came back ok — that is partial coverage the judging rules carry", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          { url: "/img/ok.svg", on: ["/a"] },
          unknown("/img/refused.png", ["/a"], "refused", "url-policy: reserved address"),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent when a file answered 4xx/5xx — resources.broken speaks, so the silence is not all-unknown", async () => {
      // A broken row is a decided verdict a judging rule reports; the marker's
      // whole premise is that NO rule found anything. So a crawl with a broken
      // row is not the silent window, and the marker stays quiet while
      // resources.broken fires.
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          { url: "/img/gone.png", on: ["/a"], fetchClass: "client_error", statusCode: 404, bytes: null, cacheControl: null },
          unknown("/img/refused.png", ["/a"], "refused", "url-policy: reserved address"),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
      expect(await run("resources.broken", crawlId)).toHaveLength(1);
    });

    it("is silent when a single row is still unasked — that crawl is not-fetched's, not this one's", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          unknown("/img/refused.png", ["/a"], "refused", "url-policy: reserved address"),
          { url: "/img/pending.png", on: ["/a"], fetchClass: null, fetchReason: null, statusCode: null, bytes: null, cacheControl: null },
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a crawl that recorded no resources at all", async () => {
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 2 }], []);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a normal completed pass", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 1 }],
        [{ url: "/img/a.svg", on: ["/a"] }],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("names every judging rule silent on its own crawl, and is the one that speaks", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          unknown("https://cdn.example/1.png", ["/a"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("/img/2.png", ["/a"], "fetch_error", "connection reset"),
        ],
      );
      for (const id of [
        "resources.broken",
        "images.oversized",
        "images.legacy-format",
        "resources.uncached",
        "resources.not-recorded",
        "resources.not-fetched",
      ]) {
        expect(await run(id, crawlId), id).toEqual([]);
      }
      expect(await run(ID, crawlId)).toHaveLength(1);
    });
  });

  /**
   * THE FOURTH AND LAST MARKER (P14-T1): a PARTIAL pass whose decided rows are
   * all unknown and the rest still unasked.
   *
   * The window phase-13.md §8 pointer 1 named, one layer in from the §10.1 one
   * its sibling closed. A crawl whose rows are a MIX of `null` (never asked) and
   * decided-unknown classes — `refused`, `robots_denied`, `robots_unreachable`,
   * `fetch_error` — with NO `ok` row and NO broken (4xx/5xx) row fires none of
   * the three markers: `not-recorded` needs `seen == 0`, `not-fetched` needs
   * EVERY row null, `all-unknown` needs EVERY row a decided unknown, and the
   * judging rules' `unknownResources` buckets need an `ok` row to ride on and
   * there is none. Six rules go quiet with nothing to explain the silence — the
   * exact rule-1 shape. This marker is the fourth sibling that closes it.
   *
   * Every case here seeds a genuine MIX: at least one null row and at least one
   * decided-unknown row, and never an `ok` and never a broken row. One `ok` row
   * hands the crawl back to the judging rules (partial coverage they carry with
   * `unknownResources`); one broken row hands it to `resources.broken`; all-null
   * is not-fetched's; all-decided-unknown is all-unknown's.
   */
  describe("resources.partial-unknown", () => {
    const ID = "resources.partial-unknown";

    /** A decided-unknown row: a class, no bytes, no headers, the reason beside. */
    function unknown(url: string, on: string[], fetchClass: string, fetchReason: string): ResourceSpec {
      return {
        url,
        on,
        fetchClass,
        fetchReason,
        statusCode: null,
        contentType: null,
        bytes: null,
        bytesSource: null,
        cacheControl: null,
      };
    }

    /** A row the pass never reached: null class, null everything. */
    function unasked(url: string, on: string[], fetchReason: string | null): ResourceSpec {
      return {
        url,
        on,
        fetchClass: null,
        fetchReason,
        statusCode: null,
        contentType: null,
        bytes: null,
        bytesSource: null,
        cacheControl: null,
      };
    }

    it("reports a mix of unasked and decided-unknown rows, with the census, the unfetched count and the dominant class", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 4 }, { path: "/b" }],
        [
          unknown("https://cdn.example/1.png", ["/a"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("https://cdn.example/2.png", ["/a", "/b"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("/js/3.js", ["/a"], "fetch_error", "timeout after 15000ms"),
          unasked("/img/4.png", ["/a"], null),
          unasked("/css/5.css", ["/b"], RESOURCE_CAP_REASON),
        ],
      );
      const findings = await run(ID, crawlId);
      expect(findings).toHaveLength(1);
      const f = findings[0]!;
      expect(f.pageId).toBeNull();
      expect(f.pageUrl).toBeNull();
      expect(f.severity).toBe("info");
      expect(f.dedupeKey).toBe("site");
      expect(f.evidence).toMatchObject({
        resourcesSeen: 5,
        // The unasked half of the census — the rows the pass never reached.
        resourcesUnfetched: 2,
        // The decided-unknown half, per class, every class named even at zero.
        census: {
          refused: 0,
          robots_denied: 0,
          robots_unreachable: 2,
          fetch_error: 1,
        },
        dominantClass: "robots_unreachable",
        pagesCrawled: 2,
      });
    });

    it("is silent when even one file came back ok — that is partial coverage the judging rules carry", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          { url: "/img/ok.svg", on: ["/a"] },
          unknown("/img/refused.png", ["/a"], "refused", "url-policy: reserved address"),
          unasked("/img/pending.png", ["/a"], null),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent when even one file answered 4xx/5xx — resources.broken speaks", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          { url: "/img/gone.png", on: ["/a"], fetchClass: "client_error", statusCode: 404, bytes: null, cacheControl: null },
          unknown("/img/refused.png", ["/a"], "refused", "url-policy: reserved address"),
          unasked("/img/pending.png", ["/a"], null),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
      expect(await run("resources.broken", crawlId)).toHaveLength(1);
    });

    it("is silent when every row is unasked — that crawl is not-fetched's", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [unasked("/img/a.png", ["/a"], null), unasked("/img/b.png", ["/a"], null)],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent when every row is a decided unknown — that crawl is all-unknown's", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 2 }],
        [
          unknown("/img/a.png", ["/a"], "refused", "url-policy: reserved address"),
          unknown("/js/b.js", ["/a"], "fetch_error", "connection reset"),
        ],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a crawl that recorded no resources at all", async () => {
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 2 }], []);
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("is silent on a normal completed pass", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 1 }],
        [{ url: "/img/a.svg", on: ["/a"] }],
      );
      expect(await run(ID, crawlId)).toEqual([]);
    });

    it("names every other rule silent on its own crawl, and is the one that speaks", async () => {
      // The gap, proven: on the mix shape the six rules go quiet and the three
      // other markers do not fire either. This marker is the only speaker.
      const { crawlId } = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          unknown("https://cdn.example/1.png", ["/a"], "robots_unreachable", "robots.txt unreachable (503)"),
          unknown("/js/2.js", ["/a"], "fetch_error", "connection reset"),
          unasked("/img/3.png", ["/a"], null),
        ],
      );
      for (const id of [
        "resources.broken",
        "images.oversized",
        "images.legacy-format",
        "resources.uncached",
        "resources.not-recorded",
        "resources.not-fetched",
        "resources.all-unknown",
      ]) {
        expect(await run(id, crawlId), id).toEqual([]);
      }
      expect(await run(ID, crawlId)).toHaveLength(1);
    });
  });

  describe("the four markers are mutually exclusive by construction", () => {
    it("one test, all four boundaries: each marker fires on its own and nowhere else", async () => {
      // ONE test, four conditions, because the exclusivity is the property:
      // `resources.not-recorded` needs `resourcesSeen == 0`,
      // `resources.not-fetched` needs every row unfetched (null == seen),
      // `resources.all-unknown` needs every row DECIDED into an unknown class
      // (a null row disqualifies it, an ok or broken row disqualifies it), and
      // `resources.partial-unknown` needs the MIX the other three each exclude —
      // some null AND some decided-unknown, no ok and no broken row. The four
      // partition the "no ok, no broken, silent" space over `seen > 0` exactly,
      // so no crawl can satisfy two, and this is what says so if any condition is
      // ever loosened.
      const preTables = await seed([{ path: "/a", imagesTotal: 3 }], []);
      const off = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          {
            url: "/img/a.png",
            on: ["/a"],
            fetchClass: null,
            fetchReason: RESOURCE_OFF_REASON,
            statusCode: null,
            bytes: null,
            cacheControl: null,
          },
        ],
      );
      const allUnknown = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          {
            url: "https://cdn.example/a.png",
            on: ["/a"],
            fetchClass: "robots_unreachable",
            fetchReason: "robots.txt unreachable (503)",
            statusCode: null,
            bytes: null,
            cacheControl: null,
          },
        ],
      );
      const partialUnknown = await seed(
        [{ path: "/a", imagesTotal: 3 }],
        [
          {
            url: "https://cdn.example/a.png",
            on: ["/a"],
            fetchClass: "robots_unreachable",
            fetchReason: "robots.txt unreachable (503)",
            statusCode: null,
            bytes: null,
            cacheControl: null,
          },
          {
            url: "/img/b.png",
            on: ["/a"],
            fetchClass: null,
            fetchReason: null,
            statusCode: null,
            bytes: null,
            cacheControl: null,
          },
        ],
      );

      const cases: Array<[string, string]> = [
        ["resources.not-recorded", preTables.crawlId],
        ["resources.not-fetched", off.crawlId],
        ["resources.all-unknown", allUnknown.crawlId],
        ["resources.partial-unknown", partialUnknown.crawlId],
      ];
      const markers = cases.map(([id]) => id);
      for (const [firer, crawlId] of cases) {
        for (const marker of markers) {
          const findings = await run(marker, crawlId);
          if (marker === firer) expect(findings, `${marker} on ${firer}'s crawl`).toHaveLength(1);
          else expect(findings, `${marker} on ${firer}'s crawl`).toEqual([]);
        }
      }
    });
  });

  describe("the whole family on a crawl that recorded nothing", () => {
    it("every judging rule is silent, and the marker is the one that speaks", async () => {
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 2 }], []);
      for (const id of [
        "resources.broken",
        "images.oversized",
        "images.legacy-format",
        "resources.uncached",
        // The sibling too: it reports rows that were not asked about, and this
        // crawl has no rows.
        "resources.not-fetched",
      ]) {
        expect(await run(id, crawlId), id).toEqual([]);
      }
      expect(await run("resources.not-recorded", crawlId)).toHaveLength(1);
    });
  });
});
