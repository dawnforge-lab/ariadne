/**
 * The host-variant rules, against a real database.
 *
 * Their whole input is one jsonb column — `crawls.host_probe_jsonb`, written by
 * `probeHostVariants` before the crawl starts — so the rows here are hand-built
 * `HostProbeResult`s, typed as such: a test cannot describe a probe result the
 * prober could never have produced, and a change to the probe's shape breaks
 * these tests at compile time rather than leaving them asserting against a blob
 * nothing writes any more.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { HostProbeResult, HostProbeVariant } from "../../src/crawl/host-probe.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls } from "../../src/db/schema.js";
import { hostRules } from "../../src/rules/query/host.js";
import type { Finding, QueryRule } from "../../src/rules/registry/types.js";
import { mkDiscovery } from "./mk-discovery.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://hosts.example";

const byId = new Map(hostRules.map((r) => [r.id, r]));
function rule(id: string): QueryRule {
  const r = byId.get(id);
  if (!r) throw new Error(`no rule '${id}' in hostRules`);
  return r;
}

/** A chain that answers `status` at its start URL and goes no further. */
function lands(start: string, status: number): HostProbeVariant {
  return {
    start,
    hops: [{ url: start, statusCode: status, fetchClass: status === 200 ? "ok" : "client_error", location: null }],
    final: start,
  };
}

/** A chain that redirects once and then answers 200 at `to`. */
function redirectsTo(start: string, to: string): HostProbeVariant {
  return {
    start,
    hops: [
      { url: start, statusCode: 301, fetchClass: "redirect", location: to },
      { url: to, statusCode: 200, fetchClass: "ok", location: null },
    ],
    final: to,
  };
}

/** A chain where nothing answered: DNS or TLS failure, recorded as the terminal hop. */
function unreachable(start: string): HostProbeVariant {
  return {
    start,
    hops: [{ url: start, statusCode: null, fetchClass: "network_error", location: null }],
    final: null,
  };
}

const APEX_HTTP = "http://hosts.example/";
const APEX_HTTPS = "https://hosts.example/";
const WWW_HTTP = "http://www.hosts.example/";
const WWW_HTTPS = "https://www.hosts.example/";

/** The healthy site: every spelling redirects into the canonical https apex. */
function healthy(): HostProbeResult {
  return {
    variants: [
      redirectsTo(APEX_HTTP, APEX_HTTPS),
      lands(APEX_HTTPS, 200),
      redirectsTo(WWW_HTTP, APEX_HTTPS),
      redirectsTo(WWW_HTTPS, APEX_HTTPS),
    ],
  };
}

describe("hostRules metadata", () => {
  it("defines the three host rules and the statement that the probe did not run", () => {
    expect(hostRules.map((r) => r.id).sort()).toEqual([
      "host.duplicate-host-200",
      "host.http-serves-200",
      "host.legacy-host-reachable",
      "host.probe-skipped",
    ]);
  });

  it("claims the checklist ids, severities and categories the table assigns", () => {
    expect(
      Object.fromEntries(hostRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "host.http-serves-200": [["CHECK-14"], "critical", "host"],
      "host.duplicate-host-200": [["CHECK-15"], "critical", "host"],
      "host.legacy-host-reachable": [["CHECK-15"], "warning", "host"],
      // The skip covers both checks, because both are unanswerable without the
      // probe.
      "host.probe-skipped": [["CHECK-14", "CHECK-15"], "info", "host"],
    });
  });

  it("every rule is a query rule carrying its own copy and a ruleset version", () => {
    const titles = new Set<string>();
    for (const r of hostRules) {
      expect(r.kind, r.id).toBe("query");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.explanation.length, r.id).toBeGreaterThan(40);
      expect(r.rulesetVersion, r.id).toBeTruthy();
      titles.add(r.title);
    }
    expect(titles.size).toBe(hostRules.length);
  });
});

