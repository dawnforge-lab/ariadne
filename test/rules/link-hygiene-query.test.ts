/**
 * The link-hygiene rules (Phase 26a Task 8), against a real database.
 *
 * Rows are inserted directly, as the link-graph tests do: what is under test is
 * what the rules make of the link rows the crawler stored, not the crawling.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { BLOCKED_HOSTS, BLOCKED_HOST_SUFFIXES, blockedHostReason } from "../../src/crawl/url-policy.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages } from "../../src/db/schema.js";
import { SAMPLE_SOURCES } from "../../src/rules/query/link-targets.js";
import { LOCALHOST_HOST_BATCH, linkHygieneRules } from "../../src/rules/query/link-hygiene.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { HIGH_EXTERNAL_OUTLINKS, HIGH_INTERNAL_OUTLINKS } from "../../src/rules/thresholds.js";
import { mkDiscovery } from "./mk-discovery.js";
import { writerIndexable, type IndexabilitySpec } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://hygiene.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(linkHygieneRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in linkHygieneRules`);
  return r;
}

describe("linkHygieneRules metadata", () => {
  it("defines the six rules of the plan's table, with its checks, severities and category", () => {
    expect(
      Object.fromEntries(linkHygieneRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "links.internal-nofollow": [["CHECK-33"], "warning", "links"],
      "links.only-from-non-indexable": [["CHECK-32"], "warning", "links"],
      "links.localhost": [["CHECK-86"], "warning", "links"],
      "links.non-descriptive-anchor": [["CHECK-86"], "info", "links"],
      "links.no-anchor-text": [["CHECK-86"], "info", "links"],
      "links.high-outlinks": [["CHECK-33"], "info", "links"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    for (const r of linkHygieneRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });
});

describe("the link-hygiene rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec extends IndexabilitySpec {
    path: string;
    canonical?: string | null;
    extractionVersion?: number | null;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
    });
    createdCrawls.push(id);
    return id;
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
        extractionVersion: s.extractionVersion === undefined ? null : s.extractionVersion,
        depth: 1,
        discoveredVia: "link",
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  interface LinkSpec {
    target: string;
    anchor?: string | null;
    nofollow?: boolean;
    internal?: boolean;
  }

  /** Targets that start with a path are on the site; anything with a scheme is as given. */
  async function addLinks(crawlId: string, sourceId: string, specs: (LinkSpec | string)[]): Promise<void> {
    const rows = specs.map((raw, position) => {
      const s: LinkSpec = typeof raw === "string" ? { target: raw } : raw;
      const absolute = /^https?:\/\//.test(s.target);
      return {
        crawlId,
        sourcePageId: sourceId,
        targetUrl: absolute ? s.target : url(s.target),
        targetPageId: null,
        anchor: s.anchor === undefined ? "a descriptive anchor" : s.anchor,
        rel: s.nofollow === true ? "nofollow" : null,
        isInternal: s.internal ?? !absolute,
        isNofollow: s.nofollow ?? false,
        position,
      };
    });
    if (rows.length > 0) await db.insert(links).values(rows);
  }

  const run = (id: string, crawlId: string, caps?: { listing: number | null }): Promise<Finding[]> =>
    rule(id).run(db, crawlId, caps);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  describe("links.internal-nofollow", () => {
    const ID = "links.internal-nofollow";

    it("fires on a page with an internal nofollow link, counting them and sampling the targets", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }, { path: "/a" }, { path: "/b" }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/b", nofollow: true },
        { target: "/a", nofollow: true },
        { target: "/c" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/"),
        pageUrl: url("/"),
        dedupeKey: url("/"),
      });
      expect(found[0]!.evidence).toEqual({
        nofollowCount: 2,
        sample: [url("/a"), url("/b")],
      });
    });

    it("is silent for a nofollow EXTERNAL link and for an all-follow page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }, { path: "/a" }]);
      await addLinks(crawlId, ids.get("/")!, [{ target: "https://elsewhere.example/x", nofollow: true }]);
      await addLinks(crawlId, ids.get("/a")!, ["/"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("does not judge a page the crawl did not fetch OK", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/gone", fetchClass: "client_error", statusCode: 404 }]);
      await addLinks(crawlId, ids.get("/gone")!, [{ target: "/x", nofollow: true }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("samples at most SAMPLE_SOURCES targets and counts them all", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      const n = SAMPLE_SOURCES + 5;
      await addLinks(
        crawlId,
        ids.get("/")!,
        Array.from({ length: n }, (_, i) => ({ target: `/t${String(i).padStart(3, "0")}`, nofollow: true })),
      );
      const found = await run(ID, crawlId);
      expect(found[0]!.evidence["nofollowCount"]).toBe(n);
      expect((found[0]!.evidence["sample"] as string[]).length).toBe(SAMPLE_SOURCES);
      expect((found[0]!.evidence["sample"] as string[])[0]).toBe(url("/t000"));
    });

    it("lists at most the cap and reports the exact total", async () => {
      const crawlId = await newCrawl();
      const specs = Array.from({ length: 5 }, (_, i) => ({ path: `/p${i}` }));
      const ids = await addPages(crawlId, specs);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, [{ target: "/x", nofollow: true }]);
      const found = await run(ID, crawlId, { listing: 2 });
      expect(found).toHaveLength(2);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/p0"), url("/p1")]);
      expect(found[1]!.evidence["truncated"]).toEqual({ reported: 2, total: 5 });
    });
  });

  describe("links.only-from-non-indexable", () => {
    const ID = "links.only-from-non-indexable";

    it("fires on an indexable page whose every inlink comes from a noindex page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/" },
        { path: "/hidden-hub", robotsMeta: "noindex, follow" },
        { path: "/target" },
      ]);
      await addLinks(crawlId, ids.get("/")!, ["/hidden-hub"]);
      await addLinks(crawlId, ids.get("/hidden-hub")!, ["/target"]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        ruleId: ID,
        severity: "warning",
        pageId: ids.get("/target"),
        pageUrl: url("/target"),
        dedupeKey: url("/target"),
      });
      expect(found[0]!.evidence).toEqual({ inlinkSources: 1, sample: [url("/hidden-hub")] });
    });

    it("is silent once ONE indexable page links the target", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/" },
        { path: "/hidden-hub", robotsMeta: "noindex" },
        { path: "/target" },
      ]);
      await addLinks(crawlId, ids.get("/")!, ["/hidden-hub", "/target"]);
      await addLinks(crawlId, ids.get("/hidden-hub")!, ["/target"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("counts a source canonicalised elsewhere as non-indexable", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/" },
        { path: "/dupe", canonical: url("/") },
        { path: "/target" },
      ]);
      await addLinks(crawlId, ids.get("/dupe")!, ["/target"]);
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/target")]);
    });

    it("does not count a self-link: a page linked by itself and a noindex page still fires", async () => {
      // Without `source_page_id <> p.id` the self-link would be an indexable
      // inlink and the page would vanish from this rule.
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/self" },
        { path: "/hidden-hub", robotsMeta: "noindex" },
      ]);
      await addLinks(crawlId, ids.get("/self")!, ["/self"]);
      await addLinks(crawlId, ids.get("/hidden-hub")!, ["/self"]);
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/self")]);
      expect(found[0]!.evidence).toEqual({ inlinkSources: 1, sample: [url("/hidden-hub")] });
    });

    it("is silent on a page only itself links to: that is links.orphan's", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/self" }]);
      await addLinks(crawlId, ids.get("/self")!, ["/self"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent on a target that is not itself judged", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [
        { path: "/hidden-hub", robotsMeta: "noindex" },
        { path: "/also-noindex", robotsMeta: "noindex" },
      ]);
      await addLinks(crawlId, ids.get("/hidden-hub")!, ["/also-noindex"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("samples at most SAMPLE_SOURCES sources and counts every one", async () => {
      const crawlId = await newCrawl();
      const n = SAMPLE_SOURCES + 3;
      const specs = Array.from({ length: n }, (_, i) => ({
        path: `/h${String(i).padStart(2, "0")}`,
        robotsMeta: "noindex",
      }));
      const ids = await addPages(crawlId, [{ path: "/target" }, ...specs]);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, ["/target"]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence["inlinkSources"]).toBe(n);
      expect((found[0]!.evidence["sample"] as string[]).length).toBe(SAMPLE_SOURCES);
    });
  });

  describe("links.localhost", () => {
    const ID = "links.localhost";

    it("fires on localhost and a private IP, and not on a public host", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }, { path: "/b" }, { path: "/c" }]);
      await addLinks(crawlId, ids.get("/a")!, ["http://localhost:3000/x"]);
      await addLinks(crawlId, ids.get("/b")!, ["http://192.168.1.4/"]);
      await addLinks(crawlId, ids.get("/c")!, ["https://example.com/"]);
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/a"), url("/b")]);
      expect(found[0]!.evidence).toEqual({
        targets: ["http://localhost:3000/x"],
        reason: "blocked host name (localhost)",
        targetCount: 1,
      });
      expect(found[1]!.evidence).toMatchObject({
        targets: ["http://192.168.1.4/"],
        reason: "private IPv4 address (192.168.0.0/16)",
      });
    });

    // The SQL prefilter is a superset of what `blockedHostReason` blocks and the
    // JavaScript decides: every host below is a link on its own page, and the
    // rule must fire on exactly the pages whose host `blockedHostReason` blocks.
    const HOSTS = [
      "http://localhost/",
      "http://localhost./",
      "http://foo.localhost/",
      "http://printer.local/",
      "http://nas.localdomain/",
      "http://svc.internal/",
      "http://router.home.arpa/",
      "http://metadata.google.internal/",
      "http://metadata/",
      "http://169.254.169.254/latest",
      "http://100.100.100.200/",
      "http://10.1.2.3/admin",
      "http://127.0.0.1:8080/",
      "http://172.16.0.9/",
      "http://[::1]/",
      "http://[fd00::1]:3000/",
      "http://user:secret@localhost/",
      "http://intranet/",
      "http://172.32.0.1/",
      "http://8.8.8.8/",
      "http://[2001:4860:4860::8888]/",
      "https://example.com/",
      "https://localhost.example.com/",
      "https://3m.com/",
      "https://notlocal.com/",
    ];

    it("fires on exactly the hosts blockedHostReason blocks", async () => {
      const crawlId = await newCrawl();
      const specs = HOSTS.map((h, i) => ({ path: `/p${String(i).padStart(2, "0")}`, host: h }));
      const ids = await addPages(crawlId, specs);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, [s.host]);

      const expected = specs
        .filter((s) => blockedHostReason(new URL(s.host).hostname) !== null)
        .map((s) => url(s.path));
      // A guard on the table itself: it has to hold both kinds, or the equality
      // below could pass on an empty set.
      expect(expected.length).toBeGreaterThan(10);
      expect(expected.length).toBeLessThan(specs.length);

      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual(expected);
    });

    it("builds the prefilter from every entry of the policy's own lists", async () => {
      const crawlId = await newCrawl();
      const hosts = [
        ...BLOCKED_HOSTS,
        ...BLOCKED_HOST_SUFFIXES.map((s) => `x${s}`),
      ];
      const specs = hosts.map((h, i) => ({ path: `/q${i}`, host: `http://${h}/` }));
      const ids = await addPages(crawlId, specs);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, [s.host]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(hosts.length);
    });

    it("reads external links only: an internal link to a private host is the site itself", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }]);
      await addLinks(crawlId, ids.get("/a")!, [{ target: "http://localhost:3000/x", internal: true }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("lists at most 10 targets, counts them all, and quotes the first target's reason", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/a" }]);
      const targets = Array.from({ length: 13 }, (_, i) => `http://10.0.0.${i + 1}/`);
      await addLinks(crawlId, ids.get("/a")!, ["https://example.com/", ...targets]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      const ev = found[0]!.evidence;
      expect((ev["targets"] as string[]).length).toBe(10);
      expect(ev["targetCount"]).toBe(13);
      expect(ev["reason"]).toBe("private IPv4 address (10.0.0.0/8)");
    });

    it("finds every blocked host when there are more of them than one host batch", async () => {
      const crawlId = await newCrawl();
      const n = LOCALHOST_HOST_BATCH + 5;
      // One page per host, hosts that are blocked, plus a public host between
      // them in the ordering that must stay silent.
      const specs = Array.from({ length: n }, (_, i) => ({
        path: `/h${String(i).padStart(4, "0")}`,
        host: `http://svc${String(i).padStart(4, "0")}.internal/`,
      }));
      const ids = await addPages(crawlId, [...specs, { path: "/public" }]);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, [s.host]);
      await addLinks(crawlId, ids.get("/public")!, ["https://svc0100.example.com/"]);
      const found = await run(ID, crawlId, { listing: null });
      expect(found.map((f) => f.pageUrl)).toEqual(specs.map((s) => url(s.path)));
      expect(found[0]!.evidence["reason"]).toBe("internal host suffix (.internal)");
    });

    it("two runs at once on different crawls do not see each other's hosts", async () => {
      const a = await newCrawl();
      const b = await newCrawl();
      const ia = await addPages(a, [{ path: "/a" }]);
      const ib = await addPages(b, [{ path: "/b" }]);
      await addLinks(a, ia.get("/a")!, ["http://10.0.0.1/"]);
      await addLinks(b, ib.get("/b")!, ["http://192.168.0.1/"]);
      const [fa, fb] = await Promise.all([run(ID, a), run(ID, b)]);
      expect(fa.map((f) => f.evidence["targets"])).toEqual([["http://10.0.0.1/"]]);
      expect(fb.map((f) => f.evidence["targets"])).toEqual([["http://192.168.0.1/"]]);
    });

    it("lists in URL order under a cap and keeps the exact total", async () => {
      const crawlId = await newCrawl();
      const n = 250;
      const specs = Array.from({ length: n }, (_, i) => ({ path: `/s${String(i).padStart(4, "0")}` }));
      const ids = await addPages(crawlId, specs);
      for (const s of specs) await addLinks(crawlId, ids.get(s.path)!, ["http://localhost/"]);
      const all = await run(ID, crawlId, { listing: null });
      expect(all).toHaveLength(n);
      expect(all.map((f) => f.pageUrl)).toEqual(specs.map((s) => url(s.path)));
      const capped = await run(ID, crawlId, { listing: 3 });
      expect(capped).toHaveLength(3);
      expect(capped[2]!.evidence["truncated"]).toEqual({ reported: 3, total: n });
    });

    it("does not judge a source page the crawl did not fetch OK", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/gone", fetchClass: "client_error", statusCode: 404 }]);
      await addLinks(crawlId, ids.get("/gone")!, ["http://localhost/"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });
  });

  describe("links.non-descriptive-anchor", () => {
    const ID = "links.non-descriptive-anchor";

    it("fires on a generic anchor after case and whitespace are normalised", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/a", anchor: "Read  More" },
        { target: "/b", anchor: "  CLICK HERE " },
        { target: "/c", anchor: "read\tmore" },
        { target: "/d", anchor: "Pricing" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ruleId: ID, severity: "info", pageUrl: url("/") });
      expect(found[0]!.evidence).toEqual({ anchors: ["click here", "read more"], count: 3 });
    });

    it("is silent on an anchor that merely starts with a generic phrase, and on empty or missing anchors", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/a", anchor: "read more about pricing" },
        { target: "/b", anchor: "" },
        { target: "/c", anchor: null },
        { target: "/d", anchor: "here comes the sun" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("judges internal anchors only", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "https://elsewhere.example/x", anchor: "click here" },
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("treats a no-break space as whitespace, which Postgres \\s does not", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/a", anchor: "Read\u00a0More" },
        { target: "/b", anchor: "\u00a0click\u00a0\u00a0here\u00a0" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ anchors: ["click here", "read more"], count: 2 });
    });

    it("lists at most 10 distinct anchors and counts every generic link", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/" }]);
      const generic = [
        "click here", "click", "here", "read more", "more", "learn more", "find out more",
        "continue reading", "continue", "see more", "view more", "more info",
      ];
      await addLinks(
        crawlId,
        ids.get("/")!,
        generic.map((anchor, i) => ({ target: `/g${i}`, anchor })),
      );
      const found = await run(ID, crawlId);
      expect(found[0]!.evidence["count"]).toBe(12);
      expect((found[0]!.evidence["anchors"] as string[]).length).toBe(10);
    });
  });

  describe("links.no-anchor-text", () => {
    const ID = "links.no-anchor-text";
    const V2 = { extractionVersion: 2 };

    it("fires on empty, whitespace-only and no-break-space anchors, one finding per page", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/", ...V2 }, { path: "/b", ...V2 }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/z", anchor: "" },
        { target: "/a", anchor: "  \t " },
        { target: "/c", anchor: "\u00a0\u00a0" },
        { target: "/d", anchor: "Pricing" },
        { target: "https://elsewhere.example/x", anchor: "" },
      ]);
      await addLinks(crawlId, ids.get("/b")!, [{ target: "/d", anchor: "Pricing" }]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ruleId: ID, severity: "info", pageUrl: url("/") });
      expect(found[0]!.evidence).toEqual({
        count: 3,
        targets: [url("/a"), url("/c"), url("/z")],
      });
    });

    it("an image link with alt (stored as the anchor) is not textless, one without alt is", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/", ...V2 }]);
      await addLinks(crawlId, ids.get("/")!, [
        { target: "/with-alt", anchor: "Company logo" },
        { target: "/no-alt", anchor: "" },
      ]);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!.evidence).toEqual({ count: 1, targets: [url("/no-alt")] });
    });

    it("refuses a crawl with any page below extraction 2: the marker speaks, this is silent", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/", ...V2 }, { path: "/old", extractionVersion: 1 }]);
      await addLinks(crawlId, ids.get("/")!, [{ target: "/z", anchor: "" }]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("lists at most SAMPLE_SOURCES targets, counts every link, and caps the listing", async () => {
      const crawlId = await newCrawl();
      const specs = Array.from({ length: 3 }, (_, i) => ({ path: `/p${i}`, ...V2 }));
      const ids = await addPages(crawlId, specs);
      const n = SAMPLE_SOURCES + 4;
      await addLinks(
        crawlId,
        ids.get("/p0")!,
        Array.from({ length: n }, (_, i) => ({ target: `/t${String(i).padStart(3, "0")}`, anchor: "" })),
      );
      for (const s of specs.slice(1)) await addLinks(crawlId, ids.get(s.path)!, [{ target: "/x", anchor: "" }]);
      const all = await run(ID, crawlId, { listing: null });
      expect(all).toHaveLength(3);
      expect(all[0]!.evidence["count"]).toBe(n);
      expect((all[0]!.evidence["targets"] as string[]).length).toBe(SAMPLE_SOURCES);
      const capped = await run(ID, crawlId, { listing: 2 });
      expect(capped).toHaveLength(2);
      expect(capped[1]!.evidence["truncated"]).toEqual({ reported: 2, total: 3 });
    });
  });

  describe("links.high-outlinks", () => {
    const ID = "links.high-outlinks";
    const internal = (n: number): string[] => Array.from({ length: n }, (_, i) => `/o?n=${i}`);
    const external = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `https://ext${i}.example/`);

    it("is silent at exactly HIGH_INTERNAL_OUTLINKS distinct targets and fires on one more", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/at" }, { path: "/over" }]);
      await addLinks(crawlId, ids.get("/at")!, internal(HIGH_INTERNAL_OUTLINKS));
      await addLinks(crawlId, ids.get("/over")!, internal(HIGH_INTERNAL_OUTLINKS + 1));
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/over")]);
      expect(found[0]).toMatchObject({ ruleId: ID, severity: "info" });
      expect(found[0]!.evidence).toEqual({
        internalOutlinks: HIGH_INTERNAL_OUTLINKS + 1,
        externalOutlinks: 0,
        max: HIGH_INTERNAL_OUTLINKS,
        crossed: "internal",
      });
    });

    it("is silent at exactly HIGH_EXTERNAL_OUTLINKS distinct external targets and fires on one more", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/at" }, { path: "/over" }]);
      await addLinks(crawlId, ids.get("/at")!, external(HIGH_EXTERNAL_OUTLINKS));
      await addLinks(crawlId, ids.get("/over")!, external(HIGH_EXTERNAL_OUTLINKS + 1));
      const found = await run(ID, crawlId);
      expect(found.map((f) => f.pageUrl)).toEqual([url("/over")]);
      expect(found[0]!.evidence).toEqual({
        internalOutlinks: 0,
        externalOutlinks: HIGH_EXTERNAL_OUTLINKS + 1,
        max: HIGH_EXTERNAL_OUTLINKS,
        crossed: "external",
      });
    });

    it("does not add internal and external counts together", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/mixed" }]);
      await addLinks(crawlId, ids.get("/mixed")!, [
        ...internal(HIGH_EXTERNAL_OUTLINKS),
        ...external(HIGH_EXTERNAL_OUTLINKS),
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("counts distinct targets, not link rows", async () => {
      const crawlId = await newCrawl();
      const ids = await addPages(crawlId, [{ path: "/dup" }]);
      // Two rows for each of HIGH_EXTERNAL_OUTLINKS targets: more rows than the
      // threshold, exactly the threshold in distinct targets.
      await addLinks(crawlId, ids.get("/dup")!, [
        ...external(HIGH_EXTERNAL_OUTLINKS),
        ...external(HIGH_EXTERNAL_OUTLINKS),
      ]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });
  });
});
