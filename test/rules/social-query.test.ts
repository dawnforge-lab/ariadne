/**
 * The two social query rules (Phase 26b, Task 6), against a real database:
 * `social.og-duplicate` (one og:title or og:description shared by pages) and
 * `social.image-broken` (an og/X share image that is relative, malformed,
 * answered non-200, over `SOCIAL_IMAGE_MAX_BYTES`, or never fetched).
 *
 * Rows are inserted directly: what is under test is what the rules make of the
 * `pages`, `resources` and `page_resources` rows a crawl writes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { analyzePage, shareImage } from "../../src/crawl/parse/page-analyzer.js";
import { SOCIAL_URL_MAX, type SocialFacts } from "../../src/crawl/parse/page-facts.js";
import { INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";
import { RESOURCE_OFF_REASON } from "../../src/crawl/resources/fetch-resources.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pageResources, pages, resources } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import { DEFAULT_RULE_CAPS } from "../../src/rules/query/crawl-evidence.js";
import { socialQueryRules } from "../../src/rules/query/social.js";
import type { MetricRule, QueryRule, RuleCaps } from "../../src/rules/registry/types.js";
import { SOCIAL_IMAGE_MAX_BYTES } from "../../src/rules/thresholds.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://social.example";

function rule(id: string): QueryRule {
  const r = socialQueryRules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule '${id}' in socialQueryRules`);
  return r;
}
const duplicate = rule("social.og-duplicate");
const imageBroken = rule("social.image-broken");

/** Any registered rule, for the Review Focus 2 cross-checks. */
const registry = buildRegistry();
function registered(id: string): QueryRule {
  const r = registry.all().find((x) => x.id === id);
  if (!r || r.kind !== "query") throw new Error(`no query rule '${id}'`);
  return r;
}
function metric(id: string): MetricRule {
  const r = registry.all().find((x) => x.id === id);
  if (!r || r.kind !== "metric") throw new Error(`no metric rule '${id}'`);
  return r;
}

function caps(listing: number | null): RuleCaps {
  return { ...DEFAULT_RULE_CAPS, listing };
}

/**
 * A social set holding only the images a case is about, with the `imageRefs`
 * the analyzer would have stored beside them (`shareImage`, the one function
 * that resolves a share image; relative values against the site root, which
 * the rule never looks up), and the Phase 26c `imageRefTooLong` flags.
 */
function images(og: string | undefined, x?: string): SocialFacts {
  const resolved = (value: string | undefined) =>
    value === undefined ? { ref: null, tooLong: false } : shareImage(value, `${SITE}/`);
  return {
    og: { title: "A share title", type: "website", url: SITE, ...(og === undefined ? {} : { image: og }) },
    x: { card: "summary_large_image", ...(x === undefined ? {} : { image: x }) },
    counts: {},
    conflicting: [],
    outsideHead: false,
    xViaProperty: false,
    imageRefs: { og: resolved(og).ref, x: resolved(x).ref },
    // Phase 26c: present on every social object the analyzer writes (v3).
    imageRefTooLong: { og: resolved(og).tooLong, x: resolved(x).tooLong },
  };
}

interface PageSpec {
  path: string;
  title?: string;
  ogTitle?: string | null;
  ogDescription?: string | null;
  social?: SocialFacts | null;
  extractionVersion?: number | null;
  isIndexable?: boolean;
  robotsMeta?: string | null;
}

interface ResourceSpec {
  url: string;
  fetchClass?: string | null;
  fetchReason?: string | null;
  statusCode?: number | null;
  contentType?: string | null;
  bytes?: number | null;
  /** Paths of the pages that LOAD it (a `page_resources` edge). */
  on?: string[];
}

