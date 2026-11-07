/**
 * The sitemap entry rules (26a): the limits and shapes a sitemap document owes
 * the protocol, judged from `sitemap_urls` alone.
 *
 *  - `sitemap.over-50k-urls`  a document holding more entries than the cap
 *  - `sitemap.url-too-long`   a `<loc>` longer than `SITEMAP_LOC_MAX`
 *  - `sitemap.cross-host-loc` a `<loc>` whose scheme or host is neither its
 *                             document's nor the crawled site's
 *  - `sitemap.lastmod-invalid` a `<lastmod>` outside the W3C date-time profile,
 *                             or one dated after the crawl that read it ended
 *
 * Every question is one aggregate or one filtered scan in SQL, ordered and
 * capped by `caps.listing` with the exact total carried by `count(*) over ()`,
 * so memory is O(findings reported) whatever the sitemap's size (hard rules 3
 * and 6).
 *
 * ## What reaches the table
 *
 * `discover` policy-checks each `<loc>` and normalises it with `new URL()`;
 * neither imposes a length limit and neither requires the host of the document,
 * so an over-long entry and a cross-host entry are stored as published. That is
 * what makes these rules able to fire at all (hard rule 1).
 *
 * ## `sitemap.over-50k-urls` is exact (Phase 26c)
 *
 * `sitemap_urls` is keyed on (crawl, url), so a URL listed in two documents is
 * stored once, under the first. `sitemap_memberships` holds one row per URL per
 * document, so the count per document is exact. The rule, and the two Phase 26c
 * rules beside it (`sitemap.oversized`, `sitemap.url-in-multiple`), read facts
 * discovery records from 26c on and REFUSE a crawl without
 * `discovery.sitemapFacts` (they return no findings; the marker
 * `extraction.not-recorded` says why).
 *
 * Every count is of the TABLE. `sitemapFacts.memberships` counts memberships
 * offered to the sink and can exceed the stored rows.
 *
 * ## `sitemap.lastmod-invalid`
 *
 * The shape is `W3C_DATETIME` (the six W3C-DTF forms) tested in Postgres. A
 * shape-valid value can still name a day that does not exist (30 February), so
 * the value is also parsed by the database's own `timestamptz` input, guarded
 * with `pg_input_is_valid`; a value it refuses is `format` too.
 *
 * "Future" means later than the moment the site served the sitemap, never the
 * wall clock, so re-judging an old crawl gives the same answer. The crawl does
 * not record when each sitemap document was read (the discovery evidence holds
 * outcomes and counts, no timestamps), so the reference is `crawls.finished_at`:
 * every sitemap a crawl reads is read before the crawl closes, so a value after
 * it was in the future when it was served, whatever the document. It is NOT
 * `started_at`. Discovery reads the sitemaps after the crawl row is created, and
 * a site that stamps every entry with the moment it generated the file (Shopify
 * does: the Phase 26a gate's lavishalice crawl read 205 entries stamped eight
 * seconds after `started_at`) would read as "future" for a value that was "now"
 * when served. The window between the start and the end of the crawl is
 * therefore not judged: a value inside it may have been in the future when read,
 * and this rule cannot tell, so it says nothing rather than guess.
 *
 * Every closed crawl has `finished_at` (`closeCrawl` writes it with the status,
 * and the rules refuse a crawl that is still running). A crawl with lastmod
 * values to judge and no `finished_at` is a row this engine did not produce,
 * and the rule throws rather than judge it against some other instant (hard
 * rule 7). A crawl with no lastmod at all has nothing whose verdict depends on
 * the reference, so it is not refused.
 *
 * Zone-less forms (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) are read as UTC midnight at
 * the START of the period they name, and a value is future when that instant is
 * after `finished_at`. A date-only value on the crawl's own UTC day therefore
 * starts before the crawl ended and is NOT future; so is the current month or
 * the current year. A date-time is compared as the instant it names, the offset
 * honoured.
 */
import { sql, type SQL } from "drizzle-orm";

import { INDEXED_URL_MAX } from "../../crawl/parse/url-utils.js";
import { SITEMAP_MAX_BYTES } from "../../crawl/sitemap-stream.js";
import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { SITEMAP_LOC_MAX, SITEMAP_URL_CAP, W3C_DATETIME } from "../thresholds.js";
import {
  assertNormalisedSitemap,
  capsOr,
  limitTo,
  noteTruncation,
  readCrawlEvidence,
} from "./crawl-evidence.js";
import { readSitemapFacts } from "./page-facts.js";

const CATEGORY = "sitemap";

