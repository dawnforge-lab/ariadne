/**
 * The render pass's coverage: how much of this crawl left through a browser,
 * and what the selection that chose it was working with (CHECK-01 evidence).
 *
 * The three diff rules (src/rules/query/render-diff.ts) speak only about pages
 * the render pass measured, and on a budgeted pass that is a small minority of a
 * large crawl. Their silence is therefore ambiguous on its own — "no page of
 * this site depends on JavaScript" and "we rendered four pages of fifty
 * thousand" produce the same empty findings list. This metric is what
 * disambiguates them, and it is the number the agent quotes before quoting any
 * of the three: it makes the sampling story sayable instead of inferrable.
 *
 * **TWO SIDES, NAMED AS SUCH.** The columns fall into two groups that are
 * measured differently and must not be read as one:
 *
 *  - the SELECTION side (`selection*`) — what the render selection decided, from
 *    `renderSelectionStats` (src/crawl/render/select.ts). Those numbers have no
 *    column to live in, so they are RECOMPUTED from the same SQL that chose the
 *    pages. That is sound because every input the decision reads is written by
 *    the CRAWL pass and the render pass writes only `rendered_*` columns, so the
 *    recomputation returns the same numbers before the pass, during it, and a
 *    week later (the function's own header states this contract).
 *
 *    **One thing recomputation cannot see, and it governs the rest of that
 *    side**: whether the automatic decision was the one that ran. Since Phase 8
 *    a caller may NAME the pages worth a browser, and a named list is an input
 *    no `pages` column records — so the render pass writes it to
 *    `crawls.render_urls_jsonb`, its own column since migration 0012 (through
 *    Phase 8 it was a key inside `config_jsonb`; `recordRenderSelection`,
 *    src/crawl/render/run-render.ts, carries the history). `selectionMode` is
 *    that record, and in the explicit case the four automatic numbers are null
 *    rather than zero.
 *
 *    **AND ONE THING RECOMPUTATION CANNOT SAY AT ALL**: whether ANY pass ran.
 *    The recomputation answers the same numbers on a crawl nobody has ever
 *    rendered as on one rendered last week, so `selectionSelected: 18` beside
 *    `pagesRendered: 0` reads as a record of eighteen pages somebody chose, and
 *    on an unrendered crawl it is not one. The Phase 11 audit found exactly
 *    that and filed it (docs/gates/phase-11.md §6.3); `renderPassEvidence` is
 *    the answer, and it is described where it is written below.
 *  - the EVIDENCE side (`pages*`, `renderFailures`) — what is actually on the
 *    page rows now: how many say `rendered`, and how many carry a
 *    `render_error`.
 *
 * **THE SINGLE-PASS INVARIANT IS NOT ASSERTED.** It would be tempting to check
 * `pagesRendered + renderFailures == selectionSelected` and throw otherwise. It
 * is deliberately absent: a re-selection under a CHANGED BUDGET leaves the
 * earlier pass's `rendered_*` columns standing on pages the new selection does
 * not name (`selectRenderSet` demotes their frontier rows, it does not erase
 * their evidence), so the two sides legitimately disagree on any crawl selected
 * more than once. That asymmetry is documented here and visible in the numbers a
 * reader gets; erasing it with an assertion would turn a describable history
 * into a crash, and erasing it with a correction would be the silent fallback
 * hard rule 7 forbids.
 *
 * The config comes from the CRAWL'S OWN `config_jsonb` — never from the ambient
 * `RENDER_DEFAULTS`. `startCrawl` stores the config it ran with, and the render
 * pass resolves that same object; reading defaults here for a crawl configured
 * otherwise would describe a selection that never happened. A crawl that stored
 * none of the three knobs is a crawl the pass ran on the resolved defaults, and
 * `resolveRenderConfig` reproduces exactly that resolution rather than
 * substituting for it.
 */
import { eq, sql } from "drizzle-orm";

import { frontierCounts } from "../../crawl/frontier.js";
import {
  renderSelectionStats,
  type RenderSelectionConfig,
} from "../../crawl/render/select.js";
import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { metricRow, metricRule, ROBOTS_BLOCKED, type MetricIdentity } from "../helpers.js";
import { perScope } from "../registry/metric-table.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { num } from "./cohort.js";

/**
 * `renderPassEvidence`'s closed vocabulary: `ran` when this crawl holds anything
 * a render pass wrote, `none` when it holds nothing of the kind.
 *
 * Declared as a named constant on the `RESOURCE_FETCH_CLASSES` model
 * (src/crawl/resources/fetch-resources.ts): this rule WRITES the value, so it
 * owns the strings, and every reader — the metric's own tests, the `pages`
 * filter hint in mcp.ts — names them through this object rather than spelling a
 * bare `"ran"`/`"none"` a rename would leave silently matching nothing. The two
 * value strings ARE the wire contract and are unchanged by this refactor; the
 * constant is literal→named, not a wire change.
 */