describe("the host rules against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(
    hostProbe: HostProbeResult | null,
    siteUrl = SITE,
    legacyHosts: string[] = [],
  ): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl,
      config: { userAgent: "AriadneBot-test", maxPages: 500, legacyHosts },
      rulesetVersion: "test",
      status: "finished",
      discovery: mkDiscovery(),
      hostProbe,
    });
    createdCrawls.push(id);
    return id;
  }

  const run = (id: string, crawlId: string): Promise<Finding[]> => rule(id).run(db, crawlId);

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("every rule is silent on a site whose spellings all redirect to one canonical host", async () => {
    const crawlId = await newCrawl(healthy());
    for (const r of hostRules) expect(await r.run(db, crawlId), r.id).toHaveLength(0);
  });

  describe("host.http-serves-200", () => {
    const ID = "host.http-serves-200";

    it("reports an http spelling that answers 200 instead of redirecting", async () => {
      const probe = healthy();
      probe.variants[0] = lands(APEX_HTTP, 200);
      const crawlId = await newCrawl(probe);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: rule(ID).severity,
        pageId: null,
        pageUrl: APEX_HTTP,
        dedupeKey: APEX_HTTP,
      });
      expect(found[0]!.evidence).toEqual({
        variant: APEX_HTTP,
        hops: probe.variants[0]!.hops,
      });
    });

    it("reports each http spelling separately", async () => {
      const probe = healthy();
      probe.variants[0] = lands(APEX_HTTP, 200);
      probe.variants[2] = lands(WWW_HTTP, 200);
      const crawlId = await newCrawl(probe);
      expect((await run(ID, crawlId)).map((f) => f.dedupeKey)).toEqual([APEX_HTTP, WWW_HTTP]);
    });

    it("reports a chain that redirects DOWN into an http 200", async () => {
      // The condition is the final hop, not the start: a spelling that lands on
      // http with a 200 serves the site over http however it got there.
      const probe = healthy();
      probe.variants[3] = redirectsTo(WWW_HTTPS, APEX_HTTP);
      const crawlId = await newCrawl(probe);
      expect((await run(ID, crawlId)).map((f) => f.dedupeKey)).toEqual([WWW_HTTPS]);
    });

    it("is silent on an http spelling that answers something other than 200", async () => {
      const probe = healthy();
      probe.variants[0] = lands(APEX_HTTP, 403);
      const crawlId = await newCrawl(probe);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent on an http spelling nothing answered at all", async () => {
      const probe = healthy();
      probe.variants[0] = unreachable(APEX_HTTP);
      const crawlId = await newCrawl(probe);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });
  });

  describe("host.duplicate-host-200", () => {
    const ID = "host.duplicate-host-200";

    it("reports the www and apex https spellings both serving 200", async () => {
      const probe = healthy();
      probe.variants[3] = lands(WWW_HTTPS, 200);
      const crawlId = await newCrawl(probe);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: rule(ID).severity,
        pageId: null,
        pageUrl: null,
        dedupeKey: "www-apex",
      });
      expect(found[0]!.evidence).toEqual({
        variants: [APEX_HTTPS, WWW_HTTPS],
        finals: [APEX_HTTPS, WWW_HTTPS],
      });
    });

    it("fires when a spelling redirects WITHIN its own host and then serves 200", async () => {
      // The question is whether both names serve the site, not how many hops it
      // takes: www.hosts.example/ -> www.hosts.example/home is still the www
      // host serving the site under its own name.
      const probe = healthy();
      probe.variants[3] = redirectsTo(WWW_HTTPS, `${WWW_HTTPS}home`);
      const crawlId = await newCrawl(probe);
      expect(await run(ID, crawlId)).toHaveLength(1);
    });

    it("is silent when one spelling redirects into the other", async () => {
      // healthy() is exactly that configuration, asserted here on its own so
      // the silence is pinned to the redirect rather than to the fixture.
      const crawlId = await newCrawl(healthy());
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when only one of the two answers 200", async () => {
      const probe = healthy();
      probe.variants[3] = lands(WWW_HTTPS, 404);
      const crawlId = await newCrawl(probe);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("is silent when the site is addressed by IP and has no www twin", async () => {
      const crawlId = await newCrawl(
        { variants: [lands("https://203.0.113.7/", 200), lands("http://203.0.113.7/", 200)] },
        "https://203.0.113.7/",
      );
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("reads the site's own spellings, whichever way round the seed was written", async () => {
      // Seeded as www: the apex is still the other spelling of the same site.
      const probe = healthy();
      probe.variants[3] = lands(WWW_HTTPS, 200);
      const crawlId = await newCrawl(probe, "https://www.hosts.example/");
      expect(await run(ID, crawlId)).toHaveLength(1);
    });
  });

  describe("host.legacy-host-reachable", () => {
    const ID = "host.legacy-host-reachable";

    const LEGACY_HTTPS = "https://old.example/";

    it("reports a legacy host that still answers 200 in its own right", async () => {
      const probe = healthy();
      probe.variants.push(lands(LEGACY_HTTPS, 200));
      const crawlId = await newCrawl(probe, SITE, ["old.example"]);

      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: rule(ID).severity,
        pageId: null,
        pageUrl: LEGACY_HTTPS,
        dedupeKey: LEGACY_HTTPS,
      });
      expect(found[0]!.evidence).toEqual({
        variant: LEGACY_HTTPS,
        hops: [{ url: LEGACY_HTTPS, statusCode: 200, fetchClass: "ok", location: null }],
      });
    });

    it("is silent on a legacy host that redirects into the live site", async () => {
      const probe = healthy();
      probe.variants.push(redirectsTo(LEGACY_HTTPS, APEX_HTTPS));
      const crawlId = await newCrawl(probe, SITE, ["old.example"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("fires when the legacy host redirects to a page of its own", async () => {
      const probe = healthy();
      probe.variants.push(redirectsTo(LEGACY_HTTPS, `${LEGACY_HTTPS}home`));
      const crawlId = await newCrawl(probe, SITE, ["old.example"]);
      expect((await run(ID, crawlId)).map((f) => f.dedupeKey)).toEqual([LEGACY_HTTPS]);
    });

    it("is silent on a legacy host that no longer resolves", async () => {
      const probe = healthy();
      probe.variants.push(unreachable(LEGACY_HTTPS));
      const crawlId = await newCrawl(probe, SITE, ["old.example"]);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });

    it("never reports one of the site's own spellings as a legacy host", async () => {
      const probe = healthy();
      probe.variants[3] = lands(WWW_HTTPS, 200);
      const crawlId = await newCrawl(probe);
      expect(await run(ID, crawlId)).toHaveLength(0);
    });
  });

  describe("host.probe-skipped", () => {
    const ID = "host.probe-skipped";

    it("says so, once, when the crawl recorded no host probe", async () => {
      const crawlId = await newCrawl(null);
      const found = await run(ID, crawlId);
      expect(found).toHaveLength(1);
      expect(found[0]!).toMatchObject({
        ruleId: ID,
        severity: "info",
        pageId: null,
        pageUrl: null,
        dedupeKey: "site",
      });
      expect(String(found[0]!.evidence["skipped"])).toMatch(/probe/i);
    });

    it("and the three rules it stands in for stay silent on that crawl", async () => {
      const crawlId = await newCrawl(null);
      for (const id of [
        "host.http-serves-200",
        "host.duplicate-host-200",
        "host.legacy-host-reachable",
      ]) {
        expect(await run(id, crawlId), id).toHaveLength(0);
      }
    });

    it("is silent when the probe did run", async () => {
      const crawlId = await newCrawl(healthy());
      expect(await run(ID, crawlId)).toHaveLength(0);
    });
  });

  describe("the stored blob is validated, not cast", () => {
    it.each([
      ["not an object", 42],
      ["no variants array", { variants: "all of them" }],
      ["a variant with no start", { variants: [{ hops: [], final: null }] }],
      ["a variant with no hops array", { variants: [{ start: APEX_HTTPS, final: null }] }],
      [
        "a hop with a non-numeric status",
        { variants: [{ start: APEX_HTTPS, hops: [{ url: APEX_HTTPS, statusCode: "200", fetchClass: "ok", location: null }], final: APEX_HTTPS }] },
      ],
      [
        "a hop with no url",
        { variants: [{ start: APEX_HTTPS, hops: [{ statusCode: 200, fetchClass: "ok", location: null }], final: APEX_HTTPS }] },
      ],
    ])("throws on %s rather than judging the site on it", async (_name, blob) => {
      const id = `crawl_${randomUUID()}`;
      await db.insert(crawls).values({
        id,
        siteUrl: SITE,
        config: { userAgent: "AriadneBot-test" },
        rulesetVersion: "test",
        status: "finished",
        discovery: mkDiscovery(),
        hostProbe: blob,
      });
      createdCrawls.push(id);
      await expect(run("host.http-serves-200", id)).rejects.toThrow(/host probe/i);
    });

    it("refuses a crawl id nothing knows", async () => {
      for (const r of hostRules) {
        await expect(r.run(db, "crawl_nope"), r.id).rejects.toThrow(/no such crawl/);
      }
    });
  });
});
