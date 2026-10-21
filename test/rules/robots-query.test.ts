/**
 * The robots.txt rules, against a real database.
 *
 * Rows are inserted directly (the link-graph pattern): what is under test is
 * what the rules make of the discovery evidence the crawl left behind on the
 * `crawls` row, not the fetching that produced it. Every `discovery_jsonb`
 * here is hand-built to the `DiscoveryEvidence` shape the crawl loop writes.
 *
 * The re-parse is the subject of half of these. `robots.blocks-sitemap-urls`
 * reads the stored robots.txt text back out of the database and asks
 * robots-parser about each sitemap URL — a database read, never a fetch — so
 * the tests pin what it concludes AND the three cases where it refuses to
 * conclude at all: a truncated file, an unreachable one, and a URL on another
 * origin that this robots.txt does not govern.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, links, pages, sitemapUrls } from "../../src/db/schema.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { robotsRules } from "../../src/rules/query/robots.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";
import { normalised } from "./mk-page.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://robots.example";
const UA = "AriadneBot-test";

const byId = new Map(robotsRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in robotsRules`);
  return r;
}

describe("robotsRules metadata", () => {
  it("defines the four robots rules", () => {
    expect(robotsRules.map((r) => r.id).sort()).toEqual([
      "robots.blocks-internal-urls",
      "robots.blocks-sitemap-urls",
      "robots.check-skipped",
      "robots.missing",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(robotsRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "robots.missing": [["CHECK-03"], "info", "crawl"],
      "robots.blocks-sitemap-urls": [["CHECK-03"], "critical", "crawl"],
      // Phase 23 T3: the linked URLs robots.txt keeps the crawler out of. A
      // warning — the Disallow may well be intended — where a sitemap that
      // lists what robots.txt blocks contradicts itself and is critical.
      "robots.blocks-internal-urls": [["CHECK-03"], "warning", "crawl"],
      // Info: a statement about what this crawl could read, not a fault on the
      // site's markup.
      "robots.check-skipped": [["CHECK-03"], "info", "crawl"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of robotsRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    // The skip has its own copy for the same reason `links.orphan-skipped`
    // does: "the check could not run" rendered under "robots.txt blocks URLs
    // your sitemap lists" would be a false statement to a client.
    expect(titles.size).toBe(robotsRules.length);
  });
});

describe("the robots rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(
    discovery: unknown,
    config: Record<string, unknown> = { maxPages: 500, userAgent: UA },
  ): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config,
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
      discovery,
    });
    createdCrawls.push(id);
    return id;
  }

  // `url_normalised` is computed the way the crawl loop computes it: the rule
  // judges that column, and a helper that left it empty would be testing a
  // sitemap row no crawl could write.
  async function addSitemapUrls(crawlId: string, urls: string[]): Promise<void> {
    await db.insert(sitemapUrls).values(
      urls.map((url) => ({
        crawlId,
        url,
        urlNormalised: normalised(url),
        sitemapSource: `${SITE}/sitemap.xml`,
        lastmod: null,
      })),
    );
  }

  const run = async (id: string, crawlId: string): Promise<Finding[]> =>
    rule(id).run(db, crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  // ------------------------------------------------------------ robots.missing

  it("reports a site with no robots.txt, site-scoped, carrying the crawl's own note", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        robots: {
          outcome: "absent",
          raw: null,
          note: "robots.txt absent (HTTP 404): crawling allow-all",
        },
        sitemapSources: [`${SITE}/sitemap.xml`],
      }),
    );

    const found = await run("robots.missing", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "robots.missing",
      severity: "info",
      pageId: null,
      pageUrl: null,
      dedupeKey: "site",
    });
    expect(found[0]!.evidence).toEqual({
      outcome: "absent",
      note: "robots.txt absent (HTTP 404): crawling allow-all",
    });
  });

  it("is silent about a robots.txt the crawl read", async () => {
    const crawlId = await newCrawl(mkDiscovery({ robots: { raw: "User-agent: *\nAllow: /\n" } }));
    expect(await run("robots.missing", crawlId)).toHaveLength(0);
  });

  // "Unreachable" is not "absent": a 5xx or a timeout is the site failing to
  // answer, not the site saying there are no rules. Saying "this site has no
  // robots.txt" about a server that could not serve one would be a false
  // statement; `robots.check-skipped` is where that crawl is reported.
  it("does not call an unreachable robots.txt a missing one", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        robots: { outcome: "unreachable", raw: null, note: "robots.txt unreachable (503)" },
      }),
    );
    expect(await run("robots.missing", crawlId)).toHaveLength(0);
    expect(await run("robots.check-skipped", crawlId)).toHaveLength(1);
  });

  // ------------------------------------------------- robots.blocks-sitemap-urls

  it("reports each sitemap URL the stored robots.txt disallows, naming the rule line", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /admin\n" } }),
    );
    await addSitemapUrls(crawlId, [`${SITE}/admin/secret`, `${SITE}/public`]);

    const found = await run("robots.blocks-sitemap-urls", crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({
      ruleId: "robots.blocks-sitemap-urls",
      severity: rule("robots.blocks-sitemap-urls").severity,
      pageUrl: `${SITE}/admin/secret`,
      dedupeKey: `${SITE}/admin/secret`,
    });
    expect(found[0]!.evidence).toEqual({
      url: `${SITE}/admin/secret`,
      userAgent: UA,
      matchedBy: { line: 2, text: "Disallow: /admin" },
    });
  });

  // robots.txt governs its own origin and nothing else (RFC 9309 §2.2.1), and
  // robots-parser answers `undefined` for a URL on another host. `undefined` is
  // not a prohibition — and `isDisallowed` inverts it into `true`, which is the
  // trap this test exists to keep the rule out of.
  it("does not claim a sitemap entry on another origin is blocked", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /admin\n" } }),
    );
    await addSitemapUrls(crawlId, ["https://cdn.example/admin/secret"]);
    expect(await run("robots.blocks-sitemap-urls", crawlId)).toHaveLength(0);
  });

  // A sitemap that lists the www spelling while robots.txt was read from the
  // apex (or the other way round) is the same site by the crawl's own boundary
  // rule — the crawler refused to enqueue those URLs, judging them against
  // exactly these rules. robots-parser answers `undefined` for a different
  // origin, so without the rewrite this rule would report as allowed the very
  // URLs the crawl would not fetch.
  it("judges a www/apex spelling of the same site by this robots.txt", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /admin\n" } }),
    );
    await addSitemapUrls(crawlId, ["https://www.robots.example/admin/secret"]);

    const found = await run("robots.blocks-sitemap-urls", crawlId);
    expect(found).toHaveLength(1);
    // Reported under the spelling the sitemap published, not the rewritten one.
    expect(found[0]!.pageUrl).toBe("https://www.robots.example/admin/secret");
    expect(found[0]!.evidence).toMatchObject({
      url: "https://www.robots.example/admin/secret",
      matchedBy: { line: 2, text: "Disallow: /admin" },
    });
  });

  it("matches the crawl's own user agent, not a generic one", async () => {
    const raw = `User-agent: ${UA}\nDisallow: /admin\n\nUser-agent: *\nAllow: /\n`;
    const blocked = await newCrawl(mkDiscovery({ robots: { raw } }));
    await addSitemapUrls(blocked, [`${SITE}/admin/secret`]);
    expect(await run("robots.blocks-sitemap-urls", blocked)).toHaveLength(1);

    // The same robots.txt, read on behalf of a crawl that identified itself as
    // something else: the group that names us no longer applies.
    const other = await newCrawl(mkDiscovery({ robots: { raw } }), {
      maxPages: 500,
      userAgent: "SomeOtherBot",
    });
    await addSitemapUrls(other, [`${SITE}/admin/secret`]);
    expect(await run("robots.blocks-sitemap-urls", other)).toHaveLength(0);
  });

  // No fallback user agent: matching a robots.txt group is the whole rule, and
  // a guessed agent would silently judge the site against a group it never had.
  it("refuses to run when the stored config records no user agent", async () => {
    const crawlId = await newCrawl(mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /a\n" } }), {
      maxPages: 500,
    });
    await addSitemapUrls(crawlId, [`${SITE}/a`]);
    await expect(run("robots.blocks-sitemap-urls", crawlId)).rejects.toThrow(/user agent/i);
  });

  it("is silent when robots.txt is absent: allow-all disallows nothing", async () => {
    const crawlId = await newCrawl(mkDiscovery({ robots: { outcome: "absent", raw: null } }));
    await addSitemapUrls(crawlId, [`${SITE}/admin/secret`]);
    expect(await run("robots.blocks-sitemap-urls", crawlId)).toHaveLength(0);
    // And nothing was skipped: an absent robots.txt is a complete answer.
    expect(await run("robots.check-skipped", crawlId)).toHaveLength(0);
  });

  it("caps the findings and says so on the last one", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /admin\n" } }),
    );
    const total = URL_FINDING_CAP + 1;
    await addSitemapUrls(
      crawlId,
      Array.from({ length: total }, (_, i) => `${SITE}/admin/${String(i).padStart(4, "0")}`),
    );

    const found = await run("robots.blocks-sitemap-urls", crawlId);
    expect(found).toHaveLength(URL_FINDING_CAP);
    // The count is exact: the cap bounds what is reported, never what is known.
    expect(found[found.length - 1]!.evidence).toMatchObject({
      truncated: { reported: URL_FINDING_CAP, total },
    });
    // And only the last one carries it.
    expect(found[0]!.evidence).not.toHaveProperty("truncated");
  });

  // ------------------------------------------------------- robots.check-skipped

  it("refuses to conclude from a truncated robots.txt, and says which cap stopped it", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({
        robots: { raw: "User-agent: *\nDisallow: /admin\n", truncated: true },
      }),
    );
    await addSitemapUrls(crawlId, [`${SITE}/admin/secret`]);

    // The URL the truncated text disallows is NOT reported: a 500KB prefix has
    // no `Disallow` past the cap, so neither a fire nor a silence from it is
    // sound (RFC 9309 §2.3.1.4, and the DiscoveryEvidence.truncated contract).
    expect(await run("robots.blocks-sitemap-urls", crawlId)).toHaveLength(0);

    const skipped = await run("robots.check-skipped", crawlId);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!).toMatchObject({
      ruleId: "robots.check-skipped",
      severity: "info",
      pageId: null,
      pageUrl: null,
      dedupeKey: "site",
    });
    expect(String((skipped[0]!.evidence as { skipped: string }).skipped)).toMatch(/500KB|read cap/);
    // `robotsTruncated`, not `truncated`: the second name belongs to the
    // truncation note a capped listing writes, and one evidence object must
    // not spell two different facts the same way.
    expect(skipped[0]!.evidence).toMatchObject({ outcome: "read", robotsTruncated: true });
  });

  it("is silent when the robots.txt was read whole", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /admin\n" } }),
    );
    expect(await run("robots.check-skipped", crawlId)).toHaveLength(0);
  });

  // ----------------------------------------------------------------- the reads

  it("refuses a crawl id nothing knows, naming it", async () => {
    const missing = `crawl_${randomUUID()}`;
    for (const r of robotsRules) {
      await expect(r.run(db, missing), r.id).rejects.toThrow(missing);
    }
  });

  // `discovery_jsonb` is written by `runCrawl` before the frontier is seeded,
  // unconditionally. A null column is therefore not "the crawl chose not to
  // look" — it is a row no crawl of this engine produced, which the rules
  // cannot interpret. A loud error, never a quiet pass (hard rule 7).
  it("refuses a crawl row with no discovery evidence", async () => {
    const crawlId = await newCrawl(null);
    for (const r of robotsRules) {
      await expect(r.run(db, crawlId), r.id).rejects.toThrow(/discovery/i);
    }
  });

  it("refuses discovery evidence that is not the shape the crawl writes", async () => {
    const crawlId = await newCrawl({ robots: "yes" });
    for (const r of robotsRules) {
      await expect(r.run(db, crawlId), r.id).rejects.toThrow(/discovery/i);
    }
  });

  // This rule judges `url_normalised` — the spelling the crawler would have
  // fetched — so a crawl whose sitemap rows predate that column hands
  // robots-parser an empty string, which it cannot judge and answers
  // `undefined` for. The rule would then report nothing at all: a false
  // ALL-CLEAR over a sitemap it never checked. Refused, by the same gate the
  // sitemap rules use, and only for the rule that reads the column.
  it("refuses a crawl whose sitemap rows predate url_normalised", async () => {
    const crawlId = await newCrawl(
      mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /private/\n" } }),
    );
    // The shape migration 0006 left behind: published spelling, column default.
    await db.insert(sitemapUrls).values({
      crawlId,
      url: `${SITE}/private/hidden`,
      sitemapSource: `${SITE}/sitemap.xml`,
      lastmod: null,
    });

    const blocks = robotsRules.find((r) => r.id === "robots.blocks-sitemap-urls");
    if (blocks === undefined) throw new Error("robots.blocks-sitemap-urls is not registered");
    await expect(blocks.run(db, crawlId)).rejects.toThrow(
      /no normalised spelling.*Re-crawl the site/s,
    );
    await expect(blocks.run(db, crawlId)).rejects.toThrow(crawlId);

    // The other two read the discovery blob alone and never touch the column.
    for (const id of ["robots.missing", "robots.check-skipped"]) {
      const other = robotsRules.find((r) => r.id === id);
      if (other === undefined) throw new Error(`${id} is not registered`);
      await expect(other.run(db, crawlId), id).resolves.toBeDefined();
    }
  });
});

/**
 * `robots.blocks-internal-urls` (Phase 23 T3, study D1): the rows the crawl
 * RECORDED and never requested because robots.txt disallowed them, each with
 * the internal links that point at it.
 *
 * Rows are hand-built to the shape the crawl loop writes: `fetch_class
 * 'disallowed'`, `fetch_reason 'robots.txt: <the matching line>'`, no status.
 * The rule reads the database only — the line is the one the crawl stored, not
 * a re-parse.
 */
