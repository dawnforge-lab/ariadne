/**
 * The `anchors_by_target` listing (Phase 29c, CHECK-86, ruling R6): for each page
 * that internal links point at, how many pages link to it, which anchor texts
 * they use, and how much of that is empty or says nothing.
 *
 * ONE STATEMENT, one lateral aggregate per target page over `links_crawl_target_url`
 * (crawl_id, target_url): every link question is SQL (hard rule 3), so the memory
 * is O(limit) and never O(links).
 *
 * WHAT IS COUNTED: DISTINCT SOURCE PAGES, throughout. `inlinks` is
 * `pages.inlinks_internal` (R1: distinct sources, self excluded, nofollow
 * counted), checked against a count of distinct sources taken from the links
 * in the same statement: a row where the two differ throws, never lists. Every anchor count is the number of distinct source
 * pages that use that anchor on a link to the target, so a page linking twice
 * with the same text counts once, and `topAnchors[].count` never exceeds
 * `inlinks`. A page linking with two different texts counts once under each.
 * `genericShare` is the distinct source pages EVERY ONE OF WHOSE LINKS to the
 * target is empty or non-descriptive, over `inlinks` (the final-review M4 ruling).
 * So `genericShare` is 1 exactly when every inlink anchor is generic, the anchor
 * condition `links.anchors-generic-only` fires on: a source with "Read more" AND a
 * descriptive link to the target does not count. When every source links once it
 * equals (empty + nonDescriptive) over inlinks (R6); it can never pass 1.
 * `emptyAnchors` and `nonDescriptiveAnchors` stay per anchor class: the sources
 * that use an empty (or a non-descriptive) anchor on ANY of their links to the
 * target.
 *
 * Anchors are grouped by `NORMALISED_ANCHOR`, the comparison `links.non-descriptive-
 * anchor` and `links.anchors-generic-only` use, so a finding and this listing
 * agree on what "click here" is. EMPTY is a normalised anchor that is `''` or
 * null: an aria-label does not make an anchor non-empty, this listing is about
 * link text.
 */
import { sql, type SQL } from "drizzle-orm";

import { NORMALISED_ANCHOR, anchorList } from "../rules/query/link-hygiene.js";

/** Anchor texts listed per target. */
export const ANCHORS_TOP_N = 5;

export interface AnchorTextCount {
  text: string;
  count: number;
}

export interface AnchorsByTargetRow {
  url: string;
  pageType: string | null;
  /** Distinct internal source pages (`inlinks_internal`). */
  inlinks: number;
  /** Distinct normalised anchors, the empty one included when present. */
  distinctAnchors: number;
  /** The most frequent non-empty anchors: count desc, text asc. */
  topAnchors: AnchorTextCount[];
  /** Distinct source pages whose link has no text. */
  emptyAnchors: number;
  /** Distinct source pages whose link text is on `NON_DESCRIPTIVE_ANCHORS`. */
  nonDescriptiveAnchors: number;
  /** Source pages whose every link to the target is empty or non-descriptive, over `inlinks`, 4 places. */
  genericShare: number;
}

/** The columns `anchorsByTargetSql` selects. */
export type AnchorsByTargetRaw = {
  url: string;
  page_type: string | null;
  inlinks: number;
  distinct_anchors: number;
  top: unknown;
  empty_anchors: number;
  non_descriptive: number;
  generic_sources: number;
  source_count: number;
};

/**
 * The statement. `cohort` is a condition on `p.page_type` (the service's
 * `pageTypeCondition`), or null for every page. `cursor` is the last url seen,
 * or null. Ordered by url.
 */
