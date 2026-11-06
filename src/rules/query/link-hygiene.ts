/**
 * The link-hygiene rules: what the links a page carries say about whether a
 * visitor or a crawler can use them (Phase 26a, CHECK-32, CHECK-33, CHECK-86).
 *
 * Every question here is a question about the `links` table, and the table is
 * never loaded (hard rule 3): each rule groups by source (or target) page in
 * Postgres and takes a capped, ordered slice, with the exact total counted in
 * the same statement. `links.localhost` has one extra step: its verdict is
 * JavaScript's, so it first reads the DISTINCT candidate hosts, decides them,
 * and then runs the same kind of capped aggregation over the blocked ones.
 *
 * THE SOURCE COHORT is the fetched-OK pages (`FETCHED_OK`): a link is judged on
 * the page that carries it whether or not that page is indexable, because a
 * nofollowed or private-host link on a noindex page is still a link the site
 * wrote. Links are only ever extracted from pages the crawl parsed, so the
 * cohort is a guard against a stale row rather than a filter that removes
 * anything on a healthy crawl.
 */
import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { BLOCKED_HOSTS, BLOCKED_HOST_SUFFIXES, blockedHostReason } from "../../crawl/url-policy.js";
import type { Db } from "../../db/client.js";
import { FETCHED_OK, JUDGED, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  HIGH_EXTERNAL_OUTLINKS,
  HIGH_INTERNAL_OUTLINKS,
  NON_DESCRIPTIVE_ANCHORS,
} from "../thresholds.js";
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { SAMPLE_SOURCES } from "./link-targets.js";
import { v2Gate } from "./page-facts.js";

const CATEGORY = "links" as const;

/**
 * Distinct candidate hosts decided per round trip by `links.localhost`: the
 * memory bound, a batch and never the number of hosts a crawl links to. Exported
 * so a test can force the cursor past one batch.
 */
export const LOCALHOST_HOST_BATCH = 500;

const NOFOLLOW: RuleIdentity = { id: "links.internal-nofollow", severity: "warning" };
const NON_INDEXABLE_ONLY: RuleIdentity = {
  id: "links.only-from-non-indexable",
  severity: "warning",
};
const LOCALHOST: RuleIdentity = { id: "links.localhost", severity: "warning" };
const ANCHOR: RuleIdentity = { id: "links.non-descriptive-anchor", severity: "info" };
const NO_ANCHOR: RuleIdentity = { id: "links.no-anchor-text", severity: "info" };
const HIGH_OUTLINKS: RuleIdentity = { id: "links.high-outlinks", severity: "info" };

/**
 * An anchor as the comparison sees it: trimmed, lower-cased, runs of whitespace
 * collapsed, a no-break space (U+00A0) counting as whitespace because Postgres'
 * `\s` does not match it. The analyzer collapses whitespace when it stores an
 * anchor, and the rule does not rely on that: `links.anchor` is a column other
 * writers could fill, and "Read  More" must match whichever wrote it.
 */
const NORMALISED_ANCHOR = sql`lower(btrim(regexp_replace(l.anchor, '[\\s\\u00a0]+', ' ', 'g')))`;

const anchorList = (): SQL =>
  sql.join(
    NON_DESCRIPTIVE_ANCHORS.map((a) => sql`${a}`),
    sql`, `,
  );

