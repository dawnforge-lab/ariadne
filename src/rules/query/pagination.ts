import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { pages } from "../../db/schema.js";
import {
  hasNoindex,
  isAuditable,
  queryFinding,
  type RuleIdentity,
} from "../helpers.js";
import { resolveEffectiveCanonical } from "../page/canonical.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type PageRecord,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { PAGINATION_WALK_MAX } from "../thresholds.js";
import { fencedOffSql } from "../../crawl/url-scope.js";
import { cappedListing, capsOr, limitTo, noteTruncation, storedScope } from "./crawl-evidence.js";

export { PAGINATION_WALK_MAX };

const CATEGORY = "url";

/**
 * Pages read per round trip by the pagination scan — the memory contract: a
 * batch, never the whole table. Exported so a test can force the cursor to
 * iterate without hardcoding the number.
 */
export const PAGINATION_BATCH = 500;

const NEXT_UNCRAWLED: RuleIdentity = {
  id: "pagination.next-target-uncrawled",
  severity: "info",
};
const NEXT_NOT_LINKED: RuleIdentity = { id: "pagination.next-not-linked", severity: "warning" };
const CANONICAL_TO_OTHER: RuleIdentity = {
  id: "pagination.canonical-to-other",
  severity: "info",
};

/**
 * Most URLs a loop finding quotes. The finding's `cycleLength` carries the true
 * length, so a longer cycle is quoted in part and never silently.
 */
const LOOP_QUOTE_MAX = 20;

const NON_INDEXABLE_TARGET: RuleIdentity = {
  id: "pagination.non-indexable-target",
  severity: "warning",
};
const LOOP: RuleIdentity = { id: "pagination.loop", severity: "warning" };
const SEQUENCE_ERROR: RuleIdentity = { id: "pagination.sequence-error", severity: "info" };

/** The columns of a `rel=next` / `rel=prev` target's `pages` row the rules read. */
interface PageTarget {
  url: string;
  /** Whether any OTHER page links to it. */
  linked: boolean;
  fetchClass: string;
  statusCode: number | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  /** The target's own `rel_prev`, exactly as authored. */
  relPrev: string | null;
}

/** A page carrying `rel=next` and/or `rel=prev`, with its targets resolved. */
interface PaginatedPage {
  page: PageRecord;
  /** `rel_next` as declared, or null when the page declares none. */
  relNext: string | null;
  /** `rel_next` resolved against the page URL, or null when it will not resolve. */
  resolvedNext: string | null;
  /** The `pages` row for `resolvedNext`, or null when the crawl never fetched it. */
  nextTarget: PageTarget | null;
  /** `rel_prev` resolved against the page URL, or null when absent or it will not resolve. */
  resolvedPrev: string | null;
  /** The `pages` row for `resolvedPrev`, or null when the crawl never fetched it. */
  prevTarget: PageTarget | null;
  /**
   * `resolvedNext` is a URL the crawl's CURRENT scope refuses (27c), decided in
   * SQL by the same patterns the frontier used. Not crawling it was our
   * decision, so `next-target-uncrawled` leaves it out.
   */
  nextFenced: boolean;
}

/**
 * Every 200 OK page declaring a `rel=next` or a `rel=prev`, batched, with the
 * `rel=next` target resolved and looked up.
 *
 * Batched rather than joined in SQL because the resolution is JavaScript:
 * `rel_next` is stored exactly as authored (`?page=2` is the common form) and
 * `normalizeUrl` — the same function that produced `pages.url` — is what turns
 * it into something comparable. Each batch resolves its targets, looks them up
 * in one `IN` query, and is then dropped, so RAM is O(batch) on a crawl of any
 * size.
 *
 * `isAuditable` gates the scan for the reason every canonical rule is gated:
 * these columns come from the analyzer, which only runs on an HTML 200, so a
 * page that 404s or redirects has no pagination signals to judge — and a row
 * that somehow carried them would be judged on markup nobody was served.
 *
 * IT IS DELIBERATELY NOT `isJudged` (Phase 22 §1), where the on-page rules
 * went. `pagination.canonical-to-other` is ABOUT a page whose canonical names
 * another URL — the judged cohort would silence it entirely — and a paginated
 * series is a crawl-path fact that a noindex on page four does not repeal.
 */
