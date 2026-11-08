/**
 * The two overviews of Phase 27a. The Crawl Overview (T9, `crawl_overview`,
 * below) is sectioned counts that describe the crawl.
 *
 * The Issues Overview (Phase 27a T8): one row per rule, with the crawl's
 * judgement applied — what `issues_overview` serves as JSON over MCP and HTTP
 * and as the `issues_overview` CSV view.
 *
 * ONE BUILDER, TWO SURFACES. The JSON and the CSV are the same function's
 * answer, so they can never disagree on a row or an order.
 *
 * Hard rule 3: the findings are counted by ONE `GROUP BY rule_id` statement
 * with the disabled filter in SQL; nothing loads `issues` into memory. The
 * answer is bounded by the rule count (at most 174 finding rules), which is why
 * ordering the aggregate in code is not an unbounded structure.
 *
 * `urls` is the number of DISTINCT URLs, as `issue_urls` lists them: the
 * distinct `details.pageUrl` (the key `issue_urls` pages on), with every finding
 * that names no URL standing for one site-wide entry (the `''` bucket, counted
 * as 1). A site-wide rule that carries many URLs (`sitemap.uncrawled`) therefore
 * counts them all, and a rule whose only finding names no URL still reads 1.
 * `issues_list.count` counts FINDINGS and can exceed `urls` when a rule fires
 * more than once per URL (e.g. `social.og-duplicate`).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import type { RuleCategory, Severity, AnyRule, IssueType, Priority } from "../rules/registry/types.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import { INDEXABILITY_STATUS_SQL, ROBOTS_BLOCKED } from "../rules/helpers.js";
import { RENDER_PASS_EVIDENCE } from "../rules/metric/render-metrics.js";
import {
  copyRenderer,
  loadJudgementView,
  notDisabled,
  type JudgementStale,
  type JudgementView,
} from "./judgement-view.js";
import { ServiceError } from "./errors.js";

export interface IssuesOverviewRow {
  ruleId: string;
  title: string;
  type: IssueType;
  typeOverridden?: true;
  priority: Priority;
  priorityOverridden?: true;
  severity: Severity;
  category: RuleCategory;
  checkIds: string[];
  /** Distinct URLs, as `issue_urls` lists them (site-wide entry counts 1). */
  urls: number;
  percentOfJudged: number | null;
  marker?: true;
}

export interface IssuesOverview {
  crawlId: string;
  rulesetVersion: string;
  pagesJudged: number | null;
  rows: IssuesOverviewRow[];
  disabledRules: string[];
  judgementStale: JudgementStale;
}

const TYPE_ORDER: Record<IssueType, number> = { issue: 0, warning: 1, opportunity: 2 };
const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/**
 * What an overview reads through: the snapshot transaction it opened (or, for a
 * helper shared with other surfaces, the pool).
 */
export type SnapshotReader = Pick<Db, "select" | "execute">;

/**
 * ONE SNAPSHOT PER OVERVIEW CALL (Ruling 14). Each overview opens one
 * `repeatable read, read only` transaction and reads EVERYTHING inside it: the
 * judgement view (whose `rules_run_at` decides what is measured), the crawl
 * detail, and every count. A `crawl_rules` re-run commits `delete issues` with
 * `rules_run_at = null` as one step (src/rules/run.ts); a view read before that
 * commit beside rows read after it would report a judged crawl with no
 * findings: measured zeros where the truth is "not judged".
 */
async function inSnapshot<T>(db: Db, body: (tx: SnapshotReader) => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => await body(tx), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/**
 * `site.health`'s Pages Judged (`urlsTotal`), as the rules run stored it.
 * Null when the crawl has no `site.health` row; a row whose value is not an
 * object with a non-negative integer `urlsTotal` throws, naming the crawl — a
 * malformed measurement is never read as "no measurement".
 */
async function storedPagesJudged(db: SnapshotReader, crawlId: string): Promise<number | null> {
  const result = await db.execute<{ value: unknown }>(sql`
    select m.value_jsonb as value
      from metrics m
     where m.crawl_id = ${crawlId} and m.metric_id = 'site.health' and m.scope = 'site'
     order by m.scope_value asc
     limit 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const value = row.value;
  const total =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).urlsTotal
      : undefined;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new Error(
      `crawl ${crawlId}'s stored site.health metric has no usable urlsTotal ` +
        `(${JSON.stringify(total)}): re-run the rules over this crawl`,
    );
  }
  return total;
}

