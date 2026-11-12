/**
 * The rules link (Phase 28c): judge a stopped crawl, shared by the API's
 * `crawl_rules` and a schedule's chain. The caller owns the claim (a `rules`
 * job pinned to its process); nothing here claims anything.
 */
import { eq, sql } from "drizzle-orm";

import { ServiceError, clip } from "../api/errors.js";
import { readJudgementBlock } from "../api/judgement-view.js";
import type { Db } from "../db/client.js";
import { crawls, pages } from "../db/schema.js";
import type { Registry } from "./registry/registry.js";
import { runRules, type RunSummary } from "./run.js";

/** `crawl_rules` on a crawl that has not stopped — the same sentence from the claim and from the run. */
export function rulesWhileLive(crawlId: string, status: string): ServiceError {
  return new ServiceError(
    "CONFLICT",
    `crawl ${crawlId} is '${status}': the rules may only run over a crawl that ` +
      `has stopped, or they would judge a site that is still being fetched`,
  );
}

/** `runRulesForCrawl`'s work, under its `rules` job: the body of `ApiService.judgeUnderJob`, moved here unchanged. */
export async function runRulesLink(db: Db, crawlId: string, registry: Registry): Promise<RunSummary> {
  try {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId)).limit(1);
    if (row === undefined) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
    }
    if (row.status === "queued" || row.status === "running") {
      throw rulesWhileLive(crawlId, row.status);
    }
    // Ruling 11: a crawl with no discovery evidence and no pages never ran —
    // it was paused or cancelled while still queued — so there is nothing to
    // judge. Refused here, as the render driver refuses a crawl that "never
    // completed discovery", rather than letting the first rule that reads
    // the robots evidence throw and the transport answer 500. A legacy row
    // (written before the discovery column existed) can hold pages yet a
    // null `discovery`: it DID run, so the sentence must not say it did not
    // (27c T11); it names the missing evidence and stops there.
    if (row.discovery === null) {
      const [{ n: pageCount } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.crawlId, crawlId));
      if (pageCount > 0) {
        throw new ServiceError(
          "CONFLICT",
          `crawl ${crawlId} is '${row.status}' and has ${pageCount} page(s) but no discovery ` +
            `evidence (it predates the discovery record), so the rules cannot judge it`,
        );
      }
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} is '${row.status}' and has no discovery evidence: it never ran ` +
          (row.status === "paused" || row.status === "cancelled"
            ? `(it was ${row.status} before discovery)`
            : `(it ended before discovery completed)`) +
          `, so there is nothing to judge`,
      );
    }
    // The stored judgement block, validated before a row is touched: an
    // override of a rule this ruleset lacks (a later ruleset removed it) is
    // the CONFLICT the read surfaces answer, naming the crawl and the rule
    // and pointing at crawl_config_set — not the bare `JudgementError`
    // `runRules` would throw, which a transport answers 500.
    // `crawl_config_set` validates against this registry and is refused
    // while the crawl is held (above), so a block that passes here cannot
    // gain an unknown rule before `runRules` reads it.
    readJudgementBlock(row.judgement, crawlId, registry);
    return await runRules(db, crawlId, registry);
  } catch (error) {
    // The one refusal `runRules` owns: an id nothing knows. It is raced with
    // the read above (a crawl deleted in between), so it is mapped rather
    // than assumed impossible.
    if (error instanceof Error && error.message.startsWith("no such crawl")) {
      throw new ServiceError("NOT_FOUND", `no such crawl '${crawlId}'`);
    }
    throw error;
  }
  // The job is released on the failure path too (`withPinnedJob` settles it
  // `failed`): a run that threw is a run that is no longer writing, and a
  // crawl no one could ever judge again because one run died would be a
  // worse failure than the one being guarded against.
}
