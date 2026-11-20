/**
 * The internal link score derivation (Phase 29c): `pages.link_score_raw` and
 * `pages.link_score`, the share of internal link weight a page holds
 * (random-surfer model, damping 0.85).
 *
 * The algorithm is power-iteration PageRank (the name belongs in this comment
 * only), computed entirely in SQL over session-private temp tables so that no
 * link ever reaches Node and RAM stays O(1) in the number of links (hard rules
 * 3 and 6). Like the derivations beside it this is not a rule: it accuses
 * nobody and writes no findings.
 *
 * THE GRAPH (R3). Nodes are the crawl's FETCHED_OK pages. An edge is a distinct
 * `(source, target)` pair over internal, link-level followed `links` whose
 * target URL is another node. So an edge to a 404, to a redirecting URL, or to
 * a URL that was never crawled is dropped (the target is not a node), as is a
 * self-loop and an external link. A page whose robots meta or
 * `X-Robots-Tag` says `nofollow` (or `none`, "noindex, nofollow"; whole-token,
 * `SAYS_NOFOLLOW`) passes no link score: all its outgoing edges are dropped
 * (owner ruling, 29c). It stays a node and can still receive weight; with no
 * kept edge out it is dangling like any such page. Link counts are unchanged
 * (R2: outlinks include nofollow). Out-degree counts kept edges only.
 *
 * THE ITERATION. Start vector 1/N. Each iteration:
 *   v' = (1-d)/N + d*dangling/N + d * sum over edges (s -> p) of v_s / outdeg_s
 * where `dangling` is the total rank of the nodes with no kept edge out, shared
 * over all N nodes. Stop after the first iteration whose L1 change
 * sum|v' - v| is below the tolerance, or after the maximum. Each iteration is a
 * fixed number of set-based statements; only the scalar change is read back.
 *
 * THE SCORE (R5). `link_score` is an integer 0-100, `round(100 * ln(raw/min) /
 * ln(max/min))` over the graph's pages, so 100 is the crawl's top page. When
 * max = min within `LINK_SCORE_EQUAL_TOLERANCE` (relative: `max - min <=
 * 1e-9 * max`) every page scores 100. Rows outside
 * the graph keep null in both columns.
 *
 * THE WRITES (final review M1, M2). The rank vector alternates between two temp
 * tables, each iteration truncating and refilling the one it writes, so no
 * iteration leaves dead tuples behind in a table the next one scans (temp
 * tables are never vacuumed). `pages` is written ONCE: one statement sets the
 * final value of every row of the crawl, null included for the rows outside
 * the graph, guarded by `is distinct from` so a row already right is not
 * rewritten (`pages` carries many indexes, and every rewritten row touches each
 * of them).
 */
import { eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { FETCHED_OK, SAYS_NOFOLLOW } from "../helpers.js";

/** Random-surfer damping. Fixed by the spec (§29c); not a tool parameter. */
export const LINK_SCORE_DAMPING = 0.85;
/** Iteration cap. Fixed by the spec (§29c). */
export const LINK_SCORE_MAX_ITERATIONS = 20;
/** Stop once the L1 change of one iteration is below this. Fixed by the spec. */
export const LINK_SCORE_TOLERANCE = 1e-6;
/**
 * Relative tolerance for "max = min": when `(max - min) <= this * max` every
 * page scores 100, so float noise of a few ulps on a truly-equal graph does not
 * spread the scores over 0-100. Owner ruling (29c); not a tool parameter.
 */
export const LINK_SCORE_EQUAL_TOLERANCE = 1e-9;

/**
 * The 0-100 score of raw value `v` given the graph's `lo` (min) and `hi` (max),
 * as a SQL expression: 100 for everyone when `hi - lo <= tolerance * hi`, else
 * `round(100 * ln(v/lo) / ln(hi/lo))`. Exported so a test can pin the scaling
 * with crafted values.
 */
export const LINK_SCORE_SCALE = (v: SQL, lo: SQL, hi: SQL): SQL => sql`(
  case
    when (${hi} - ${lo}) <= ${LINK_SCORE_EQUAL_TOLERANCE}::float8 * ${hi} then 100
    else round(100 * ln(${v} / ${lo}) / ln(${hi} / ${lo}))::int
  end)`;

export interface LinkScoreDerivation extends Record<string, number> {
  /** Graph pages (FETCHED_OK). */
  nodes: number;
  /** Distinct kept edges. */
  edges: number;
  /** Nodes with no kept edge out. */
  dangling: number;
  /** Iterations run. */
  iterations: number;
  /** 1 when the tolerance was reached within the cap (or there was nothing to do), else 0. */
  converged: number;
}

/**
 * Recompute both columns for one crawl inside one transaction: every row of the
 * crawl is given its final value (null outside the graph), so a stale score
 * cannot survive a re-run and a reader never sees a half-written crawl. The
 * temp tables are `on commit drop`, so a failure leaves nothing behind.
 */
export async function deriveLinkScore(db: Db, crawlId: string): Promise<LinkScoreDerivation> {
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveLinkScore: no such crawl '${crawlId}'`);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      create temporary table ls_nodes (
        n int primary key, page_id text not null, outdeg int not null default 0,
        nofollow boolean not null default false
      ) on commit drop`);
    await tx.execute(sql`
      insert into ls_nodes (n, page_id, nofollow)
      select (row_number() over (order by p.url))::int, p.id,
             ${sql.raw(SAYS_NOFOLLOW("p.robots_meta"))} or ${sql.raw(SAYS_NOFOLLOW("p.x_robots_tag"))}
      from pages p
      where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")}`);

    const nodes = (
      await tx.execute<{ n: number }>(sql`select count(*)::int as n from ls_nodes`)
    ).rows[0]?.n;
    if (nodes === undefined) throw new Error(`deriveLinkScore: crawl '${crawlId}' counted no nodes`);
    if (nodes === 0) {
      // No graph: every row of the crawl is outside it, so both columns are null.
      await tx.execute(sql`
        update pages set link_score_raw = null, link_score = null
        where crawl_id = ${crawlId}
          and (link_score_raw is not null or link_score is not null)`);
      return { nodes: 0, edges: 0, dangling: 0, iterations: 0, converged: 1 };
    }

    await tx.execute(sql`
      create temporary table ls_edges (src int not null, dst int not null) on commit drop`);
    await tx.execute(sql`
      insert into ls_edges (src, dst)
      select distinct s.n, d.n
      from links l
      join ls_nodes s on s.page_id = l.source_page_id
      join pages t on t.crawl_id = ${crawlId} and t.url = l.target_url
      join ls_nodes d on d.page_id = t.id
      where l.crawl_id = ${crawlId}
        and l.is_internal and not l.is_nofollow
        and s.n <> d.n
        and not s.nofollow`);
    await tx.execute(sql`
      update ls_nodes nd set outdeg = o.c
      from (select src, count(*)::int as c from ls_edges group by src) o
      where nd.n = o.src`);
    await tx.execute(sql`create index ls_edges_src on ls_edges (src)`);
    await tx.execute(sql`analyze ls_nodes`);
    await tx.execute(sql`analyze ls_edges`);

    const counts = (
      await tx.execute<{ edges: number; dangling: number }>(sql`
        select (select count(*) from ls_edges)::int as edges,
               (select count(*) from ls_nodes where outdeg = 0)::int as dangling`)
    ).rows[0];
    if (counts === undefined) throw new Error(`deriveLinkScore: crawl '${crawlId}' counted no edges`);

    // Two rank tables whose roles swap every iteration: `cur` holds the vector
    // read, `nxt` is truncated and refilled with the next one. The names are the
    // two literals below, never input.
    await tx.execute(sql`
      create temporary table ls_rank_a (n int primary key, v double precision not null)
      on commit drop`);
    await tx.execute(sql`
      create temporary table ls_rank_b (n int primary key, v double precision not null)
      on commit drop`);
    let cur = sql.raw("ls_rank_a");
    let nxt = sql.raw("ls_rank_b");
    await tx.execute(sql`insert into ${cur} (n, v) select n, 1.0::float8 / ${nodes}::float8 from ls_nodes`);

    const d = LINK_SCORE_DAMPING;
    let iterations = 0;
    let converged = 0;
    while (iterations < LINK_SCORE_MAX_ITERATIONS) {
      iterations += 1;
      await tx.execute(sql`truncate ${nxt}`);
      await tx.execute(sql`
        insert into ${nxt} (n, v)
        with dang as (
          select coalesce(sum(r.v), 0)::float8 as w
          from ${cur} r join ls_nodes nd on nd.n = r.n
          where nd.outdeg = 0
        ), inc as (
          select e.dst as n, sum(r.v / nd.outdeg)::float8 as s
          from ls_edges e
          join ${cur} r on r.n = e.src
          join ls_nodes nd on nd.n = e.src
          group by e.dst
        )
        select nd.n,
               (1.0::float8 - ${d}::float8) / ${nodes}::float8
                 + ${d}::float8 * dang.w / ${nodes}::float8
                 + ${d}::float8 * coalesce(inc.s, 0)
        from ls_nodes nd
        cross join dang
        left join inc on inc.n = nd.n`);
      const delta = (
        await tx.execute<{ delta: number }>(sql`
          select sum(abs(x.v - r.v))::float8 as delta
          from ${nxt} x join ${cur} r on r.n = x.n`)
      ).rows[0]?.delta;
      if (delta === undefined || delta === null || !Number.isFinite(Number(delta))) {
        throw new Error(`deriveLinkScore: crawl '${crawlId}' produced a non-finite change at iteration ${iterations}`);
      }
      // The vector just written is the one the next iteration (or the score) reads.
      [cur, nxt] = [nxt, cur];
      if (Number(delta) < LINK_SCORE_TOLERANCE) {
        converged = 1;
        break;
      }
    }

    // Every row of the crawl: the graph's pages get their score, the rest null.
    await tx.execute(sql`
      with b as (
        select min(v) as lo, max(v) as hi from ${cur}
      ), s as (
        select r.n, r.v, b.lo, b.hi from ${cur} r cross join b
      ), fin as (
        select p.id,
               s.v as raw,
               case
                 when s.n is null then null
                 else ${LINK_SCORE_SCALE(sql`s.v`, sql`s.lo`, sql`s.hi`)}
               end as score
        from pages p
        left join ls_nodes nd on nd.page_id = p.id
        left join s on s.n = nd.n
        where p.crawl_id = ${crawlId}
      )
      update pages p
      set link_score_raw = fin.raw, link_score = fin.score
      from fin
      where p.crawl_id = ${crawlId} and p.id = fin.id
        and (p.link_score_raw, p.link_score) is distinct from (fin.raw, fin.score)`);

    return {
      nodes,
      edges: counts.edges,
      dangling: counts.dangling,
      iterations,
      converged,
    };
  });
}
