/**
 * Which pages the render pass is allowed to render.
 *
 * Rendering is the expensive half of this engine — a browser context, a real
 * navigation, a settle wait — so the second pass never runs over the whole
 * crawl. It runs over a *selection*, and this file is the whole of that
 * decision, taken in SQL against the evidence the crawl already wrote.
 *
 * The selection has two halves and one hard bound:
 *
 *  - **Suspects.** Pages whose raw HTML looks like it is not the whole page: a
 *    long document with almost no words in it, a page that links nowhere, a
 *    sizeable page with no title, or a page carrying a client-side framework's
 *    hydration marker. Each is a reason to believe a browser would see
 *    something the tokenizer did not, and each is a column the analyzer already
 *    filled in (migration 0007).
 *  - **A per-page-type sample.** Three pages of every page type, so the pass
 *    can say something about templates that tripped no suspicion at all. A
 *    render that finds nothing is evidence too: without the sample, "no CSR
 *    problems found" would only ever mean "no suspect happened to be wrong".
 *  - **The budget.** `min(ceil(pages × pct/100), renderMaxPages)`. Suspects are
 *    seated first, then the sample, and whatever does not fit is cut — with
 *    `truncated` saying so, because a silently trimmed sample would make the
 *    coverage metric a lie (hard rule 7). The percentage is taken over EVERY
 *    crawled URL, not over the renderable ones, because the bound it enforces
 *    is "we will not render more than 5% of this site".
 *
 * Everything here is one statement's worth of SQL over `pages` and `links`.
 * Nothing loads a page list into memory except the selection itself, which the
 * budget bounds by construction (hard rules 3 and 6).
 *
 * WHAT THIS FUNCTION IS ALLOWED TO ASSUME: that the crawl pass is over. It
 * moves frontier rows into `render_pending` and demotes render rows it no
 * longer names, so running it while a crawl or a render pass is live would take
 * URLs out from under that worker — the same caveat `releaseLeases(db, id,
 * null)` carries, and for the same reason. `runRenderPass` (run-render.ts)
 * ENFORCES that caveat before it calls this function.
 *
 * `renderSelectionStats` is the same decision asked read-only: the coverage
 * metric has to quote the sampling story long after the selection object is
 * gone, and these numbers have no column to live in. Both share `candidateCte`
 * so there is one spelling of "suspect" in the codebase.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";

/**
 * The three numbers the render pass is calibrated with. Phase-5 first
 * calibration: the gate records how many suspects a synthetic 50k site trips so
 * a later phase can move them from data rather than from taste.
 *
 * `renderBudgetPct` of 5 with `renderMaxPages` of 500 means a 10,000-page crawl
 * renders 500 pages and a 50,000-page crawl renders the same 500: past 10k the
 * absolute cap is what binds, which is the intent — the browser cost is the
 * thing being bounded, not a ratio.
 */
export const RENDER_DEFAULTS = {
  renderBudgetPct: 5,
  renderMaxPages: 500,
  renderSamplePerType: 3,
} as const;

/**
 * The four suspicion thresholds, named because two of them are also quoted in
 * the phase-5 gate document and one is a byte count nobody should have to
 * decode twice (51200 = 50KB, 25600 = 25KB).
 */
export const SUSPICION = {
  /** A page with fewer words than this, in a document of `thinHtmlBytes`. */
  thinWordCount: 50,
  /** …and the document size that makes those missing words suspicious. */
  thinHtmlBytes: 50 * 1024,
  /** A titleless page this big is a page whose head was probably built by JS. */
  titlelessHtmlBytes: 25 * 1024,
} as const;

/**
 * The render-pass knobs, as a caller may leave them: every field optional, with
 * `RENDER_DEFAULTS` behind it. `CrawlConfig` extends this, so a crawl config is
 * a render config and the API/CLI layers have one place to read the defaults
 * from (src/crawl/loop.ts).
 */
export interface RenderSelectionConfig {
  /** Percentage of crawled URLs the pass may render. 0 < pct ≤ 100. */
  renderBudgetPct?: number;
  /** Absolute ceiling on renders, whatever the percentage works out to. */
  renderMaxPages?: number;
  /** Pages of each `page_type` to render regardless of suspicion. 0 = none. */
  renderSamplePerType?: number;
}

/** The same three numbers, all resolved. */
export type ResolvedRenderConfig = Required<RenderSelectionConfig>;