/** Internal links carrying rel=nofollow, grouped by the page that carries them. */
async function nofollowFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    nofollow_count: number;
    total_matches: number;
    sample: string[];
  }>(sql`
    with srcs as (
      select p.id as page_id, p.url as page_url,
             count(*)::int as nofollow_count,
             count(*) over ()::int as total_matches
      from links l
      join pages p on p.id = l.source_page_id and p.crawl_id = ${crawlId}
      where l.crawl_id = ${crawlId} and l.is_internal and l.is_nofollow and ${FETCHED_OK("p")}
      group by p.id, p.url
      order by p.url
      ${limitTo(caps.listing)}
    )
    select s.page_id, s.page_url, s.nofollow_count, s.total_matches, x.sample
    from srcs s
    cross join lateral (
      select coalesce(array_agg(t.target_url order by t.target_url), array[]::text[]) as sample
      from (
        select distinct l2.target_url
        from links l2
        where l2.crawl_id = ${crawlId} and l2.source_page_id = s.page_id
          and l2.is_internal and l2.is_nofollow
        order by l2.target_url
        limit ${SAMPLE_SOURCES}
      ) t
    ) x
    order by s.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(NOFOLLOW, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { nofollowCount: row.nofollow_count, sample: row.sample },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * JUDGED pages that other pages link to, none of which is itself JUDGED.
 *
 * "Not judged" is decided as `JUDGED(s) is not false` NEGATED across the group
 * (`count(*) filter (...) = 0`): a source whose indexability the row cannot
 * settle (a NULL flag) leaves `JUDGED` NULL, and `JUDGED` is never negated
 * (src/rules/helpers.ts), so such a source counts as possibly indexable and the
 * page is not reported on its account. The rule fires only when every linking
 * page is definitely out of the index.
 *
 * `l.source_page_id <> p.id`: a self-link is not an inlink, as in `links.orphan`
 * — and a page nothing else links to is `links.orphan`'s, not this rule's,
 * because the inner join leaves it with no group at all.
 */
async function nonIndexableOnlyFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    inlink_sources: number;
    total_matches: number;
    sample: string[];
  }>(sql`
    with targets as (
      select p.id as page_id, p.url as page_url,
             count(distinct l.source_page_id)::int as inlink_sources,
             count(*) over ()::int as total_matches
      from pages p
      join links l on l.crawl_id = ${crawlId} and l.target_url = p.url
                  and l.is_internal and l.source_page_id <> p.id
      join pages s on s.id = l.source_page_id and s.crawl_id = ${crawlId}
      where p.crawl_id = ${crawlId} and ${JUDGED("p")}
      group by p.id, p.url
      having count(*) filter (where ${JUDGED("s")} is not false) = 0
      order by p.url
      ${limitTo(caps.listing)}
    )
    select t.page_id, t.page_url, t.inlink_sources, t.total_matches, x.sample
    from targets t
    cross join lateral (
      select coalesce(array_agg(u.url order by u.url), array[]::text[]) as sample
      from (
        select distinct s2.url
        from links l2
        join pages s2 on s2.id = l2.source_page_id and s2.crawl_id = ${crawlId}
        where l2.crawl_id = ${crawlId} and l2.target_url = t.page_url
          and l2.is_internal and l2.source_page_id <> t.page_id
        order by s2.url
        limit ${SAMPLE_SOURCES}
      ) u
    ) x
    order by t.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(NON_INDEXABLE_ONLY, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { inlinkSources: row.inlink_sources, sample: row.sample },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * The host of a stored link target, as the SQL below reads it: the part after
 * `scheme://` and any `user:pass@`, up to the port, path, query or fragment — a
 * bracketed IPv6 literal kept whole, brackets included — lower-cased.
 */
const HOST_PATTERN = String.raw`^[a-z][a-z0-9+.-]*://(?:[^/?#@]*@)?(\[[^]]*\]|[^/?#:]*)`;

/** The external links of the crawl with their host, as a derived table `b`. */
function externalLinksWithHost(crawlId: string): SQL {
  return sql`(
    select l.source_page_id, l.target_url,
           lower(substring(l.target_url from ${HOST_PATTERN})) as host
    from links l
    where l.crawl_id = ${crawlId} and not l.is_internal
  )`;
}

/**
 * A SUPERSET of the hosts `blockedHostReason` blocks, in SQL, over a host column.
 * The JavaScript decides; this only has to never exclude a host it would block,
 * so that the distinct hosts read stay few and none that matter are lost. It
 * admits a host that is:
 *  - unreadable by the pattern (NULL, kept so the caller can fail loudly);
 *  - a bracketed IPv6 literal;
 *  - dotless (`localhost`, `metadata`, an intranet name — and the empty host);
 *  - spelled with a trailing dot (`localhost.`, which `blockedHostReason`
 *    normalises away, and which a dotless test alone would miss);
 *  - all digits and dots (an IPv4 literal, which `normalizeUrl` has already put
 *    in dotted-quad form);
 *  - one of `BLOCKED_HOSTS`, or ending in one of `BLOCKED_HOST_SUFFIXES`, both
 *    read from the url-policy module itself rather than copied here.
 */
function hostPrefilter(host: SQL): SQL {
  const exact = sql.join(
    [...BLOCKED_HOSTS].map((h) => sql`${h}`),
    sql`, `,
  );
  const suffixes = sql.join(
    BLOCKED_HOST_SUFFIXES.map((s) => sql`${`%${s}`}`),
    sql`, `,
  );
  return sql`(
    ${host} is null
    or ${host} like '[%'
    or ${host} !~ '[.]'
    or ${host} like '%.'
    or ${host} ~ '^[0-9.]+$'
    or ${host} in (${exact})
    or ${host} like any (array[${suffixes}])
  )`;
}

/**
 * Pages with an external link whose host is localhost, a private or reserved
 * address, or an internal-only name.
 *
 * EXTERNAL LINKS ONLY (`is_internal = false`). An internal link is the site
 * itself: a site crawled on a private address, as the fixture site is, links
 * itself everywhere and would otherwise report its own address on every page.
 * The same-origin test that sets `is_internal` is the crawler's, so the rule
 * and the crawl agree about what the site is.
 *
 * THE JAVASCRIPT SITS BETWEEN TWO STEPS, and Node holds one batch. The distinct
 * hosts of the external links that pass the SQL prefilter (`hostPrefilter`, a
 * superset) are read in keyset batches ordered by host (`LOCALHOST_HOST_BATCH`),
 * and `blockedHostReason` — the url-policy authority the crawler itself refuses
 * with — decides each batch, so a link is reported as private exactly when the
 * crawler would refuse to fetch it. Dotless names such as `intranet` pass the
 * prefilter and fail the policy, and are not reported: the policy does not call
 * them private, and the rule does not either. The blocked hosts and their
 * reasons go into a temporary table, and then one ordinary capped aggregation
 * joins it, like the other four rules': per source page, an exact total from
 * `count(*) over ()` before the `limit`, ordered by URL.
 *
 * The temporary table follows `pagination.loop`'s pattern: one transaction, so
 * every statement shares a connection (a temp table is session-local), a random
 * name so concurrent runs never meet, dropped before the transaction ends and
 * rolled back with it if anything throws. Nothing is bound per host in the
 * aggregation, so the number of blocked hosts cannot reach a bind-parameter
 * limit either.
 */
async function localhostFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const table = sql.raw(`links_blocked_hosts_${randomUUID().replace(/-/g, "")}`);
  const external = externalLinksWithHost(crawlId);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`create temporary table ${table} (host text primary key, reason text not null)`,
    );

    // `links.target_url` is `normalizeUrl` output, so a target with no readable
    // host is our defect and not a link to skip.
    const unreadable = await tx.execute(sql`
      select 1
      from ${external} b
      join pages p on p.id = b.source_page_id and p.crawl_id = ${crawlId}
      where ${FETCHED_OK("p")} and b.host is null
      limit 1`);
    if (unreadable.rows.length > 0) {
      throw new Error(`${LOCALHOST.id}: an external link target has no readable host`);
    }

    let cursor: string | null = null;
    for (;;) {
      const batch: { rows: { host: string }[] } = await tx.execute<{ host: string }>(sql`
        select distinct b.host
        from ${external} b
        join pages p on p.id = b.source_page_id and p.crawl_id = ${crawlId}
        where ${FETCHED_OK("p")} and b.host is not null
          and ${cursor === null ? sql`true` : sql`b.host > ${cursor}`}
          and ${hostPrefilter(sql`b.host`)}
        order by b.host
        limit ${LOCALHOST_HOST_BATCH}`);
      if (batch.rows.length === 0) break;
      cursor = batch.rows[batch.rows.length - 1]!.host;

      const hosts: string[] = [];
      const reasons: string[] = [];
      for (const { host } of batch.rows) {
        const reason = blockedHostReason(host);
        if (reason === null) continue;
        hosts.push(host);
        reasons.push(reason);
      }
      if (hosts.length === 0) continue;
      await tx.execute(sql`
        insert into ${table} (host, reason)
        select * from unnest(${sql.param(hosts)}::text[], ${sql.param(reasons)}::text[])`);
    }

    const blockedLinks = sql`(
      select b.source_page_id, b.target_url, b.host, r.reason
      from ${external} b
      join ${table} r on r.host = b.host
    )`;
    const result = await tx.execute<{
      page_id: string;
      page_url: string;
      target_count: number;
      first_reason: string | null;
      total_matches: number;
      targets: string[];
    }>(sql`
      with srcs as (
        select p.id as page_id, p.url as page_url,
               count(distinct x.target_url)::int as target_count,
               (array_agg(x.reason order by x.target_url))[1] as first_reason,
               count(*) over ()::int as total_matches
        from ${blockedLinks} x
        join pages p on p.id = x.source_page_id and p.crawl_id = ${crawlId}
        where ${FETCHED_OK("p")}
        group by p.id, p.url
        order by p.url
        ${limitTo(caps.listing)}
      )
      select s.page_id, s.page_url, s.target_count, s.first_reason, s.total_matches, t.targets
      from srcs s
      cross join lateral (
        select coalesce(array_agg(u.target_url order by u.target_url), array[]::text[]) as targets
        from (
          select distinct x.target_url
          from ${blockedLinks} x
          where x.source_page_id = s.page_id
          order by x.target_url
          limit ${SAMPLE_SOURCES}
        ) u
      ) t
      order by s.page_url`);

    await tx.execute(sql`drop table ${table}`);

    const findings = result.rows.map((row) => {
      if (row.first_reason === null) {
        throw new Error(`${LOCALHOST.id}: no reason recorded for the first target of ${row.page_url}`);
      }
      return queryFinding(LOCALHOST, {
        pageId: row.page_id,
        pageUrl: row.page_url,
        evidence: {
          targets: row.targets,
          reason: row.first_reason,
          targetCount: row.target_count,
        },
        dedupeKey: row.page_url,
      });
    });
    return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
  });
}

