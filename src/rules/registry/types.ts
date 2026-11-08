import type { Db } from "../../db/client.js";
import type { pages } from "../../db/schema.js";
import type { MetricTable } from "./metric-table.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../threshold-table.js";

export type Severity = "critical" | "warning" | "info";
/**
 * What a finding IS, in Screaming Frog's Issue Type vocabulary (Phase 27a):
 * a defect to fix, something a human must check because it may be fine, or a
 * change that would help where nothing is broken. The rubric and every rule's
 * value live in src/rules/registry/triage.ts.
 */
export type IssueType = "issue" | "warning" | "opportunity";
/**
 * What FIXING a finding is worth on the pages it hits (Phase 27a): high when it
 * decides whether they are crawled, indexed or served correctly, medium when it
 * moves how they rank or appear, low for hygiene. Not severity, which is the
 * engine's fact about the rule (Phase 16) and is never overridden.
 */
export type Priority = "high" | "medium" | "low";
export type PageRecord = typeof pages.$inferSelect;

export interface Finding {
  ruleId: string;
  pageId: string | null;
  pageUrl: string | null;
  severity: Severity;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

/**
 * What a metric row is the answer FOR.
 *
 * `site` is the crawl as a whole and names nothing; the others each name one
 * thing in `scope_value`, and the pair is part of the metrics primary key.
 *
 *  - `page_type` — one cohort of pages, named by the crawler's own template
 *    detection (src/crawl/page-type.ts: per URL as each page is written, then
 *    collapsed over the whole population at crawl end, so a cohort is a
 *    template rather than a URL shape that occurred once), with the untyped
 *    pages under the `UNTYPED` sentinel.
 *  - `sitemap_doc` — one sitemap document, named by the URL it was fetched
 *    from. It exists because `sitemap.structure` has per-document rows and a
 *    sitemap document is NOT a page type: filing `https://site/sitemap-1.xml`
 *    under `page_type` would put a URL where every other reader of that scope
 *    expects a template name, and every consumer that groups the two scopes
 *    together — the report, the agent, a future `page_type` join — would read
 *    it as a cohort of pages that does not exist. A scope is a claim about what
 *    a row counts, so a new kind of row gets a new scope rather than a
 *    borrowed one (hard rule 7).
 *
 * Closed, like `RuleCategory`, and for the same reason: the runner deletes and
 * rewrites metric rows by (crawl, metric, scope, scope value), so a one-off
 * spelling is a row nothing recomputes. `METRIC_SCOPES` below is the same list
 * as a value, because the runner checks a rule's return at the JavaScript
 * boundary where the type system has seen nothing.
 */
export type MetricScope = "site" | "page_type" | "sitemap_doc";

/** `MetricScope` as a value — what `runRules` validates a returned row against. */
export const METRIC_SCOPES: readonly MetricScope[] = ["site", "page_type", "sitemap_doc"];

export interface Metric {
  metricId: string;
  scope: MetricScope;
  scopeValue: string;
  value: Record<string, unknown>;
}

/**
 * The report's top-level grouping. A closed union rather than a free string:
 * the categories are what the report and the action plan sort findings into,
 * so a one-off spelling ("structure", "mobile") is a group of one nobody asked
 * for. A new rule belongs in one of these; if it genuinely does not, the union
 * is what gets extended, deliberately, in one place.
 */
export type RuleCategory =
  | "on-page"
  | "canonical"
  | "indexability"
  | "hreflang"
  | "technical"
  | "crawl"
  | "redirects"
  | "links"
  | "sitemap"
  | "url"
  | "host"
  | "content"
  | "structured-data";

/**
 * One column of a rule's report, as `RuleMeta.columns` declares it.
 *
 * `key` NAMES AN EVIDENCE FIELD — a top-level key of the `evidence` object the
 * rule's findings carry — and `label` is the header a client prints. The labels
 * are Screaming Frog's vocabulary wherever one exists (`Status Code`,
 * `Inlinks`, `Title 1`, `Title 1 Length`, `Word Count`, `No. Near Duplicates`,
 * `Closest Near Duplicate Match`, `Canonical Link Element`, `Meta Robots`,
 * `hreflang`, `Expected Link`, `URL Not Returning Link`, `Source`, `Anchor`),
 * because the people reading these reports read those exports every week and a
 * second name for one thing is a second thing to them.
 *
 * THE FIVE STANDARD KEYS ARE RESERVED and may never be declared here:
 * `address`, `statusCode`, `indexability`, `indexabilityStatus` are derived
 * from the finding's page row and are prepended to every rule's column list by
 * the surface; `pageUrl` is the key `runRules` writes the finding's own URL
 * under, which `address` already is. A rule that declared one of them would
 * print two columns with one heading, one of them from a different source.
 *
 * `optional` marks a key the rule writes only SOMETIMES — a caveat, an
 * "at least" flag, a second sample list that exists only when there is more
 * than one. It is a property of the rule, not of any one crawl, so it is
 * declared beside the column rather than kept in a list in a test: the harness
 * requires every NON-optional column of a rule that fired to appear in at least
 * one of its rows (a column nobody can ever see is a heading, not a report),
 * and lets an optional one be absent. It is on the wire too, because a client
 * laying out a table wants to know which cells may be blank by design.
 */
export interface RuleColumn {
  key: string;
  label: string;
  optional?: true;
}

interface RuleMeta {
  id: string;               // 'canonical.non-200-target'
  checkIds: string[];       // ['CHECK-19'] — traces to skills/ariadne-audit/checklist.md
  category: RuleCategory;
  severity: Severity;
  title: string;
  explanation: string;      // client-facing
  howToFix: string;         // client-facing
  rulesetVersion: string;
  /**
   * The rule's default issue type and priority (Phase 27a). REQUIRED on a rule
   * that finds and ABSENT on a metric rule, which produces no findings; never
   * written by a rule's module: `defineRule` attaches both from the one table,
   * src/rules/registry/triage.ts, and refuses a definition that disagrees with
   * it. A crawl's overrides apply at read time, not here.
   */
  type?: IssueType;
  priority?: Priority;
  /**
   * Present ONLY on a NOT MEASURED marker — a rule whose whole purpose is to be
   * read, because it reports that a check below COULD NOT BE ANSWERED on this
   * crawl (`content.thin-skipped`, `resources.not-fetched`, `host.probe-skipped`
   * and their siblings). An agent that never meets the marker reads the silence
   * of the rules it stands in for as a clean site, so the marker has to be named
   * in the checklist entry of every check it claims AND in CHECK-83's NOT
   * MEASURED family list.
   *
   * The FLAG IS THE SINGLE SOURCE OF TRUTH for "which rules are markers": the
   * value is the short note describing the crawl condition whose silence the
   * marker explains, migrated from the hand-written map in
   * test/skills/identifier-guard.test.ts that this field replaced. The identifier
   * guard derives its marker set from `marker !== undefined` over the registry
   * and checks both checklist obligations against it, so adding a marker is ONE
   * edit — this flag on its definition — and a flagged rule the checklist forgets,
   * or a checklist entry that names a rule nobody flagged, is a red test rather
   * than a silent divergence. Absent (undefined) on every ordinary rule; a
   * present-but-empty string is refused by `defineRule` — a flag with no reason
   * is the drift the field exists to prevent.
   *
   * NOT a verdict and NOT client copy: it never reaches a finding, a metric or
   * the ruleset version. It is the registry's own metadata — read by the guard
   * and, since Phase 17, mirrored onto the rules catalog (`CatalogRule.marker`)
   * so a UI can tell "this check could not be answered" from "this check found
   * something small" without keeping its own list of which rules are markers.
   */
  marker?: string;
  /**
   * THE RULE'S REPORT, column by column — what a reader sees after the four
   * standard columns every finding row carries (`address`, `statusCode`,
   * `indexability`, `indexabilityStatus`).
   *
   * REQUIRED ON EVERY RULE THAT FINDS (`page` and `query`), and ABSENT on every
   * `metric` rule: a metric writes a table of its own shape into `metrics` and
   * never writes an `issues` row, so there is no finding row for a column to be
   * a column of. `defineRule` enforces both halves.
   *
   * EMPTY IS A STATEMENT, not an omission, and it is why the field is required
   * rather than non-empty. `canonical.missing`, `mobile.viewport-missing` and
   * `pages.not-in-sitemap` write no evidence beyond the URL the finding is
   * filed against: their report IS the standard four columns, and inventing a
   * fifth so the array could be non-empty would put a heading over a column the
   * rule cannot honestly fill (hard rule 1's shape, one layer out). What the
   * field being required buys is that a NEW rule cannot forget to say what its
   * report looks like — the absent field is the error, the empty array is an
   * answer.
   *
   * THE ORDER IS THE READING ORDER. A rule's evidence object is written in
   * whatever order its body happened to build it; this list is the order the
   * fact matters in — the value first, then its measurement, then the context.
   *
   * KEYS ARE CHECKED AGAINST REALITY BY THE HARNESS, not by `defineRule`: a
   * declaration is about what the rule writes, and only a run over a real crawl
   * knows that. test/fixtures/harness.test.ts asserts, for every rule that fired
   * on the fixture site, that each non-`optional` column appears in at least one
   * of its rows AND that no evidence key of that rule is undeclared (bar
   * `pageUrl`, which the writer adds, and `truncated`, which the cap machinery
   * adds). An undeclared key is a column nobody sees; evidence IS the report.
   */
  columns?: ReadonlyArray<RuleColumn>;
  /**
   * THE METRIC'S TABLE — the other kind of report, and the mirror image of
   * `columns`.
   *
   * REQUIRED ON EVERY `metric` RULE and ABSENT on every rule that finds, which
   * is exactly the reverse of `columns` and for the same reason: a metric writes
   * a jsonb object per scope into `metrics` and never an `issues` row, so its
   * report is not a list of evidence fields but a shaper that says how those
   * objects become rows. `defineRule` enforces both halves.
   *
   * The declaration is DATA (see src/rules/registry/metric-table.ts) so the
   * catalog can serve it, and the labels in it are CLIENT-FACING COPY: a reader
   * of a metric table sees these strings and nothing else of the declaration.
   * That is why the ruleset version moves when they do.
   *
   * THE KEYS ARE CHECKED AGAINST REALITY BY THE HARNESS, exactly as a finding
   * rule's are: `defineRule` sees a declaration and not one stored row, so a key
   * that names nothing the metric writes — a column empty on every row of every
   * crawl — is caught in test/fixtures/harness.test.ts over a real crawl, in
   * both directions (a column nothing fills, and a value key no column prints).
   */
  table?: MetricTable;
}

export interface PageRule extends RuleMeta {
  kind: "page";
  /** Attached by `defineRule` from triage.ts — see `RuleMeta.type`. */
  type: IssueType;
  priority: Priority;
  /** Required on a rule that finds — see `RuleMeta.columns`. Empty is an answer. */
  columns: ReadonlyArray<RuleColumn>;
  /** NEVER PRESENT on a rule that finds — see `MetricRule.table`. */
  table?: undefined;
  run: (page: PageRecord, ctx?: JudgementContext) => Finding[];
}
/**
 * How much one rules run may LIST — the run-level budget every query rule is
 * handed, rather than a constant each of them imports.
 *
 * It is a PARAMETER and not module state, and that is load-bearing rather than
 * stylistic. `ApiService` serialises rules runs per crawl (`this.judging`), but
 * nothing serialises them ACROSS crawls: two `runRulesForCrawl` calls for two
 * different crawls interleave freely in one process, and one of them may be a
 * billed uncapped audit while the other is a 200-capped first look. A cap held
 * in a module variable — or in an `AsyncLocalStorage` a rule could forget to
 * enter — would let the second run's budget decide what the first one reports.
 * Passed down the call stack, each run's caps are unreachable from the other's.
 *
 * `null` means UNCAPPED: list everything the rule finds. The default and how a
 * crawl chooses live in src/rules/query/crawl-evidence.ts (`resolveRuleCaps`).
 *
 * ONE BUDGET, SINCE PHASE 19 §11. There were two until then, because
 * `content.near-duplicate` reported PAIRS — a unit quadratic in the site, with
 * a default of its own (500) and a scan ceiling `findingCap` could not lift.
 * That rule now reports one finding per PAGE, aggregating the pair join inside
 * Postgres, so its output is bounded by the site exactly like every other
 * listing rule's and it spends the same budget. The ceiling went with the unit:
 * what it protected against was a findings array quadratic in the near-identical
 * cohort (hard rule 6), and there is no longer such an array to bound.
 *
 * WHAT A TRUNCATION NOTE MEANS, STATED AS THE CONTRAPOSITIVE BECAUSE THAT IS THE
 * HALF READERS DEPEND ON: **a note means the list is incomplete; its absence
 * means it is complete.** An uncapped run produces no note — nothing truncated
 * it. Read the note rather than inferring completeness from the crawl's
 * configuration.
 *
 * WHAT IT DOES NOT GOVERN: the size of one finding's evidence. A duplicate
 * GROUP finding quotes `DUPLICATE_SAMPLE_URLS` (20) URLs and the group's exact
 * count, at every cap including none — the sample is a shape decision about
 * what a single row of evidence should be, and a 5,000-element array in one
 * `details` jsonb is a pathological row rather than a fuller picture. The cap
 * governs HOW MANY FINDINGS a rule reports; the count inside each one is exact
 * either way.
 */
export interface RuleCaps {
  /**
   * Findings a URL-scoped listing rule may report.
   *
   * It is a FIELD rather than a constant each rule imports because it has to be
   * per-run state: two runs of two crawls are inside `runRules` at the same
   * moment in one process, and a module variable would let one run's budget
   * decide what the other reports (the paragraph above, and the concurrency
   * test in test/rules/finding-cap.test.ts).
   */
  listing: number | null;
}

/**
 * What a rules run judges ONE crawl with (Phase 27a): its effective thresholds
 * and the rules its block disables.
 *
 * Per-run state for the reason `RuleCaps` is: two runs of two crawls are inside
 * `runRules` at once in one process, so a threshold a rule imports as a module
 * constant could not differ between them. A rule reads
 * `judgementOr(ctx).thresholds.NAME`; test/rules/threshold-guard.test.ts fails
 * on a rule that still imports or names an overridable constant.
 *
 * Disabled rules still RUN and their findings are stored (a disable applies at
 * read time); `disabledRules` is read only by `site.health`, which must not
 * count a finding the agent has said is not an issue here.
 */
export interface JudgementContext {
  thresholds: Thresholds;
  disabledRules: ReadonlySet<string>;
}

/** The context of a crawl with no overrides. */
export const DEFAULT_JUDGEMENT: JudgementContext = Object.freeze({
  thresholds: DEFAULT_THRESHOLDS,
  disabledRules: new Set<string>(),
});

/** `ctx ?? DEFAULT_JUDGEMENT`, named so every rule resolves it the same way (see `capsOr`). */
export function judgementOr(ctx: JudgementContext | undefined): JudgementContext {
  return ctx ?? DEFAULT_JUDGEMENT;
}

export interface QueryRule extends RuleMeta {
  kind: "query";
  /** Attached by `defineRule` from triage.ts — see `RuleMeta.type`. */
  type: IssueType;
  priority: Priority;
  /** Required on a rule that finds — see `RuleMeta.columns`. Empty is an answer. */
  columns: ReadonlyArray<RuleColumn>;
  /** NEVER PRESENT on a rule that finds — see `MetricRule.table`. */
  table?: undefined;
  /**
   * `caps` is optional so a direct caller — a rule test, a script — may invoke
   * a rule without restating the engine's defaults; `capsOr` turns the absence
   * into `DEFAULT_RULE_CAPS`. `runRules` always passes a resolved value.
   */
  run: (
    db: Db,
    crawlId: string,
    caps?: RuleCaps,
    ctx?: JudgementContext,
  ) => Promise<Finding[]>;
}
export interface MetricRule extends RuleMeta {
  kind: "metric";
  /** NEVER PRESENT: a metric produces no findings to triage — see `RuleMeta.type`. */
  type?: undefined;
  priority?: undefined;
  /**
   * NEVER PRESENT. Narrowed to `undefined` rather than left inherited so the
   * type says what `defineRule` refuses: a metric writes rows into `metrics`,
   * not `issues`, so it has no finding row for a column to be a column of.
   */
  columns?: undefined;
  /**
   * REQUIRED. How this metric's stored rows become the table a client reads —
   * see `RuleMeta.table`, and the four shapers in
   * src/rules/registry/metric-table.ts.
   */
  table: MetricTable;
  run: (db: Db, crawlId: string, ctx?: JudgementContext) => Promise<Metric[]>;
}
export type AnyRule = PageRule | QueryRule | MetricRule;