async function eachPaginatedPage(
  db: Db,
  crawlId: string,
  visit: (p: PaginatedPage) => void,
): Promise<void> {
  const scope = await storedScope(db, crawlId);
  let cursor = "";
  for (;;) {
    const batch = await db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          gt(pages.id, cursor),
          or(isNotNull(pages.relNext), isNotNull(pages.relPrev)),
        ),
      )
      .orderBy(asc(pages.id))
      .limit(PAGINATION_BATCH);
    if (batch.length === 0) return;
    cursor = batch[batch.length - 1]!.id;

    const auditable = batch.filter((page) => isAuditable(page));
    const resolved = new Map<string, string | null>();
    const resolvedPrevs = new Map<string, string | null>();
    for (const page of auditable) {
      if (page.relNext !== null) resolved.set(page.id, normalizeUrl(page.relNext, page.url));
      if (page.relPrev !== null) resolvedPrevs.set(page.id, normalizeUrl(page.relPrev, page.url));
    }

    const wanted = [
      ...new Set(
        [...resolved.values(), ...resolvedPrevs.values()].filter((u): u is string => u !== null),
      ),
    ];
    const targets = new Map<string, PageTarget>();
    const fencedOff = new Set<string>();
    if (wanted.length > 0) {
      // One array parameter rather than one placeholder per URL, so the
      // statement's shape stays constant across batches (the link-targets
      // pattern). The inbound-link test is an `exists` inside the query: the
      // links table is never loaded (hard rule 3).
      //
      // `l.source_page_id <> p.id` excludes the target's links to ITSELF. A
      // paginated page normally renders the whole pagination control, current
      // page included, so page 2 almost always carries an anchor to page 2 —
      // and without this exclusion that self-link would answer "is anything
      // linking to page 2?" with a yes the reader can never follow, making the
      // rule silent on precisely the sites it is for.
      const rows = await db.execute<{
        url: string;
        linked: boolean;
        fetch_class: string;
        status_code: number | null;
        robots_meta: string | null;
        x_robots_tag: string | null;
        rel_prev: string | null;
      }>(sql`
        select p.url, p.fetch_class, p.status_code, p.robots_meta, p.x_robots_tag, p.rel_prev,
               exists (
                 select 1 from links l
                 where l.crawl_id = ${crawlId}
                   and l.target_url = p.url
                   and l.source_page_id <> p.id
               ) as linked
        from pages p
        where p.crawl_id = ${crawlId}
          and p.url = any(${sql.param(wanted)}::text[])
          -- A disallowed row is a URL the crawl recorded and NEVER REQUESTED:
          -- robots.txt refused it (Phase 23 T3, ROBOTS_BLOCKED) or our own
          -- url-policy did, before any connection was made. Either way, to "was
          -- the next page crawled" it answers no, exactly as the absence of a
          -- row did before such rows existed, so it is not a target any rule
          -- here judges as fetched (non-indexable-target, next-not-linked).
          -- An 'excluded' row (the crawl's scope, 27c) is the same: never asked.
          and p.fetch_class not in ('disallowed', 'excluded')`);
      const fenced = await db.execute<{ url: string }>(sql`
        select u.url
        from unnest(${sql.param(wanted)}::text[]) as u(url)
        -- u.url is never NULL: the array holds only non-null resolved URLs.
        where ${fencedOffSql(sql`u.url`, scope, scope.siteUrl)}`);
      for (const row of fenced.rows) fencedOff.add(String(row.url));
      for (const row of rows.rows) {
        targets.set(String(row.url), {
          url: String(row.url),
          linked: row.linked,
          fetchClass: row.fetch_class,
          statusCode: row.status_code,
          robotsMeta: row.robots_meta,
          xRobotsTag: row.x_robots_tag,
          relPrev: row.rel_prev,
        });
      }
    }

    for (const page of auditable) {
      // `?? null` is a Map miss (the page declares no such rel, or it will not
      // resolve) read as the absence it is, not a default for a missing value.
      const next = resolved.get(page.id) ?? null;
      const prev = resolvedPrevs.get(page.id) ?? null;
      visit({
        page,
        relNext: page.relNext,
        resolvedNext: next,
        nextTarget: next === null ? null : (targets.get(next) ?? null),
        resolvedPrev: prev,
        prevTarget: prev === null ? null : (targets.get(prev) ?? null),
        nextFenced: next !== null && fencedOff.has(next),
      });
    }
  }
}