export const RENDER_PASS_EVIDENCE = {
  ran: "ran",
  none: "none",
} as const;
export type RenderPassEvidence = (typeof RENDER_PASS_EVIDENCE)[keyof typeof RENDER_PASS_EVIDENCE];

/** The three render knobs a `crawls` row may carry, in the order they are read. */
const RENDER_CONFIG_KEYS = [
  "renderBudgetPct",
  "renderMaxPages",
  "renderSamplePerType",
] as const satisfies readonly (keyof RenderSelectionConfig)[];

/**
 * The render knobs this crawl was configured with, read from its own row.
 *
 * Validated rather than cast, for `parseDiscovery`'s reason and with a sharper
 * consequence: a stored `renderMaxPages: "500"` would reach
 * `resolveRenderConfig` as a string, and the range check there would report a
 * budget problem rather than the type problem that caused it. Checked here,
 * where the message can name the crawl and the key. A key that is ABSENT is not
 * an error — it is a crawl that left the knob at its default, which is what the
 * render pass itself did with the same row.
 */
interface StoredRenderInputs {
  /** The three knobs, as the crawl stored them. */
  cfg: RenderSelectionConfig;
  /**
   * The URL list the last render pass was given, or null for the automatic
   * selection — including the null a crawl that has never been rendered by a
   * Phase 8 pass gets, where automatic is the only decision that can have
   * happened. See `crawls.render_urls_jsonb` (src/db/schema.ts).
   */
  renderUrls: string[] | null;
  /**
   * What the LAST render pass stamped on the crawl row: the number of pages it
   * rendered (`crawls.render_pass_count`, set — never incremented — by step 4
   * of the pass). Read here only as evidence that a pass ran; see
   * `renderPassEvidence` below.
   */
  renderPassCount: number;
}

