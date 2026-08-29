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
 *    detection (`derivePageType`), with the untyped pages under the `UNTYPED`
 *    sentinel.
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
 * `null` on either field means UNCAPPED: list everything, and write no
 * truncation note, because nothing was truncated. The defaults and how a crawl
 * chooses live in src/rules/query/crawl-evidence.ts (`resolveRuleCaps`).
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
  /** Findings a URL-scoped listing rule may report. */
  listing: number | null;
  /** Pairs `content.near-duplicate` may report — a different unit, its own budget. */
  nearDuplicatePairs: number | null;
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
