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

import { renderSelectionStats, type RenderSelectionConfig } from "../../crawl/render/select.js";
import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { num } from "./cohort.js";

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
async function readRenderConfig(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<RenderSelectionConfig> {
  const rows = await db
    .select({ config: crawls.config })
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
  return cfg;
}

/**
 * One site row: the sampling story and what came of it.
 *
 * The columns, in the order they are written:
 *
 *  - `pagesCrawled` — every `pages` row of the crawl, whatever it answered. The
 *    same denominator the budget is a percentage OF, deliberately: `budget` is
 *    `min(ceil(pages × pct/100), renderMaxPages)` over this number, not over the
 *    renderable subset.
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
 */
async function renderCoverage(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  const cfg = await readRenderConfig(db, crawlId, self.id);
  const selection = await renderSelectionStats(db, crawlId, cfg);

  const res = await db.execute<{
    pages_crawled: number;
    pages_rendered: number;
    render_failures: number;
  }>(sql`
    select count(*)::int as pages_crawled,
           count(*) filter (where p.rendered)::int as pages_rendered,
           count(*) filter (where p.render_error is not null)::int as render_failures
    from pages p
    where p.crawl_id = ${crawlId}`);

  const row = res.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row is a statement that did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' render count query returned no row`);
  }

  return [
    metricRow(self, {
      scope: "site",
      value: {
        pagesCrawled: num(row.pages_crawled, "pages_crawled", self.id),
        selectionBudget: selection.budget,
        selectionSuspects: selection.suspects,
        selectionSampled: selection.sampled,
        selectionSelected: Math.min(selection.budget, selection.suspects + selection.sampled),
        selectionTruncated: selection.truncated,
        pagesRendered: num(row.pages_rendered, "pages_rendered", self.id),
        renderFailures: num(row.render_failures, "render_failures", self.id),
      },
    }),
  ];
}

export const renderMetrics: MetricRule[] = [
  metricRule("render.coverage", ["CHECK-01"], "crawl", async (db, crawlId, self) =>
    renderCoverage(db, crawlId, self),
  ),
];
