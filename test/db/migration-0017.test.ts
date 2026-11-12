/**
 * Migration 0017: `crawls.failure_reason` — why a `failed` crawl failed.
 *
 * THE DEFECT THIS CLOSES, in one sentence from the Phase 17 gate (§5, clause
 * 5): a crawl of a host whose robots.txt answered 502 closed `failed` after 14
 * seconds, the demo page showed "failed" and nothing else, and the sentence
 * explaining it existed only in the engine's process log. `status` said
 * something went wrong and refused to say what.
 *
 * What is under test is not the DDL (`runMigrations` either applied it or
 * threw) but the CLAIMS the column makes, and they are driven through REAL
 * crawls of real fixture servers rather than through hand-written rows — the
 * migration-0013 / 0016 discipline, and it is load-bearing twice over here:
 *
 *  1. the reason on the robots path is composed by the crawl loop out of what
 *     the host actually did (the outcome, the attempt count, the status code),
 *     so a seeded row would still pass with that composition deleted;
 *  2. the healthy crawl's NULL is the other half of the contract, and only a
 *     crawl that really ran can show that a successful close writes null rather
 *     than leaving a stale sentence behind.
 *
 * The five claims:
 *
 *  1. a crawl whose robots.txt answers 502 closes `failed` AND carries a
 *     non-null `failure_reason` naming robots, the attempts and the status;
 *  2. that reason is ONE LINE and carries no stack frame — the column is a
 *     sentence, on the `pages.render_error` precedent, because it is served
 *     (`CrawlDetail.failureReason`);
 *  3. the same sentence the run's own summary reported: the row and the summary
 *     do not tell two stories about one crawl;
 *  4. a crawl that finished normally carries NULL — the reason is not a
 *     leftover of some earlier state;
 *  5. the contract itself, asked as SQL over the whole table:
 *     `failure_reason IS NOT NULL` ⟹ `status = 'failed'`. The converse is NOT
 *     asserted and must not be: a `failed` row with a null reason is a row this
 *     engine closed before 0017 existed.
 *  6. RESUMING that failed crawl clears the sentence with the status it
 *     belonged to — held mid-run against the fixture, because "running, and
 *     here is why it failed" is precisely the pair claim 5 forbids;
 *  7. and `failureReasonOf`, the one helper both writers now use, answers a
 *     sentence for an error with no message rather than throwing — a throw
 *     there is inside the recovery path and would leave the row `running`.
 *
 * …and the cascade, which every column on this table depends on.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import {
  failureReasonOf,
  resumeCrawl,
  runCrawl,
  type CrawlConfig,
  type CrawlSummary,
} from "../../src/crawl/loop.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { LOCAL_TENANT } from "../../src/tenant.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

let db: Db;

/**
 * The site whose robots.txt is DOWN — a 502 from the CDN in front of it, which
 * is the shape the gate hit on a real host. RFC 9309 §2.3.1.4 makes that a
 * complete disallow: the crawl is refused before it fetches a page, and the
 * whole point of this file is that it now says so on the row.
 *
 * Its pages answer 200 deliberately. A fixture that served errors everywhere
 * would leave "the crawl failed because the site is down" as an alternative
 * explanation for the row; this one is a healthy site behind an unhealthy
 * robots.txt, so the reason can only have come from the robots path.
 */
let brokenRobots: Server;
let brokenBase: string;

/** One crawl config for every run in this file — the resume reads it too. */
function config(siteUrl: string): CrawlConfig {
  return {
    siteUrl,
    maxPages: 10,
    maxDepth: 2,
    userAgent: "AriadneBot-0017",
    perHostDelayMs: 0,
    maxConcurrency: 2,
    probeHosts: false,
    // The sanctioned test-only use: both fixture sites are on 127.0.0.1.
    allowPrivate: true,
  };
}

/**
 * A one-shot hold on the broken robots.txt, for the resume case below.
 *
 * Armed, the next request for /robots.txt announces itself and then waits for
 * the test to let it go — which parks the resumed crawl in `running` for as
 * long as the assertion needs, instead of racing a poll against a crawl that
 * fails in milliseconds. Disarmed by the request that trips it, so the two
 * retries behind it answer 502 at once and the crawl closes as it always does.
 */
let robotsHold: { asked: () => void; release: Promise<void> } | null = null;

/** The control: an ordinary site that crawls to completion. */
let healthy: Server;
let healthyBase: string;

