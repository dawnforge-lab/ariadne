/**
 * The `url_params` derivation, against a real database.
 *
 * A derivation is not a rule: it writes an inventory table nobody is accused
 * by. What is under test is therefore the arithmetic — which param names the
 * crawl's URLs carry, how many URLs carry each, which of them are tracking
 * params — and the one property that makes it safe to run twice: re-deriving a
 * crawl replaces that crawl's rows and touches no other crawl's.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages, urlParams } from "../../src/db/schema.js";
import { deriveUrlParams, TRACKING_PARAMS } from "../../src/rules/derive/url-params.js";
import { mkDiscovery } from "./mk-discovery.js";
import { LOCAL_TENANT } from "../../src/api/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://params.example";

describe("TRACKING_PARAMS", () => {
  // The list is a single definition shared by the derivation and by
  // `url.tracking-params-internal` (which reads it to build its SQL pattern).
  // Pinned here so a name added for one of them is added for both.
  it("is exactly the fifteen names the plan's table names", () => {
    expect([...TRACKING_PARAMS].sort()).toEqual(
      [
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "gclid", "gbraid", "wbraid", "fbclid", "msclkid",
        "mc_cid", "mc_eid", "igshid", "twclid", "ttclid",
      ].sort(),
    );
  });

  // The rule builds a POSIX regex by joining these names with `|`. A name
  // carrying a regex metacharacter would silently change what that pattern
  // matches, so the shape is asserted rather than assumed.
  it("holds only names that are literal in a regex alternation", () => {
    for (const name of TRACKING_PARAMS) expect(name, name).toMatch(/^[a-z_]+$/);
  });
});

describe("deriveUrlParams against the database", () => {
  let db: Db;
  const createdCrawls: string[] = [];

  async function newCrawl(): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
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

  async function addPages(crawlId: string, paths: string[]): Promise<void> {
    await db.insert(pages).values(
      paths.map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId,
        url: `${SITE}${path}`,
        urlNormalised: `${SITE}${path}`,
        fetchClass: "ok",
        statusCode: 200,
        isIndexable: true,
        depth: 1,
        discoveredVia: "link",
      })),
    );
  }

  async function storedParams(
    crawlId: string,
  ): Promise<{ name: string; count: number; tracking: boolean; samples: string[] }[]> {
    const rows = await db
      .select()
      .from(urlParams)
      .where(eq(urlParams.crawlId, crawlId))
      .orderBy(asc(urlParams.paramName));
    return rows.map((r) => ({
      name: r.paramName,
      count: r.occurrenceCount,
      tracking: r.isTracking,
      samples: r.sampleUrls,
    }));
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("writes one row per param name, splitting tracking from the rest", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/a?b=1&utm_source=x", "/c?b=2"]);

    expect(await deriveUrlParams(db, crawlId)).toEqual({ params: 2 });
    expect(await storedParams(crawlId)).toEqual([
      { name: "b", count: 2, tracking: false, samples: [`${SITE}/a?b=1&utm_source=x`, `${SITE}/c?b=2`] },
      { name: "utm_source", count: 1, tracking: true, samples: [`${SITE}/a?b=1&utm_source=x`] },
    ]);
  });

  it("counts URLs, not occurrences: a param repeated in one URL counts once", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/a?tag=1&tag=2&tag=3"]);

    await deriveUrlParams(db, crawlId);
    expect(await storedParams(crawlId)).toEqual([
      { name: "tag", count: 1, tracking: false, samples: [`${SITE}/a?tag=1&tag=2&tag=3`] },
    ]);
  });

  it("keeps the count exact past the five-URL sample cap", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, [1, 2, 3, 4, 5, 6, 7].map((n) => `/p${n}?page=${n}`));

    await deriveUrlParams(db, crawlId);
    const [row] = await storedParams(crawlId);
    expect(row?.count).toBe(7);
    // Lexically first five, so the sample is deterministic rather than
    // whatever order the scan happened to return.
    expect(row?.samples).toEqual([1, 2, 3, 4, 5].map((n) => `${SITE}/p${n}?page=${n}`));
  });

  it("records a valueless param under its bare name", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/a?debug"]);

    await deriveUrlParams(db, crawlId);
    expect((await storedParams(crawlId)).map((r) => r.name)).toEqual(["debug"]);
  });

  it("writes nothing for a crawl whose URLs carry no query string", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/", "/about"]);

    expect(await deriveUrlParams(db, crawlId)).toEqual({ params: 0 });
    expect(await storedParams(crawlId)).toEqual([]);
  });

  it("is idempotent: a second run leaves the same rows", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/a?b=1", "/c?b=2&fbclid=z"]);

    const first = await deriveUrlParams(db, crawlId);
    const afterFirst = await storedParams(crawlId);
    const second = await deriveUrlParams(db, crawlId);

    expect(second).toEqual(first);
    expect(await storedParams(crawlId)).toEqual(afterFirst);
  });

  it("replaces the crawl's inventory rather than adding to it", async () => {
    const crawlId = await newCrawl();
    await addPages(crawlId, ["/a?gone=1"]);
    await deriveUrlParams(db, crawlId);
    expect((await storedParams(crawlId)).map((r) => r.name)).toEqual(["gone"]);

    // The crawl is re-crawled over the same row: the old URL is replaced by a
    // new one. A derivation that only inserted would leave `gone` behind as an
    // inventory entry for a param the crawl no longer sees.
    await db.delete(pages).where(eq(pages.crawlId, crawlId));
    await addPages(crawlId, ["/a?fresh=1"]);
    await deriveUrlParams(db, crawlId);
    expect((await storedParams(crawlId)).map((r) => r.name)).toEqual(["fresh"]);
  });

  it("is scoped to one crawl: deriving mine does not read or delete yours", async () => {
    const mine = await newCrawl();
    const yours = await newCrawl();
    await addPages(mine, ["/a?mine=1"]);
    await addPages(yours, ["/a?yours=1"]);

    await deriveUrlParams(db, yours);
    await deriveUrlParams(db, mine);

    expect((await storedParams(mine)).map((r) => r.name)).toEqual(["mine"]);
    expect((await storedParams(yours)).map((r) => r.name)).toEqual(["yours"]);
  });

  it("refuses a crawl id nothing knows rather than reporting an empty inventory", async () => {
    await expect(deriveUrlParams(db, "crawl_nope")).rejects.toThrow(/no such crawl/);
  });
});