/** Internal links whose whole anchor is on `NON_DESCRIPTIVE_ANCHORS`. */
async function anchorFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    generic_count: number;
    total_matches: number;
    anchors: string[];
  }>(sql`
    with srcs as (
      select p.id as page_id, p.url as page_url,
             count(*)::int as generic_count,
             count(*) over ()::int as total_matches
      from links l
      join pages p on p.id = l.source_page_id and p.crawl_id = ${crawlId}
      where l.crawl_id = ${crawlId} and l.is_internal and ${FETCHED_OK("p")}
        and ${NORMALISED_ANCHOR} in (${anchorList()})
      group by p.id, p.url
      order by p.url
      ${limitTo(caps.listing)}
    )
    select s.page_id, s.page_url, s.generic_count, s.total_matches, x.anchors
    from srcs s
    cross join lateral (
      select coalesce(array_agg(a.anchor order by a.anchor), array[]::text[]) as anchors
      from (
        select distinct ${NORMALISED_ANCHOR} as anchor
        from links l
        where l.crawl_id = ${crawlId} and l.source_page_id = s.page_id and l.is_internal
          and ${NORMALISED_ANCHOR} in (${anchorList()})
        order by 1
        limit ${SAMPLE_SOURCES}
      ) a
    ) x
    order by s.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(ANCHOR, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { anchors: row.anchors, count: row.generic_count },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * Internal links whose stored anchor is empty once whitespace (no-break spaces
 * included, as `NORMALISED_ANCHOR` reads them) is removed. On an extraction 2 row
 * the stored anchor includes the alt text of an image inside the link, so an
 * image link with alt is not empty and one without alt is.
 *
 * Opens with `v2Gate`: the alt-in-anchor reading exists only on v2 rows, so on a
 * crawl with any older page the marker speaks and this returns `[]`.
 *
 * Only the first anchor per target is stored (the existing link-dedupe
 * contract), so a target reached first by an empty image link and later by a
 * text link reads empty here.
 */
async function noAnchorFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const gate = await v2Gate(db, crawlId);
  if (!gate.recorded) return [];
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    empty_count: number;
    total_matches: number;
    targets: string[];
  }>(sql`
    with srcs as (
      select p.id as page_id, p.url as page_url,
             count(*)::int as empty_count,
             count(*) over ()::int as total_matches
      from links l
      join pages p on p.id = l.source_page_id and p.crawl_id = ${crawlId}
      where l.crawl_id = ${crawlId} and l.is_internal and ${FETCHED_OK("p")}
        and ${NORMALISED_ANCHOR} = ''
      group by p.id, p.url
      order by p.url
      ${limitTo(caps.listing)}
    )
    select s.page_id, s.page_url, s.empty_count, s.total_matches, x.targets
    from srcs s
    cross join lateral (
      select coalesce(array_agg(t.target_url order by t.target_url), array[]::text[]) as targets
      from (
        select distinct l.target_url
        from links l
        where l.crawl_id = ${crawlId} and l.source_page_id = s.page_id and l.is_internal
          and ${NORMALISED_ANCHOR} = ''
        order by l.target_url
        limit ${SAMPLE_SOURCES}
      ) t
    ) x
    order by s.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(NO_ANCHOR, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { count: row.empty_count, targets: row.targets },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * Pages linking to more distinct internal URLs than `HIGH_INTERNAL_OUTLINKS`, or
 * more distinct external URLs than `HIGH_EXTERNAL_OUTLINKS`. The two counts are
 * never added: a page with 100 of each has crossed neither line.
 *
 * Distinct targets, not link rows: the analyzer keeps one row per target, and
 * the rule does not depend on that. `max` is the limit that was crossed (the
 * internal one when both were) and `crossed` says which.
 */
async function highOutlinkFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    internal_outlinks: number;
    external_outlinks: number;
    total_matches: number;
  }>(sql`
    select p.id as page_id, p.url as page_url,
           (count(distinct l.target_url) filter (where l.is_internal))::int as internal_outlinks,
           (count(distinct l.target_url) filter (where not l.is_internal))::int as external_outlinks,
           count(*) over ()::int as total_matches
    from links l
    join pages p on p.id = l.source_page_id and p.crawl_id = ${crawlId}
    where l.crawl_id = ${crawlId} and ${FETCHED_OK("p")}
    group by p.id, p.url
    having count(distinct l.target_url) filter (where l.is_internal) > ${HIGH_INTERNAL_OUTLINKS}
        or count(distinct l.target_url) filter (where not l.is_internal) > ${HIGH_EXTERNAL_OUTLINKS}
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) => {
    const internalCrossed = row.internal_outlinks > HIGH_INTERNAL_OUTLINKS;
    const externalCrossed = row.external_outlinks > HIGH_EXTERNAL_OUTLINKS;
    return queryFinding(HIGH_OUTLINKS, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: {
        internalOutlinks: row.internal_outlinks,
        externalOutlinks: row.external_outlinks,
        max: internalCrossed ? HIGH_INTERNAL_OUTLINKS : HIGH_EXTERNAL_OUTLINKS,
        crossed: internalCrossed && externalCrossed ? "both" : internalCrossed ? "internal" : "external",
      },
      dedupeKey: row.page_url,
    });
  });
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

export const linkHygieneRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: NOFOLLOW.id,
    checkIds: ["CHECK-33"],
    category: CATEGORY,
    severity: NOFOLLOW.severity,
    columns: [
      { key: "nofollowCount", label: "Nofollow Links" },
      { key: "sample", label: "Sample Targets" },
    ],
    ...copyFor(NOFOLLOW.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => nofollowFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE_ONLY.id,
    checkIds: ["CHECK-32"],
    category: CATEGORY,
    severity: NON_INDEXABLE_ONLY.severity,
    columns: [
      { key: "inlinkSources", label: "Linking Pages" },
      { key: "sample", label: "Sample Sources" },
    ],
    ...copyFor(NON_INDEXABLE_ONLY.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => nonIndexableOnlyFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: LOCALHOST.id,
    checkIds: ["CHECK-86"],
    category: CATEGORY,
    severity: LOCALHOST.severity,
    columns: [
      { key: "targets", label: "Private Targets" },
      { key: "targetCount", label: "Private Link Count" },
      { key: "reason", label: "Reason" },
    ],
    ...copyFor(LOCALHOST.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => localhostFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: ANCHOR.id,
    checkIds: ["CHECK-86"],
    category: CATEGORY,
    severity: ANCHOR.severity,
    columns: [
      { key: "count", label: "Generic Anchor Links" },
      { key: "anchors", label: "Anchor Text" },
    ],
    ...copyFor(ANCHOR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => anchorFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: NO_ANCHOR.id,
    checkIds: ["CHECK-86"],
    category: CATEGORY,
    severity: NO_ANCHOR.severity,
    columns: [
      { key: "count", label: "Links Without Anchor Text" },
      { key: "targets", label: "Targets" },
    ],
    ...copyFor(NO_ANCHOR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => noAnchorFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: HIGH_OUTLINKS.id,
    checkIds: ["CHECK-33"],
    category: CATEGORY,
    severity: HIGH_OUTLINKS.severity,
    columns: [
      { key: "internalOutlinks", label: "Unique Internal Outlinks" },
      { key: "externalOutlinks", label: "Unique External Outlinks" },
      { key: "max", label: "Limit Crossed" },
      { key: "crossed", label: "Outlink Type Crossed" },
    ],
    ...copyFor(HIGH_OUTLINKS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => highOutlinkFindings(db, crawlId, capsOr(caps)),
  }),
];