export function anchorsByTargetSql(
  crawlId: string,
  cursor: string | null,
  limit: number,
  cohort: SQL | null = null,
): SQL {
  const where: SQL[] = [sql`p.crawl_id = ${crawlId}`, sql`p.inlinks_internal >= 1`];
  if (cohort !== null) where.push(cohort);
  if (cursor !== null) where.push(sql`p.url > ${cursor}::text`);
  return sql`
    select p.url, p.page_type, p.inlinks_internal as inlinks,
           a.distinct_anchors, a.top, a.empty_anchors, a.non_descriptive, a.generic_sources,
           a.source_count
      from (
        -- THE LIMIT IS TAKEN BEFORE THE LATERAL: the page keys are chosen, ordered
        -- and cut first, so at most the limit per-target aggregates run whatever the
        -- planner estimates (hard rule 6: never O(all links) per page of the listing).
        select p.id, p.url, p.page_type, p.inlinks_internal
          from pages p
         where ${sql.join(where, sql` and `)}
         order by p.url asc
         limit ${limit}
      ) p
     cross join lateral (
       with sa as (
         select distinct l.source_page_id as sid, coalesce(${NORMALISED_ANCHOR}, '') as anchor
           from links l
          where l.crawl_id = ${crawlId} and l.target_url = p.url and l.source_page_id <> p.id
       ), pa as (
         select anchor, count(*)::int as n from sa group by anchor
       )
       select (select count(*) from pa)::int as distinct_anchors,
              (select count(distinct sid) from sa)::int as source_count,
              (select coalesce(sum(n), 0) from pa where anchor = '')::int as empty_anchors,
              -- Distinct sources, not a sum over pa: a source using two different
              -- generic phrases is one source in the class (never above inlinks).
              (select count(distinct sid) from sa
                where anchor <> '' and anchor in (${anchorList()}))::int as non_descriptive,
              -- A source is generic only when ALL its links to the target are.
              (select count(*) from (
                 select sid from sa
                  group by sid
                 having bool_and(anchor = '' or anchor in (${anchorList()}))
              ) g)::int as generic_sources,
              coalesce((select jsonb_agg(jsonb_build_object('text', t.anchor, 'count', t.n)
                                         order by t.n desc, t.anchor asc)
                          from (select anchor, n from pa where anchor <> ''
                                 order by n desc, anchor asc limit ${ANCHORS_TOP_N}) t),
                       '[]'::jsonb) as top
     ) a
     order by p.url asc`;
}

/** The share, 4 places. A target with no inlinks is never selected, so no zero divisor. */
function share(row: AnchorsByTargetRaw): number {
  if (row.inlinks < 1) {
    throw new Error(`anchors_by_target: ${row.url} has ${row.inlinks} inlinks, which the listing never selects`);
  }
  return Math.round((row.generic_sources / row.inlinks) * 10_000) / 10_000;
}

/** A raw row as the surface's shape; throws on a top list this query could not write. */
export function anchorsByTargetRow(row: AnchorsByTargetRaw): AnchorsByTargetRow {
  if (row.source_count !== row.inlinks) {
    throw new Error(
      `anchors_by_target: ${row.url} has inlinks_internal ${row.inlinks} but ${row.source_count} distinct ` +
        "linking pages in links: re-run the rules (crawl_rules)",
    );
  }
  const top = row.top;
  if (!Array.isArray(top)) {
    throw new Error(`anchors_by_target: ${row.url} has a top-anchors value that is not a list`);
  }
  return {
    url: row.url,
    pageType: row.page_type,
    inlinks: row.inlinks,
    distinctAnchors: row.distinct_anchors,
    topAnchors: top.map((t) => {
      const e = t as { text?: unknown; count?: unknown };
      if (typeof e.text !== "string" || typeof e.count !== "number") {
        throw new Error(`anchors_by_target: ${row.url} has a malformed top-anchor entry`);
      }
      return { text: e.text, count: e.count };
    }),
    emptyAnchors: row.empty_anchors,
    nonDescriptiveAnchors: row.non_descriptive,
    genericShare: share(row),
  };
}

/** `text (n); text (n)`, the CSV rendering of `topAnchors`. */
export function renderTopAnchors(top: readonly AnchorTextCount[]): string {
  return top.map((t) => `${t.text} (${t.count})`).join("; ");
}
