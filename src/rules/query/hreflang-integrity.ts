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
import { POSSIBLY_CAPPED_PAGES, sitemapHreflangCutShort } from "./hreflang-completeness.js";
import { SAMPLE_SOURCES } from "./link-targets.js";
import { sitemapFactsRecorded, v2Gate, v3Gate } from "./page-facts.js";

const CATEGORY = "hreflang";

const RETURN_CODE: RuleIdentity = { id: "hreflang.inconsistent-return-code", severity: "warning" };
const MULTIPLE: RuleIdentity = { id: "hreflang.multiple-entries", severity: "warning" };
const SELF_ONLY: RuleIdentity = { id: "hreflang.self-only", severity: "info" };
const LANG_MISMATCH: RuleIdentity = { id: "hreflang.html-lang-mismatch", severity: "info" };
const UNLINKED: RuleIdentity = { id: "hreflang.unlinked-target", severity: "info" };
const SOURCE_CONFLICT: RuleIdentity = { id: "hreflang.source-conflict", severity: "warning" };

/**
 * Codes `hreflang.source-conflict` lists per source under `onlyIn` before it
 * stops naming them; `onlyInTruncated` then carries the exact count. A site
 * annotates a page in a dozen or so locales, so this is room for every one of
 * them on an ordinary site and a bound on a broken template.
 */
export const ONLY_IN_CODES_CAP = 20;