/**
 * The shape the pagination listing rules take: walk the paginated pages and keep
 * the ones the rule fires on.
 *
 * Capped at `caps.listing` like every other URL-scoped rule — an archive
 * carries `rel=next` on every page of every series, so a crawl that stops
 * short of the last page fires on O(pages) of them — and the scan runs to the
 * end of the last batch either way, so the count behind the cap is exact
 * (`noteTruncation`): only the LISTING stops at the cap, never the counting.
 */
async function paginationFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fires: (p: PaginatedPage) => Record<string, unknown> | null,
  caps: RuleCaps,
): Promise<Finding[]> {
  return paginationFindingsMany(
    self,
    db,
    crawlId,
    (p) => {
      const evidence = fires(p);
      return evidence === null ? [] : [{ evidence, dedupeKey: p.page.url }];
    },
    caps,
  );
}

/**
 * `paginationFindings` for a rule that can fire more than once on one page
 * (`rel=next` and `rel=prev` are two links with two targets). Each hit carries
 * its own dedupe key, because two findings of one rule on one page may not
 * share one.
 */
async function paginationFindingsMany(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fires: (p: PaginatedPage) => Array<{ evidence: Record<string, unknown>; dedupeKey: string }>,
  caps: RuleCaps,
): Promise<Finding[]> {
  const out = cappedListing(self, caps);
  await eachPaginatedPage(db, crawlId, (p) => {
    for (const hit of fires(p)) {
      out.add({
        pageId: p.page.id,
        pageUrl: p.page.url,
        evidence: hit.evidence,
        dedupeKey: hit.dedupeKey,
      });
    }
  });
  return out.done();
}

