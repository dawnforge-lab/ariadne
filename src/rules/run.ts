import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls, issues, pages } from "../db/schema.js";
import { RULESET_VERSION, type Registry } from "./registry/registry.js";
import type { Finding } from "./registry/types.js";

/**
 * Pages read per round trip — the memory contract: never the whole table.
 * Exported so a test can build a crawl that forces the cursor loop to iterate
 * more than once without hardcoding the number.
 */
export const PAGE_BATCH = 500;
/** Findings per insert statement. */
const INSERT_BATCH = 500;

export interface RunSummary {
  pagesScanned: number;
  findings: number;
  byRule: Record<string, number>;
}

/**
 * Run every rule in `registry` over one crawl, writing `issues` rows.
 *
 * Pages are streamed by id cursor and findings are buffered, so RAM is
 * O(batch), never O(URLs). Inserts are `onConflictDoNothing`: the
 * `issues_dedupe` unique index absorbs a re-run over the same crawl, which
 * makes the runner safe to repeat.
 *
 * A rule that throws aborts the run loudly, naming the rule — what is already
 * buffered is flushed first so the partial evidence is on disk, but the error
 * surfaces rather than becoming an empty findings list.
 */
export async function runRules(
  db: Db,
  crawlId: string,
  registry: Registry,
): Promise<RunSummary> {
  // A crawl id nothing knows selects no pages, and a run over no pages looks
  // exactly like a clean site: zero findings, no error. Ask the `crawls` table
  // first so a typo or a deleted crawl is an error rather than a green report
  // about nothing (hard rule 7).
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`no such crawl '${crawlId}'`);

  // Metric rules exist in the registry's type but nothing here drives them.
  // Silently ignoring one would mean a registered rule that never runs and a
  // check that looks covered — so refuse the run instead.
  if (registry.byKind("metric").length > 0) {
    throw new Error(
      "runRules does not drive metric rules yet — extend the runner before registering metric rules",
    );
  }

  const summary: RunSummary = { pagesScanned: 0, findings: 0, byRule: {} };
  const buffer: Finding[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    for (let i = 0; i < batch.length; i += INSERT_BATCH) {
      await db
        .insert(issues)
        .values(
          batch.slice(i, i + INSERT_BATCH).map((f) => ({
            crawlId,
            ruleId: f.ruleId,
            pageId: f.pageId,
            severity: f.severity,
            // The ruleset that produced the row, stamped alongside it: a
            // finding read back later says which rules judged it, without
            // depending on the crawl row still being there to say so.
            rulesetVersion: RULESET_VERSION,
            dedupeKey: f.dedupeKey,
            details: { pageUrl: f.pageUrl, ...f.evidence },
          })),
        )
        .onConflictDoNothing();
    }
  };

  const record = (f: Finding): void => {
    buffer.push(f);
    summary.findings += 1;
    summary.byRule[f.ruleId] = (summary.byRule[f.ruleId] ?? 0) + 1;
  };

  const pageRules = registry.byKind("page");
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), gt(pages.id, cursor)))
      .orderBy(asc(pages.id))
      .limit(PAGE_BATCH);
    if (batch.length === 0) break;
    for (const page of batch) {
      summary.pagesScanned += 1;
      for (const rule of pageRules) {
        try {
          for (const f of rule.run(page)) record(f);
        } catch (error) {
          await flush();
          throw new Error(`rule '${rule.id}' threw on page ${page.url}`, { cause: error });
        }
      }
    }
    if (buffer.length >= INSERT_BATCH) await flush();
    cursor = batch[batch.length - 1]!.id;
  }

  // Query rules run after the page rules: they read the crawl's tables whole
  // (in SQL), so they are unaffected by the page cursor.
  for (const rule of registry.byKind("query")) {
    try {
      for (const f of await rule.run(db, crawlId)) record(f);
    } catch (error) {
      await flush();
      throw new Error(`rule '${rule.id}' threw`, { cause: error });
    }
    await flush();
  }
  await flush();
  return summary;
}
