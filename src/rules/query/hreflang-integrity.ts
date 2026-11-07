import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import {
  CANONICALISED_ELSEWHERE,
  FETCHED_OK,
  queryFinding,
  ROBOTS_BLOCKED,
  URL_MATCH_KEY,
  type RuleIdentity,
} from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { SAMPLE_SOURCES } from "./link-targets.js";
import { v2Gate } from "./page-facts.js";

const CATEGORY = "hreflang";

const RETURN_CODE: RuleIdentity = { id: "hreflang.inconsistent-return-code", severity: "warning" };
const MULTIPLE: RuleIdentity = { id: "hreflang.multiple-entries", severity: "warning" };
const SELF_ONLY: RuleIdentity = { id: "hreflang.self-only", severity: "info" };
const LANG_MISMATCH: RuleIdentity = { id: "hreflang.html-lang-mismatch", severity: "info" };
const UNLINKED: RuleIdentity = { id: "hreflang.unlinked-target", severity: "info" };

// --------------------------------------------------------------------------
// THE COHORT, shared by the four rules (Phase 26a Task 6).
//
// The declarations of auditable pages: `source = 'html'`, the declaring page
// fetched OK as a 200 and not canonicalised elsewhere. It is the cohort
// `hreflang.ts` documents for its own rules (a canonicalised page is invisible
// to hreflang on both sides of every relationship), narrowed to the HTML source
// because a sitemap or header annotation is not a thing a template emitted and
// is judged by the rules that own those sources (26c widens this).
//
// Codes are compared as `lower(btrim(code))` and targets on `URL_MATCH_KEY`, so
// `en-GB` and `en-gb ` are one code, and a fragment, a host in capitals, a
// query in another order or a bare origin against a root slash are one target.
// A path with and without a trailing slash is NOT one target: `normalizeUrl`,
// and so the crawl, treats `/a` and `/a/` as two URLs with two `pages` rows.
//
// It is SQL end to end (hard rule 3): the `hreflang` and `links` tables are
// grouped in Postgres and each rule's result is capped at `caps.listing` with
// the exact total beside it, so RAM is O(cap), never O(declarations).
// --------------------------------------------------------------------------
const DECLARATIONS = (crawlId: string): SQL => sql`
  decl as (
    select h.page_id, p.url as page_url, ${URL_MATCH_KEY("p.url")} as page_key,
           lower(btrim(h.hreflang_code)) as code, h.target_url,
           ${URL_MATCH_KEY("h.target_url")} as target_key
    from hreflang h
    join pages p on p.id = h.page_id and p.crawl_id = h.crawl_id
    where h.crawl_id = ${crawlId} and h.source = 'html'
      and ${FETCHED_OK("p")} and not ${CANONICALISED_ELSEWHERE("p")}
  )`;

/** `x-default` is a fallback, not a language: the code rules never read it as one. */
const X_DEFAULT = "x-default";

/**
 * Pairs (A, B) where A lists B, B lists A back, and the two disagree about A's
 * language.
 *
 * A's SELF code is the code A uses for its own URL; the RETURN code is the code
 * B uses for A. They are the same fact stated by two pages, and a cluster whose
 * pages disagree is one a search engine may discard. A page with no
 * self-reference has no code to compare, so it is not judged here
 * (`hreflang.missing-self-reference` owns it), and neither is a pair where B
 * does not return A (`hreflang.missing-return-link`) or B was never crawled.
 *
 * `x-default` is left out of both sides: A naming itself `x-default` and B
 * returning A as `x-default` is the ordinary fallback block, not a language.
 * When A (or B) uses several language codes for the pair, the pair disagrees
 * only if the two sets share none, so a page that is both `en` and `en-gb` is
 * not reported against a return link that says `en`.
 *
 * B must be a cluster member the crawl can read: fetched OK, not robots-blocked,
 * not canonicalised elsewhere (the declaration cohort above, applied to B).
 * One finding per (A, B) pair, filed on A.
 */
