import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls, issues, metrics, pages } from "../db/schema.js";
import { deriveClickDepth } from "./derive/click-depth.js";
import { deriveFieldPresence } from "./derive/field-presence.js";
import { deriveSitemapHreflang } from "./derive/sitemap-hreflang.js";
import { deriveUrlParams } from "./derive/url-params.js";
import { effectiveThresholds, judgedWithOf, readStoredJudgement } from "./judgement.js";
import { resolveRuleCaps, storedFindingCap } from "./query/crawl-evidence.js";
import { RULESET_VERSION, type Registry } from "./registry/registry.js";
import {
  METRIC_SCOPES,
  type Finding,
  type JudgementContext,
  type Metric,
} from "./registry/types.js";

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
 * What a caller may say about a run that the crawl's own row does not already
 * say.
 *
 * One field today, and its precedence is the house pattern rather than a new
 * one: `ResumeOpts.config` overrides the stored crawl config the same way, for
 * the same reason — a stored value is the crawl's own decision, and an explicit
 * argument is this call's. Absent means "read the crawl's config", which is the
 * normal path and the only one the API uses: `crawl_rules` takes no cap argument,
 * so a crawl started as a billed audit must carry that choice on its own row or
 * lose it the moment the judgement is re-run.
 */
export interface RunOptions {
  /**
   * Findings each listing rule may report: a positive integer, or `null` for
   * uncapped. Omit to use the crawl's `config.findingCap`, and omit that for
   * the engine's defaults (`resolveRuleCaps`).
   */
  findingCap?: number | null;
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
 * inventory table, `deriveFieldPresence` recomputes the column it fills,
 * `deriveClickDepth` clears its column for the crawl before it searches, and
 * `deriveSitemapHreflang` replaces the crawl's `source = 'sitemap'` hreflang
 * rows in one statement — so a re-run over the same crawl leaves exactly what
 * the first run left.
 *
 * The four are independent: they read `pages`, `structured_data`, `pages` and
 * `links`, and `sitemap_hreflang` and `pages`, and none of them reads what
 * another writes. The order between them is therefore arbitrary today, and
 * stated rather than discovered so that it stops being arbitrary the moment one
 * of them starts mattering.
 */
const derivations: Derivation[] = [
  deriveUrlParams,
  deriveFieldPresence,
  deriveClickDepth,
  deriveSitemapHreflang,
];

/**
 * Run every rule in `registry` over one crawl, writing `issues` and `metrics`
 * rows.
 *
 * Pages are streamed by id cursor and findings are buffered, so RAM is
 * O(batch), never O(URLs).
 *
 * A RULES RUN RECOMPUTES THE CRAWL'S JUDGEMENT — both tables, not just one.
 * This crawl's rows are cleared before the rules that own them write: `issues`
 * in a single statement at the top of the run, `metrics` per rule inside the
 * transaction that inserts it. The granularity differs because the write paths
 * do; the principle does not. Both deletes carry their argument where they
 * stand, and the run's summary is therefore a description of the two tables
 * rather than of one run's contribution to them:
 * `count(issues where crawl_id) == summary.findings`, every time.
 *
 * A rule that throws aborts the run loudly, naming the rule — what is already
 * buffered is flushed first so the partial evidence is on disk, but the error
 * surfaces rather than becoming an empty findings list.
 */
export async function runRules(
  db: Db,
  crawlId: string,
  registry: Registry,
  opts: RunOptions = {},
): Promise<RunSummary> {
  // A crawl id nothing knows selects no pages, and a run over no pages looks
  // exactly like a clean site: zero findings, no error. Ask the `crawls` table
  // first so a typo or a deleted crawl is an error rather than a green report
  // about nothing (hard rule 7).
  const crawl = await db
    .select({ id: crawls.id, config: crawls.config, judgement: crawls.judgement })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = crawl[0];
  if (row === undefined) throw new Error(`no such crawl '${crawlId}'`);

  // THE RUN'S CAPS, RESOLVED ONCE AND HELD ON THIS STACK.
  //
  // Not a module constant and not module state: `ApiService` holds a per-crawl
  // lock, so two runs over ONE crawl cannot overlap — but two runs over two
  // DIFFERENT crawls can, in this process, at the same time, and one of them
  // may be a billed uncapped audit while the other is a 200-capped first look.
  // A cap resolved into a variable outside this function would let whichever
  // run started last decide what both of them report. This `const` is
  // per-invocation, and it reaches a rule as an argument (`RuleCaps`), so there
  // is no path by which one run can read another's budget.
  //
  // Sourced from the crawl's own row unless this call says otherwise, because
  // the cap is a crawl-start decision and `crawl_rules` has no argument to
  // restate it with. A stored value that is neither absent, null, nor a
  // positive integer throws here rather than being read as "the default".
  const capInput =
    opts.findingCap !== undefined ? opts.findingCap : storedFindingCap(row.config, crawlId);
  const caps = resolveRuleCaps(capInput);

  // THE CRAWL'S JUDGEMENT BLOCK, read and validated before anything is deleted.
  // A block that does not parse — or names a rule this registry does not have —
  // throws here naming the crawl, so a run never judges a crawl under overrides
  // it cannot read, and never as if there were none (hard rule 7). Up front, so
  // the refusal leaves the previous judgement and its stamp exactly as they
  // were. What the run was judged with is stamped beside `rules_run_at` at the
  // end: the cap is the one the run took as input (absent when neither the call
  // nor the crawl chose, i.e. the engine default applied).
  const block = readStoredJudgement(row.judgement, crawlId, registry);
  const judgedWith = judgedWithOf(block, capInput);
  // What every rule of THIS run reads its thresholds from. Built per call and
  // passed down, never held in a module, because two runs of two crawls are in
  // here at once (the finding cap's argument, and the concurrency test in
  // test/rules/thresholds-override.test.ts). Disabled rules are in it for
  // `site.health` alone: they still run and their findings are still stored.
  const judgement: JudgementContext = {
    thresholds: effectiveThresholds(block),
    disabledRules: new Set(judgedWith.disabledRules),
  };

  // Planner statistics, before any rule reads a table.
  //
  // A crawl fills these tables from empty and then the rules query them
  // immediately. Postgres' autovacuum daemon is what normally keeps
  // `pg_statistic` current, and it runs on its own schedule: the Phase 4 gate
  // disclosed that the rules run had usable statistics only because autovacuum
  // happened to analyze mid-crawl. That is luck, and the failure it hides is
  // the quiet kind — never an error, just the planner choosing a nested loop
  // over a 50k-row table it believes holds 0 rows, and a rules run that takes
  // minutes instead of seconds (the `sd_crawl_page` and simhash-band
  // precedents in schema.ts: a missing index is a slow query, never an error).
  //
  // One statement over every table a rule or a derivation reads —
  // `structured_data` included, since three of the schema query rules select
  // from it and `deriveFieldPresence` scans it, and `sitemap_hreflang`, which
  // only `deriveSitemapHreflang` reads. `metrics` is deliberately absent: no
  // rule reads it — the metric phase only writes it.
  //
  // Loud by construction: no catch, so a failed ANALYZE aborts the run rather
  // than leaving it to judge the site on whatever plan it gets (hard rule 7).
  await db.execute(
    sql`ANALYZE pages, links, sitemap_urls, url_params, hreflang, issues, structured_data,
                sitemap_hreflang`,
  );

  // THIS CRAWL'S JUDGEMENT IS RECOMPUTED, NOT ACCUMULATED. Every issue row the
  // crawl has is deleted here, before the first rule writes one.
  //
  // Phase 4 built this table append-only and said why: an issue is EVIDENCE, it
  // happened, and `onConflictDoNothing` over the `issues_dedupe` index absorbs
  // a re-run. That argument holds only while every rule is DETERMINISTIC, and
  // one of them was not. `content.near-duplicate` used to stop listing at 500
  // PAIRS with NO `ORDER BY` — deliberately, because ordering would have forced
  // the whole quadratic join the cap existed to avoid — so *which* 500 real
  // pairs it reported was undefined. (Phase 19 §11 made it count in SQL and
  // report one ordered row per page, so the shape below no longer has a live
  // example; the delete stays, because the invariant is about what a capped
  // listing IS, not about which rule last violated it.) A second run laid a
  // different arbitrary 500 on top of the first, and nothing collided.
  // Measured on the P6 gate crawl: two runs, each reporting 500 near-duplicate
  // findings, left 751 rows in the table — 1565 issue rows against a summary
  // saying 1314. The agent surface (`GET /crawls/:id/issues`) reads the TABLE,
  // so an audit run twice would have quoted a site defect count that grew
  // because we asked twice. A number that changes when you repeat the question
  // is not evidence of anything (hard rule 7).
  //
  // So an issue is recomputed state, exactly as a metric is: the crawl's
  // judgement under the ruleset that just ran, not a log of every judgement
  // ever passed on it. What survives a run is what that run found.
  //
  // ONE STATEMENT, PHASE-LEVEL, rather than the metric phase's per-rule delete
  // inside the transaction that replaces the rows. There is no per-rule seam to
  // put a transaction around here: the findings buffer batches ACROSS rules —
  // page rules interleave per page and flush together whenever the buffer
  // fills — so a per-rule delete would have to rewrite the buffer, and half a
  // seam is worse than none.
  //
  // WHAT THAT COSTS, STATED RATHER THAN HIDDEN: a run that dies part-way leaves
  // the table holding a PREFIX of its own findings and none of the previous
  // run's. That is a coherent state rather than a silently mixed one —
  // everything in the table came from the run that died — and the run threw, so
  // nothing anywhere reports it as complete. The rejected alternative is worse
  // in exactly the way that matters: deleting per rule as each finishes would
  // leave the previous run's rows for rules that had not run yet sitting beside
  // this run's rows for the ones that had, two answers in one table with
  // nothing to tell them apart.
  //
  // AFTER the ANALYZE above, not before: the planner's statistics then describe
  // a table roughly the size this run is about to rewrite it to, rather than
  // the empty one it would see for the rest of the run.
  //
  // IN ONE TRANSACTION WITH `crawls.rules_run_at = null`, which is the crawl's
  // judged-state marker (schema.ts). The pair is the whole point: the moment
  // the previous run's findings stop being in the table, the timestamp that
  // said when they were produced stops being true, and the two facts must not
  // be observable apart. A reader that saw an old `rulesRunAt` over a
  // half-rewritten `issues` table would take a coherent prefix of THIS run for
  // a complete judgement made at a time that has passed.
  //
  // So the null window — from here to the stamp at the end of the run — is the
  // honest state and is meant to be read as one: "this crawl is being judged,
  // or a judgement of it died part-way". It is also what a crashed run leaves
  // behind, deliberately: the table then holds a coherent prefix of a run that
  // threw, and `rulesRunAt: null` is the surface saying that no complete pass
  // is on record rather than pointing at the run before it (hard rule 7).
  await db.transaction(async (tx) => {
    await tx.delete(issues).where(eq(issues.crawlId, crawlId));
    // The stamp of what the run was judged with goes with the timestamp: it
    // describes the same completed pass, so it is null whenever that is.
    await tx
      .update(crawls)
      .set({ rulesRunAt: null, rulesJudgedWith: null })
      .where(eq(crawls.id, crawlId));
  });

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
        );
      // NO CONFLICT CLAUSE, and that is the metric phase's argument arriving
      // here: the delete at the top of the run owns idempotence now, so this
      // crawl's rows were cleared before any rule wrote. The only way left to
      // collide is ONE RULE EMITTING THE SAME `dedupeKey` TWICE IN ONE RUN —
      // two findings claiming to be the same finding, which is a rule defect
      // and must surface rather than have one of them quietly dropped. It is
      // also what makes `count(issues) == summary.findings` an invariant a
      // reader can check instead of a coincidence: with a conflict clause the
      // table could sit silently BELOW the summary, the same class of drift in
      // the other direction.
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
          for (const f of rule.run(page, judgement)) record(f);
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