async function readRenderConfig(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<StoredRenderInputs> {
  const rows = await db
    .select({
      config: crawls.config,
      renderUrls: crawls.renderUrlsJsonb,
      renderPassCount: crawls.renderPassCount,
    })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  // The existence gate every metric opens with: an unknown crawl aggregates to
  // a table of zeroes that reads exactly like a crawl nobody rendered.
  if (row === undefined) throw new Error(`${ruleId}: no such crawl '${crawlId}'`);
  const config: unknown = row.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${ruleId}: crawl '${crawlId}' config is not an object`);
  }

  const stored = config as Record<string, unknown>;
  const cfg: RenderSelectionConfig = {};
  for (const key of RENDER_CONFIG_KEYS) {
    const value = stored[key];
    if (value === undefined) continue;
    if (typeof value !== "number") {
      throw new Error(
        `${ruleId}: crawl '${crawlId}' config.${key} is ${typeof value}, not a number — ` +
          "the render selection this metric describes cannot be reproduced from it",
      );
    }
    cfg[key] = value;
  }

  // The fourth input — its own column since migration 0012, and validated on
  // the same terms as the three above for a sharper reason: a shape this rule
  // cannot read would otherwise be reported as "the automatic selection", which
  // is a claim about how the pages were chosen and would be false. NULL is not
  // malformed — see `StoredRenderInputs.renderUrls`.
  const named: unknown = row.renderUrls;
  let renderUrls: string[] | null = null;
  if (named !== null) {
    if (!Array.isArray(named) || named.some((entry) => typeof entry !== "string")) {
      throw new Error(
        `${ruleId}: crawl '${crawlId}' render_urls_jsonb is neither null nor an ` +
          "array of strings — the render selection this metric describes cannot be " +
          "reproduced from it",
      );
    }
    renderUrls = named as string[];
  }

  return { cfg, renderUrls, renderPassCount: row.renderPassCount };
}

/**
 * One site row: the sampling story and what came of it.
 *
 * The columns, in the order they are written:
 *
 *  - `pagesCrawled` — every `pages` row of the crawl, whatever it answered,
 *    bar the robots-blocked rows that were never requested (Phase 23 T3). The
 *    same denominator the budget is a percentage OF, deliberately: `budget` is
 *    `min(ceil(pages × pct/100), renderMaxPages)` over this number, not over the
 *    renderable subset.
 *  - `renderPassEvidence` — `ran` or `none`: whether ANYTHING this crawl holds
 *    was written by a render pass. It comes before `selectionMode` because it
 *    governs the mode in turn: on `none`, the four automatic numbers below
 *    describe the selection a pass WOULD make if one were started now, and not
 *    one that was made. See the section on it below.
 *  - `selectionMode` — `auto` or `explicit`: WHICH DECISION chose the pages, and
 *    therefore how the four numbers after it are to be read. It comes first
 *    among the selection columns because it governs them.
 *  - `selectionBudget` — the seats the selection had.
 *  - `selectionSuspects` — candidates that tripped a suspicion trigger (a long
 *    document with no words, a titleless page, a framework marker, a page that
 *    links nowhere), BEFORE the budget cut.
 *  - `selectionSampled` — candidates the per-page-type sample contributed and
 *    suspicion did not, also before the cut. A page that is both counts once, on
 *    the suspect side, so the two sum to the whole candidate set.
 *  - `selectionSelected` — `min(budget, suspects + sampled)`: how many pages the
 *    selection actually names. Derived here rather than returned, because it is
 *    the budget cut applied to the candidate total and both of those are above
 *    it; a reader should be able to check it.
 *  - `selectionTruncated` — whether a candidate was cut for want of a seat. When
 *    true, `selectionSelected` is the budget and not the need.
 *  - `pagesRendered` — page rows now carrying `rendered = true`.
 *  - `renderFailures` — page rows carrying a `render_error`. A failure is a
 *    RECORDED row rather than a skipped URL (hard rule 7), and it is counted
 *    separately from `pagesRendered` because the two are disjoint: a failed
 *    render writes the error and no counts.
 *
 * See the module header for why `pagesRendered + renderFailures` is not asserted
 * to equal `selectionSelected`.
 *
 * ## THE EXPLICIT CASE: four nulls, not four zeroes
 *
 * When `selectionMode` is `explicit`, an auditing agent named the pages and the
 * automatic decision never ran. `selectionBudget`, `selectionSuspects`,
 * `selectionSampled` and `selectionTruncated` are then **null**, and
 * `selectionSelected` is the length of the list.
 *
 * The tempting alternatives are both worse, and both were considered:
 *
 *  - **Zeroes.** `selectionSuspects: 0` beside `selectionSampled: 0` says "the
 *    automatic selection ran and found no candidate" — a real and different
 *    fact, and one a reader would quote as evidence that the site's HTML looked
 *    complete. It is exactly the mis-reading `selectionMode` exists to prevent,
 *    so putting it in the columns beside the mode would defeat the field.
 *  - **The automatic numbers anyway**, recomputed for information. They describe
 *    a selection that did not happen. `selectionSelected` would then contradict
 *    the pages actually rendered for no reason a reader could work out.
 *
 * A null here means "this question does not apply to how these pages were
 * chosen", which is what it means everywhere else in this engine.
 *
 * ## `renderPassEvidence`: `ran` and `none`, and why neither is `false`
 *
 * P12-T4, closing the residual the Phase 11 audit filed at
 * docs/gates/phase-11.md §6.3: on a crawl with no render pass this row read
 * `{pagesRendered: 0, selectionMode: "auto", selectionBudget: 28,
 * selectionSampled: 18, selectionSelected: 18}`, and the last three describe a
 * decision nobody took. `pagesRendered: 0` was the only thing saying so, and it
 * is the wrong field to say it with: a pass that ran and rendered nothing
 * writes the same zero.
 *
 * **The nulls were the obvious fix and are the wrong one.** Blanking the four
 * numbers on an unrendered crawl would throw away the one thing an agent
 * DECIDING WHETHER TO RENDER wants — how many seats a pass would have and how
 * many pages look worth one — and would spend the doctrine's null on a question
 * that does apply. The numbers stay; a field beside them says what they are.
 *
 * **`ran` is a claim about writing, and every disjunct is something a pass
 * WROTE:**
 *
 *  - a page row saying `rendered`, or one carrying a `render_error` — the two
 *    outcomes `writeRenderResult` produces;
 *  - `crawls.render_urls_jsonb` — written inside the pass's own selection
 *    transaction (`recordRenderSelection`), which is why `explicit` can never
 *    appear beside `none`;
 *  - `crawls.render_pass_count` — the pass's step 4. Redundant with
 *    `pagesRendered` BY CONSTRUCTION today (it is stamped with the count of the
 *    rows just written), and read anyway because the number is SERVED:
 *    `crawl_status` publishes it, and answering `none` beside a
 *    `renderPassCount` of 2 would be two surfaces of one engine disagreeing
 *    about one crawl;
 *  - a frontier row still `render_pending` — the only proof a pass ABORTED
 *    before its first completed render leaves anywhere, and the whole reason
 *    this rule asks the frontier at all.
 *
 * **`none` is a claim about our records, not about history**, and it is worded
 * that way on purpose: it says nothing this crawl holds was written by a render
 * pass. There is exactly one shape it gets wrong, and it is stated rather than
 * hidden — an automatic pass that selected ZERO pages promotes no frontier row,
 * renders nothing, fails nothing and stamps 0, so it leaves no trace at all. On
 * that crawl the projection and the record are the same zeroes, so the numbers
 * beside `none` are still exactly what happened. That is why the value is
 * `none` and not `false`: a field called "did a pass run" answering `false`
 * there would be a claim about the past that this rule cannot make.
 */
async function renderCoverage(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  const { cfg, renderUrls, renderPassCount } = await readRenderConfig(db, crawlId, self.id);
  // Recomputed only when it describes something. On an explicit pass the
  // automatic decision is not merely unreported, it is not asked: running the
  // candidate SQL to throw the answer away would invite a later reader to
  // publish it.
  const selection = renderUrls === null ? await renderSelectionStats(db, crawlId, cfg) : null;

  const res = await db.execute<{
    pages_crawled: number;
    pages_rendered: number;
    render_failures: number;
  }>(sql`
    select count(*)::int as pages_crawled,
           count(*) filter (where p.rendered)::int as pages_rendered,
           count(*) filter (where p.render_error is not null)::int as render_failures
    from pages p
    where p.crawl_id = ${crawlId}
      -- Crawled means requested: a robots-blocked row (Phase 23 T3) is not,
      -- and the render budget's denominator excludes it the same way.
      and not ${ROBOTS_BLOCKED("p")}`);

  const row = res.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' render count query returned no row`);
  }

  const pagesRendered = num(row.pages_rendered, "pages_rendered", self.id);
  const renderFailures = num(row.render_failures, "render_failures", self.id);
  // The frontier is asked ONLY for the aborted pass — a selection promoted to
  // `render_pending` and never completed leaves nothing on `crawls` and nothing
  // on `pages`. One extra query, over an indexed column, on a rule that runs
  // once per crawl; `frontierCounts` is used rather than a fifth hand-written
  // `state = 'render_pending'` so the state string stays owned by the module
  // that owns the state machine.
  const renderPending = (await frontierCounts(db, crawlId)).renderPending;

  return [
    metricRow(self, {
      scope: "site",
      value: {
        pagesCrawled: num(row.pages_crawled, "pages_crawled", self.id),
        renderPassEvidence:
          renderUrls !== null ||
          renderPassCount > 0 ||
          pagesRendered > 0 ||
          renderFailures > 0 ||
          renderPending > 0
            ? RENDER_PASS_EVIDENCE.ran
            : RENDER_PASS_EVIDENCE.none,
        selectionMode: selection === null ? "explicit" : "auto",
        selectionBudget: selection?.budget ?? null,
        selectionSuspects: selection?.suspects ?? null,
        selectionSampled: selection?.sampled ?? null,
        selectionSelected:
          selection === null
            ? // The list IS the selection: every entry was checked against this
              // crawl's pages before the pass ran, and the pass refuses to
              // render a shorter list than it was handed
              // (selectExplicitRenderSet's own invariant).
              (renderUrls?.length ?? 0)
            : Math.min(selection.budget, selection.suspects + selection.sampled),
        selectionTruncated: selection?.truncated ?? null,
        pagesRendered,
        renderFailures,
      },
    }),
  ];
}

export const renderMetrics: MetricRule[] = [
  metricRule(
    "render.coverage",
    ["CHECK-01"],
    "crawl",
    // `Render Run` is `renderPassEvidence` and it is the column to read FIRST:
    // the four selection numbers beside it describe a decision that was taken
    // ("ran") or one that would be ("none"), and they look identical either way.
    perScope("Scope", [
      { key: "pagesCrawled", label: "Pages Crawled" },
      { key: "renderPassEvidence", label: "Render Run" },
      { key: "selectionMode", label: "Selection Mode" },
      { key: "selectionBudget", label: "Render Budget" },
      { key: "selectionSuspects", label: "Suspect Pages" },
      { key: "selectionSampled", label: "Sampled Pages" },
      { key: "selectionSelected", label: "Selected Pages" },
      { key: "selectionTruncated", label: "Selection Truncated" },
      { key: "pagesRendered", label: "Pages Rendered" },
      { key: "renderFailures", label: "Render Failures" },
    ], 9),
    async (db, crawlId, self) => renderCoverage(db, crawlId, self),
  ),
];
