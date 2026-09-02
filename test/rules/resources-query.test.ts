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
import { RESOURCE_OFF_REASON } from "../../src/crawl/resources/fetch-resources.js";
import { DEFAULT_RULE_CAPS } from "../../src/rules/query/crawl-evidence.js";
import {
  BROKEN_SAMPLE_RESOURCES,
  IMAGE_WEIGHT_WARN,
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
  it("defines exactly the five resource rules of the Phase 11 table", () => {
    expect(resourceRules.map((r) => r.id).sort()).toEqual([
      "images.legacy-format",
      "images.oversized",
      "resources.broken",
      "resources.not-recorded",
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
      "images.oversized": [["CHECK-49"], "warning", "technical"],
      "images.legacy-format": [["CHECK-49"], "info", "technical"],
      "resources.uncached": [["CHECK-50"], "info", "technical"],
      // The marker claims every check whose silence it explains.
      "resources.not-recorded": [
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
    // every reference and asks about none of them, so the rows exist, the
    // marker's condition (`resourcesSeen == 0`) is false, and it stays silent —
    // while the four judging rules above are silent too, because every row is
    // unfetched and an unfetched resource is unknown rather than fine.
    //
    // That combination — four quiet rules and no marker — is deliberate and it
    // is NOT a rule that always passes. The reason it is safe is that the fact
    // lives one surface over, where the auditor is told to look first: the rows
    // carry `fetch_reason: 'resource-fetch-off'`, `crawl_status` echoes
    // `fetchResources: false` beside `resources.skipped == seen`, and CHECK-83
    // is answered before any check these rules claim. Widening the marker to
    // cover this case would change when a rule fires, which is a verdict change
    // and a ruleset bump; it is written up in the T4 report as the alternative
    // that was weighed and left to the owner.
    it("stays silent when the operator turned the pass off, because the rows exist", async () => {
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
    });

    it("is silent on a crawl whose pages genuinely reference nothing", async () => {
      // No resource rows AND no page that counted an image: nothing is missing,
      // so there is nothing to mark. The marker reports a gap in the EVIDENCE,
      // never a site that ships no assets.
      const { crawlId } = await seed([{ path: "/a", imagesTotal: 0 }], []);
      expect(await run("resources.not-recorded", crawlId)).toEqual([]);
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
      ]) {
        expect(await run(id, crawlId), id).toEqual([]);
      }
      expect(await run("resources.not-recorded", crawlId)).toHaveLength(1);
    });
  });
});