// --------------------------------------------------------------------------
// THE COHORT, shared by the six rules (Phase 26a Task 6, widened in 26c).
//
// The declarations of auditable pages, FROM EVERY SOURCE: the page's HTML
// (`html`), its HTTP `Link` header (`header`) and the sitemap entry that lists
// it (`sitemap`, tied to the page by `deriveSitemapHreflang`). Search engines
// read all three and union them, so a page's hreflang is what the three say
// together, and a rule that read one of them would judge a set the engine never
// sees. The declaring page is fetched OK as a 200 and not canonicalised
// elsewhere: the cohort `hreflang.ts` documents for its own rules (a
// canonicalised page is invisible to hreflang on both sides of every
// relationship).
//
// One row per (page, code, target URL), with `sources` the sorted distinct
// sources that state it. The `hreflang` table has no unique key and repeats
// are ordinary (a template emitting its block twice, a pair in the HTML and in
// the sitemap), so grouping here is what keeps a repeat from counting as a
// second declaration. A rule that needs one source at a time
// (`hreflang.multiple-entries`, `hreflang.source-conflict`) unnests `sources`;
// every other rule reads the union.
//
// Codes are compared as `replace(lower(btrim(code)), '_', '-')` and targets on
// `URL_MATCH_KEY`, so `en-GB`, `en-gb ` and `en_GB` are one code (whether the
// underscore is a valid spelling is `hreflang.invalid-code`'s question, not
// these rules'), and a fragment, a host in capitals, a query in another order
// or a bare origin against a root slash are one target. A path with and
// without a trailing slash is NOT one target: `normalizeUrl`, and so the
// crawl, treats `/a` and `/a/` as two URLs with two `pages` rows.
//
// It is SQL end to end (hard rule 3): the `hreflang` and `links` tables are
// grouped in Postgres and each rule's result is capped at `caps.listing` with
// the exact total beside it, so RAM is O(cap), never O(declarations).
// --------------------------------------------------------------------------
const DECLARATIONS = (crawlId: string): SQL => sql`
  decl as (
    select r.page_id, r.page_url, ${URL_MATCH_KEY("r.page_url")} as page_key,
           r.code, r.target_url, ${URL_MATCH_KEY("r.target_url")} as target_key,
           array_agg(distinct r.source order by r.source) as sources
    from (
      select h.page_id, p.url as page_url,
             replace(lower(btrim(h.hreflang_code)), '_', '-') as code,
             h.target_url, h.source
      from hreflang h
      join pages p on p.id = h.page_id and p.crawl_id = h.crawl_id
      where h.crawl_id = ${crawlId}
        and ${FETCHED_OK("p")} and not ${CANONICALISED_ELSEWHERE("p")}
    ) r
    group by r.page_id, r.page_url, r.code, r.target_url
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
 * One finding per (A, B) pair, filed on A; `sources` are the sources of A's
 * declarations of B, so the reader knows where the code A lists lives.
 */
async function returnCodeFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    target_url: string;
    listed: string[];
    returned: string[];
    self_codes: string[];
    sources: string[];
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
               filter (where r.code <> ${X_DEFAULT}) as returned,
             array_agg(distinct asrc.source order by asrc.source) as sources
      from decl a
      cross join lateral unnest(a.sources) as asrc(source)
      join pages b on b.crawl_id = ${crawlId}
        and ${URL_MATCH_KEY("b.url")} = a.target_key and b.id <> a.page_id
      join decl r on r.page_id = b.id and r.target_key = a.page_key
      where not ${ROBOTS_BLOCKED("b")} and not ${CANONICALISED_ELSEWHERE("b")}
      group by a.page_id, a.page_url, b.id, b.url
    ),
    hits as (
      select p.page_id, p.page_url, p.target_url, p.listed, p.returned,
             s.codes as self_codes, p.sources, count(*) over ()::int as total_matches
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
        sources: row.sources,
      },
      dedupeKey: `${row.page_url}→${row.target_url}`,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * One page listing one code for two or more different URLs IN ONE SOURCE.
 *
 * A code names one version of the page: `en` for two addresses leaves the
 * engine to pick one, or to drop both. Two spellings of one URL are one target
 * (the match key), and one URL under several codes is the ordinary `en` plus
 * `x-default` block, so only DISTINCT targets under ONE code count. `x-default`
 * is a code like any other here: two fallbacks is the same fault.
 *
 * PER SOURCE (Phase 26c, deviation 5): the HTML, the `Link` header and the
 * sitemap are each read on their own. One source giving a code two URLs is
 * this rule's finding; two sources giving it one URL each disagree with EACH
 * OTHER, which is `hreflang.source-conflict`'s, so that defect never fires
 * both rules.
 *
 * One finding per (page, code), filed on the page, however many sources repeat
 * the fault. The evidence lists the targets of the offending sources sorted,
 * each shown as the least spelling used for it, and `sources` names those
 * sources.
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
    sources: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    per_target as (
      select d.page_id, d.page_url, d.code, s.source, d.target_key,
             min(d.target_url) as shown
      from decl d
      cross join lateral unnest(d.sources) as s(source)
      group by d.page_id, d.page_url, d.code, s.source, d.target_key
    ),
    offending as (
      select page_id, code, source
      from per_target
      group by page_id, code, source
      having count(*) >= 2
    ),
    offending_targets as (
      select t.page_id, t.page_url, t.code, t.target_key, min(t.shown) as shown
      from per_target t
      join offending o on o.page_id = t.page_id and o.code = t.code and o.source = t.source
      group by t.page_id, t.page_url, t.code, t.target_key
    ),
    offending_sources as (
      select page_id, code, array_agg(source order by source) as sources
      from offending
      group by page_id, code
    ),
    hits as (
      select t.page_id, t.page_url, t.code, array_agg(t.shown order by t.shown) as targets,
             os.sources, count(*) over ()::int as total_matches
      from offending_targets t
      join offending_sources os on os.page_id = t.page_id and os.code = t.code
      group by t.page_id, t.page_url, t.code, os.sources
    )
    select * from hits order by page_url, code ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(MULTIPLE, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { hreflang: row.code, targets: row.targets, sources: row.sources },
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
 *
 * The union of the sources is judged: a page whose HTML names only itself and
 * whose sitemap entry names its French version declares an alternate. `sources`
 * names every source that annotated the page.
 *
 * It reads an ABSENCE (no alternate), so it refuses a crawl whose sitemap walk
 * was cut short, where a page's sitemap alternates may never have been read,
 * and skips a page with `MAX_HREFLANG_PAIRS` or more declarations from one
 * source, whose alternates may have been the pairs not kept (PR #24 review;
 * `hreflang.declarations-incomplete` speaks for both).
 */
async function selfOnlyFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  if (await sitemapHreflangCutShort(db, crawlId, SELF_ONLY.id)) return [];
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    codes: string[];
    sources: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    hits as (
      select d.page_id, d.page_url, array_agg(distinct d.code order by d.code) as codes,
             array_agg(distinct s.source order by s.source) as sources,
             count(*) over ()::int as total_matches
      from decl d
      cross join lateral unnest(d.sources) as s(source)
      where d.page_id not in (${POSSIBLY_CAPPED_PAGES(crawlId)})
      group by d.page_id, d.page_url, d.page_key
      having bool_and(d.target_key = d.page_key)
    )
    select * from hits order by page_url ${limitTo(caps.listing)}`);

  const findings = result.rows.map((row) =>
    queryFinding(SELF_ONLY, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: { hreflang: row.codes, sources: row.sources },
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
 * The page's SELF codes are its hreflang codes whose target is the page itself
 * (the cohort above), `x-default` excluded, FROM EVERY SOURCE: a self code the
 * sitemap or the `Link` header states is the same claim about the page's
 * language as one in its HTML, and search engines act on it, so `<html lang>`
 * disagreeing with it is the same fault. `sources` names where the self codes
 * were stated. Only the PRIMARY
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
    sources: string[];
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    self_codes as (
      select d.page_id, array_agg(distinct d.code order by d.code) as codes,
             array_agg(distinct src.source order by src.source) as sources
      from decl d
      cross join lateral unnest(d.sources) as src(source)
      where d.target_key = d.page_key and d.code <> ${X_DEFAULT}
      group by d.page_id
    ),
    hits as (
      select p.id as page_id, p.url as page_url, p.html_lang, s.codes, s.sources,
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
      evidence: { htmlLang: row.html_lang, hreflangCodes: row.codes, sources: row.sources },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * A page whose hreflang sources disagree about where a language lives
 * (Phase 26c, CHECK-24).
 *
 * A page can be annotated three ways at once: its HTML, its HTTP `Link` header
 * and its sitemap entry. Search engines read all three and union them, so when
 * the HTML says `de` is `/de/` and the sitemap says `de` is `/de-de/`, the page
 * declares two German versions and the cluster is ambiguous. The usual cause is
 * two generators (a CMS template and a sitemap plugin) fed from two mappings.
 *
 * WHAT CONFLICTS (deviation 4): one normalised code (the cohort's
 * `replace(lower(btrim(code)), '_', '-')`, `x-default` included) whose TARGET
 * SET differs between two sources that both list it, targets compared on
 * `URL_MATCH_KEY`. A code one source lists and another omits is NOT a
 * conflict: the union is what the engine reads, and a sitemap carrying more
 * locales than the template is ordinary. Those codes are reported as
 * information (`onlyIn`) on a page that does conflict, never as a finding of
 * their own. One source giving a code two or more targets is
 * `hreflang.multiple-entries`' (deviation 5), so only the sources that give
 * the code EXACTLY ONE target are compared here: the HTML naming `/de` and
 * `/de-2` beside a sitemap naming `/de` is one defect (the HTML's ambiguity),
 * reported once by that rule, and removing `/de-2` clears it. Two single-target
 * sources naming different URLs conflict whatever a third, ambiguous source
 * says.
 *
 * The page must be annotated by at least two sources, which a conflicting code
 * implies. The cohort is the declaring pages of `DECLARATIONS` (fetched OK, a
 * 200, not canonicalised elsewhere). Repeats never count: the cohort holds one
 * row per (page, code, target) and `deriveSitemapHreflang` writes the
 * sitemap's pairs distinct, so a sitemap listing a URL twice is one source
 * stating one set.
 *
 * GATED twice, and both gates refuse rather than judge: `v3Gate`, because the
 * header source exists only on extraction 3 rows, and `sitemapFactsRecorded`,
 * because a crawl whose discovery predates 26c staged no sitemap alternates. A
 * page in either crawl could only ever look single-sourced, which is silence
 * that reads as "no conflict"; `extraction.not-recorded` speaks instead.
 *
 * One finding per page, filed on it, capped at `caps.listing` with the exact
 * total. The evidence carries the FIRST conflicting code (by code) with each
 * listing source's targets (`bySource`, sources and targets sorted), how many
 * codes conflict (`conflictingCodes`), and `onlyIn`: the codes only one source
 * gives, per source, at most `ONLY_IN_CODES_CAP` each, with `onlyInTruncated`
 * when that cut anything. SQL end to end: the per-source sets are grouped in
 * Postgres and only the capped page list is shaped into evidence.
 */
async function sourceConflictFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const gate = await v3Gate(db, crawlId);
  if (!gate.recorded) return [];
  if (!(await sitemapFactsRecorded(db, crawlId))) return [];

  const result = await db.execute<{
    page_id: string;
    page_url: string;
    first_code: string;
    conflicting_codes: number;
    by_source: Array<{ source: string; targets: string[] }>;
    only_in: Array<{ source: string; codes: string[] }>;
    only_in_reported: number;
    only_in_total: number;
    total_matches: number;
  }>(sql`
    with ${DECLARATIONS(crawlId)},
    by_source as (
      select d.page_id, d.code, s.source,
             array_agg(distinct d.target_key order by d.target_key) as keys
      from decl d
      cross join lateral unnest(d.sources) as s(source)
      group by d.page_id, d.code, s.source
    ),
    per_code as (
      select page_id, code, count(*)::int as source_count,
             -- Single-target sources only: an ambiguous source is
             -- multiple-entries' finding, never this one's (deviation 5).
             count(distinct keys) filter (where cardinality(keys) = 1)::int as set_count
      from by_source
      group by page_id, code
    ),
    hits as (
      select c.page_id, p.url as page_url, min(c.code) as first_code,
             count(*)::int as conflicting_codes,
             count(*) over ()::int as total_matches
      from per_code c
      join pages p on p.id = c.page_id and p.crawl_id = ${crawlId}
      where c.set_count >= 2
      group by c.page_id, p.url
      order by p.url
      ${limitTo(caps.listing)}
    ),
    first_targets as (
      select h.page_id, s.source, d.target_key, min(d.target_url) as shown
      from hits h
      join decl d on d.page_id = h.page_id and d.code = h.first_code
      cross join lateral unnest(d.sources) as s(source)
      group by h.page_id, s.source, d.target_key
    ),
    first_by_source as (
      select page_id,
             jsonb_agg(jsonb_build_object('source', source, 'targets', targets)
                       order by source) as by_source
      from (
        select page_id, source, array_agg(shown order by shown) as targets
        from first_targets
        group by page_id, source
      ) t
      group by page_id
    ),
    only_in_ranked as (
      select b.page_id, b.source, b.code,
             row_number() over (partition by b.page_id, b.source order by b.code) as rn
      from by_source b
      join hits h on h.page_id = b.page_id
      join per_code c on c.page_id = b.page_id and c.code = b.code and c.source_count = 1
    ),
    only_in as (
      select page_id,
             jsonb_agg(jsonb_build_object('source', source, 'codes', codes)
                       order by source) as only_in,
             sum(listed)::int as reported, sum(total)::int as total
      from (
        select page_id, source,
               array_agg(code order by code) filter (where rn <= ${ONLY_IN_CODES_CAP}) as codes,
               count(*) filter (where rn <= ${ONLY_IN_CODES_CAP}) as listed,
               count(*) as total
        from only_in_ranked
        group by page_id, source
      ) o
      group by page_id
    )
    select h.page_id, h.page_url, h.first_code, h.conflicting_codes, h.total_matches,
           f.by_source,
           coalesce(o.only_in, '[]'::jsonb) as only_in,
           coalesce(o.reported, 0) as only_in_reported,
           coalesce(o.total, 0) as only_in_total
    from hits h
    join first_by_source f on f.page_id = h.page_id
    left join only_in o on o.page_id = h.page_id
    order by h.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(SOURCE_CONFLICT, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: {
        code: row.first_code,
        bySource: row.by_source,
        conflictingCodes: row.conflicting_codes,
        onlyIn: row.only_in,
        // Named for the LIST it describes, not `truncated`, which is what a
        // capped listing of findings writes (the `hostsTruncated` precedent).
        ...(row.only_in_total > row.only_in_reported
          ? { onlyInTruncated: { reported: row.only_in_reported, total: row.only_in_total } }
          : {}),
      },
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
      { key: "sources", label: "Declaration Source" },
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
      { key: "sources", label: "Declaration Source" },
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
      { key: "sources", label: "Declaration Source" },
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
    columns: [
      { key: "hreflang", label: "hreflang" },
      { key: "sources", label: "Declaration Source" },
    ],
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

  defineRule<QueryRule>({
    kind: "query",
    id: SOURCE_CONFLICT.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: SOURCE_CONFLICT.severity,
    columns: [
      { key: "code", label: "hreflang" },
      { key: "bySource", label: "Alternate URLs by Source" },
      { key: "conflictingCodes", label: "Conflicting Codes" },
      { key: "onlyIn", label: "Codes in One Source Only" },
      { key: "onlyInTruncated", label: "Codes in One Source Truncated", optional: true },
    ],
    ...copyFor(SOURCE_CONFLICT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => sourceConflictFindings(db, crawlId, capsOr(caps)),
  }),
];