/**
 * Every page in a `rel=next` cycle, with the cycle it is in.
 *
 * THE DESIGN, AGAINST HARD RULES 3 AND 6. A cycle can span any pages of the
 * crawl, so the walk needs the next-edge of EVERY page at once, and building
 * that page by page in Node is an O(pages) map. It is built in Postgres. The
 * pages are read in batches (`PAGINATION_BATCH`), each page's `rel_next` is
 * resolved with `normalizeUrl` (the only part that has to be JavaScript, as in
 * `eachPaginatedPage`), and the batch's (page, next) edges are `unnest`ed into
 * a temporary table and dropped from memory. One recursive query then walks the
 * whole edge set inside the database. Node holds one batch.
 *
 * THE TEMPORARY TABLES live inside one transaction, so every statement runs on
 * the SAME connection (a pool would otherwise hand each statement to a
 * different session, and a temp table is session-local). Their names carry a
 * random suffix and they are dropped before the transaction ends, so two runs in
 * one process (different crawls, see `RuleCaps`) never meet, and neither does a
 * run nested inside another transaction.
 *
 * THE WALK, IN THREE STEPS. What is bounded: the recursive rows (one per page
 * peeled in step 1, a short run per page left for step 2, one per loop member
 * in step 3, never pages times the step limit), and the JOIN INPUT of every
 * recursive step after step 1, which is the residual table of pages step 1
 * left, not the crawl's whole edge set. The step limit still bounds how far one
 * walk goes. History (PR #22 review and re-review): the first version started
 * a walk at EVERY edge, so a 2,000-page series in ascending URL order produced
 * 875,250 walk rows and found nothing. The second walked few rows but joined
 * the whole edge table on each step, and the planner rebuilt a hash of it every
 * time: on the re-review's 69,000-edge crawl (2,500 twenty-page archives, one
 * 5,000-page series, 20 400-page loops with 300-page tails) that was
 * `Hash rows=69000 loops=500`, 15.9 s for 92,757 walk rows, against 11.5 s for
 * the first version's 9.1 million. Peeling into a table of its own was
 * measured there at 0.84 s for the peel and 0.19 s for the walk, with the same
 * 8,000 members. The whole rule on that crawl, loading its 69,000 edges
 * included, took 17.8–20.1 s before this change and 3.4–3.5 s after it
 * (2026-11-06, dev Postgres 16, two runs each, 8,000 findings both times).
 *
 *  1. `ends` peels off every page whose `next` chain ENDS — at a target that
 *     declares no `next` of its own (or was never crawled), or at a page already
 *     peeled. Every `rel=next` edge has one target, so each page is peeled at
 *     most once: a straight series of any length costs one row per page and
 *     never reaches step 2. What is left — the loops and the pages that lead
 *     into one — is copied into a second temporary table with its own primary
 *     key and statistics, and steps 2 and 3 read only that table. That is sound
 *     because a page left behind always points at a page left behind: had its
 *     target been peeled, it would have been peeled with it.
 *  2. `walk` starts from every page left, follows `next` and CONTINUES ONLY
 *     WHILE THE PAGE IT IS ON SORTS AFTER ITS START, so each loop is walked in
 *     full from exactly one member, its smallest: that walk passes every other
 *     member and arrives back at its start after exactly the loop's length in
 *     steps, while a walk from any other member stops at the first page that
 *     sorts before it. A page that only leads into a loop never arrives back at
 *     itself; it stops the same way or at `PAGINATION_WALK_MAX` steps, and is
 *     not reported. A loop longer than the limit is NOT recognised.
 *     THE ORDER IS `md5(url)`, NOT THE URL. A series that wraps from its last
 *     page to its first is a loop in ascending URL order, and in that order
 *     every member's walk would run on through the rest of the loop: 101,945
 *     rows for a 450-page ring, 875,250 for a 2,000-page one. Hashed, the run of
 *     pages that sort after a start is short whatever order the site's URLs
 *     are in: 3,931 and 12,711 rows for those two rings, counting every
 *     recursive step of the query (test/rules/pagination-query.test.ts reads
 *     them from EXPLAIN ANALYZE). The walk still carries
 *     the smallest URL it passes (`least_url`), which is the loop's identity
 *     everywhere else, so the evidence is unchanged.
 *  3. `members` fans each loop found out to its members by following `next`
 *     from its smallest URL for the loop's length, so each member is reported
 *     once with the loop's length, exactly as when every member walked itself.
 *
 * WHY NOT `CYCLE ... SET is_cycle`, which the plan names. It keeps the path so
 * far on every row, so a row at step k costs O(k): measured on a 502-page ring
 * (where every walk then ran the full 500 steps) the first version, which used
 * it, took 26 s, and a version with O(1) rows 0.4 s; the walk above keeps its
 * rows O(1) and walks each loop once. The quoted path is built ONCE PER DISTINCT LOOP, starting from its
 * smallest URL and at most `LOOP_QUOTE_MAX` steps, and every listed member of
 * the loop gets that same quote and the loop's true length, so the cost of the
 * path does not grow with the loop's length or its member count.
 *
 * `isAuditable` gates the edges like the other pagination rules: a page that
 * was not served as an HTML 200 has no `rel=next` signal to follow.
 */
