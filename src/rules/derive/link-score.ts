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
 * self-loop and an external link. A page-level `<meta name=robots
 * content=nofollow>` does not exclude its edges yet: that is an open item for
 * the gate record, not a silent choice. Out-degree counts kept edges only.
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
 * max = min (or the ratio is not above 1) every page scores 100. Rows outside
 * the graph keep null in both columns.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { FETCHED_OK } from "../helpers.js";

/** Random-surfer damping. Fixed by the spec (§29c); not a tool parameter. */
export const LINK_SCORE_DAMPING = 0.85;
/** Iteration cap. Fixed by the spec (§29c). */
export const LINK_SCORE_MAX_ITERATIONS = 20;
/** Stop once the L1 change of one iteration is below this. Fixed by the spec. */
export const LINK_SCORE_TOLERANCE = 1e-6;

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
 * Recompute both columns for one crawl, IDEMPOTENT BY NULL-THEN-SET inside one
 * transaction (as `deriveLinkCounts` is). The temp tables are `on commit drop`,
 * so a failure leaves nothing behind.
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
      update pages set link_score_raw = null, link_score = null
      where crawl_id = ${crawlId}`);

    await tx.execute(sql`
      create temporary table ls_nodes (
        n int primary key, page_id text not null, outdeg int not null default 0
      ) on commit drop`);
    await tx.execute(sql`
      insert into ls_nodes (n, page_id)
      select (row_number() over (order by p.url))::int, p.id
      from pages p
      where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")}`);

    const nodes = (
      await tx.execute<{ n: number }>(sql`select count(*)::int as n from ls_nodes`)
    ).rows[0]?.n;
    if (nodes === undefined) throw new Error(`deriveLinkScore: crawl '${crawlId}' counted no nodes`);
    if (nodes === 0) return { nodes: 0, edges: 0, dangling: 0, iterations: 0, converged: 1 };

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
        and s.n <> d.n`);
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

    await tx.execute(sql`
      create temporary table ls_rank (n int primary key, v double precision not null)
      on commit drop`);
    await tx.execute(sql`
      create temporary table ls_next (n int primary key, v double precision not null)
      on commit drop`);
    await tx.execute(sql`insert into ls_rank (n, v) select n, 1.0::float8 / ${nodes}::float8 from ls_nodes`);

    const d = LINK_SCORE_DAMPING;
    let iterations = 0;
    let converged = 0;
    while (iterations < LINK_SCORE_MAX_ITERATIONS) {
      iterations += 1;
      await tx.execute(sql`truncate ls_next`);
      await tx.execute(sql`
        insert into ls_next (n, v)
        with dang as (
          select coalesce(sum(r.v), 0)::float8 as w
          from ls_rank r join ls_nodes nd on nd.n = r.n
          where nd.outdeg = 0
        ), inc as (
          select e.dst as n, sum(r.v / nd.outdeg)::float8 as s
          from ls_edges e
          join ls_rank r on r.n = e.src
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
          from ls_next x join ls_rank r on r.n = x.n`)
      ).rows[0]?.delta;
      if (delta === undefined || delta === null || !Number.isFinite(Number(delta))) {
        throw new Error(`deriveLinkScore: crawl '${crawlId}' produced a non-finite change at iteration ${iterations}`);
      }
      await tx.execute(sql`
        update ls_rank r set v = x.v from ls_next x where r.n = x.n`);
      if (Number(delta) < LINK_SCORE_TOLERANCE) {
        converged = 1;
        break;
      }
    }

    await tx.execute(sql`
      with b as (
        select min(v) as lo, max(v) as hi from ls_rank
      ), s as (
        select r.n, r.v, b.lo, b.hi, ln(b.hi / b.lo) as span from ls_rank r cross join b
      )
      update pages p
      set link_score_raw = s.v,
          link_score = case
            when s.span > 0 then round(100 * ln(s.v / s.lo) / s.span)::int
            else 100
          end
      from s
      join ls_nodes nd on nd.n = s.n
      where p.crawl_id = ${crawlId} and p.id = nd.page_id`);

    return {
      nodes,
      edges: counts.edges,
      dangling: counts.dangling,
      iterations,
      converged,
    };
  });
}