/** Characters of a `<loc>` quoted in evidence. The full length is its own key. */
const LOC_EXCERPT = 200;

/** Documents named on a `sitemap.url-in-multiple` finding; `count` is exact. */
const IN_MULTIPLE_LISTED = 10;

const OVER_50K: RuleIdentity = { id: "sitemap.over-50k-urls", severity: "warning" };
const OVERSIZED: RuleIdentity = { id: "sitemap.oversized", severity: "warning" };
const IN_MULTIPLE: RuleIdentity = { id: "sitemap.url-in-multiple", severity: "info" };
const TOO_LONG: RuleIdentity = { id: "sitemap.url-too-long", severity: "info" };
const CROSS_HOST: RuleIdentity = { id: "sitemap.cross-host-loc", severity: "warning" };
const LASTMOD: RuleIdentity = { id: "sitemap.lastmod-invalid", severity: "info" };

interface EntryRow extends Record<string, unknown> {
  url: string;
  sitemap_source: string;
  page_id: string | null;
  page_url: string | null;
  lastmod: string | null;
  reason: string | null;
  total_matches: number;
}

/**
 * Entries matching `condition`, joined to the page the entry names when the
 * crawl has one (the finding then sits on that page, as every sitemap rule's
 * does) and to the crawl row for `finished_at`.
 */
async function entryFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  condition: SQL,
  reason: SQL,
  evidenceOf: (row: EntryRow) => Record<string, unknown>,
  caps: RuleCaps,
): Promise<Finding[]> {
  await readCrawlEvidence(db, crawlId, self.id);
  await assertNormalisedSitemap(db, crawlId, self.id);
  const result = await db.execute<EntryRow>(sql`
    with judged as (
      select s.url, s.sitemap_source, s.url_normalised, s.lastmod, c.site_url,
             ${reason} as reason
      from sitemap_urls s
      join crawls c on c.id = s.crawl_id
      where s.crawl_id = ${crawlId}
    )
    select j.url, j.sitemap_source, p.id as page_id, p.url as page_url, j.lastmod, j.reason,
           count(*) over ()::int as total_matches
    from judged j
    left join pages p on p.crawl_id = ${crawlId} and p.url = j.url_normalised
    where ${condition}
    order by j.url
    ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.page_id,
      // The page row's own URL when the entry names a crawled page: the
      // published `<loc>` (fragment and all) is the evidence, not the key.
      pageUrl: row.page_url ?? row.url,
      evidence: evidenceOf(row),
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

const NO_REASON = sql`null::text`;

/**
 * Refuse to judge lastmod values on a crawl with no `finished_at`, the instant
 * "future" is measured from (see the header). One indexed lookup for the crawl
 * row and one `exists` probe on `sitemap_urls`; a crawl with no lastmod at all
 * is not refused, because no verdict depends on the reference.
 */
async function assertLastmodReference(db: Db, crawlId: string): Promise<void> {
  const result = await db.execute<{ unfinished: boolean; has_lastmod: boolean }>(sql`
    select c.finished_at is null as unfinished,
           exists (select 1 from sitemap_urls s
                   where s.crawl_id = c.id and s.lastmod is not null) as has_lastmod
    from crawls c where c.id = ${crawlId}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`${LASTMOD.id}: no such crawl '${crawlId}'`);
  if (row.unfinished && row.has_lastmod) {
    throw new Error(
      `${LASTMOD.id}: crawl '${crawlId}' has sitemap lastmod values but no finished_at, ` +
        `so "future" cannot be judged: it is measured against the instant the crawl finished. ` +
        `A crawl that ran to a terminal state always records finished_at, so this is normally ` +
        `a crawl row that never reached one (it is still running, or it was interrupted)`,
    );
  }
}

/**
 * `lastmod` as an ISO date-time `timestamptz` can read: the three zone-less
 * forms padded to UTC midnight of the period's first instant. A date-time
 * already carries its designator.
 */
const LASTMOD_ISO = sql`case
  when s.lastmod ~ '^[0-9]{4}$' then s.lastmod || '-01-01T00:00:00Z'
  when s.lastmod ~ '^[0-9]{4}-[0-9]{2}$' then s.lastmod || '-01T00:00:00Z'
  when s.lastmod ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then s.lastmod || 'T00:00:00Z'
  else s.lastmod end`;

/** `format`, `future` or null. Nested `case`: the cast runs only on valid text. */
const LASTMOD_REASON = sql`case
  when s.lastmod is null then null
  when s.lastmod !~ ${W3C_DATETIME.source} then 'format'
  when not pg_input_is_valid(${LASTMOD_ISO}, 'timestamptz') then 'format'
  when (${LASTMOD_ISO})::timestamptz > c.finished_at then 'future'
  else null end`;