describe("socialQueryRules metadata", () => {
  it("defines the two query rules", () => {
    expect(socialQueryRules.map((r) => r.id)).toEqual([
      "social.og-duplicate",
      "social.image-broken",
    ]);
    expect([duplicate.severity, duplicate.category, duplicate.checkIds]).toEqual([
      "info",
      "on-page",
      ["CHECK-87"],
    ]);
    expect([imageBroken.severity, imageBroken.category, imageBroken.checkIds]).toEqual([
      "warning",
      "on-page",
      ["CHECK-87"],
    ]);
    expect(duplicate.marker).toBeUndefined();
    expect(imageBroken.marker).toBeUndefined();
  });

  it("declares groupFindings' columns plus the field, and the image list", () => {
    expect(duplicate.columns).toEqual([
      { key: "field", label: "Tag" },
      { key: "value", label: "Shared Value" },
      { key: "count", label: "Occurrences" },
      { key: "pages", label: "Addresses" },
      { key: "alternatesCollapsed", label: "Alternates Collapsed" },
      { key: "paginationExcluded", label: "Paginated Pages Set Aside (Site-Wide)" },
    ]);
    expect(imageBroken.columns).toEqual([{ key: "images", label: "Image Problems" }]);
  });

  it("the size limit is 5 MB", () => {
    expect(SOCIAL_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("social query rules against the database", () => {
  let db: Db;
  const created: string[] = [];

  async function seed(
    pageSpecs: PageSpec[],
    resourceSpecs: ResourceSpec[] = [],
  ): Promise<{ crawlId: string; ids: Map<string, string> }> {
    const crawlId = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({ tenantId: LOCAL_TENANT, id: crawlId, siteUrl: SITE, config: {}, rulesetVersion: "test" });
    created.push(crawlId);
    const rows = pageSpecs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: `${SITE}${s.path}`,
      pageType: "content",
      fetchClass: "ok",
      statusCode: 200,
      isIndexable: s.isIndexable ?? true,
      robotsMeta: s.robotsMeta ?? null,
      depth: 1,
      discoveredVia: "link",
      htmlBytes: 20_000,
      title: s.title ?? `Title of ${s.path}`,
      ogTitle: s.ogTitle ?? null,
      ogDescription: s.ogDescription ?? null,
      social: s.social === undefined ? null : s.social,
      extractionVersion: s.extractionVersion === undefined ? 2 : s.extractionVersion,
    }));
    if (rows.length > 0) await db.insert(pages).values(rows);
    const ids = new Map(pageSpecs.map((s, i) => [s.path, rows[i]!.id]));
    if (resourceSpecs.length > 0) {
      await db.insert(resources).values(
        resourceSpecs.map((r) => ({
          crawlId,
          url: r.url,
          kind: "image",
          // Every row here is named by a share tag (an edge, where a spec has
          // one, only says a page also loads it).
          shareImage: true,
          fetchClass: r.fetchClass === undefined ? "ok" : r.fetchClass,
          fetchReason: r.fetchReason ?? null,
          statusCode: r.statusCode === undefined ? 200 : r.statusCode,
          contentType: r.contentType === undefined ? "image/png" : r.contentType,
          bytes: r.bytes === undefined ? 40_000 : r.bytes,
          bytesSource: r.bytes === null ? null : "header",
          cacheControl: "public, max-age=3600",
        })),
      );
      const edges = resourceSpecs.flatMap((r) =>
        (r.on ?? []).map((path) => {
          const pageId = ids.get(path);
          if (pageId === undefined) throw new Error(`no page ${path}`);
          return { crawlId, pageId, resourceUrl: r.url };
        }),
      );
      if (edges.length > 0) await db.insert(pageResources).values(edges);
    }
    return { crawlId, ids };
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("social.og-duplicate", () => {
    it("groups two pages sharing one og:title under different titles", async () => {
      const { crawlId, ids } = await seed([
        { path: "/a", title: "Alpha", ogTitle: "Shared share title" },
        { path: "/b", title: "Beta", ogTitle: "  Shared share title " },
        { path: "/c", title: "Gamma", ogTitle: "Another share title" },
      ]);
      const f = await duplicate.run(db, crawlId);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({
        ruleId: "social.og-duplicate",
        severity: "info",
        pageId: ids.get("/a"),
        pageUrl: `${SITE}/a`,
      });
      expect(f[0]?.evidence).toEqual({
        field: "og:title",
        value: "Shared share title",
        count: 2,
        pages: [`${SITE}/a`, `${SITE}/b`],
        alternatesCollapsed: 0,
        paginationExcluded: 0,
      });
      expect(f[0]?.dedupeKey).toMatch(/^og:title:[0-9a-f]{64}$/);
    });

    it("groups pages whose og:title is written with name= (PR #23 P9)", async () => {
      // End to end through the analyzer: the og_title column now reads what
      // the social set reads, `name=` included.
      const head = (title: string) =>
        analyzePage(
          `<html><head><title>${title}</title><meta name="og:title" content="Shared by name">` +
            `<meta name="description" property="og:description" content="Shared description">` +
            `</head><body><p>x</p></body></html>`,
          `${SITE}/x`,
        );
      const a = head("Alpha");
      const b = head("Beta");
      const { crawlId } = await seed([
        { path: "/a", title: "Alpha", ogTitle: a.ogTitle, ogDescription: a.ogDescription },
        { path: "/b", title: "Beta", ogTitle: b.ogTitle, ogDescription: b.ogDescription },
      ]);
      const f = await duplicate.run(db, crawlId);
      expect(f.map((x) => [x.evidence.field, x.evidence.value, x.evidence.pages])).toEqual([
        ["og:title", "Shared by name", [`${SITE}/a`, `${SITE}/b`]],
        ["og:description", "Shared description", [`${SITE}/a`, `${SITE}/b`]],
      ]);
    });

    it("reports title groups, then description groups; one text in both is two findings", async () => {
      const { crawlId } = await seed([
        { path: "/a", ogTitle: "Same words", ogDescription: "Same words" },
        { path: "/b", ogTitle: "Same words", ogDescription: "Same words" },
      ]);
      const f = await duplicate.run(db, crawlId);
      expect(f.map((x) => x.evidence.field)).toEqual(["og:title", "og:description"]);
      // The prefix is what keeps the two keys apart: the value hashes alike.
      expect(f[0]?.dedupeKey).not.toBe(f[1]?.dedupeKey);
      expect(f[0]?.dedupeKey.slice("og:title:".length)).toBe(
        f[1]?.dedupeKey.slice("og:description:".length),
      );
    });

    it("an og:title equal to another page's og:description is not a group", async () => {
      const { crawlId } = await seed([
        { path: "/a", ogTitle: "Crossed value" },
        { path: "/b", ogDescription: "Crossed value" },
      ]);
      expect(await duplicate.run(db, crawlId)).toEqual([]);
    });

    it("judges only judged pages, and never groups blanks", async () => {
      const { crawlId } = await seed([
        { path: "/a", ogTitle: "Kept out" },
        { path: "/b", ogTitle: "Kept out", robotsMeta: "noindex", isIndexable: false },
        { path: "/c", ogTitle: "" },
        { path: "/d", ogTitle: "   " },
      ]);
      expect(await duplicate.run(db, crawlId)).toEqual([]);
    });

    it("judges a v1 crawl too: the og columns predate the bump (deviation 1)", async () => {
      const { crawlId } = await seed([
        { path: "/a", ogTitle: "Old crawl title", extractionVersion: 1 },
        { path: "/b", ogTitle: "Old crawl title", extractionVersion: 1 },
      ]);
      expect(await duplicate.run(db, crawlId)).toHaveLength(1);
    });

    it("one cap and one exact note across both fields", async () => {
      const { crawlId } = await seed([
        { path: "/a", ogTitle: "T1", ogDescription: "D1" },
        { path: "/b", ogTitle: "T1", ogDescription: "D1" },
        { path: "/c", ogTitle: "T2", ogDescription: "D2" },
        { path: "/d", ogTitle: "T2", ogDescription: "D2" },
      ]);
      const capped = await duplicate.run(db, crawlId, caps(3));
      expect(capped.map((x) => [x.evidence.field, x.evidence.value])).toEqual([
        ["og:title", "T1"],
        ["og:title", "T2"],
        ["og:description", "D1"],
      ]);
      // One note, on the last finding, with the exact total of both fields.
      expect(capped.filter((x) => "truncated" in x.evidence)).toHaveLength(1);
      expect(capped[2]?.evidence.truncated).toEqual({ reported: 3, total: 4 });

      const one = await duplicate.run(db, crawlId, caps(1));
      expect(one).toHaveLength(1);
      expect(one[0]?.evidence.truncated).toEqual({ reported: 1, total: 4 });

      const all = await duplicate.run(db, crawlId, caps(null));
      expect(all).toHaveLength(4);
      expect(all.some((x) => "truncated" in x.evidence)).toBe(false);
    });

    it("throws on a crawl that does not exist", async () => {
      await expect(duplicate.run(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });
  });

  describe("social.image-broken", () => {
    const OK = `${SITE}/og/fine.png`;

    it("fires on a relative og:image, before any fetch", async () => {
      const { crawlId, ids } = await seed([{ path: "/a", social: images("/og/share.png") }]);
      const f = await imageBroken.run(db, crawlId);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({
        ruleId: "social.image-broken",
        severity: "warning",
        pageId: ids.get("/a"),
        pageUrl: `${SITE}/a`,
        dedupeKey: `${SITE}/a`,
      });
      expect(f[0]?.evidence).toEqual({
        images: [{ tag: "og:image", url: "/og/share.png", problem: "relative" }],
      });
    });

    it("a protocol-relative image is relative; a non-http scheme or a broken host is invalid", async () => {
      const { crawlId } = await seed([
        { path: "/a", social: images("//cdn.example/x.png") },
        { path: "/b", social: images("data:image/png;base64,AAAA") },
        { path: "/c", social: images("https://exa mple.com/x.png") },
      ]);
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [{ tag: "og:image", url: "//cdn.example/x.png", problem: "relative" }],
        [{ tag: "og:image", url: "data:image/png;base64,AAAA", problem: "invalid" }],
        [{ tag: "og:image", url: "https://exa mple.com/x.png", problem: "invalid" }],
      ]);
    });

    it("fires on a non-200 status and on an image over 5 MB; one finding names both tags", async () => {
      const BIG = `${SITE}/og/big.png`;
      const GONE = `${SITE}/og/gone.png`;
      const { crawlId } = await seed(
        [{ path: "/a", social: images(BIG, GONE) }],
        [
          { url: BIG, bytes: 6 * 1024 * 1024 },
          { url: GONE, fetchClass: "client_error", statusCode: 404, bytes: null },
        ],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f).toHaveLength(1);
      expect(f[0]?.evidence).toEqual({
        images: [
          { tag: "og:image", url: BIG, problem: "too-large", bytes: 6 * 1024 * 1024 },
          { tag: "twitter:image", url: GONE, problem: "status", statusCode: 404 },
        ],
      });
    });

    it("is silent on a fetched 200 at exactly the limit, and on a page with no image", async () => {
      const EDGE = `${SITE}/og/edge.png`;
      const { crawlId } = await seed(
        [
          { path: "/a", social: images(EDGE) },
          { path: "/b", social: images(undefined) },
          { path: "/c", social: null },
        ],
        [{ url: EDGE, bytes: SOCIAL_IMAGE_MAX_BYTES }],
      );
      expect(await imageBroken.run(db, crawlId)).toEqual([]);
    });

    it("judges a share image over SOCIAL_URL_MAX by the row the analyzer queued (final review I1)", async () => {
      // End to end through the analyzer: the stored og:image is cut at the
      // cap, the `resources` row is keyed by the WHOLE resolved value, and the
      // rule must find that row, not report the image unfetched.
      const long = `${SITE}/og/${"u".repeat(1_500)}.png`;
      const pageUrl = `${SITE}/a`;
      const analysis = analyzePage(
        `<html><head><meta property="og:image" content="${long}"></head><body><p>x</p></body></html>`,
        pageUrl,
      );
      expect(analysis.social?.og.image).toHaveLength(SOCIAL_URL_MAX);
      expect(analysis.socialImageRefs).toEqual([long]);
      const { crawlId } = await seed(
        [{ path: "/a", social: analysis.social }],
        [{ url: analysis.socialImageRefs[0]!, fetchClass: "client_error", statusCode: 404, bytes: null }],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [{ tag: "og:image", url: analysis.social?.og.image, problem: "status", statusCode: 404 }],
      ]);
    });

    it("judges a relative and an ftp share image from the stored value, with no ref (PR #23 P7)", async () => {
      // End to end through the analyzer: neither value gets a ref (so no
      // `resources` row is queued), and the rule still names each problem.
      const pageUrl = `${SITE}/a`;
      const analysis = analyzePage(
        `<html><head><meta property="og:image" content="/og.png">` +
          `<meta name="twitter:image" content="ftp://x/a.png"></head><body><p>x</p></body></html>`,
        pageUrl,
      );
      expect(analysis.social?.imageRefs).toEqual({ og: null, x: null });
      expect(analysis.socialImageRefs).toEqual([]);
      const { crawlId } = await seed([{ path: "/a", social: analysis.social }]);
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [
          { tag: "og:image", url: "/og.png", problem: "relative" },
          { tag: "twitter:image", url: "ftp://x/a.png", problem: "invalid" },
        ],
      ]);
    });

    it("throws on a v2 row whose social set predates imageRefs, never re-resolving the capped value", async () => {
      const legacy: Partial<SocialFacts> = { ...images(OK) };
      delete legacy.imageRefs;
      const { crawlId } = await seed([{ path: "/a", social: legacy as SocialFacts }], [{ url: OK }]);
      await expect(imageBroken.run(db, crawlId)).rejects.toThrow(/imageRefs/);
    });

    // Phase 26c (Task 2): a share image whose resolved address is over
    // INDEXED_URL_MAX gets no ref and no `resources` row; the analyzer flags it
    // and the rule names it `too-long`, on a v3 row.
    it("reports a share image too long to index as too-long on a v3 row (end to end)", async () => {
      const long = `${SITE}/og/${"w".repeat(3_000)}.png`;
      const pageUrl = `${SITE}/a`;
      const analysis = analyzePage(
        `<html><head><meta property="og:image" content="${long}">` +
          `<meta name="twitter:image" content="${OK}"></head><body><p>x</p></body></html>`,
        pageUrl,
      );
      expect(analysis.social?.imageRefTooLong).toEqual({ og: true, x: false });
      const { crawlId } = await seed(
        [{ path: "/a", social: analysis.social, extractionVersion: 3 }],
        [{ url: OK }],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [{ tag: "og:image", url: analysis.social?.og.image, problem: "too-long", max: INDEXED_URL_MAX }],
      ]);
    });

    it("reports a too-long twitter:image beside a fine og:image (v3)", async () => {
      const long = `${SITE}/x/${"v".repeat(3_000)}.png`;
      const { crawlId } = await seed(
        [{ path: "/a", social: images(OK, long), extractionVersion: 3 }],
        [{ url: OK }],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [{ tag: "twitter:image", url: long, problem: "too-long", max: INDEXED_URL_MAX }],
      ]);
    });

    it("throws re-crawl on a v3 row whose social set has no imageRefTooLong", async () => {
      const partial: Partial<SocialFacts> = { ...images(OK) };
      delete partial.imageRefTooLong;
      const { crawlId } = await seed(
        [{ path: "/a", social: partial as SocialFacts, extractionVersion: 3 }],
        [{ url: OK }],
      );
      await expect(imageBroken.run(db, crawlId)).rejects.toThrow(/imageRefTooLong.*re-crawl/);
    });

    // Final review M2: a partial flag object is not read as false for the half
    // it lacks; nor is a flag that is not a boolean.
    it("throws re-crawl on a v3 row whose imageRefTooLong is partial or not boolean", async () => {
      const shapes: unknown[] = [{ og: false }, { x: false }, {}, { og: "false", x: false }, { og: false, x: null }, null];
      for (const flags of shapes) {
        const partial = { ...images(OK), imageRefTooLong: flags } as unknown as SocialFacts;
        const { crawlId } = await seed(
          [{ path: "/a", social: partial, extractionVersion: 3 }],
          [{ url: OK }],
        );
        await expect(imageBroken.run(db, crawlId), JSON.stringify(flags)).rejects.toThrow(
          /imageRefTooLong.*re-crawl/,
        );
      }
    });

    // Ruling R3: a v2 row is judged exactly as in Phase 26b. It never carries
    // the flag, so it neither throws nor reports `too-long`.
    it("judges a v2 row without imageRefTooLong as in 26b: no throw, no too-long", async () => {
      const BROKEN = `${SITE}/og/broken.png`;
      const v2Fine: Partial<SocialFacts> = { ...images(OK) };
      delete v2Fine.imageRefTooLong;
      const v2Broken: Partial<SocialFacts> = { ...images(BROKEN) };
      delete v2Broken.imageRefTooLong;
      // A v2 row's over-long http value had no ref; 26b called that `invalid`.
      const v2Long: Partial<SocialFacts> = {
        ...images(undefined),
        og: { image: `${SITE}/og/${"t".repeat(900)}.png` },
        imageRefs: { og: null, x: null },
      };
      delete v2Long.imageRefTooLong;
      const { crawlId } = await seed(
        [
          { path: "/a", social: v2Fine as SocialFacts, extractionVersion: 2 },
          { path: "/b", social: v2Broken as SocialFacts, extractionVersion: 2 },
          { path: "/c", social: v2Long as SocialFacts, extractionVersion: 2 },
        ],
        [{ url: OK }, { url: BROKEN, fetchClass: "client_error", statusCode: 404, bytes: null }],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => [x.pageUrl, x.evidence.images])).toEqual([
        [`${SITE}/b`, [{ tag: "og:image", url: BROKEN, problem: "status", statusCode: 404 }]],
        [`${SITE}/c`, [{ tag: "og:image", url: `${SITE}/og/${"t".repeat(900)}.png`, problem: "invalid" }]],
      ]);
    });

    it("matches the resource row by the resolved URL (fragment and host case ignored)", async () => {
      const { crawlId } = await seed(
        [{ path: "/a", social: images("https://SOCIAL.example/og/fine.png#x") }],
        [{ url: OK }],
      );
      expect(await imageBroken.run(db, crawlId)).toEqual([]);
    });

    it("on a crawl whose file check ran, an unfetched image is listed as not fetched (R13)", async () => {
      const UNASKED = `${SITE}/og/unasked.png`;
      const FAILED = `${SITE}/og/failed.png`;
      const { crawlId } = await seed(
        [
          { path: "/a", social: images(UNASKED) },
          { path: "/b", social: images(FAILED) },
          // No `resources` row at all (none was written for it).
          { path: "/c", social: images(`${SITE}/og/norow.png`) },
          // The check ran: this page's image was asked about and answered.
          { path: "/d", social: images(OK) },
        ],
        [
          { url: OK },
          // The check stopped short of this one.
          { url: UNASKED, fetchClass: null, statusCode: null, contentType: null, bytes: null },
          { url: FAILED, fetchClass: "fetch_error", statusCode: null, contentType: null, bytes: null },
        ],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => x.evidence.images)).toEqual([
        [{ tag: "og:image", url: UNASKED, problem: "not-fetched", fetchClass: null }],
        [{ tag: "og:image", url: FAILED, problem: "not-fetched", fetchClass: "fetch_error" }],
        [{ tag: "og:image", url: `${SITE}/og/norow.png`, problem: "not-fetched", fetchClass: null }],
      ]);
    });

    it("one unfetched image on a crawl whose check ran is a per-page entry (R13)", async () => {
      const SKIPPED = `${SITE}/og/skipped.png`;
      const { crawlId, ids } = await seed(
        [
          { path: "/a", social: images(OK) },
          { path: "/b", social: images(SKIPPED) },
        ],
        [
          { url: OK },
          { url: SKIPPED, fetchClass: null, statusCode: null, contentType: null, bytes: null },
        ],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f).toHaveLength(1);
      expect(f[0]?.pageId).toBe(ids.get("/b"));
      expect(f[0]?.evidence).toEqual({
        images: [{ tag: "og:image", url: SKIPPED, problem: "not-fetched", fetchClass: null }],
      });
    });

    it("on a crawl whose file check asked nothing, the marker speaks once instead (R13)", async () => {
      const A = `${SITE}/og/a.png`;
      const B = `${SITE}/og/b.png`;
      const { crawlId } = await seed(
        [
          { path: "/a", social: images(A) },
          { path: "/b", social: images(B) },
          // No row at all: nothing to list either when the check asked nothing.
          { path: "/c", social: images(`${SITE}/og/norow.png`) },
        ],
        [A, B].map((url) => ({
          url,
          fetchClass: null,
          fetchReason: RESOURCE_OFF_REASON,
          statusCode: null,
          contentType: null,
          bytes: null,
        })),
      );
      expect(await imageBroken.run(db, crawlId)).toEqual([]);
      // The crawl's only rows are og-only ones and no page counts an <img>, so
      // `resources.not-recorded` is silent and `resources.not-fetched` speaks for
      // the share images (both claim CHECK-87).
      expect(await registered("resources.not-recorded").run(db, crawlId)).toEqual([]);
      const marker = await registered("resources.not-fetched").run(db, crawlId);
      expect(marker.map((x) => x.evidence)).toEqual([
        expect.objectContaining({ reason: "fetch-off", resourcesSeen: 2, resourcesSkipped: 2 }),
      ]);
    });

    it("a relative image still fires on a crawl whose file check asked nothing", async () => {
      const OFF = `${SITE}/og/off.png`;
      const { crawlId } = await seed(
        [
          { path: "/a", social: images("/og/share.png") },
          { path: "/b", social: images(OFF) },
        ],
        [
          {
            url: OFF,
            fetchClass: null,
            fetchReason: RESOURCE_OFF_REASON,
            statusCode: null,
            contentType: null,
            bytes: null,
          },
        ],
      );
      const f = await imageBroken.run(db, crawlId);
      expect(f.map((x) => [x.pageUrl, x.evidence.images])).toEqual([
        [`${SITE}/a`, [{ tag: "og:image", url: "/og/share.png", problem: "relative" }]],
      ]);
    });

    it("judges only judged pages", async () => {
      const { crawlId } = await seed([
        { path: "/a", social: images("/rel.png"), robotsMeta: "noindex", isIndexable: false },
      ]);
      expect(await imageBroken.run(db, crawlId)).toEqual([]);
    });

    it("is silent on a v1 or a mixed crawl: extraction.not-recorded speaks", async () => {
      const v1 = await seed([{ path: "/a", extractionVersion: 1 }]);
      expect(await imageBroken.run(db, v1.crawlId)).toEqual([]);
      const mixed = await seed([
        { path: "/a", social: images("/rel.png") },
        { path: "/b", extractionVersion: 1 },
      ]);
      expect(await imageBroken.run(db, mixed.crawlId)).toEqual([]);
    });

    it("caps the listing with an exact note", async () => {
      const { crawlId } = await seed([
        { path: "/a", social: images("/1.png") },
        { path: "/b", social: images("/2.png") },
        { path: "/c", social: images("/3.png") },
      ]);
      const f = await imageBroken.run(db, crawlId, caps(2));
      expect(f.map((x) => x.pageUrl)).toEqual([`${SITE}/a`, `${SITE}/b`]);
      expect(f[1]?.evidence.truncated).toEqual({ reported: 2, total: 3 });
      expect(await imageBroken.run(db, crawlId, caps(null))).toHaveLength(3);
    });

    it("throws on a crawl that does not exist", async () => {
      await expect(imageBroken.run(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
    });

    /**
     * Review Focus 2: an og-only image URL that 404s is a `resources` row with
     * no `page_resources` edge. `social.image-broken` reports it; the file rules,
     * mixed content and page weight do not see it. A page-loaded resource on the
     * same page keeps each of those rules speaking, so the silence is about the
     * og row and not an empty crawl.
     */
    it("an og-only 404 fires social.image-broken and nothing in the resource family", async () => {
      const OG_ONLY = "http://cdn.social.example/og-only.png";
      const X_ONLY = "http://cdn.social.example/x-only.png";
      const LOADED = "http://cdn.social.example/loaded.png";
      const { crawlId } = await seed(
        [{ path: "/a", social: images(OG_ONLY, X_ONLY) }],
        [
          { url: OG_ONLY, fetchClass: "client_error", statusCode: 404, contentType: "text/html", bytes: null },
          // Answered 200 as text/html: a bad content type if a page loaded it.
          { url: X_ONLY, contentType: "text/html", bytes: 2_000 },
          { url: LOADED, fetchClass: "client_error", statusCode: 404, contentType: "text/html", bytes: null, on: ["/a"] },
        ],
      );
      const social = await imageBroken.run(db, crawlId);
      expect(social.map((x) => x.evidence.images)).toEqual([
        [{ tag: "og:image", url: OG_ONLY, problem: "status", statusCode: 404 }],
      ]);

      const broken = await registered("resources.broken").run(db, crawlId);
      expect(broken).toHaveLength(1);
      expect(JSON.stringify(broken)).toContain(LOADED);
      expect(JSON.stringify(broken)).not.toContain(OG_ONLY);
      expect(await registered("resources.bad-content-type").run(db, crawlId)).toEqual([]);
      const mixed = await registered("security.mixed-content").run(db, crawlId);
      expect(mixed.map((x) => x.evidence.sample)).toEqual([[LOADED]]);

      // Page weight with and without the two og/X rows: the same table.
      const weight = await metric("page.weight").run(db, crawlId);
      for (const url of [OG_ONLY, X_ONLY]) {
        await db
          .delete(resources)
          .where(and(eq(resources.crawlId, crawlId), eq(resources.url, url)));
      }
      expect(await metric("page.weight").run(db, crawlId)).toEqual(weight);
    });
  });
});