  // Statistics again, for the four tables the derivation phase just rewrote —
  // and this one is not belt-and-braces, it is the case the top-of-run ANALYZE
  // cannot cover.
  //
  // On a crawl's FIRST rules run, `url_params` is EMPTY when the statement
  // above runs: the derivation that fills it has not happened yet. So the
  // planner is not merely uninformed about that table, it is taught that the
  // table holds nothing and it believes it — and then `deriveUrlParams` writes
  // a row per parameter and the URL-hygiene query rules join it. Same seam for
  // `structured_data`, whose `field_presence_jsonb` `deriveFieldPresence` has
  // just rewritten for every block on the crawl, which is what
  // `schema.product-incomplete` reads. And `hreflang`, whose `source =
  // 'sitemap'` rows `deriveSitemapHreflang` has just written: on a first run
  // the table held only the HTML and header rows when it was sampled, and on a
  // site that annotates in its sitemap that is a fraction of what every
  // hreflang rule now joins.
  //
  // `pages` IS ANALYZED TWICE FOR THE SAME REASON, not for a second one. It is
  // in the statement above because every rule reads it, and it is here because
  // `deriveClickDepth` has just rewritten a COLUMN of it: on a crawl's first
  // run `click_depth` is entirely null when the planner is taught the table, so
  // it believes `click_depth is not null` selects nothing — and then
  // `structure.click-depth-distribution` groups by it. The same first-run
  // statistics argument as `url_params`, one level down.
  //
  // Same idiom as above and for the same reason: no catch, because a plan
  // built on statistics that describe an empty table (or an all-null column) is
  // a slow query and never an error (hard rule 7).
  await db.execute(sql`ANALYZE pages, url_params, structured_data, hreflang`);