export const sitemapEntryRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: OVER_50K.id,
    checkIds: ["CHECK-08"],
    category: CATEGORY,
    severity: OVER_50K.severity,
    columns: [
      { key: "sitemap", label: "Sitemap" },
      { key: "entries", label: "Entries" },
      { key: "membershipLimited", label: "Membership Cap Reached", optional: true },
    ],
    ...copyFor(OVER_50K.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, OVER_50K.id);
      const facts = await readSitemapFacts(db, crawlId, OVER_50K.id);
      if (facts === null) return [];
      const result = await db.execute<{
        sitemap_source: string;
        entries: number;
        total_matches: number;
      }>(sql`
        select sitemap_source, entries::int as entries,
               count(*) over ()::int as total_matches
        from (
          select sitemap_source, count(*) as entries
          from sitemap_memberships
          where crawl_id = ${crawlId}
          group by sitemap_source
          having count(*) > ${SITEMAP_URL_CAP}
        ) over_cap
        order by sitemap_source
        ${limitTo(capsOr(caps).listing)}`);
      const findings = result.rows.map((row) =>
        queryFinding(OVER_50K, {
          pageId: null,
          pageUrl: null,
          evidence: {
            sitemap: row.sitemap_source,
            entries: row.entries,
            // The membership cap dropped later listings: the count is a floor.
            ...(facts.membershipLimited ? { membershipLimited: true } : {}),
          },
          dedupeKey: row.sitemap_source,
        }),
      );
      return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
    },
  }),

  // A `<loc>` over `INDEXED_URL_MAX` is stored nowhere (it would not fit an
  // index entry), so discovery counts it in `sitemapFacts.overlongLocsSkipped`.
  // That count is one more site finding beside the stored 2,049-2,500 ones.
  defineRule<QueryRule>({
    kind: "query",
    id: TOO_LONG.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: TOO_LONG.severity,
    columns: [
      { key: "sitemap", label: "Sitemap" },
      { key: "loc", label: "Loc" },
      { key: "length", label: "Length" },
      { key: "skipped", label: "Locs Not Stored", optional: true },
      { key: "max", label: "Storage Limit", optional: true },
    ],
    ...copyFor(TOO_LONG.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      const findings = await entryFindings(
        TOO_LONG,
        db,
        crawlId,
        sql`length(j.url) > ${SITEMAP_LOC_MAX}`,
        NO_REASON,
        (row) => ({
          sitemap: row.sitemap_source,
          loc: row.url.slice(0, LOC_EXCERPT),
          length: row.url.length,
        }),
        capsOr(caps),
      );
      const facts = await readSitemapFacts(db, crawlId, TOO_LONG.id);
      if (facts === null || facts.overlongLocsSkipped === 0) return findings;
      // After the truncation note, which rides on the last listed entry.
      return [
        ...findings,
        queryFinding(TOO_LONG, {
          pageId: null,
          pageUrl: null,
          evidence: { skipped: facts.overlongLocsSkipped, max: INDEXED_URL_MAX },
          dedupeKey: "overlong-locs-skipped",
        }),
      ];
    },
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: OVERSIZED.id,
    checkIds: ["CHECK-08"],
    category: CATEGORY,
    severity: OVERSIZED.severity,
    columns: [
      { key: "sitemapUrl", label: "Sitemap" },
      { key: "bytesRead", label: "Bytes Read" },
      { key: "urlsKept", label: "URLs Kept" },
      { key: "max", label: "Size Limit (Bytes)" },
    ],
    ...copyFor(OVERSIZED.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, OVERSIZED.id);
      const facts = await readSitemapFacts(db, crawlId, OVERSIZED.id);
      if (facts === null) return [];
      return facts.oversizedDocs.map((doc) =>
        queryFinding(OVERSIZED, {
          pageId: null,
          pageUrl: null,
          evidence: {
            sitemapUrl: doc.url,
            bytesRead: doc.bytesRead,
            urlsKept: doc.urlsKept,
            max: SITEMAP_MAX_BYTES,
          },
          dedupeKey: doc.url,
        }),
      );
    },
  }),

  // A URL listed in more than one sitemap document. It is crawled once (one
  // `sitemap_urls` row, first source wins) and judged once; the redundancy is
  // what is reported. Grouped on the frontier key, so two spellings of one URL
  // (a fragment) in different documents are one URL; the distinct count is of
  // documents, so a repeat within one document is not a second listing.
  defineRule<QueryRule>({
    kind: "query",
    id: IN_MULTIPLE.id,
    checkIds: ["CHECK-08"],
    category: CATEGORY,
    severity: IN_MULTIPLE.severity,
    columns: [
      { key: "url", label: "URL" },
      { key: "sitemaps", label: "Sitemaps" },
      { key: "count", label: "Sitemap Count" },
      { key: "membershipLimited", label: "Membership Cap Reached", optional: true },
    ],
    ...copyFor(IN_MULTIPLE.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps): Promise<Finding[]> => {
      await readCrawlEvidence(db, crawlId, IN_MULTIPLE.id);
      const facts = await readSitemapFacts(db, crawlId, IN_MULTIPLE.id);
      if (facts === null) return [];
      const result = await db.execute<{
        url: string;
        sitemaps: string[];
        sitemap_count: number;
        page_id: string | null;
        page_url: string | null;
        total_matches: number;
      }>(sql`
        with multi as (
          select m.url_normalised, min(m.url) as url,
                 (array_agg(distinct m.sitemap_source order by m.sitemap_source))
                   [1:${sql.raw(String(IN_MULTIPLE_LISTED))}] as sitemaps,
                 count(distinct m.sitemap_source)::int as sitemap_count
          from sitemap_memberships m
          where m.crawl_id = ${crawlId}
          group by m.url_normalised
          having count(distinct m.sitemap_source) > 1
        )
        select x.url, x.sitemaps, x.sitemap_count, p.id as page_id, p.url as page_url,
               count(*) over ()::int as total_matches
        from multi x
        left join pages p on p.crawl_id = ${crawlId} and p.url = x.url_normalised
        order by x.url
        ${limitTo(capsOr(caps).listing)}`);
      const findings = result.rows.map((row) =>
        queryFinding(IN_MULTIPLE, {
          pageId: row.page_id,
          pageUrl: row.page_url ?? row.url,
          evidence: {
            url: row.url,
            sitemaps: row.sitemaps,
            count: row.sitemap_count,
            ...(facts.membershipLimited ? { membershipLimited: true } : {}),
          },
          dedupeKey: row.url,
        }),
      );
      return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
    },
  }),

  // The scheme AND host (with any port) of the `<loc>` against the document's
  // own AND the crawled site's origin (`crawls.site_url`), from the
  // `^[a-zA-Z]+://[^/]+` prefix, lower-cased in SQL. The protocol requires a
  // `<loc>` to share its document's location, except that a document on host A
  // may list host B's URLs when B's robots.txt declares it. This engine only
  // reaches a sitemap through the crawled site's robots.txt (or its own
  // /sitemap.xml and index children), so a document elsewhere that lists URLs on
  // the CRAWLED SITE's origin is that allowed cross-submission and is not
  // reported. `www.`, a port or http against https is a different host here, as
  // it is to a search engine.
  defineRule<QueryRule>({
    kind: "query",
    id: CROSS_HOST.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: CROSS_HOST.severity,
    columns: [
      { key: "sitemap", label: "Sitemap" },
      { key: "loc", label: "Loc" },
    ],
    ...copyFor(CROSS_HOST.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      entryFindings(
        CROSS_HOST,
        db,
        crawlId,
        sql`lower(substring(j.url from '^[a-zA-Z]+://[^/]+'))
              <> lower(substring(j.sitemap_source from '^[a-zA-Z]+://[^/]+'))
            and lower(substring(j.url from '^[a-zA-Z]+://[^/]+'))
              <> lower(substring(j.site_url from '^[a-zA-Z]+://[^/]+'))`,
        NO_REASON,
        (row) => ({ sitemap: row.sitemap_source, loc: row.url }),
        capsOr(caps),
      ),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: LASTMOD.id,
    checkIds: ["CHECK-07"],
    category: CATEGORY,
    severity: LASTMOD.severity,
    columns: [
      { key: "sitemap", label: "Sitemap" },
      { key: "loc", label: "Loc" },
      { key: "lastmod", label: "Lastmod" },
      { key: "reason", label: "Reason" },
    ],
    ...copyFor(LASTMOD.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId, caps) => {
      await assertLastmodReference(db, crawlId);
      return entryFindings(
        LASTMOD,
        db,
        crawlId,
        sql`j.reason is not null`,
        LASTMOD_REASON,
        (row) => ({
          sitemap: row.sitemap_source,
          loc: row.url,
          lastmod: row.lastmod,
          reason: row.reason,
        }),
        capsOr(caps),
      );
    },
  }),
];