async function returnCodeFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    target_url: string;
    listed: string[];
    returned: string[];
    self_codes: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    self_codes as (
      select page_id, array_agg(distinct code order by code) as codes
      from decl
      where target_key = page_key and code <> ${X_DEFAULT}
      group by page_id
    ),
    pairs as (
      select a.page_id, a.page_url, b.url as target_url,
             array_agg(distinct a.code order by a.code) as listed,
             array_agg(distinct r.code order by r.code)
               filter (where r.code <> ${X_DEFAULT}) as returned
      from decl a
      join pages b on b.crawl_id = ${crawlId}
        and ${URL_MATCH_KEY("b.url")} = a.target_key and b.id <> a.page_id
      join decl r on r.page_id = b.id and r.target_key = a.page_key
      where not ${ROBOTS_BLOCKED("b")} and not ${CANONICALISED_ELSEWHERE("b")}
      group by a.page_id, a.page_url, b.id, b.url
    ),
    hits as (
      select p.page_id, p.page_url, p.target_url, p.listed, p.returned,
             s.codes as self_codes, count(*) over ()::int as total_matches
      from pairs p
      join self_codes s on s.page_id = p.page_id
      where p.returned is not null and not (p.returned && s.codes)
    )
    select * from hits order by page_url, target_url ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(RETURN_CODE, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: {
        hreflang: row.listed,
        target: row.target_url,
        returnCode: row.returned,
        selfCode: row.self_codes,
      },
      dedupeKey: `${row.page_url}→${row.target_url}`,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * One page listing one code for two or more different URLs.
 *
 * A code names one version of the page: `en` for two addresses leaves the
 * engine to pick one, or to drop both. Two spellings of one URL are one target
 * (the match key), and one URL under several codes is the ordinary `en` plus
 * `x-default` block, so only DISTINCT targets under ONE code count. `x-default`
 * is a code like any other here: two fallbacks is the same fault.
 *
 * One finding per (page, code), filed on the page; the evidence lists the
 * targets sorted, each shown as the least spelling the page used for it.
 */
async function multipleEntriesFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    code: string;
    targets: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    per_target as (
      select page_id, page_url, code, target_key, min(target_url) as shown
      from decl
      group by page_id, page_url, code, target_key
    ),
    hits as (
      select page_id, page_url, code, array_agg(shown order by shown) as targets,
             count(*) over ()::int as total_matches
      from per_target
      group by page_id, page_url, code
      having count(*) >= 2
    )
    select * from hits order by page_url, code ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(MULTIPLE, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { hreflang: row.code, targets: row.targets },
      dedupeKey: `${row.page_url}#${row.code}`,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * A page whose every hreflang declaration names the page itself.
 *
 * That is an annotation block that declares no alternate: the template emits
 * `<link rel="alternate" hreflang="en" href="<this page>">` and nothing else,
 * which is valid and says nothing a search engine did not already know. At
 * least one row is required; a page with none declares nothing and is not here.
 */
async function selfOnlyFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    codes: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    hits as (
      select page_id, page_url, array_agg(distinct code order by code) as codes,
             count(*) over ()::int as total_matches
      from decl
      group by page_id, page_url, page_key
      having bool_and(target_key = page_key)
    )
    select * from hits order by page_url ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(SELF_ONLY, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { hreflang: row.codes },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * A crawled alternate that no other page links to: reachable only through the
 * annotation, which search engines treat as a hint and not as a link.
 *
 * THE TARGET is a fetched 200 page the crawl actually requested (not
 * robots-blocked) and not canonicalised elsewhere, named by an hreflang row of
 * the cohort above from a page other than itself. A target the crawl never
 * fetched, or fetched and could not read, is evidence we do not have or a
 * fault other rules own, so it is not judged.
 *
 * "Linked" is a `links` row with `is_internal`, `target_url` equal to the
 * target's URL and a source page that is not the target itself; a page that
 * links only to itself is as unreachable as one nobody links to. The link may
 * come from a declaring page. A link to a URL that redirects to the target does
 * not count, which is the same reading `canonical.unlinked` takes.
 *
 * FILED ON THE TARGET, one finding per target: the unit is the alternate, and
 * the fix (link it from the site) is made once however many pages declare it.
 * `sourceCount` is exact; `sources` are at most `SAMPLE_SOURCES` declaring
 * pages, the first by URL, picked inside a lateral so Postgres never builds the
 * full list. The `targets` CTE is capped at `caps.listing` and the window count
 * before the limit keeps the total exact.
 */
async function unlinkedTargetFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    target_id: string;
    target_url: string;
    source_count: number;
    total_matches: number;
    sample_sources: string[];
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    targets as (
      select t.id as target_id, t.url as target_url, ${URL_MATCH_KEY("t.url")} as target_key,
             count(distinct d.page_id)::int as source_count,
             count(*) over ()::int as total_matches
      from decl d
      join pages t on t.crawl_id = ${crawlId}
        and ${URL_MATCH_KEY("t.url")} = d.target_key and t.id <> d.page_id
      where ${FETCHED_OK("t")} and not ${ROBOTS_BLOCKED("t")}
        and not ${CANONICALISED_ELSEWHERE("t")}
        and not exists (
          select 1 from links l
          where l.crawl_id = ${crawlId} and l.is_internal
            and l.target_url = t.url and l.source_page_id <> t.id
        )
      group by t.id, t.url
      order by t.url
      ${limitTo(caps.listing)}
    ),
    declarers as (
      select distinct d.target_key, d.page_id, d.page_url from decl d
    ),
    ranked as (
      select t.target_id, dr.page_url,
             row_number() over (partition by t.target_id order by dr.page_url) as rn
      from targets t
      join declarers dr on dr.target_key = t.target_key and dr.page_id <> t.target_id
    )
    select t.target_id, t.target_url, t.source_count, t.total_matches,
           coalesce(array_agg(r.page_url order by r.page_url)
                      filter (where r.page_url is not null), array[]::text[])
             as sample_sources
    from targets t
    left join ranked r on r.target_id = t.target_id and r.rn <= ${SAMPLE_SOURCES}
    group by t.target_id, t.target_url, t.source_count, t.total_matches
    order by t.target_url`);

  const findings = result.rows.map((row) =>
    queryFinding(UNLINKED, {
      pageId: row.target_id,
      pageUrl: row.target_url,
      evidence: { sources: row.sample_sources, sourceCount: row.source_count },
      dedupeKey: row.target_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * A page whose `<html lang>` names a different language from the one its own
 * hreflang block gives it (Phase 26b, CHECK-25).
 *
 * Opens with `v2Gate`: `html_lang` exists only on extraction 2 rows, so a crawl
 * not wholly recorded returns `[]` and `extraction.not-recorded` speaks.
 *
 * The page's SELF codes are its html-source hreflang codes whose target is the
 * page itself (the cohort above), `x-default` excluded. Only the PRIMARY
 * language subtag is compared (before the first `-` or `_`, lower-cased, on
 * both sides): `en-US` against `en-gb` agree, and so do `en_US` against
 * `en-us`; `de` against `en` do not. The page fires when it has at least one self
 * code and none of their primary subtags equals `html_lang`'s. A page with no
 * `lang`, or no self code, has nothing to compare and is not this rule's.
 */
async function htmlLangMismatchFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const gate = await v2Gate(db, crawlId);
  if (!gate.recorded) return [];
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    html_lang: string;
    codes: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    self_codes as (
      select page_id, array_agg(distinct code order by code) as codes
      from decl
      where target_key = page_key and code <> ${X_DEFAULT}
      group by page_id
    ),
    hits as (
      select p.id as page_id, p.url as page_url, p.html_lang, s.codes,
             count(*) over ()::int as total_matches
      from self_codes s
      join pages p on p.id = s.page_id and p.crawl_id = ${crawlId}
      where nullif(btrim(p.html_lang), '') is not null
        and not (split_part(replace(lower(btrim(p.html_lang)), '_', '-'), '-', 1) = any (
          select split_part(replace(lower(c), '_', '-'), '-', 1) from unnest(s.codes) as c))
    )
    select * from hits order by page_url ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(LANG_MISMATCH, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { htmlLang: row.html_lang, hreflangCodes: row.codes },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

export const hreflangIntegrityRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: LANG_MISMATCH.id,
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: LANG_MISMATCH.severity,
    columns: [
      { key: "htmlLang", label: "HTML Lang" },
      { key: "hreflangCodes", label: "Self Hreflang" },
    ],
    ...copyFor(LANG_MISMATCH.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => htmlLangMismatchFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: RETURN_CODE.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: RETURN_CODE.severity,
    columns: [
      { key: "hreflang", label: "hreflang" },
      { key: "target", label: "Alternate URL" },
      { key: "returnCode", label: "Return hreflang" },
      { key: "selfCode", label: "Self hreflang" },
    ],
    ...copyFor(RETURN_CODE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => returnCodeFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: MULTIPLE.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: MULTIPLE.severity,
    columns: [
      { key: "hreflang", label: "hreflang" },
      { key: "targets", label: "Alternate URLs" },
    ],
    ...copyFor(MULTIPLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => multipleEntriesFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: SELF_ONLY.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: SELF_ONLY.severity,
    columns: [{ key: "hreflang", label: "hreflang" }],
    ...copyFor(SELF_ONLY.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => selfOnlyFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: UNLINKED.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: UNLINKED.severity,
    columns: [
      { key: "sources", label: "Declaring Pages" },
      { key: "sourceCount", label: "Declaring Pages Count" },
    ],
    ...copyFor(UNLINKED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => unlinkedTargetFindings(db, crawlId, capsOr(caps)),
  }),
];