let failedCrawlId = "";
let failedSummary: CrawlSummary | null = null;
let okCrawlId = "";
const created: string[] = [];

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);

  brokenRobots = createServer((req, res) => {
    if ((req.url ?? "") === "/robots.txt") {
      // The gateway in front of the origin, not the origin: no body a parser
      // could read as rules, and a status that is retried and then given up on.
      const answer = (): void => {
        res.writeHead(502, { "content-type": "text/html" });
        res.end(html("<p>bad gateway</p>"));
      };
      const hold = robotsHold;
      if (hold !== null) {
        robotsHold = null;
        hold.asked();
        void hold.release.then(answer);
        return;
      }
      answer();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html("<p>a page nobody is allowed to ask for</p>"));
  });
  await new Promise<void>((ok) => brokenRobots.listen(0, "127.0.0.1", ok));
  const brokenAddr = brokenRobots.address();
  if (brokenAddr === null || typeof brokenAddr === "string") throw new Error("no fixture port");
  brokenBase = `http://127.0.0.1:${brokenAddr.port}`;

  healthy = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(`<a href="/two">two</a><p>the page a crawl starts at</p>`));
      return;
    }
    if (path === "/two") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(`<a href="/">home</a><p>the second page</p>`));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(html("<p>gone</p>"));
  });
  await new Promise<void>((ok) => healthy.listen(0, "127.0.0.1", ok));
  const healthyAddr = healthy.address();
  if (healthyAddr === null || typeof healthyAddr === "string") throw new Error("no fixture port");
  healthyBase = `http://127.0.0.1:${healthyAddr.port}`;

  failedSummary = await runCrawl(db, LOCAL_TENANT, config(`${brokenBase}/`));
  failedCrawlId = failedSummary.crawlId;
  created.push(failedCrawlId);

  const okSummary = await runCrawl(db, LOCAL_TENANT, config(`${healthyBase}/`));
  okCrawlId = okSummary.crawlId;
  created.push(okCrawlId);
}, 60_000);

afterAll(async () => {
  for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
  await closeDb(db);
  await new Promise<void>((ok) => brokenRobots.close(() => ok()));
  await new Promise<void>((ok) => healthy.close(() => ok()));
  await closeFetchAgents();
});

async function crawlRow(id: string) {
  const [row] = await db
    .select({ status: crawls.status, failureReason: crawls.failureReason })
    .from(crawls)
    .where(eq(crawls.id, id));
  if (row === undefined) throw new Error(`no crawl row for ${id}`);
  return row;
}