/**
 * Build the overview inside ONE snapshot (`inSnapshot`): the judgement view is
 * read in it, then the counts. Answers the overview AND the view it was built
 * with, so the CSV renders its copy from that same view rather than a second
 * read that could describe another moment. `ruleFor` is the service's
 * read-time copy join: it throws the 409 `issues_list` raises for a stored
 * finding of a rule the registry lacks.
 */
export async function buildIssuesOverview(
  db: Db,
  crawlId: string,
  registry: Registry,
  ruleFor: (ruleId: string) => AnyRule,
  includeZero: boolean,
): Promise<{ overview: IssuesOverview; view: JudgementView }> {
  return await inSnapshot(db, async (tx) => {
    const view = await loadJudgementView(tx, crawlId, registry);
    const overview = await issuesOverviewIn(tx, crawlId, registry, view, ruleFor, includeZero);
    return { overview, view };
  });
}

async function issuesOverviewIn(
  db: SnapshotReader,
  crawlId: string,
  registry: Registry,
  view: JudgementView,
  ruleFor: (ruleId: string) => AnyRule,
  includeZero: boolean,
): Promise<IssuesOverview> {
  if (view.judgedWith === null) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} has not been judged: run crawl_rules first — an empty overview ` +
        "would read as a clean site",
    );
  }
  const pagesJudged = await storedPagesJudged(db, crawlId);
  const copy = copyRenderer(view.copyThresholds);

  const result = await db.execute<{ rule_id: string; urls: number }>(sql`
    select i.rule_id,
           count(distinct coalesce(i.details_jsonb->>'pageUrl', ''))::int as urls
      from issues i
     where i.crawl_id = ${crawlId} and ${notDisabled(view.disabledRules)}
     group by i.rule_id`);

  const counts = new Map<string, number>();
  for (const r of result.rows) {
    counts.set(r.rule_id, r.urls);
  }

  const rowFor = (ruleId: string, urls: number): IssuesOverviewRow => {
    const rule = ruleFor(ruleId);
    if (rule.kind === "metric") {
      throw new Error(`issues overview of crawl ${crawlId}: '${ruleId}' is a metric rule`);
    }
    const t = view.typeOf(ruleId);
    const p = view.priorityOf(ruleId);
    return {
      ruleId,
      title: copy(ruleId).title,
      type: t.type,
      ...(t.overridden ? { typeOverridden: true as const } : {}),
      priority: p.priority,
      ...(p.overridden ? { priorityOverridden: true as const } : {}),
      severity: rule.severity,
      category: rule.category,
      checkIds: [...rule.checkIds],
      urls,
      percentOfJudged:
        pagesJudged === null || pagesJudged === 0
          ? null
          : Math.round((urls / pagesJudged) * 1000) / 10,
      ...(rule.marker !== undefined ? { marker: true as const } : {}),
    };
  };

  const rows: IssuesOverviewRow[] = [];
  for (const [ruleId, urls] of counts) rows.push(rowFor(ruleId, urls));
  if (includeZero) {
    for (const rule of registry.all()) {
      if (rule.kind === "metric" || counts.has(rule.id)) continue;
      if (view.disabledRules.includes(rule.id)) continue;
      rows.push(rowFor(rule.id, 0));
    }
  }
  rows.sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.urls - a.urls ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );

  return {
    crawlId,
    rulesetVersion: RULESET_VERSION,
    pagesJudged,
    rows,
    disabledRules: view.disabledRules,
    judgementStale: view.judgementStale,
  };
}

// ---------------------------------------------------------------------------
// The Crawl Overview (Phase 27a T9)
// ---------------------------------------------------------------------------

/** One count in a Crawl Overview section. */
export interface OverviewEntry {
  label: string;
  value: number;
  /**
   * `value` over the section's total, to one decimal place; null when that
   * total is 0, or when the entry is not a share of it (`urls`' dropped count).
   */
  percent: number | null;
}

/** One section of the Crawl Overview, its entries in a fixed order. */
export interface OverviewSection {
  id: string;
  entries: OverviewEntry[];
}

/**
 * Counts that describe the CRAWL, not the site's quality: Screaming Frog's crawl
 * overview panel, built from what the database stores. `crawl_overview` serves
 * it as JSON over MCP and HTTP, and the `crawl_overview` CSV view writes the
 * same answer from the same builder (`buildCrawlOverview`).
 *
 * SECTIONS, in this order (absent when not measured):
 *  - `urls`: from `crawl_status`'s own fields, so the two cannot disagree.
 *    `Encountered` is every frontier row (pending + leased + done + failed +
 *    renderPending) plus the robots-blocked rows on record, which never enter
 *    the frontier. Percents are against Encountered (itself 100.0), except
 *    `Blocked by robots.txt (dropped)`, which counts DISCOVERIES turned away, is
 *    not a subset of Encountered, and has a null percent. The entries are not a
 *    partition and need not sum (a resume reseeds `pagesCrawled`).
 *  - `fetch-class`, `status-class`, `indexability`, `click-depth`, `discovery`,
 *    `response-time`: each a partition of the crawl's `pages` rows, percent
 *    against the page count.
 *  - `content`: `HTML: <page_type>` over the `ok` rows, `Non-HTML: <family>`
 *    over the `non_html` rows, `Resource: <kind>` over the `resources` rows.
 *    Each percent is against ITS OWN GROUP's subtotal. `too_large` and
 *    `unsupported_encoding` rows are in neither page group (no body was read).
 *  - `render`: pages rendered, and the stored `render.coverage` state.
 *  - `issues-grid`: stored findings by type x priority after the crawl's
 *    overrides, the disabled rules' findings left out.
 *
 * `notMeasured` names what the crawl could not measure, with the reason; it is
 * never written as zeros. It usually names a whole section (`click-depth` and
 * `issues-grid` on an unjudged crawl, `render` on one that never rendered), but
 * MAY NAME ONE ENTRY of a measured section: `render-coverage` (the render
 * section's coverage entry, on a crawl that rendered and was never judged) and
 * `robots-blocked-dropped` (the `urls` dropped count, on a crawl that predates
 * the counter).
 */
export interface CrawlOverview {
  crawlId: string;
  sections: OverviewSection[];
  notMeasured: { id: string; reason: string }[];
  judgementStale: JudgementStale;
}

/** The `notMeasured` reasons, stated once so the docs and tests quote them. */
export const NOT_MEASURED_REASONS = {
  "robots-blocked-dropped":
    "the robots-blocked overflow was not counted on this crawl (it predates migration 0020)",
  "click-depth": "click depth is derived by the rules run; run crawl_rules",
  render: "no render pass ran",
  "render-coverage": "render coverage is a rules-run metric; run crawl_rules",
  "issues-grid": "no rules run has judged this crawl; run crawl_rules",
} as const;

type NotMeasuredId = keyof typeof NOT_MEASURED_REASONS;

/** The fields of `CrawlDetail` (`crawl_status`) the overview reads. */
export interface CrawlOverviewDetail {
  pagesCrawled: number;
  renderPassCount: number;
  frontier: { pending: number; leased: number; done: number; failed: number; renderPending: number };
  robotsBlocked: { recorded: number; dropped: number | null };
}

/** What a section's statements run on: the overview's snapshot transaction. */
type Exec = SnapshotReader;

function percentOf(value: number, total: number): number | null {
  return total === 0 ? null : Math.round((value / total) * 1000) / 10;
}

/** Entries over one total, each with its percent of it. */
function shares(rows: readonly (readonly [string, number])[], total: number): OverviewEntry[] {
  return rows.map(([label, value]) => ({ label, value, percent: percentOf(value, total) }));
}

const sumOf = (rows: readonly (readonly [string, number])[]): number =>
  rows.reduce((n, [, v]) => n + v, 0);

/** Most first, then by label: the order of an open vocabulary's entries. */
function byCountThenLabel(a: readonly [string, number], b: readonly [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

function urlsSection(detail: CrawlOverviewDetail): OverviewSection {
  const f = detail.frontier;
  const encountered =
    f.pending + f.leased + f.done + f.failed + f.renderPending + detail.robotsBlocked.recorded;
  const share = (label: string, value: number): OverviewEntry => ({
    label,
    value,
    percent: percentOf(value, encountered),
  });
  const dropped = detail.robotsBlocked.dropped;
  return {
    id: "urls",
    entries: [
      share("Encountered", encountered),
      share("Fetched", detail.pagesCrawled),
      share("Not fetched (frontier)", f.pending + f.leased),
      share("Blocked by robots.txt (stored)", detail.robotsBlocked.recorded),
      // NULL IS NOT ZERO (`CrawlDetail.robotsBlocked.dropped`): the caller
      // names a null in `notMeasured`. Discoveries, not URLs: never a share of
      // Encountered, so no percent.
      ...(dropped === null
        ? []
        : [{ label: "Blocked by robots.txt (dropped)", value: dropped, percent: null }]),
    ],
  };
}

async function fetchClassSection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const result = await db.execute<{ label: string; n: number }>(sql`
    select p.fetch_class as label, count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId}
     group by p.fetch_class`);
  const rows = result.rows.map((r) => [r.label, r.n] as const).sort(byCountThenLabel);
  return { id: "fetch-class", entries: shares(rows, sumOf(rows)) };
}

const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "No response"] as const;

/**
 * `2xx` … `5xx`, and `No response` (status_code null). A status outside
 * 200–599 (a 1xx that reached the record, LinkedIn's 999) is counted in an
 * `Other status` entry that appears only when non-zero, so the section stays a
 * partition of the pages rather than dropping a row.
 */
async function statusClassSection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const result = await db.execute<{ label: string; n: number }>(sql`
    select case
             when p.status_code is null then 'No response'
             when p.status_code between 200 and 599 then (p.status_code / 100)::text || 'xx'
             else 'Other status'
           end as label,
           count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId}
     group by 1`);
  const counts = new Map(result.rows.map((r) => [r.label, r.n]));
  const rows: [string, number][] = STATUS_CLASSES.map((label) => [label, counts.get(label) ?? 0]);
  const other = counts.get("Other status");
  if (other !== undefined) rows.push(["Other status", other]);
  return { id: "status-class", entries: shares(rows, sumOf(rows)) };
}

/** `resources.kind` (`ResourceKind`) → its label. A kind not here throws. */
const RESOURCE_KIND_LABELS: Record<string, string> = {
  image: "Image",
  css: "CSS",
  js: "JavaScript",
};
const NON_HTML_FAMILIES = ["PDF", "Image", "CSS", "JavaScript", "Other"] as const;

/**
 * One statement, three groups (a `union all` of three `group by`s):
 *  - `HTML: <page_type>`: the `ok` rows, a null page type as `Unclassified`;
 *  - `Non-HTML: <family>`: the `non_html` rows by media type: `PDF`, `Image`,
 *    `CSS`, `JavaScript` (the JavaScript / ECMAScript types), else `Other` (a
 *    missing content type included);
 *  - `Resource: <kind>`: the `resources` rows (`Image`, `CSS`, `JavaScript`).
 * Each percent is against ITS OWN GROUP's subtotal: a page and a resource are
 * not shares of one whole. `too_large` and `unsupported_encoding` rows are in
 * neither page group, because no body was read; `fetch-class` counts them.
 */
async function contentSection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const mediaType = sql.raw(`lower(btrim(split_part(coalesce(p.content_type, ''), ';', 1)))`);
  const result = await db.execute<{ grp: string; key: string | null; n: number }>(sql`
    select 'HTML' as grp, p.page_type as key, count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId} and p.fetch_class = 'ok'
     group by p.page_type
    union all
    select 'Non-HTML' as grp,
           case
             when ${mediaType} = 'application/pdf' then 'PDF'
             when ${mediaType} like 'image/%' then 'Image'
             when ${mediaType} = 'text/css' then 'CSS'
             when ${mediaType} in ('application/javascript', 'text/javascript',
               'application/x-javascript', 'application/ecmascript', 'text/ecmascript')
               then 'JavaScript'
             else 'Other'
           end as key,
           count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId} and p.fetch_class = 'non_html'
     group by 2
    union all
    select 'Resource' as grp, r.kind as key, count(*)::int as n
      from resources r
     where r.crawl_id = ${crawlId}
     group by r.kind`);

  const html: [string, number][] = [];
  const nonHtml = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  for (const r of result.rows) {
    if (r.grp === "HTML") {
      html.push([`HTML: ${r.key ?? "Unclassified"}`, r.n]);
    } else if (r.grp === "Non-HTML") {
      nonHtml.set(r.key ?? "Other", r.n);
    } else {
      const label = r.key === null ? undefined : RESOURCE_KIND_LABELS[r.key];
      if (label === undefined) {
        throw new Error(
          `crawl overview of crawl ${crawlId}: resources.kind '${String(r.key)}' has no ` +
            "label; add it to RESOURCE_KIND_LABELS (src/api/overview.ts)",
        );
      }
      resourceCounts.set(label, r.n);
    }
  }
  html.sort(byCountThenLabel);
  const nonHtmlRows = NON_HTML_FAMILIES.map(
    (family) => [`Non-HTML: ${family}`, nonHtml.get(family) ?? 0] as const,
  );
  const resourceRows = Object.values(RESOURCE_KIND_LABELS).map(
    (label) => [`Resource: ${label}`, resourceCounts.get(label) ?? 0] as const,
  );
  return {
    id: "content",
    entries: [
      ...shares(html, sumOf(html)),
      ...shares(nonHtmlRows, sumOf(nonHtmlRows)),
      ...shares(resourceRows, sumOf(resourceRows)),
    ],
  };
}

/**
 * `Indexable`, then one entry per `INDEXABILITY_STATUS_SQL` value, most first.
 * The `Canonicalised` branch is `CANONICALISED_ELSEWHERE`, which abstains
 * (counts the page `Indexable`) on a relative, non-ASCII or dot-segment
 * canonical: the same predicate the SQL rules' judged set uses (Controller
 * Ruling 8).
 */
async function indexabilitySection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const result = await db.execute<{ status: string; n: number }>(sql`
    select ${INDEXABILITY_STATUS_SQL("p")} as status, count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId}
     group by 1`);
  const indexable = result.rows.find((r) => r.status === "")?.n ?? 0;
  const rows: [string, number][] = [
    ["Indexable", indexable],
    ...result.rows
      .filter((r) => r.status !== "")
      .map((r): [string, number] => [r.status, r.n])
      .sort(byCountThenLabel),
  ];
  return { id: "indexability", entries: shares(rows, sumOf(rows)) };
}

const CLICK_DEPTH_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10+", "Unreachable"];

/**
 * `pages.click_depth` over every page, as `deriveClickDepth` wrote it on the
 * last rules run: `0` … `9`, `10+`, and `Unreachable` for a null (no internal
 * link path from the entry point reaches the page).
 */
async function clickDepthSection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const result = await db.execute<{ label: string; n: number }>(sql`
    select case
             when p.click_depth is null then 'Unreachable'
             when p.click_depth >= 10 then '10+'
             else p.click_depth::text
           end as label,
           count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId}
     group by 1`);
  const counts = new Map(result.rows.map((r) => [r.label, r.n]));
  for (const label of counts.keys()) {
    if (!CLICK_DEPTH_LABELS.includes(label)) {
      // A negative depth: a writer defect, never a bucket to drop.
      throw new Error(`crawl overview of crawl ${crawlId}: click depth '${label}' has no bucket`);
    }
  }
  const rows = CLICK_DEPTH_LABELS.map((label) => [label, counts.get(label) ?? 0] as const);
  return { id: "click-depth", entries: shares(rows, sumOf(rows)) };
}

/**
 * One entry per `discovered_via`, most first, then `In a sitemap` /
 * `Not in a sitemap`: whether any of the crawl's `sitemap_urls.url_normalised`
 * is the page's `url` (the join `sitemap.ts` and `link-graph.ts` make). Both
 * halves partition the pages, so both are against the page count.
 */
async function discoverySection(db: Exec, crawlId: string): Promise<OverviewSection> {
  const result = await db.execute<{ via: string; in_sitemap: boolean; n: number }>(sql`
    select p.discovered_via as via,
           exists (
             select 1 from sitemap_urls s
              where s.crawl_id = ${crawlId} and s.url_normalised = p.url
           ) as in_sitemap,
           count(*)::int as n
      from pages p
     where p.crawl_id = ${crawlId}
     group by 1, 2`);
  const via = new Map<string, number>();
  let inSitemap = 0;
  let notInSitemap = 0;
  for (const r of result.rows) {
    via.set(r.via, (via.get(r.via) ?? 0) + r.n);
    if (r.in_sitemap) inSitemap += r.n;
    else notInSitemap += r.n;
  }
  const total = inSitemap + notInSitemap;
  return {
    id: "discovery",
    entries: [
      ...shares([...via.entries()].sort(byCountThenLabel), total),
      ...shares(
        [
          ["In a sitemap", inSitemap],
          ["Not in a sitemap", notInSitemap],
        ],
        total,
      ),
    ],
  };
}

/**
 * `pages.response_time_ms` in fixed buckets (plan Deviation 5), each [lo, hi):
 * 249 is `Under 250 ms`, 250 is `250–500 ms`, 2000 is `2000+ ms`. EVERY page
 * row is counted and a row with no response time (never requested, such as a
 * robots-blocked or url-policy row) is `No response time`, so the six buckets
 * partition the pages. The population is NOT the judged set.
 *
 * `Over SLOW_MS (<n> ms)` is not a bucket: it counts pages STRICTLY over the
 * crawl's SLOW_MS (`>`, as `performance.slow-response` compares) across the
 * buckets, over the same population. That rule fires only on the judged set
 * (`isJudged`), so this count can exceed its findings. SLOW_MS is the one the
 * stored findings were judged with (the stamp), or the current block's on an
 * unjudged crawl (`JudgementView.copyThresholds`).
 */
async function responseTimeSection(
  db: Exec,
  crawlId: string,
  slowMs: number,
): Promise<OverviewSection> {
  const result = await db.execute<{
    b0: number;
    b1: number;
    b2: number;
    b3: number;
    b4: number;
    none: number;
    over: number;
    total: number;
  }>(sql`
    select count(*) filter (where p.response_time_ms < 250)::int as b0,
           count(*) filter (where p.response_time_ms >= 250 and p.response_time_ms < 500)::int as b1,
           count(*) filter (where p.response_time_ms >= 500 and p.response_time_ms < 1000)::int as b2,
           count(*) filter (where p.response_time_ms >= 1000 and p.response_time_ms < 2000)::int as b3,
           count(*) filter (where p.response_time_ms >= 2000)::int as b4,
           count(*) filter (where p.response_time_ms is null)::int as none,
           count(*) filter (where p.response_time_ms > ${slowMs})::int as over,
           count(*)::int as total
      from pages p
     where p.crawl_id = ${crawlId}`);
  const r = result.rows[0];
  if (r === undefined) {
    // A bare aggregate answers one row over any input; none is a defect of ours.
    throw new Error(`crawl overview of crawl ${crawlId}: the response-time aggregate answered no row`);
  }
  const rows: [string, number][] = [
    ["Under 250 ms", r.b0],
    ["250–500 ms", r.b1],
    ["500–1000 ms", r.b2],
    ["1000–2000 ms", r.b3],
    ["2000+ ms", r.b4],
    ["No response time", r.none],
    [`Over SLOW_MS (${slowMs} ms)`, r.over],
  ];
  return { id: "response-time", entries: shares(rows, r.total) };
}

/** The `render.coverage` value fields the overview reads, validated (rule 7). */
function storedRenderCoverage(
  value: unknown,
  crawlId: string,
): { pagesCrawled: number; pagesRendered: number; evidence: string } {
  const v =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const count = (key: string): number => {
    const n = v?.[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(
        `crawl ${crawlId}'s stored render.coverage metric has no usable ${key} ` +
          `(${JSON.stringify(n)}): re-run the rules over this crawl`,
      );
    }
    return n;
  };
  const evidence = v?.renderPassEvidence;
  if (typeof evidence !== "string" || !Object.values<string>(RENDER_PASS_EVIDENCE).includes(evidence)) {
    throw new Error(
      `crawl ${crawlId}'s stored render.coverage metric has no usable renderPassEvidence ` +
        `(${JSON.stringify(evidence)}): re-run the rules over this crawl`,
    );
  }
  return {
    pagesCrawled: count("pagesCrawled"),
    pagesRendered: count("pagesRendered"),
    evidence,
  };
}

