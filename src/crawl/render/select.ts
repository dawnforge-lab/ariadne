/**
 * Which pages the render pass is allowed to render.
 *
 * Rendering is the expensive half of this engine — a browser context, a real
 * navigation, a settle wait — so the second pass never runs over the whole
 * crawl. It runs over a *selection*, and this file is the whole of that
 * decision, taken in SQL against the evidence the crawl already wrote.
 *
 * TWO WAYS A SELECTION IS MADE, and they are alternatives rather than layers:
 * `selectRenderSet` (the automatic one, described below, and the default) and
 * `selectExplicitRenderSet`, where a caller who already knows the site's
 * templates NAMES the pages. Both end in the same place — frontier rows at
 * `render_pending`, everything they do not name demoted — so the pass that
 * follows cannot tell them apart. What the two differ in is what they can say
 * about themselves, which is why `RenderSelection.mode` exists and why the
 * automatic numbers are null rather than zero in the explicit case.
 *
 * The automatic selection has two halves and one hard bound:
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
 * WHICH CANDIDATES GET THE SEATS WHEN THERE ARE NOT ENOUGH OF THEM. Suspects
 * first — those are the pages there is already a reason to doubt — and then, by
 * the size of the page type each candidate belongs to, largest first:
 * `order by tier asc, type_size desc, url asc`. **A template's size is how much
 * of the site its render answers for.** Three renders of a 211-page product
 * template say something about 211 pages; three renders of a collection page
 * that exists once say something about one.
 *
 * That is written down because the first real-site crawl proved the alternative
 * wrong. 551 pages produced 196 page types — the big families collapsed
 * correctly (`/products/:slug` 211, `/collections/:slug` 115) but ~170 URLs
 * stayed singleton types — and the sampler offered 176 candidates for 28 seats
 * with no suspect among them. The cut was taken in URL order, so all 28 seats
 * went to `/apps/*` and `/collections/a-b*` and **not one of the 211 product
 * pages was rendered**: the four JavaScript rules came back empty for the
 * template that mattered most, which reads as "clean" and means "unasked".
 * Alphabetical order is not a priority. Template size is. `url asc` remains the
 * final tiebreak, so the selection is as deterministic as it ever was.
 *
 * P8-T5 fixed the other half of that crawl's problem — `inferPageTemplates`
 * (src/crawl/page-type.ts) collapses those ~170 singletons into
 * `/collections/:slug` before this module ever reads the column, so a type here
 * is a template — but it did NOT retire the ordering above, and the ordering is
 * not to be read as a workaround that has served its purpose. A flat site, a
 * site with dozens of genuinely small sections, and any crawl whose tail is
 * long still put many size-1 types in front of a big one; size-ordering is what
 * keeps the biggest template seated first in all of those, and it is the only
 * thing that does.
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
 * ENFORCES that caveat before it calls this function, in all three of its
 * shapes: a crawl worker's leases, another render pass's leases (which leave
 * the state at `render_pending` and are therefore invisible to a `leased`
 * check), and a crawl whose row still says `running` (live, or dead mid-run
 * and never resumed or marked failed). A finished-but-capped crawl with
 * `pending` rows is deliberately renderable — see run-render.ts's header.
 *
 * `renderSelectionStats` is the same decision asked read-only: the coverage
 * metric has to quote the sampling story long after the selection object is
 * gone, and these numbers have no column to live in. Both share `candidateCte`
 * so there is one spelling of "suspect" in the codebase.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { NEVER_REQUESTED } from "../../rules/helpers.js";

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
  /**
   * A page with fewer RENDERABLE words than this, in a document of
   * `thinHtmlBytes`.
   *
   * Renderable since Phase 7, for the reason every other length test moved:
   * this trigger is looking for "a big document with almost nothing in it",
   * and a shell whose 50KB is mostly a hidden mega-menu has almost nothing in
   * it however many words the raw count reports. A pre-P7 crawl stores null
   * here, `null < 50` is NULL, and the row is simply not a suspect — which is
   * byte-identical to how such a page was selected before the column existed,
   * because the render pass runs on the crawl that just wrote the rows.
   */
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

