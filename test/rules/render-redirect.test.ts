/**
 * `redirect.js`, against a real database.
 *
 * The rule with the gate that is deliberately NOT `rendered = true`, so most of
 * this file is about which rows reach it: a page that redirected itself and was
 * measured, a page that redirected itself OFF-SITE and could therefore not be
 * measured at all, and a page the server itself redirected — which belongs to
 * the HTTP redirect rules and must not be claimed twice.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { normalizeUrl } from "../../src/crawl/parse/url-utils.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { renderRedirectRules } from "../../src/rules/query/render-redirect.js";
import type { QueryRule } from "../../src/rules/registry/types.js";
import { databaseUrl } from "./metric-db.js";

const SITE = "https://jsredirect.example";
const url = (path: string): string => `${SITE}${path}`;

const byId = new Map(renderRedirectRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in renderRedirectRules`);
  return r;
}

describe("renderRedirectRules metadata", () => {
  it("defines the one rule of the plan's table, with its check and severity", () => {
    expect(renderRedirectRules.map((r) => r.id)).toEqual(["redirect.js"]);
    const r = rule("redirect.js");
    expect(r.kind).toBe("query");
    // CHECK-10 is the redirect check, shared with `redirect.chain`,
    // `redirect.loop` and the `redirect.volume` metric: this is the shape of it
    // no HTTP-level rule can see.
    expect(r.checkIds).toEqual(["CHECK-10"]);
    expect(r.severity).toBe("warning");
    expect(r.category).toBe("redirects");
    expect(r.title.length).toBeGreaterThan(5);
    expect(r.explanation.length).toBeGreaterThan(40);
    expect(r.rulesetVersion).toBeTruthy();
  });
});

describe("redirect.js against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  interface PageSpec {
    path: string;
    fetchClass?: string;
    statusCode?: number;
    rendered?: boolean;
    renderedRedirectUrl?: string | null;
    renderError?: string | null;
  }

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { userAgent: "AriadneBot-test", maxPages: 500 },
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    return id;
  }

  async function addPages(crawlId: string, specs: PageSpec[]): Promise<Map<string, string>> {
    const rows = specs.map((s) => {
      const full = url(s.path);
      const normalised = normalizeUrl(full);
      if (normalised === null) throw new Error(`${full} does not normalise`);
      const rendered = s.rendered ?? false;
      return {
        id: `page_${randomUUID()}`,
        crawlId,
        url: full,
        urlNormalised: normalised,
        fetchClass: s.fetchClass ?? "ok",
        statusCode: s.statusCode ?? 200,
        isIndexable: (s.fetchClass ?? "ok") === "ok" && (s.statusCode ?? 200) === 200,
        depth: 1,
        discoveredVia: "link",
        rendered,
        // The render pass's shapes, kept honest: counts only where the render
        // finished, and the redirect column set independently of both.
        renderedWordCount: rendered ? 400 : null,
        renderedLinkCount: rendered ? 20 : null,
        renderedNavLinkCount: rendered ? 12 : null,
        renderedFooterLinkCount: rendered ? 8 : null,
        renderedFilterLinkCount: rendered ? 0 : null,
        renderedRedirectUrl: s.renderedRedirectUrl ?? null,
        renderError: s.renderError ?? null,
      };
    });
    await db.insert(pages).values(rows);
    return new Map(rows.map((r, i) => [specs[i]!.path, r.id]));
  }

  async function firedPaths(crawlId: string): Promise<string[]> {
    const findings = await rule("redirect.js").run(db, crawlId);
    for (const f of findings) expect(f.ruleId).toBe("redirect.js");
    return findings.map((f) => (f.pageUrl ?? "").slice(SITE.length));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  // The gate, case by case:
  //
  //   /same-site-hop   ok/200, rendered, redirect column set        FIRES
  //   /off-site-hop    ok/200, NOT rendered (the navigation to
  //                    another origin was aborted), redirect
  //                    column set, render error saying so           FIRES
  //   /http-301        fetch_class 'redirect', redirect column set  silent
  //   /plain-page      ok/200, rendered, redirect column null       silent
  //   /never-rendered  ok/200, never selected, everything null      silent
  //
  // `/off-site-hop` is the case the whole gate is built around. Gating on
  // `rendered = true` would drop it, and it is both the commonest shape of the
  // defect and the worst one: the page sends visitors and crawlers to another
  // site entirely.
  it("fires on a JavaScript redirect whether or not the render finished", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/same-site-hop",
        rendered: true,
        renderedRedirectUrl: url("/target"),
      },
      {
        path: "/off-site-hop",
        rendered: false,
        renderedRedirectUrl: "https://elsewhere.example/landing",
        renderError: "off-site navigation: https://elsewhere.example/landing",
      },
      {
        path: "/http-301",
        fetchClass: "redirect",
        statusCode: 301,
        renderedRedirectUrl: url("/target"),
      },
      { path: "/plain-page", rendered: true },
      { path: "/never-rendered" },
    ]);

    expect(await firedPaths(crawlId)).toEqual(["/off-site-hop", "/same-site-hop"]);
  });

  // The HTTP redirect is silent HERE, not silent everywhere: the redirect rules
  // claim it. Asserted as its own case so the exclusion reads as a division of
  // labour rather than as a page nobody reports.
  it("leaves a server-side redirect to the HTTP redirect rules", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [
      {
        path: "/server-moved",
        fetchClass: "redirect",
        statusCode: 302,
        rendered: false,
        renderedRedirectUrl: url("/final"),
      },
    ]);
    expect(await firedPaths(crawlId)).toEqual([]);
  });

  it("quotes both URLs and which shape of the defect this is", async () => {
    const crawlId = await newCrawl();
    const ids = await addPages(crawlId, [
      {
        path: "/off-site-evidence",
        rendered: false,
        renderedRedirectUrl: "https://elsewhere.example/landing",
        renderError: "off-site navigation: https://elsewhere.example/landing",
      },
      { path: "/on-site-evidence", rendered: true, renderedRedirectUrl: url("/target") },
    ]);
    const findings = await rule("redirect.js").run(db, crawlId);
    expect(findings).toHaveLength(2);

    const offSite = findings.find((f) => f.pageId === ids.get("/off-site-evidence"))!;
    expect(offSite.severity).toBe("warning");
    expect(offSite.dedupeKey).toBe(url("/off-site-evidence"));
    expect(offSite.evidence).toEqual({
      fromUrl: url("/off-site-evidence"),
      toUrl: "https://elsewhere.example/landing",
      statusCode: 200,
      // The render that discovered it could not finish, and the evidence says
      // so: a reader who saw only the two URLs could not tell this page from
      // one that rewrote its own URL and stayed.
      rendered: false,
      renderError: "off-site navigation: https://elsewhere.example/landing",
    });

    const onSite = findings.find((f) => f.pageId === ids.get("/on-site-evidence"))!;
    expect(onSite.evidence).toEqual({
      fromUrl: url("/on-site-evidence"),
      toUrl: url("/target"),
      statusCode: 200,
      rendered: true,
      renderError: null,
    });
  });

  it("refuses a crawl id nothing knows", async () => {
    await expect(rule("redirect.js").run(db, `crawl_${randomUUID()}`)).rejects.toThrow(
      /no such crawl/,
    );
  });

  it("reads only its own crawl", async () => {
    const other = await newCrawl();
    await addPages(other, [
      { path: "/other-hop", rendered: true, renderedRedirectUrl: url("/target") },
    ]);
    const mine = await newCrawl();
    await addPages(mine, [{ path: "/mine-plain", rendered: true }]);
    expect(await firedPaths(mine)).toEqual([]);
    expect(await firedPaths(other)).toEqual(["/other-hop"]);
  });
});