  // Query rules run after the page rules: they read the crawl's tables whole
  // (in SQL), so they are unaffected by the page cursor.
  for (const rule of registry.byKind("query")) {
    let produced: Finding[];
    try {
      produced = await rule.run(db, crawlId, caps, judgement);
    } catch (error) {
      await flush();
      throw new Error(`rule '${rule.id}' threw`, { cause: error });
    }
    // Buffered in batches rather than in one go, which is what an UNCAPPED run
    // needs: with `findingCap: null` a listing rule may hand back every orphan
    // on the site, and holding all of them in `buffer` *as well as* in
    // `produced` doubled the peak for no reason. The buffer now stays
    // O(INSERT_BATCH) here exactly as it does in the page loop above.
    //
    // WHAT REMAINS O(FINDINGS) AND IS NOT PRETENDED OTHERWISE: `produced`
    // itself. A query rule's contract is `Promise<Finding[]>` — it returns its
    // findings, it does not stream them — so one rule's whole listing is in
    // memory while it is written. That is bounded by what ONE rule found on ONE
    // crawl (5,000 orphans is a few megabytes of small objects), never by the
    // crawl's page count times the ruleset, and the rules-run memory contract
    // is stated in those terms rather than claimed to be O(1).
    //
    // The flush is outside the try above on purpose: a failure to WRITE is not
    // "rule X threw", and labelling it so would send a reader to a rule that
    // did its job.
    for (const f of produced) {
      record(f);
      if (buffer.length >= INSERT_BATCH) await flush();
    }
    await flush();
  }
  await flush();