describe("robots.blocks-internal-urls against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];
  const ROBOTS_REASON = "robots.txt: Disallow: /private/";

  const blocked = (): QueryRule => {
    const r = robotsRules.find((rule) => rule.id === "robots.blocks-internal-urls");
    if (r === undefined) throw new Error("robots.blocks-internal-urls is not registered");
    return r;
  };

  async function newCrawl(dropped: number | null = 0): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 500, userAgent: UA },
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 1,
      discovery: mkDiscovery({ robots: { raw: "User-agent: *\nDisallow: /private/\n" } }),
      robotsBlockedDropped: dropped,
    });
    createdCrawls.push(id);
    return id;
  }

  interface RowSpec {
    path: string;
    fetchClass?: string;
    fetchReason?: string | null;
    statusCode?: number | null;
  }

  async function addPages(crawlId: string, specs: RowSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => ({
      id: `page_${randomUUID()}`,
      crawlId,
      url: `${SITE}${s.path}`,
      urlNormalised: normalised(`${SITE}${s.path}`),
      fetchClass: s.fetchClass ?? "ok",
      fetchReason: s.fetchReason ?? null,
      statusCode: s.statusCode === undefined ? 200 : s.statusCode,
      isIndexable: (s.fetchClass ?? "ok") === "ok",
      depth: 1,
      discoveredVia: "link",
    }));
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function addLink(
    crawlId: string,
    sourceId: string,
    target: string,
    position: number,
    isInternal = true,
  ): Promise<void> {
    await db.insert(links).values({
      crawlId,
      sourcePageId: sourceId,
      targetUrl: `${SITE}${target}`,
      targetPageId: null,
      anchor: "go",
      rel: null,
      isInternal,
      isNofollow: false,
      position,
    });
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("reports each robots-blocked URL once, with the line that blocked it and its inlinks", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a" },
      { path: "/b" },
      { path: "/private/x", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
      { path: "/private/y", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
    ]);
    await addLink(crawlId, ids.get("/a")!, "/private/x", 0);
    await addLink(crawlId, ids.get("/b")!, "/private/x", 0);
    await addLink(crawlId, ids.get("/a")!, "/private/y", 1);

    const found = await blocked().run(db, crawlId);
    expect(found.map((f) => ({ pageId: f.pageId, pageUrl: f.pageUrl, evidence: f.evidence }))).toEqual([
      {
        pageId: ids.get("/private/x"),
        pageUrl: `${SITE}/private/x`,
        evidence: { matchedRule: "Disallow: /private/", inlinks: 2 },
      },
      {
        pageId: ids.get("/private/y"),
        pageUrl: `${SITE}/private/y`,
        evidence: { matchedRule: "Disallow: /private/", inlinks: 1 },
      },
    ]);
    expect(found.every((f) => f.severity === "warning")).toBe(true);
  });

  it("never reports a URL our own policy refused: that is `disallowed` without the robots reason", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a" },
      {
        path: "/internal-admin",
        fetchClass: "disallowed",
        fetchReason: "blocked host (169.254.169.254)",
        statusCode: null,
      },
    ]);
    await addLink(crawlId, ids.get("/a")!, "/internal-admin", 0);
    expect(await blocked().run(db, crawlId)).toEqual([]);
  });

  it("is silent about a blocked row no internal link points at", async () => {
    // The seed or a redirect target: on record, but "linked from crawled
    // pages" is not true of it. An external link does not count either.
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a" },
      { path: "/private/z", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
    ]);
    await addLink(crawlId, ids.get("/a")!, "/private/z", 0, false);
    expect(await blocked().run(db, crawlId)).toEqual([]);
  });

  it("caps the listing with an exact total", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      { path: "/a" },
      { path: "/private/1", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
      { path: "/private/2", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
      { path: "/private/3", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
    ]);
    for (const [i, p] of ["/private/1", "/private/2", "/private/3"].entries()) {
      await addLink(crawlId, ids.get("/a")!, p, i);
    }
    const found = await blocked().run(db, crawlId, { listing: 2 });
    expect(found.map((f) => f.pageUrl)).toEqual([`${SITE}/private/1`, `${SITE}/private/2`]);
    expect(found[1]!.evidence).toMatchObject({ truncated: { reported: 2, total: 3 } });
    expect(found[0]!.evidence).not.toHaveProperty("truncated");
  });

  it("says the list is incomplete when the crawl turned blocked URLs away", async () => {
    const crawlId = await newCrawl(5);
    const ids = await addPages(crawlId, [
      { path: "/a" },
      { path: "/private/1", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
    ]);
    await addLink(crawlId, ids.get("/a")!, "/private/1", 0);
    const found = await blocked().run(db, crawlId);
    // A lower bound, not a total: the crawl counted discoveries it turned
    // away, not distinct URLs, so the honest claim is "at least one more".
    expect(found[0]!.evidence).toMatchObject({ truncated: { reported: 1, atLeast: 2 } });
  });

  it("reads a null overflow count (a crawl before 0020) as unmeasured, never as truncated", async () => {
    const crawlId = await newCrawl(null);
    const ids = await addPages(crawlId, [
      { path: "/a" },
      { path: "/private/1", fetchClass: "disallowed", fetchReason: ROBOTS_REASON, statusCode: null },
    ]);
    await addLink(crawlId, ids.get("/a")!, "/private/1", 0);
    const found = await blocked().run(db, crawlId);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).not.toHaveProperty("truncated");
  });

  it("refuses a crawl id nothing knows, naming it", async () => {
    await expect(blocked().run(db, "crawl_nope")).rejects.toThrow(/crawl_nope/);
  });
});