export interface RenderSelection {
  /**
   * The URLs now sitting in the frontier as `render_pending`, suspects first
   * and each half in URL order. Bounded by `budget`, so this array is the one
   * page list this module is allowed to hold.
   */
  selected: string[];
  /** `min(ceil(pages × pct/100), renderMaxPages)` — the seats available. */
  budget: number;
  /** Candidates that tripped a suspicion trigger, BEFORE the budget cut. */
  suspects: number;
  /**
   * Candidates the per-type sample contributed and suspicion did not, before
   * the cut. `suspects + sampled` is the whole candidate set, so a page that is
   * both a suspect and a sample member counts once, on the suspect side.
   */
  sampled: number;
  /** `suspects + sampled > budget`: some candidate was cut. */
  truncated: boolean;
}

/**
 * Apply the defaults and range-check the result.
 *
 * Shared with `validateConfig` in the crawl loop, so a render budget that makes
 * no sense stops the crawl at its first line rather than at the end of it.
 * A percentage of 0 is refused rather than read as "render nothing": a pass
 * that is meant to be off is a pass that is not run.
 */
export function resolveRenderConfig(cfg: RenderSelectionConfig): ResolvedRenderConfig {
  const resolved = { ...RENDER_DEFAULTS, ...stripUndefined(cfg) };

  const { renderBudgetPct, renderMaxPages, renderSamplePerType } = resolved;
  if (!Number.isFinite(renderBudgetPct) || renderBudgetPct <= 0 || renderBudgetPct > 100) {
    throw new RangeError(
      `renderBudgetPct must be a number in (0, 100], got ${renderBudgetPct}`,
    );
  }
  if (!Number.isInteger(renderMaxPages) || renderMaxPages < 1) {
    throw new RangeError(`renderMaxPages must be an integer ≥ 1, got ${renderMaxPages}`);
  }
  if (!Number.isInteger(renderSamplePerType) || renderSamplePerType < 0) {
    throw new RangeError(
      `renderSamplePerType must be an integer ≥ 0, got ${renderSamplePerType}`,
    );
  }
  return resolved;
}

/**
 * `{...defaults, ...cfg}` would let an explicit `undefined` — which is what a
 * partially-filled config object carries — overwrite a default with nothing.
 */
function stripUndefined(cfg: RenderSelectionConfig): RenderSelectionConfig {
  return Object.fromEntries(
    Object.entries(cfg).filter(([, value]) => value !== undefined),
  ) as RenderSelectionConfig;
}

/**
 * Choose the render set for `crawlId` and put it in the frontier.
 *
 * ONE statement decides everything, promotes the chosen rows and demotes the
 * ones an earlier selection had chosen and this one did not (two data-modifying
 * CTEs, `moved` and `cleared`). That is not tidiness: it makes the returned
 * array and the frontier's `render_pending` set the same fact rather than two
 * facts a crash between statements could separate.
 *
 * Re-running is idempotent under an unchanged config: the same pages are
 * chosen (every ordering in the statement is explicit), the rows are already
 * `render_pending` and stay there, and the numbers come back identical.
 */