async function loopFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const suffix = randomUUID().replace(/-/g, "");
  const table = sql.raw(`pagination_edges_${suffix}`);
  // The edges step 1 did not peel off: loops, and the pages leading into them.
  const residual = sql.raw(`pagination_loops_${suffix}`);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`create temporary table ${table} (src_id text not null, src_url text primary key, dst_url text not null, src_key text not null, dst_key text not null)`,
    );

    let cursor = "";
    for (;;) {
      const batch = await tx
        .select({
          id: pages.id,
          url: pages.url,
          relNext: pages.relNext,
          fetchClass: pages.fetchClass,
          statusCode: pages.statusCode,
        })
        .from(pages)
        .where(and(eq(pages.crawlId, crawlId), gt(pages.id, cursor), isNotNull(pages.relNext)))
        .orderBy(asc(pages.id))
        .limit(PAGINATION_BATCH);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;

      const ids: string[] = [];
      const srcs: string[] = [];
      const dsts: string[] = [];
      for (const page of batch) {
        if (!isAuditable(page) || page.relNext === null) continue;
        const next = normalizeUrl(page.relNext, page.url);
        if (next === null) continue;
        ids.push(page.id);
        srcs.push(page.url);
        dsts.push(next);
      }
      if (ids.length === 0) continue;
      await tx.execute(sql`
        insert into ${table} (src_id, src_url, dst_url, src_key, dst_key)
        select u.id, u.src, u.dst, md5(u.src), md5(u.dst)
        from unnest(${sql.param(ids)}::text[], ${sql.param(srcs)}::text[], ${sql.param(dsts)}::text[])
          as u(id, src, dst)`);
    }
    // `ends` walks edges backwards (target to source), so it needs the target
    // indexed; and a temp table is never auto-analyzed, so the planner is told
    // its size rather than guessing.
    await tx.execute(sql`create index on ${table} (dst_url)`);
    await tx.execute(sql`analyze ${table}`);

    // Step 1, into a table of its own, so the walk below joins a table the
    // planner knows is small instead of re-reading every edge on every step.
    await tx.execute(sql`
      create temporary table ${residual} as
      with recursive ends(url) as (
        select e.src_url from ${table} e
        where not exists (select 1 from ${table} n where n.src_url = e.dst_url)
        union
        select e.src_url from ends x join ${table} e on e.dst_url = x.url
      )
      select e.* from ${table} e
      where not exists (select 1 from ends x where x.url = e.src_url)`);
    await tx.execute(sql`alter table ${residual} add primary key (src_url)`);
    await tx.execute(sql`analyze ${residual}`);

    const rows = await tx.execute<{
      start_id: string;
      start_url: string;
      len: number;
      path: string[];
      total: string;
    }>(sql`
      with recursive walk(start_url, start_key, cur, cur_key, least_url, depth) as (
        select e.src_url, e.src_key, e.dst_url, e.dst_key, least(e.src_url, e.dst_url), 1
        from ${residual} e
        union all
        select w.start_url, w.start_key, n.dst_url, n.dst_key, least(w.least_url, n.dst_url),
               w.depth + 1
        from walk w
        join ${residual} n on n.src_url = w.cur
        where w.depth < ${PAGINATION_WALK_MAX}
          and (w.cur_key, w.cur) > (w.start_key, w.start_url)
      ),
      loops as (select least_url, depth as len from walk where cur = start_url),
      fan(least_url, len, url, step) as (
        select l.least_url, l.len, l.least_url, 1 from loops l
        union all
        select f.least_url, f.len, n.dst_url, f.step + 1
        from fan f
        join ${residual} n on n.src_url = f.url
        where f.step < f.len
      ),
      members as (
        select e.src_id as start_id, f.url as start_url, f.len, f.least_url,
               count(*) over () as total
        from fan f
        join ${residual} e on e.src_url = f.url
        order by f.url
        ${limitTo(caps.listing)}
      ),
      cycles as (select distinct least_url, len from members),
      trail(least_url, len, cur, path, depth) as (
        select c.least_url, c.len, c.least_url, array[c.least_url], 1 from cycles c
        union all
        select t.least_url, t.len, n.dst_url, t.path || n.dst_url, t.depth + 1
        from trail t
        join ${residual} n on n.src_url = t.cur
        where t.depth < least(t.len, ${LOOP_QUOTE_MAX})
      )
      select m.start_id, m.start_url, m.len, t.path, m.total
      from members m
      join trail t on t.least_url = m.least_url and t.len = m.len
        and t.depth = least(m.len, ${LOOP_QUOTE_MAX})
      order by m.start_url`);

    await tx.execute(sql`drop table ${residual}`);
    await tx.execute(sql`drop table ${table}`);

    const findings = rows.rows.map((row) =>
      queryFinding(LOOP, {
        pageId: row.start_id,
        pageUrl: row.start_url,
        evidence: { cycle: row.path, cycleLength: Number(row.len) },
        dedupeKey: row.start_url,
      }),
    );
    const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0]!.total);
    return noteTruncation(findings, total);
  });
}