  // The metric phase, last. A metric summarises the crawl the run has just
  // finished judging, so everything that writes evidence has to be done: a
  // metric that ran before the query rules could count a crawl's issues as they
  // stood halfway through.
  //
  // Why this phase deletes before it inserts:
  //
  //   A metric is RECOMPUTED STATE. It is the crawl's current answer, and last
  //   run's answer is not evidence of anything once this run has produced its
  //   own. An upsert alone would refresh the rows that still exist and silently
  //   preserve the ones that do not: a `page_type` cohort that vanished on a
  //   re-crawl would keep its row, and a reader would see a count for a group
  //   of pages nothing counted (hard rule 7 — a stale number is a fallback
  //   wearing a number's clothes).
  //
  // THIS USED TO BE STATED AS AN ASYMMETRY — metrics recomputed, issues
  // appended as evidence — and it is not one any more. Issues are recomputed
  // too, by the single delete at the top of the run; see the argument there for
  // what broke the append-only reading (a rule whose capped listing is
  // deterministic in count but not in content). What genuinely differs between
  // the two phases is only the GRANULARITY of the delete, and that difference
  // is a consequence of the write paths rather than of the tables:
  //
  // Each metric rule's rows for this crawl are deleted and its fresh set
  // inserted, inside ONE transaction: the two statements share it because the
  // table is otherwise briefly missing a metric a reader might be asking for.
  // Per rule rather than per phase, so a rule that throws does not take a
  // finished rule's rows with it — those rows are this crawl's true answer for
  // that metric, and rolling them back because a different rule is broken would
  // replace a true number with a missing one. The findings phases cannot do
  // this: their buffer batches across rules, so they get one phase-level delete
  // and pay for it with the crash window documented up there.
  for (const rule of registry.byKind("metric")) {
    let returned: unknown;
    try {
      returned = await rule.run(db, crawlId, judgement);
    } catch (error) {
      throw new Error(`rule '${rule.id}' threw`, { cause: error });
    }
    // A rule that returns something other than an array is a rule defect, and
    // it has to fail the way every other rule defect fails: named. Without this
    // the `for…of` below would throw a bare "is not iterable" TypeError that
    // says nothing about which rule produced it.
    if (!Array.isArray(returned)) {
      throw new Error(
        `rule '${rule.id}' returned ${returned === null ? "null" : typeof returned} ` +
          "rather than an array of metric rows",
      );
    }
    const rows: Metric[] = returned;

    // Validated as a set, before anything is written: a rule that emits one bad
    // row writes none of them, so the crawl never holds half of a metric.
    for (const m of rows) {
      // `metricRow` makes this unreachable for a rule that uses it. Checked
      // anyway because the delete below is keyed on the rule's own id: a row
      // filed under another metric id would never be recomputed and never
      // removed — a permanent stale row no rule owns.
      if (m.metricId !== rule.id) {
        throw new Error(
          `rule '${rule.id}' emitted a row under metric id '${m.metricId}' — ` +
            "a metric rule writes only its own id",
        );
      }
      if (!(METRIC_SCOPES as readonly string[]).includes(m.scope)) {
        throw new Error(`rule '${rule.id}' emitted an unknown metric scope '${m.scope}'`);
      }
      // Every scope but `site` names the one thing its row is about — a page
      // type, a sitemap document. Without that name the row identifies nothing,
      // and the empty string is already spoken for: it is what a site-scoped row
      // stores in the primary key.
      if (m.scope !== "site" && m.scopeValue === "") {
        throw new Error(
          `rule '${rule.id}' emitted a '${m.scope}' row with no scope value — ` +
            "a scoped row without a name identifies nothing",
        );
      }
      // And the symmetric defect. There is one site per crawl, so a site row
      // carrying a scope value keys a SECOND site row: the same question
      // answered twice, with nothing to say which answer is the site's.
      if (m.scope === "site" && m.scopeValue !== "") {
        throw new Error(
          `rule '${rule.id}' emitted a 'site' row with scope value '${m.scopeValue}' — ` +
            "a site-scoped metric has one row per crawl and names nothing",
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

  // THE JUDGED-STATE MARKER, stamped last and only here.
  //
  // Every finding and every metric this run produces is on disk by the time
  // this statement runs, so a non-null `rules_run_at` means exactly one thing:
  // a full pass over this crawl completed, and the `issues` and `metrics` rows
  // beside it are that pass's. The agent surface reports it as `rulesRunAt`
  // (`GET /crawls/:id`, `crawl_status`), which is how a reader tells "this
  // crawl was judged and found clean" from "this crawl was never judged" —
  // two facts an empty issues table cannot distinguish on its own.
  //
  // Deliberately NOT inside a transaction with anything: there is nothing left
  // to be atomic with. The run's writes are already committed, and a failure
  // here is a failure to record a judgement that happened — which throws, and
  // leaves the marker null, which is the same "no complete pass on record"
  // the delete above established. Never the other way round.
  //
  // The stamp of what this pass was judged with is written in the SAME update,
  // so the two are never observable apart: a timestamp always comes with the
  // inputs that produced the rows beside it.
  await db
    .update(crawls)
    .set({ rulesRunAt: new Date(), rulesJudgedWith: judgedWith })
    .where(eq(crawls.id, crawlId));

  return summary;
}