export async function selectRenderSet(
  db: Db,
  crawlId: string,
  cfg: RenderSelectionConfig,
): Promise<RenderSelection> {
  const { renderBudgetPct, renderMaxPages, renderSamplePerType } = resolveRenderConfig(cfg);

  const crawl = await db.execute(sql`select id from crawls where id = ${crawlId} limit 1`);
  if (crawl.rows.length === 0) {
    throw new Error(`selectRenderSet: no such crawl '${crawlId}'`);
  }

  const res = await db.execute(sql`
      with ${candidateCte(crawlId, {
        renderBudgetPct,
        renderMaxPages,
        renderSamplePerType,
      })},
      picked as (
        select c.url, c.tier from candidates c
        order by c.tier asc, c.url asc
        limit (select n from budget)
      ),
      moved as (
        -- Written here, in the statement that chose them. A page with no
        -- frontier row (a crawl whose rows were pruned, a test) gets one at the
        -- page's own depth; a row that already exists keeps the depth and
        -- provenance its first discovery gave it and only changes state.
        insert into frontier (crawl_id, url, state, depth, discovered_via)
        select ${crawlId}, c.url, 'render_pending', c.depth, 'render'
        from picked p join cohort c on c.url = p.url
        --
        -- THE CONFLICTING ROW IS USUALLY 'done', AND SOMETIMES 'failed'. The
        -- second case is reachable and is deliberately treated the same way.
        -- An expired lease produces a double fetch: worker 1 writes the page
        -- row and marks the URL done, worker 2 then finishes its own attempt of
        -- the same URL, spends the last retry and calls failUrl, which
        -- overwrites the row to 'failed', attempts 3. The frontier then says
        -- failed while a perfectly good ok/200 page row exists — and it is the
        -- page row this selection reads. Promoting that row to render_pending
        -- is the honest answer: the evidence the render pass diffs against is
        -- present, so the page is render-eligible on exactly the terms every
        -- other selected page is. It also cannot resurrect the URL into the
        -- CRAWL pass (rule 9): render_pending is invisible to leaseBatch in
        -- every state, held or expired, so the page is never fetched again.
        on conflict (crawl_id, url) do update
          set state = 'render_pending',
              lease_id = null,
              leased_until = null,
              -- The render pass is a fresh attempt budget: the crawl's spent
              -- attempts say nothing about whether a browser can load the page.
              attempts = 0
        returning 1
      ),
      cleared as (
        -- Anything an EARLIER selection promoted and this one does not name
        -- goes back to 'done'. Without it, re-selecting under a smaller budget
        -- would leave the previous run's rows standing and the pass would
        -- quietly render more pages than the budget it just computed.
        --
        -- Disjoint from the 'moved' CTE by construction — that one touches exactly the
        -- picked URLs, this one exactly the unpicked — which is what makes two
        -- data-modifying CTEs over one table safe here. They cannot see each
        -- other's effects, and they do not need to.
        update frontier f
          set state = 'done', lease_id = null, leased_until = null
        where f.crawl_id = ${crawlId}
          and f.state = 'render_pending'
          and not exists (select 1 from picked p where p.url = f.url)
        returning 1
      )
      select b.n as budget, s.suspects, s.sampled, s.total, p.url
      from budget b
      cross join stats s
      -- LEFT JOIN so a crawl with no candidates still returns its budget and
      -- its zeroes: an empty result set would leave the caller unable to tell
      -- "nothing to render" from "the query did not run" (hard rule 7).
      left join picked p on true
      order by p.tier asc nulls last, p.url asc`);

  const head = res.rows[0];
  if (head === undefined) {
    throw new Error(`selectRenderSet: crawl '${crawlId}' returned no selection row`);
  }
  const budget = int(head["budget"], "budget");
  const suspects = int(head["suspects"], "suspects");
  const sampled = int(head["sampled"], "sampled");
  const total = int(head["total"], "total");
  const selected = res.rows
    .map((row) => row["url"])
    .filter((value): value is string => value !== null && value !== undefined);

  // The two invariants tying the stats to the list. A mismatch means the LIMIT
  // and the counts disagreed — a rewritten CTE that stopped being one query —
  // and it fails here rather than under-rendering in silence (hard rule 7).
  const expected = Math.min(total, budget);
  if (selected.length !== expected) {
    throw new Error(
      `selectRenderSet: ${selected.length} URLs selected, expected ${expected} ` +
        `(budget ${budget}, ${total} candidates)`,
    );
  }
  if (suspects + sampled !== total) {
    throw new Error(
      `selectRenderSet: ${suspects} suspects + ${sampled} sampled ≠ ${total} candidates`,
    );
  }

  return { selected, budget, suspects, sampled, truncated: total > budget };
}

/**
 * The selection stats WITHOUT selecting: `budget`, `suspects`, `sampled` and
 * the candidate total, computed from exactly the CTEs `selectRenderSet` uses
 * and writing nothing.
 *
 * This exists because the numbers have nowhere to be stored. `render.coverage`
 * (P5-T5) has to quote the sampling story after the pass has run, and `crawls`
 * carries no render evidence blob — the phase's migration added page columns
 * only, and `config_jsonb` is the crawl's input, not a results column. So the
 * stats are RECOMPUTED rather than persisted, which is sound for exactly one
 * reason worth stating: every column the decision reads (`word_count`,
 * `html_bytes`, `title`, `framework_markers`, and the `links` rows) is written
 * by the CRAWL pass, and the render pass writes only `rendered_*` columns. The
 * inputs cannot move under a render, so this returns the same numbers before
 * the pass, during it, and a week later.
 *
 * It shares `candidateCte` with `selectRenderSet` rather than restating the
 * predicate: two spellings of "suspect" would eventually disagree, and the
 * coverage metric would then describe a selection that never happened.
 */