/** What a page's `rel=next` and `rel=prev` say about targets the series cannot use. */
function nonIndexableTargets(
  p: PaginatedPage,
): Array<{ evidence: Record<string, unknown>; dedupeKey: string }> {
  const hits: Array<{ evidence: Record<string, unknown>; dedupeKey: string }> = [];
  for (const [rel, target] of [
    ["next", p.nextTarget],
    ["prev", p.prevTarget],
  ] as const) {
    if (target === null) continue;
    const noindex = hasNoindex(target);
    // A bot-protection block is a refusal, not a page, whatever status it was
    // served with (helpers.ts `indexabilityOf`): a `blocked` 200 is not usable.
    if (target.statusCode === 200 && !noindex && target.fetchClass !== "blocked") continue;
    hits.push({
      evidence: {
        rel,
        target: target.url,
        targetStatus: target.statusCode,
        targetFetchClass: target.fetchClass,
        targetNoindex: noindex,
      },
      dedupeKey: `${p.page.url}\n${rel}`,
    });
  }
  return hits;
}

export const paginationRules: QueryRule[] = [
  // The next page of the series is a URL this crawl never fetched. Usually the
  // series is longer than the crawl's reach, sometimes the rel=next is stale or
  // malformed — which is why an href that will not resolve to a URL at all is
  // reported HERE, flagged `unparseable`, rather than dropped. Either way the
  // engine cannot say anything about the target, which is what makes this info
  // rather than a fault.
  defineRule<QueryRule>({
    kind: "query",
    id: NEXT_UNCRAWLED.id,
    checkIds: ["CHECK-22"],
    category: CATEGORY,
    severity: NEXT_UNCRAWLED.severity,
    columns: [
      { key: "relNext", label: "rel=\"next\"" },
      { key: "resolvedTo", label: "Expected Link" },
      { key: "unparseable", label: "Unparseable", optional: true },
    ],
    ...copyFor(NEXT_UNCRAWLED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      paginationFindings(
        NEXT_UNCRAWLED,
        db,
        crawlId,
        (p) => {
          if (p.relNext === null) return null;
          if (p.resolvedNext === null) {
            return { relNext: p.relNext, resolvedTo: null, unparseable: true };
          }
          // A target the crawl's scope fences off was not crawled by choice (27c).
          return p.nextTarget === null && !p.nextFenced
            ? { relNext: p.relNext, resolvedTo: p.resolvedNext }
            : null;
        },
        capsOr(caps),
      ),
  }),

  // The series is held together by rel=next alone: the next page exists, was
  // crawled, and no page on the site links to it. rel=next is a hint search
  // engines have not used for discovery since 2019, so a paginated set wired
  // this way is a set whose later pages are found by nothing but the sitemap.
  defineRule<QueryRule>({
    kind: "query",
    id: NEXT_NOT_LINKED.id,
    checkIds: ["CHECK-22"],
    category: CATEGORY,
    severity: NEXT_NOT_LINKED.severity,
    columns: [
      { key: "relNext", label: "rel=\"next\"" },
      { key: "resolvedTo", label: "Expected Link" },
    ],
    ...copyFor(NEXT_NOT_LINKED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      paginationFindings(
        NEXT_NOT_LINKED,
        db,
        crawlId,
        (p) =>
          p.relNext !== null && p.nextTarget !== null && !p.nextTarget.linked
            ? { relNext: p.relNext, resolvedTo: p.nextTarget.url }
            : null,
        capsOr(caps),
      ),
  }),

  // A page 2+ — `rel=prev` is what says so — canonicalising somewhere else,
  // normally to page 1. Both strategies are defensible: consolidating the
  // series onto page 1 hides the deeper pages' content, self-canonicalising
  // keeps it indexable at the cost of near-duplicate listings. The engine
  // states which one the site chose and the agent judges it, which is why this
  // is info and why a self-canonical paginated page fires nothing.
  defineRule<QueryRule>({
    kind: "query",
    id: CANONICAL_TO_OTHER.id,
    checkIds: ["CHECK-23"],
    category: CATEGORY,
    severity: CANONICAL_TO_OTHER.severity,
    columns: [
      { key: "canonical", label: "Canonical Link Element" },
      { key: "resolvedTo", label: "Canonical Target" },
      { key: "relPrev", label: "rel=\"prev\"" },
    ],
    ...copyFor(CANONICAL_TO_OTHER.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      paginationFindings(
        CANONICAL_TO_OTHER,
        db,
        crawlId,
        ({ page }) => {
          if (page.relPrev === null) return null;
          const canonical = resolveEffectiveCanonical(page);
          // A canonical that will not resolve is `canonical.points-elsewhere`'s
          // finding, reported there as unparseable. It is not a pagination fault.
          if (canonical === null || !canonical.pointsElsewhere) return null;
          return {
            canonical: canonical.canonical,
            resolvedTo: canonical.resolved,
            relPrev: page.relPrev,
          };
        },
        capsOr(caps),
      ),
  }),

  // The series points at a page it cannot use: a rel=next or rel=prev whose
  // target the crawl FETCHED and that is not a 200, or is a 200 that says
  // noindex. A target the crawl never fetched is `next-target-uncrawled`'s, and
  // so is a `disallowed` one (robots.txt or url-policy), which was never
  // requested. A 404 here is a broken series; a
  // noindex here is a series whose pages the site asked to be kept out.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE_TARGET.id,
    checkIds: ["CHECK-22", "CHECK-23"],
    category: CATEGORY,
    severity: NON_INDEXABLE_TARGET.severity,
    columns: [
      { key: "rel", label: "Link Type" },
      { key: "target", label: "Expected Link" },
      { key: "targetStatus", label: "Target Status" },
      { key: "targetFetchClass", label: "Target Fetch Result" },
      { key: "targetNoindex", label: "Target Noindex" },
    ],
    ...copyFor(NON_INDEXABLE_TARGET.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      paginationFindingsMany(NON_INDEXABLE_TARGET, db, crawlId, nonIndexableTargets, capsOr(caps)),
  }),

  // A page that is part of a rel=next cycle: following next from it comes back
  // to it. A series that loops has no last page, and a crawler or reader
  // following it never leaves.
  defineRule<QueryRule>({
    kind: "query",
    id: LOOP.id,
    checkIds: ["CHECK-22"],
    category: CATEGORY,
    severity: LOOP.severity,
    columns: [
      { key: "cycle", label: "Pagination Loop" },
      { key: "cycleLength", label: "Pages In Loop" },
    ],
    ...copyFor(LOOP.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => loopFindings(db, crawlId, capsOr(caps)),
  }),

  // A.next = B, and B does not say A is its previous page. Both pages are
  // fetched 200s, so both declarations were served and they disagree. Info: a
  // site may legitimately omit rel=prev altogether, but then it omits it
  // everywhere, and a half-annotated series is a template fault.
  defineRule<QueryRule>({
    kind: "query",
    id: SEQUENCE_ERROR.id,
    checkIds: ["CHECK-22"],
    category: CATEGORY,
    severity: SEQUENCE_ERROR.severity,
    columns: [
      { key: "next", label: "rel=\"next\"" },
      { key: "nextsPrev", label: "rel=\"prev\" of Next Page", optional: true },
    ],
    ...copyFor(SEQUENCE_ERROR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      paginationFindings(
        SEQUENCE_ERROR,
        db,
        crawlId,
        (p) => {
          const target = p.nextTarget;
          if (target === null || !isAuditable(target)) return null;
          const back = target.relPrev === null ? null : normalizeUrl(target.relPrev, target.url);
          return back === p.page.url ? null : { next: target.url, nextsPrev: target.relPrev };
        },
        capsOr(caps),
      ),
  }),
];