/**
 * `Pages rendered`, counted live over the REQUESTED pages (every row but the
 * robots-blocked ones, `render.coverage`'s own denominator), then
 * `Render coverage (<state>)` from the stored `render.coverage` row: value
 * `pagesRendered`, percent `pagesRendered / pagesCrawled`, the metric's
 * `renderPassEvidence` (ran | none | failed) in the label. On an unjudged crawl
 * there is no row to read, and the caller names the entry in `notMeasured`
 * (`render-coverage`); on a judged crawl a missing or malformed row throws,
 * naming the crawl.
 */
async function renderSection(
  db: Exec,
  crawlId: string,
  judged: boolean,
): Promise<OverviewSection> {
  const result = await db.execute<{ requested: number; rendered: number }>(sql`
    select count(*) filter (where not ${ROBOTS_BLOCKED("p")})::int as requested,
           count(*) filter (where p.rendered and not ${ROBOTS_BLOCKED("p")})::int as rendered
      from pages p
     where p.crawl_id = ${crawlId}`);
  const r = result.rows[0];
  if (r === undefined) {
    throw new Error(`crawl overview of crawl ${crawlId}: the render aggregate answered no row`);
  }
  const entries: OverviewEntry[] = [
    { label: "Pages rendered", value: r.rendered, percent: percentOf(r.rendered, r.requested) },
  ];
  if (!judged) return { id: "render", entries };

  const metric = await db.execute<{ value: unknown }>(sql`
    select m.value_jsonb as value
      from metrics m
     where m.crawl_id = ${crawlId} and m.metric_id = 'render.coverage' and m.scope = 'site'
     limit 2`);
  const row = metric.rows[0];
  if (row === undefined || metric.rows.length > 1) {
    throw new Error(
      `crawl ${crawlId} is judged but holds ${metric.rows.length} site-scope render.coverage ` +
        "rows, where a rules run writes exactly one: re-run the rules over this crawl",
    );
  }
  const coverage = storedRenderCoverage(row.value, crawlId);
  entries.push({
    label: `Render coverage (${coverage.evidence})`,
    value: coverage.pagesRendered,
    percent: percentOf(coverage.pagesRendered, coverage.pagesCrawled),
  });
  return { id: "render", entries };
}