/**
 * The three numbers the automatic decision reports about itself, plus the flag
 * saying whether it had room for all of them. Returned on its own by
 * `renderSelectionStats`, which asks the decision read-only.
 */
export interface RenderSelectionStats {
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

export interface RenderSelection {
  /**
   * WHICH DECISION PRODUCED THIS SET, and therefore how the four numbers below
   * are to be read.
   *
   *  - `auto` — `selectRenderSet` chose it: suspicion plus a per-type sample,
   *    cut to a budget. All four numbers are present and describe that.
   *  - `explicit` — a caller NAMED the pages (`selectExplicitRenderSet`). There
   *    was no budget, nothing was suspected, nothing was sampled and nothing
   *    was cut, so all four are **null** rather than zero. Zeroes would read as
   *    "the automatic selection ran and found nothing", which is a different
   *    fact and the one a reader would draw the wrong conclusion from
   *    (hard rule 7).
   *
   * The invariant, stated because the type cannot: `mode === "auto"` exactly
   * when the four are non-null. One function produces each mode, so it holds by
   * construction rather than by a check.
   */
  mode: "auto" | "explicit";
  /**
   * The URLs now sitting in the frontier as `render_pending`.
   *
   * In `auto` mode, in the order the seats were handed out: suspects first,
   * then largest page type first, then URL; bounded by `budget`. In `explicit`
   * mode, the caller's list in the caller's order. Either way this array is the
   * one page list this module is allowed to hold, and both bounds — the budget
   * and `renderMaxPages` — are enforced before it exists.
   */
  selected: string[];
  /** See `mode`: null in `explicit` mode. */
  budget: number | null;
  /** See `mode`: null in `explicit` mode. */
  suspects: number | null;
  /** See `mode`: null in `explicit` mode. */
  sampled: number | null;
  /** See `mode`: null in `explicit` mode. */
  truncated: boolean | null;
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
  db: Pick<Db, "execute">,
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
        -- THE CUT. Suspects before samples, then the biggest templates before
        -- the smallest, then URL as the tiebreak that keeps this deterministic.
        -- See the module header for why type_size desc is the middle key: a
        -- seat spent on a 211-page template answers for 211 pages, and a cut
        -- taken in URL order spends every seat on the front of the alphabet.
        -- "nulls last" is not defensive — Postgres orders DESC NULLS FIRST —
        -- but type_size is non-null for every candidate by construction (each
        -- one joins its own cohort row).
        select c.url, c.tier, c.type_size from candidates c
        order by c.tier asc, c.type_size desc nulls last, c.url asc
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
      -- The same three keys the cut used, so the selected list comes back in
      -- the order the seats were given out rather than in an order of its own.
      order by p.tier asc nulls last, p.type_size desc nulls last, p.url asc`);

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

  return { mode: "auto", selected, budget, suspects, sampled, truncated: total > budget };
}

/**
 * A render pass whose caller NAMED the pages.
 *
 * ## Why this exists at all
 *
 * The automatic selection is a good answer to "we have never seen this site".
 * It is a poor answer to "the audit knows this site has four templates and
 * needs the home page and three products". Suspicion cannot see a template; the
 * per-type sample can, but only through `page_type` — and until P8-T5 that
 * splintered into singletons on a real site (551 URLs, 196 types on the Phase 6
 * gate crawl), so the sample spent much of its budget on pages that exist once.
 * `inferPageTemplates` closes that half of it BEFORE this module runs: the
 * crawl collapses its own types on the way out, so a sampled type is a
 * template. What it cannot supply is intent — which templates this audit is
 * about, and which page stands for each. An auditing agent that has read the
 * cohort sizes and the URL patterns knows that, and this is how it says so.
 *
 * The alternative it exists to avoid is rendering everything, which was
 * considered and rejected: a browser per page is the most expensive thing this
 * engine can do, and doing it to every URL of a site to learn what a dozen
 * pages would have told you is waste, not rigour.
 *
 * ## AN EXPLICIT LIST REPLACES THE AUTOMATIC SELECTION FOR THIS PASS
 *
 * This is the same statement `selectRenderSet` runs, with `picked` supplied
 * rather than computed — INCLUDING the `cleared` CTE. So a crawl that was
 * selected automatically and is now given a list has the leftover
 * `render_pending` rows of that earlier selection demoted back to `done`,
 * exactly as a re-selection under a smaller budget does. It is a replacement,
 * not an addition: after this statement the frontier's render set is the list
 * and nothing else, which is what makes `rendered + failures == selected.length`
 * hold for the pass that follows.
 *
 * Pages ALREADY RENDERED by an earlier pass keep their `rendered_*` columns —
 * demotion moves a frontier row, it does not erase evidence — which is the
 * same asymmetry `render.coverage`'s module header describes and refuses to
 * assert away.
 *
 * ## What this function does NOT do
 *
 * It does not validate the URLs. The url-policy check, the allowlist posture,
 * normalisation, deduplication and the `renderMaxPages` cap all belong to the
 * transport that accepted the request, because each of them is a refusal with a
 * status code and a sentence for the caller (src/api/service.ts). What it does
 * do is REFUSE TO GUESS: every URL handed to it must resolve to a page of this
 * crawl that fetched OK with a 200, and if the count that comes back differs
 * from the count that went in, it throws rather than rendering a shorter list
 * than it was given.
 */
export async function selectExplicitRenderSet(
  db: Pick<Db, "execute">,
  crawlId: string,
  urls: readonly string[],
): Promise<RenderSelection> {
  if (urls.length === 0) {
    throw new Error(`selectExplicitRenderSet: crawl '${crawlId}' was given an empty URL list`);
  }

  const crawl = await db.execute(sql`select id from crawls where id = ${crawlId} limit 1`);
  if (crawl.rows.length === 0) {
    throw new Error(`selectExplicitRenderSet: no such crawl '${crawlId}'`);
  }

  // RESOLVE BEFORE WRITING. The check could be made after the promotion — the
  // returned row count would answer it — and that would leave a REFUSED list
  // half-promoted whenever this function is called outside a transaction: the
  // URLs that did resolve would sit in the frontier as `render_pending`,
  // waiting for a pass that was never authorised. A read first costs one
  // statement and makes the refusal total.
  const resolved = await db.execute(sql`
      select p.url from pages p
      where p.crawl_id = ${crawlId}
        and p.fetch_class = 'ok'
        and p.status_code = 200
        and p.url = any(${sql.param(urls as string[])}::text[])`);
  if (resolved.rows.length !== urls.length) {
    throw new Error(
      `selectExplicitRenderSet: crawl '${crawlId}' resolved ${resolved.rows.length} of ` +
        `${urls.length} named URL(s) to renderable pages — every URL must already be ` +
        `a page of this crawl that fetched OK with a 200, named once`,
    );
  }

  const res = await db.execute(sql`
      with named as (
        -- WITH ORDINALITY so the answer comes back in the order the caller
        -- wrote it. The frontier does not care, but the caller's echo of its
        -- own list does: a reordered list reads like a different list.
        select u.url, u.ord
        from unnest(${sql.param(urls as string[])}::text[]) with ordinality as u(url, ord)
      ),
      picked as (
        -- The same eligibility selectRenderSet's cohort applies — fetched OK
        -- with a 200 body — asked of the named URLs instead of of every page.
        -- A URL that misses here is simply absent from the result, and the
        -- length check below is what turns that into an error rather than a
        -- quietly shorter pass.
        select p.url, p.depth, n.ord
        from pages p
        join named n on n.url = p.url
        where p.crawl_id = ${crawlId}
          and p.fetch_class = 'ok'
          and p.status_code = 200
      ),
      moved as (
        -- Identical to the automatic selection's promotion, down to the
        -- conflict clause: see selectRenderSet for why a 'failed' frontier row
        -- beside a good page row is promoted rather than skipped, and why
        -- attempts is reset.
        insert into frontier (crawl_id, url, state, depth, discovered_via)
        select ${crawlId}, p.url, 'render_pending', p.depth, 'render'
        from picked p
        on conflict (crawl_id, url) do update
          set state = 'render_pending',
              lease_id = null,
              leased_until = null,
              attempts = 0
        returning 1
      ),
      cleared as (
        -- THE REPLACEMENT SEMANTICS, in four lines. Anything an earlier
        -- selection — automatic or explicit — left at 'render_pending' and this
        -- list does not name goes back to 'done'. Without it a named list would
        -- ADD to whatever the last automatic pass chose, and the pass would
        -- render pages nobody asked for while reporting the list's length.
        update frontier f
          set state = 'done', lease_id = null, leased_until = null
        where f.crawl_id = ${crawlId}
          and f.state = 'render_pending'
          and not exists (select 1 from picked p where p.url = f.url)
        returning 1
      )
      select p.url from picked p order by p.ord asc`);

  const selected = res.rows
    .map((row) => row["url"])
    .filter((value): value is string => typeof value === "string");

  // The same count again, over the statement that actually wrote. The read
  // above is what makes a refusal total; this is what makes the promotion
  // honest — a page deleted between the two statements, or two page rows
  // sharing a URL, must not come back as a shorter pass reported as a whole one
  // (the invariant discipline `selectRenderSet` applies to its own cut).
  if (selected.length !== urls.length) {
    throw new Error(
      `selectExplicitRenderSet: crawl '${crawlId}' promoted ${selected.length} of ` +
        `${urls.length} named URL(s) — the pages moved under the selection`,
    );
  }

  return { mode: "explicit", selected, budget: null, suspects: null, sampled: null, truncated: null };
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
 * reason worth stating: every column the decision reads
 * (`renderable_word_count`, `html_bytes`, `title`, `framework_markers`, and the
 * `links` rows) is written by the CRAWL pass, and the render pass writes only
 * `rendered_*` columns. The inputs cannot move under a render, so this returns
 * the same numbers before the pass, during it, and a week later.
 *
 * It shares `candidateCte` with `selectRenderSet` rather than restating the
 * predicate: two spellings of "suspect" would eventually disagree, and the
 * coverage metric would then describe a selection that never happened.
 */
export async function renderSelectionStats(
  db: Pick<Db, "execute">,
  crawlId: string,
  cfg: RenderSelectionConfig,
): Promise<RenderSelectionStats> {
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
               p.renderable_word_count, p.html_bytes, p.title, p.framework_markers
        from pages p
        where p.crawl_id = ${crawlId}
          and p.fetch_class = 'ok'
          and p.status_code = 200
      ),
      budget as (
        -- Over EVERY crawled URL, not over the cohort: the bound being enforced
        -- is "no more than pct% of this crawl leaves through a browser".
        select least(
          -- Robots-blocked rows (Phase 23 T3) and scope-excluded rows (27c)
          -- were never requested, so they are not "crawled URLs": a site that
          -- disallows a faceted space, or a crawl that fences one off, must not
          -- buy itself a bigger browser budget with rows nobody fetched.
          ceil((select count(*) from pages bp
                where bp.crawl_id = ${crawlId} and not ${NEVER_REQUESTED("bp")})::numeric
               * ${renderBudgetPct} / 100)::int,
          ${renderMaxPages}::int) as n
      ),
      type_sizes as (
        -- How many renderable pages each page type has. This is the middle key
        -- of the budget cut (see the picked CTE and the module header): a
        -- candidate inherits the size of the template it stands for, and the
        -- biggest templates are seated first. Computed here, in the SHARED
        -- fragment, so renderSelectionStats cannot drift from the decision it
        -- reports.
        select c.cohort_type, count(*)::int as n
        from cohort c group by c.cohort_type
      ),
      suspects as (
        select c.url from cohort c
        where
          -- A long document with almost nothing a reader can reach in it.
          (c.renderable_word_count < ${SUSPICION.thinWordCount}
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
        -- member count once, on the suspect side. type_size rides along from
        -- the candidate's own cohort row — one page type per URL, so the join
        -- multiplies nothing and the group-by key is redundant but honest.
        select t.url, min(t.tier) as tier, ts.n as type_size
        from (
          select url, 0 as tier from suspects
          union all
          select url, 1 as tier from sample
        ) t
        join cohort c on c.url = t.url
        join type_sizes ts on ts.cohort_type = c.cohort_type
        group by t.url, ts.n
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
