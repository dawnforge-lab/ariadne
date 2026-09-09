import type { Db } from "../../db/client.js";
import type { pages } from "../../db/schema.js";

export type Severity = "critical" | "warning" | "info";
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
}

export interface PageRule extends RuleMeta {
  kind: "page";
  run: (page: PageRecord) => Finding[];
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

export interface QueryRule extends RuleMeta {
  kind: "query";
  /**
   * `caps` is optional so a direct caller — a rule test, a script — may invoke
   * a rule without restating the engine's defaults; `capsOr` turns the absence
   * into `DEFAULT_RULE_CAPS`. `runRules` always passes a resolved value.
   */
  run: (db: Db, crawlId: string, caps?: RuleCaps) => Promise<Finding[]>;
}
export interface MetricRule extends RuleMeta {
  kind: "metric";
  run: (db: Db, crawlId: string) => Promise<Metric[]>;
}
export type AnyRule = PageRule | QueryRule | MetricRule;