const GRID_TYPES: readonly IssueType[] = ["issue", "warning", "opportunity"];
const GRID_PRIORITIES: readonly Priority[] = ["high", "medium", "low"];

/**
 * Stored FINDING rows (not URLs) by type x priority, with the crawl's overrides
 * applied (`typeOf` / `priorityOf`) and the disabled rules' findings left out
 * in SQL. One `GROUP BY rule_id`, at most one row per rule, mapped into the
 * nine cells; percent against the findings counted.
 */
async function issuesGridSection(
  db: Exec,
  crawlId: string,
  view: JudgementView,
  ruleFor: (ruleId: string) => AnyRule,
): Promise<OverviewSection> {
  const result = await db.execute<{ rule_id: string; n: number }>(sql`
    select i.rule_id, count(*)::int as n
      from issues i
     where i.crawl_id = ${crawlId} and ${notDisabled(view.disabledRules)}
     group by i.rule_id`);
  const cells = new Map<string, number>();
  for (const r of result.rows) {
    if (ruleFor(r.rule_id).kind === "metric") {
      throw new Error(`crawl overview of crawl ${crawlId}: '${r.rule_id}' is a metric rule`);
    }
    const key = `${view.typeOf(r.rule_id).type}/${view.priorityOf(r.rule_id).priority}`;
    cells.set(key, (cells.get(key) ?? 0) + r.n);
  }
  const rows = GRID_TYPES.flatMap((t) =>
    GRID_PRIORITIES.map((p) => [`${t}/${p}`, cells.get(`${t}/${p}`) ?? 0] as const),
  );
  return { id: "issues-grid", entries: shares(rows, sumOf(rows)) };
}

