import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls, issues, metrics, pages } from "../db/schema.js";
import { deriveFieldPresence } from "./derive/field-presence.js";
import { deriveUrlParams } from "./derive/url-params.js";
import { RULESET_VERSION, type Registry } from "./registry/registry.js";
import type { Finding, Metric } from "./registry/types.js";

/**
 * Pages read per round trip — the memory contract: never the whole table.
 * Exported so a test can build a crawl that forces the cursor loop to iterate
 * more than once without hardcoding the number.
 */
export const PAGE_BATCH = 500;
/** Rows per insert statement — findings, and a metric rule's rows. */
const INSERT_BATCH = 500;

export interface RunSummary {
  pagesScanned: number;
  findings: number;
  byRule: Record<string, number>;
  /** Rows each derivation wrote, by derivation name. */
  derived: Record<string, number>;
  /** `metrics` rows written across every metric rule. */
  metrics: number;
  /**
   * Rows written per metric rule. Unlike `byRule`, which names only the rules
   * that fired, this names every metric rule that ran — a metric rule that
   * produced nothing has *removed* the crawl's previous answer, which is a
   * result rather than a non-event, so a zero here and an absent key mean
   * different things.
   */
  byMetric: Record<string, number>;
}

/**
 * A derivation: SQL that turns the crawl's raw rows into an inventory table.
 *
 * It returns a count of what it wrote, keyed by field name, so the run summary
 * can say what was derived rather than leaving it invisible. Derivations write
 * only their own table — never `issues` — which is what keeps "a rule reads the
 * database and produces findings" true.
 */
type Derivation = (db: Db, crawlId: string) => Promise<Record<string, number>>;

/**
 * The derivation phase, in order.
 *
 * Ordered and explicit rather than discovered: a derivation that reads another
 * derivation's table would depend on this order, so the order is a list one can
 * read rather than an emergent property of module loading. Every entry is
 * idempotent over the crawl it is given — `deriveUrlParams` rebuilds its
 * inventory table, `deriveFieldPresence` recomputes the column it fills — so a
 * re-run over the same crawl leaves exactly what the first run left.
 *
 * The two are independent: one reads `pages`, the other `structured_data`, and
 * neither reads what the other writes. The order between them is therefore
 * arbitrary today, and stated rather than discovered so that it stops being
 * arbitrary the moment one of them starts mattering.
 */
const derivations: Derivation[] = [deriveUrlParams, deriveFieldPresence];

/**
 * Run every rule in `registry` over one crawl, writing `issues` and `metrics`
 * rows.
 *
 * Pages are streamed by id cursor and findings are buffered, so RAM is
 * O(batch), never O(URLs). Issue inserts are `onConflictDoNothing`: the
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

  const summary: RunSummary = {
    pagesScanned: 0,
    findings: 0,
    byRule: {},
    derived: {},
    metrics: 0,
    byMetric: {},
  };
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

  // The derivation phase sits between the two rule phases, and its position is
  // load-bearing in one direction: a query rule below may join the inventory a
  // derivation just wrote, so the inventory has to be current before any of
  // them runs. It reads the crawl's tables in SQL, so the page cursor above
  // neither helps it nor constrains it. Page findings buffered so far are
  // flushed first, so a derivation that throws leaves the evidence already
  // gathered on disk rather than taking it down with it.
  await flush();
  for (const derive of derivations) {
    try {
      for (const [key, count] of Object.entries(await derive(db, crawlId))) {
        summary.derived[`${derive.name}.${key}`] = count;
      }
    } catch (error) {
      // Loud, like a rule that throws. A derivation that failed silently would
      // leave the next run's rules joining a stale or empty inventory table and
      // reporting whatever that implied (hard rule 7).
      throw new Error(`derivation '${derive.name}' threw`, { cause: error });
    }
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

  // The metric phase, last. A metric summarises the crawl the run has just
  // finished judging, so everything that writes evidence has to be done: a
  // metric that ran before the query rules could count a crawl's issues as they
  // stood halfway through.
  //
  // The metrics-vs-issues asymmetry, and the reason this phase deletes before
  // it inserts:
  //
  //   An issue is EVIDENCE. It happened, it is stamped with the ruleset that
  //   found it, and a re-run adds nothing — `onConflictDoNothing` over the
  //   `issues_dedupe` index absorbs the repeat.
  //
  //   A metric is RECOMPUTED STATE. It is the crawl's current answer, and last
  //   run's answer is not evidence of anything once this run has produced its
  //   own. An upsert alone would refresh the rows that still exist and silently
  //   preserve the ones that do not: a `page_type` cohort that vanished on a
  //   re-crawl would keep its row, and a reader would see a count for a group
  //   of pages nothing counted (hard rule 7 — a stale number is a fallback
  //   wearing a number's clothes).
  //
  // So each metric rule's rows for this crawl are deleted and its fresh set
  // inserted, inside ONE transaction: the two statements share it because the
  // table is otherwise briefly missing a metric a reader might be asking for.
  // Per rule rather than per phase, so a rule that throws does not take a
  // finished rule's rows with it — those rows are this crawl's true answer for
  // that metric, and rolling them back because a different rule is broken would
  // replace a true number with a missing one.
  for (const rule of registry.byKind("metric")) {
    let rows: Metric[];
    try {
      rows = await rule.run(db, crawlId);
    } catch (error) {
      throw new Error(`rule '${rule.id}' threw`, { cause: error });
    }

    // Validated as a set, before anything is written: a rule that emits one bad
    // row writes none of them, so the crawl never holds half of a metric.
    for (const m of rows) {
      // `metricRow` makes this unreachable for a rule that uses it. Checked
      // anyway because the delete above is keyed on the rule's own id: a row
      // filed under another metric id would never be recomputed and never
      // removed — a permanent stale row no rule owns.
      if (m.metricId !== rule.id) {
        throw new Error(
          `rule '${rule.id}' emitted a row under metric id '${m.metricId}' — ` +
            "a metric rule writes only its own id",
        );
      }
      if (m.scope !== "site" && m.scope !== "page_type") {
        throw new Error(`rule '${rule.id}' emitted an unknown metric scope '${m.scope}'`);
      }
      // A cohort row is the answer for one group of pages; without a name the
      // group is unidentifiable, and the empty string is already spoken for —
      // it is what a site-scoped row stores in the primary key.
      if (m.scope === "page_type" && m.scopeValue === "") {
        throw new Error(
          `rule '${rule.id}' emitted a 'page_type' row with no scope value — ` +
            "a cohort without a name identifies no pages",
        );
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(metrics)
          .where(and(eq(metrics.crawlId, crawlId), eq(metrics.metricId, rule.id)));
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          // A plain insert, no conflict clause: the delete above cleared this
          // rule's rows, so the only way to collide now is a rule emitting the
          // same (scope, scopeValue) twice — two different answers for one
          // cohort, which is a defect that must surface rather than have one
          // answer silently win.
          await tx.insert(metrics).values(
            rows.slice(i, i + INSERT_BATCH).map((m) => ({
              crawlId,
              metricId: m.metricId,
              scope: m.scope,
              scopeValue: m.scopeValue,
              value: m.value,
            })),
          );
        }
      });
    } catch (error) {
      throw new Error(`rule '${rule.id}' failed to write its ${rows.length} metric rows`, {
        cause: error,
      });
    }

    summary.metrics += rows.length;
    summary.byMetric[rule.id] = rows.length;
  }

  return summary;
}
