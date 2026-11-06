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
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";

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
          and p.fetch_class <> 'disallowed'`);
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
  const findings: Finding[] = [];
  let total = 0;
  await eachPaginatedPage(db, crawlId, (p) => {
    for (const hit of fires(p)) {
      total += 1;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(self, {
          pageId: p.page.id,
          pageUrl: p.page.url,
          evidence: hit.evidence,
          dedupeKey: hit.dedupeKey,
        }),
      );
    }
  });
  return noteTruncation(findings, total);
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
 * THE TEMPORARY TABLE lives inside one transaction, so every statement runs on
 * the SAME connection (a pool would otherwise hand each statement to a
 * different session, and a temp table is session-local). Its name carries a
 * random suffix and it is dropped before the transaction ends, so two runs in
 * one process (different crawls, see `RuleCaps`) never meet, and neither does a
 * run nested inside another transaction.
 *
 * THE WALK starts from every edge and follows `next` until it arrives back at
 * its start or has taken `PAGINATION_WALK_MAX` steps. Each row also carries the
 * smallest URL it has passed, in O(1), which on arrival is the loop's identity. A start page is in a loop
 * exactly when its walk arrives back at it; a page that only leads into somebody
 * else's loop spins in that loop until the step limit and is not reported. Each
 * member of a loop is its own start, so each is reported once, and the number of
 * steps it took is the loop's length. A loop longer than the limit is NOT
 * recognised. Termination rests on the step limit, which bounds the work at
 * pages times the limit.
 *
 * WHY NOT `CYCLE ... SET is_cycle`, which the plan names. It keeps the path so
 * far on every row, so a row at step k costs O(k): measured on a 502-page ring
 * (the worst case, every walk runs the full 500 steps) the first version, which
 * used it, took 26 s, and this version, whose rows are O(1), 0.4 s. A series of
 * a few hundred pages in a straight line costs the same order, and archives are
 * that long. The quoted path is built ONCE PER DISTINCT LOOP, starting from its
 * smallest URL and at most `LOOP_QUOTE_MAX` steps, and every listed member of
 * the loop gets that same quote and the loop's true length, so the cost of the
 * path does not grow with the loop's length or its member count.
 *
 * `isAuditable` gates the edges like the other pagination rules: a page that
 * was not served as an HTML 200 has no `rel=next` signal to follow.
 */
async function loopFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const table = sql.raw(`pagination_edges_${randomUUID().replace(/-/g, "")}`);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`create temporary table ${table} (src_id text not null, src_url text primary key, dst_url text not null)`,
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
        insert into ${table} (src_id, src_url, dst_url)
        select * from unnest(${sql.param(ids)}::text[], ${sql.param(srcs)}::text[], ${sql.param(dsts)}::text[])`);
    }

    const rows = await tx.execute<{
      start_id: string;
      start_url: string;
      len: number;
      path: string[];
      total: string;
    }>(sql`
      with recursive walk(start_id, start_url, cur, least_url, depth) as (
        select e.src_id, e.src_url, e.dst_url, least(e.src_url, e.dst_url), 1 from ${table} e
        union all
        select w.start_id, w.start_url, n.dst_url, least(w.least_url, n.dst_url), w.depth + 1
        from walk w
        join ${table} n on n.src_url = w.cur
        where w.depth < ${PAGINATION_WALK_MAX} and w.cur <> w.start_url
      ),
      members as (
        select start_id, start_url, depth as len, least_url, count(*) over () as total
        from walk
        where cur = start_url
        order by start_url
        ${limitTo(caps.listing)}
      ),
      cycles as (select distinct least_url, len from members),
      trail(least_url, len, cur, path, depth) as (
        select c.least_url, c.len, c.least_url, array[c.least_url], 1 from cycles c
        union all
        select t.least_url, t.len, n.dst_url, t.path || n.dst_url, t.depth + 1
        from trail t
        join ${table} n on n.src_url = t.cur
        where t.depth < least(t.len, ${LOOP_QUOTE_MAX})
      )
      select m.start_id, m.start_url, m.len, t.path, m.total
      from members m
      join trail t on t.least_url = m.least_url and t.len = m.len
        and t.depth = least(m.len, ${LOOP_QUOTE_MAX})
      order by m.start_url`);

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
          return p.nextTarget === null
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