/**
 * Build the Crawl Overview inside ONE snapshot (`inSnapshot`, Ruling 14).
 * `loadDetail` is the service's `getCrawl` over the given reader, so the `urls`
 * entries are `crawl_status`'s own fields. It, the judgement view (whose
 * `rules_run_at` decides whether click depth and the issues grid are measured)
 * and every section are read in the snapshot, so they describe one moment even
 * while a rules run is rewriting the crawl. `ruleFor` is the service's
 * read-time join, which throws the 409 `issues_list` raises for a stored
 * finding of a rule the registry lacks.
 *
 * Hard rule 3: each section is one bounded aggregate; no `pages`, `links` or
 * `issues` row is loaded.
 *
 * Unlike the Issues Overview, an unjudged crawl is answered: every crawl-level
 * section is there, and only what the rules run produces (`click-depth`,
 * `issues-grid`, the render coverage entry) is named as not measured.
 */
export async function buildCrawlOverview(
  db: Db,
  crawlId: string,
  registry: Registry,
  loadDetail: (reader: SnapshotReader) => Promise<CrawlOverviewDetail>,
  ruleFor: (ruleId: string) => AnyRule,
): Promise<CrawlOverview> {
  return await inSnapshot(db, async (tx) => {
    // The detail first: an unknown crawl is its NOT_FOUND.
    const detail = await loadDetail(tx);
    const view = await loadJudgementView(tx, crawlId, registry);
    const judged = view.judgedWith !== null;
    const slowMs = view.copyThresholds.SLOW_MS;

    const sections: OverviewSection[] = [];
    const notMeasured: { id: string; reason: string }[] = [];
    const skip = (id: NotMeasuredId): void => {
      notMeasured.push({ id, reason: NOT_MEASURED_REASONS[id] });
    };

    sections.push(urlsSection(detail));
    if (detail.robotsBlocked.dropped === null) skip("robots-blocked-dropped");
    sections.push(await fetchClassSection(tx, crawlId));
    sections.push(await statusClassSection(tx, crawlId));
    sections.push(await contentSection(tx, crawlId));
    sections.push(await indexabilitySection(tx, crawlId));
    if (judged) sections.push(await clickDepthSection(tx, crawlId));
    else skip("click-depth");
    sections.push(await discoverySection(tx, crawlId));
    sections.push(await responseTimeSection(tx, crawlId, slowMs));
    if (detail.renderPassCount > 0) {
      sections.push(await renderSection(tx, crawlId, judged));
      if (!judged) skip("render-coverage");
    } else {
      skip("render");
    }
    if (judged) sections.push(await issuesGridSection(tx, crawlId, view, ruleFor));
    else skip("issues-grid");

    return { crawlId, sections, notMeasured, judgementStale: view.judgementStale };
  });
}