describe("0017 — a failed crawl says why", () => {
  it("closes the robots-502 crawl failed, with a reason naming robots and the status", async () => {
    const row = await crawlRow(failedCrawlId);
    // The premise: without a `failed` close there is nothing for the column to
    // be about, and every case below would pass vacuously.
    expect(row.status).toBe("failed");
    expect(row.failureReason, "a failed crawl closed with no reason").not.toBeNull();
    const reason = String(row.failureReason);
    // The three things a reader needs in order to know this is not a defect to
    // retry harder against: WHAT was unreachable, that we did not give up on
    // the first try, and WHAT the host answered.
    expect(reason).toContain("robots.txt unreachable");
    expect(reason).toContain("attempts");
    expect(reason).toContain("502");
    expect(reason).toContain("complete disallow");
  });

  it("records a sentence, not a stack: one line, no frames, no local path", async () => {
    // The column is SERVED as `CrawlDetail.failureReason`, so the tenant-safety
    // obligation applies to it exactly as it applies to `pages.render_error`
    // (docs/talos-surface.md §9). This is that obligation at the writer.
    const reason = String((await crawlRow(failedCrawlId)).failureReason);
    expect(reason).not.toContain("\n");
    expect(reason, "a stack frame reached the column").not.toMatch(/\s+at /);
    expect(reason, "a local path reached the column").not.toMatch(/\/(home|usr|srv|var|tmp)\//);
    expect(reason).toBe(reason.trim());
    expect(reason.length).toBeGreaterThan(0);
  });

  it("says the same thing the run's own summary said", async () => {
    // The row and the summary are two reports of one crawl. The summary's
    // `note` is what a process holding the run gets; the column is what
    // everybody else gets, and they must not diverge.
    const reason = (await crawlRow(failedCrawlId)).failureReason;
    expect(failedSummary?.status).toBe("failed");
    expect(failedSummary?.note).toBe(reason);
  });

  it("leaves the column null on a crawl that finished", async () => {
    const row = await crawlRow(okCrawlId);
    expect(row.status).toBe("finished");
    // NOT the empty string, and not a cheerful sentence: null is what "this
    // crawl did not fail" looks like, and it is the only value that keeps the
    // implication below true.
    expect(row.failureReason).toBeNull();
    // And it really crawled — a control that fetched nothing would prove
    // nothing about a successful close.
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.crawlId, okCrawlId));
    expect(count?.n).toBeGreaterThan(0);
  });

  it("clears the sentence when the failed crawl is resumed, and writes it again on the next close", async () => {
    // The row this starts from is the failed one every case above read: a real
    // crawl, closed `failed`, carrying a real reason.
    const before = await crawlRow(failedCrawlId);
    expect(before.status).toBe("failed");
    expect(before.failureReason).not.toBeNull();

    // Hold the first robots.txt request, so the resumed crawl is DEMONSTRABLY
    // mid-run when the row is read. Without the hold this is a poll racing a
    // crawl that fails in milliseconds, and a miss would look like a pass.
    let letGo = (): void => {};
    const asked = new Promise<void>((ok) => {
      robotsHold = {
        asked: ok,
        release: new Promise<void>((released) => {
          letGo = () => released();
        }),
      };
    });

    const run = resumeCrawl(db, failedCrawlId, { config: config(`${brokenBase}/`) });
    try {
      await asked;
      const mid = await crawlRow(failedCrawlId);
      // The pair the contract forbids, asked of a live row: a crawl that is
      // running does not get to keep the sentence explaining how it died.
      expect(mid.status).toBe("running");
      expect(mid.failureReason, "a resumed crawl still serves the old failure").toBeNull();
    } finally {
      letGo();
      robotsHold = null;
    }

    // And the resume is not a way to lose the reason either: this run fails the
    // same way, and the column says so again.
    const summary = await run;
    expect(summary.status).toBe("failed");
    const after = await crawlRow(failedCrawlId);
    expect(after.status).toBe("failed");
    expect(String(after.failureReason)).toContain("robots.txt unreachable");
  }, 60_000);

  it("composes a sentence for an error with no message rather than throwing", () => {
    // `failureReasonOf` runs INSIDE the recovery path that closes the row
    // `failed` (`execute` in the crawl loop, and the API queue runner's catch).
    // A throw there would abandon the close and leave the row `running` for
    // ever — the failure mode this whole column exists to end. So an empty
    // message is a sentence about the empty message, and the row still closes.
    expect(failureReasonOf(new Error(""))).toBe("the crawl threw a Error with no message");
    expect(failureReasonOf("")).toBe("the crawl threw a string with no message");
    // `String(null)` is "null", which is non-empty and would sail past a naive
    // check as if it were a reason. It is the same defect, and says so.
    expect(failureReasonOf(null)).toBe("the crawl threw a null with no message");
    expect(failureReasonOf(new Error("   \n  "))).toBe("the crawl threw a Error with no message");
    // And the ordinary case is untouched: first line, trimmed, no frames.
    expect(failureReasonOf(new Error("robots.txt unreachable\n    at somewhere:1:1"))).toBe(
      "robots.txt unreachable",
    );
  });

  it("holds failure_reason IS NOT NULL => status = 'failed' over the table", async () => {
    // Asked as SQL rather than in TypeScript because it is a claim about the
    // TABLE, not about the two rows this file created — and with those two rows
    // in it there is now a crawl on each side of the implication.
    //
    // THE CONVERSE IS DELIBERATELY NOT ASSERTED. A `failed` row with a null
    // reason is a crawl this engine closed before migration 0017, and a test
    // that refused one would be a test that refused our own history.
    const [row] = await db
      .select({ violations: sql<number>`count(*)::int` })
      .from(crawls)
      .where(sql`${crawls.failureReason} is not null and ${crawls.status} <> 'failed'`);
    expect(row?.violations).toBe(0);
  });

  it("cascades from the crawl delete, the new column and all", async () => {
    const id = created.pop()!;
    const count = async () => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, id));
      return rows[0]?.n ?? 0;
    };
    expect(await count()).toBeGreaterThan(0);
    await db.delete(crawls).where(eq(crawls.id, id));
    expect(await count()).toBe(0);
    const [gone] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(crawls)
      .where(eq(crawls.id, id));
    expect(gone?.n).toBe(0);
  });
});