export async function renderSelectionStats(
  db: Db,
  crawlId: string,
  cfg: RenderSelectionConfig,
): Promise<Omit<RenderSelection, "selected">> {
  const resolved = resolveRenderConfig(cfg);

  const res = await db.execute(sql`
      with ${candidateCte(crawlId, resolved)}
      select b.n as budget, s.suspects, s.sampled, s.total
      from budget b cross join stats s`);

  const head = res.rows[0];
  if (head === undefined) {
    throw new Error(`renderSelectionStats: crawl '${crawlId}' returned no row`);
  }
  const budget = int(head["budget"], "budget");
  const suspects = int(head["suspects"], "suspects");
  const sampled = int(head["sampled"], "sampled");
  const total = int(head["total"], "total");
  if (suspects + sampled !== total) {
    throw new Error(
      `renderSelectionStats: ${suspects} suspects + ${sampled} sampled ≠ ${total} candidates`,
    );
  }
  return { budget, suspects, sampled, truncated: total > budget };
}

/**
 * The read-only half of the selection: everything up to and including the
 * candidate set and its counts, as CTEs a caller appends its own to.
 *
 * ONE SPELLING, TWO CALLERS — `selectRenderSet`, which follows it with the
 * data-modifying CTEs that promote the chosen rows, and `renderSelectionStats`,
 * which follows it with nothing. The fragment ends without a trailing comma so
 * both can say what comes next.
 */
function candidateCte(crawlId: string, cfg: ResolvedRenderConfig): SQL {
  const { renderBudgetPct, renderMaxPages, renderSamplePerType } = cfg;
  return sql`
      cohort as (
        -- The renderable pages: fetched OK with a 200 body. Deliberately NOT
        -- filtered on is_indexable — the metric layer's cohort (src/rules/metric/
        -- cohort.ts) excludes noindex pages because they compete for nothing,
        -- but a noindex page built entirely by JavaScript is exactly the
        -- evidence this pass exists to collect.
        select p.id, p.url, p.depth,
               -- The metric layer's UNTYPED convention, spelled here rather
               -- than imported: a client-configured page type of '(untyped)'
               -- and a page with none MERGE into one cohort, which is the only
               -- sound answer once the two are indistinguishable.
               coalesce(nullif(p.page_type, ''), '(untyped)') as cohort_type,
               p.word_count, p.html_bytes, p.title, p.framework_markers
        from pages p
        where p.crawl_id = ${crawlId}
          and p.fetch_class = 'ok'
          and p.status_code = 200
      ),
      budget as (
        -- Over EVERY crawled URL, not over the cohort: the bound being enforced
        -- is "no more than pct% of this crawl leaves through a browser".
        select least(
          ceil((select count(*) from pages where crawl_id = ${crawlId})::numeric
               * ${renderBudgetPct} / 100)::int,
          ${renderMaxPages}::int) as n
      ),
      suspects as (
        select c.url from cohort c
        where
          -- A long document with almost nothing in it.
          (c.word_count < ${SUSPICION.thinWordCount}
            and c.html_bytes > ${SUSPICION.thinHtmlBytes})
          -- A page with no title at all, big enough that it should have one.
          or ((c.title is null or c.title = '')
            and c.html_bytes > ${SUSPICION.titlelessHtmlBytes})
          -- A client-side framework's hydration marker in the raw HTML.
          or jsonb_array_length(c.framework_markers) > 0
          -- A page that links nowhere. Hard rule 3: asked of the links table,
          -- never of a link list in memory.
          or not exists (
            select 1 from links l
            where l.crawl_id = ${crawlId} and l.source_page_id = c.id)
      ),
      sample as (
        select r.url from (
          select c.url,
                 row_number() over (
                   partition by c.cohort_type order by c.url asc) as rn
          from cohort c
        ) r
        where r.rn <= ${renderSamplePerType}
      ),
      candidates as (
        -- min(tier) is what makes a page that is BOTH a suspect and a sample
        -- member count once, on the suspect side.
        select url, min(tier) as tier from (
          select url, 0 as tier from suspects
          union all
          select url, 1 as tier from sample
        ) t group by url
      ),
      stats as (
        select count(*) filter (where tier = 0)::int as suspects,
               count(*) filter (where tier = 1)::int as sampled,
               count(*)::int as total
        from candidates
      )`;
}

/**
 * An integer column from the selection row, checked rather than cast — the
 * metric layer's `num()` discipline (src/rules/metric/cohort.ts). The `::int`
 * casts in the query above are what make these JavaScript numbers; drop one and
 * the driver hands back a string, and `budget: "500"` compares wrongly against
 * every number it meets.
 */
function int(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `selectRenderSet: column '${column}' came back as ${typeof value}, not an integer`,
    );
  }
  return value;
}
