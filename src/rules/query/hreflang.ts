import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import {
  CANONICALISED_ELSEWHERE,
  FETCHED_OK,
  isAuditable,
  isCanonicalisedElsewhere,
  queryFinding,
  ROBOTS_BLOCKED,
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
import { capsOr, noteAtLeastTruncation, noteTruncation } from "./crawl-evidence.js";

/**
 * BCP-47-lite: a 2–3 letter language, optionally followed by a region that is
 * either two letters (a country) or three digits (a UN M.49 area). Deliberately
 * narrower than the full BCP-47 grammar — scripts and variants are vanishingly
 * rare in hreflang and a false "invalid" is worse than a missed exotic code.
 * `x-default` is the one special value and is checked separately.
 *
 * This is a test of FORM ONLY; there is no ISO membership check, so a
 * well-formed but nonexistent code (`en-XX`, `zz`) passes. Shipping the ISO
 * 639/3166 tables to catch it would mean keeping them current, and the far
 * commoner mistake — `en_GB`, `english`, `en-UK` — is a shape this catches.
 */
const HREFLANG_CODE = /^[a-z]{2,3}(-(?:[a-z]{2}|\d{3}))?$/i;

const CATEGORY = "hreflang";

/** Pages read per round trip by the declaration-set walk (the memory contract). */
export const HREFLANG_PAGE_BATCH = 200;

/** URLs per `= any(...)` lookup when the x-default sets are attributed. */
const MEMBER_LOOKUP_BATCH = 500;

const INVALID_CODE: RuleIdentity = { id: "hreflang.invalid-code", severity: "critical" };
const X_DEFAULT: RuleIdentity = { id: "hreflang.missing-x-default", severity: "info" };
const RETURN_LINK: RuleIdentity = { id: "hreflang.missing-return-link", severity: "critical" };
const NON_INDEXABLE: RuleIdentity = { id: "hreflang.non-indexable-target", severity: "critical" };
const SELF_REFERENCE: RuleIdentity = { id: "hreflang.missing-self-reference", severity: "warning" };
const NOT_CRAWLED: RuleIdentity = { id: "hreflang.alternates-not-crawled", severity: "info" };

/**
 * Target hosts the not-crawled marker lists before it stops naming them. The
 * COUNT it reports is over every host; only the list is cut.
 *
 * A site with an alternate per market has a handful of hosts, so this is
 * insurance against a broken template naming a different host per page rather
 * than a budget anyone is expected to reach.
 */
export const ALTERNATE_HOST_CAP = 50;

// --------------------------------------------------------------------------
// WHY EVERY RULE IN THIS FILE SKIPS A CANONICALISED PAGE (Phase 19 §4).
//
// A page whose declared canonical names another URL is asking search engines to
// treat that other URL as the real one, and hreflang is evaluated on the
// canonical: the annotations on such a page are not annotations anyone acts on.
// On the crawl that motivated this, both missing-return-link findings were a
// `?product-type=…` and a `?srsltid=…` variant that inherited its template's
// hreflang block — the block names the base URL, and the base URL, correctly,
// does not name the tracking variant back. Reporting that is reporting the
// canonical's own remedy as a fault.
//
// This file therefore reached Phase 22 §1's cohort under its own steam, and
// keeps `FETCHED_OK` plus that exclusion rather than adopting `JUDGED`: an
// hreflang annotation is worth reading on a page that carries a noindex — the
// cluster it belongs to is still real, and `hreflang.non-indexable-target` is
// the rule whose whole subject is an alternate in exactly that state.
//
// So a canonicalised page is invisible to hreflang ENTIRELY, on both sides of
// every relationship:
//
//  - as a DECLARER, its set is dropped before any rule sees it;
//  - as a TARGET, it is not a member of anyone's cluster — which is what the
//    return-link rule needs, since demanding a link back from a page whose own
//    annotations we have decided to ignore is incoherent.
//
// Nothing is lost by the second half: a canonicalised alternate that is also
// broken is reported where it belongs, on that page, by `canonical.*`,
// `directive.canonical-noindex-conflict` and the crawl's own fetch evidence.
// --------------------------------------------------------------------------

/**
 * The comparison key for an hreflang target.
 *
 * `hreflang.target_url` is already absolute — `PageWriter` resolves each href
 * against the page URL before storing it — but it is a plain `new URL()` href,
 * while `pages.url` is `normalizeUrl` output. The two agree on almost every
 * URL and disagree on the three things `normalizeUrl` settles: a fragment,
 * query-parameter order, and host case. Both sides of every comparison below
 * therefore go through this function, so a `#anchor` on an alternate does not
 * turn a crawled target into an uncrawled one.
 *
 * A target `normalizeUrl` refuses (a `mailto:` or `javascript:` href that
 * resolved to a non-HTTP URL) keeps its stored form rather than disappearing:
 * it cannot match a `pages` row, which is correct, and it is still a member of
 * its declaration set, which is also correct.
 */
function targetKey(target: string): string {
  return normalizeUrl(target) ?? target;
}

function isXDefault(code: string): boolean {
  return code.trim().toLowerCase() === "x-default";
}

/**
 * One page's hreflang declarations: the cluster that page names.
 *
 * `targets` is the distinct, sorted comparison keys — two codes naming one URL
 * are one member of the cluster and one relationship to judge, so the rules
 * work from this rather than from the raw declaration rows.
 *
 * Every source is read (HTML, `Link` header, sitemap): the set is their union,
 * which is what a search engine reads. Where each declaration came from is
 * kept beside it, because a finding about a declaration is fixed where the
 * declaration lives (Phase 26c).
 */
interface DeclarationSet {
  pageId: string;
  pageUrl: string;
  /** The comparison key for `pageUrl`. */
  pageKey: string;
  targets: string[];
  /** The distinct declared codes, trimmed and sorted — the evidence's `codes`. */
  codes: string[];
  /** The distinct sources of every declaration in the set, sorted. */
  sources: string[];
  /** Per target key, the distinct sources that name it, sorted. */
  sourcesByTarget: ReadonlyMap<string, string[]>;
  hasXDefault: boolean;
  /** `isAuditable` for the DECLARING page: fetched OK as HTML with a 200. */
  auditable: boolean;
}

/**
 * A crawled page an alternate points at — one that is a cluster member, so a
 * page canonicalised elsewhere is never one of these (see the note above the
 * declaration types).
 */
interface TargetPage {
  id: string;
  url: string;
  fetchClass: string;
  statusCode: number | null;
  isIndexable: boolean | null;
}

/**
 * What one batch of declaration sets needs to know about the pages it points
 * at. Empty when the walk was asked not to look targets up.
 */
interface TargetContext {
  /** The crawled page for a target key, or undefined when it was never fetched. */
  page: (target: string) => TargetPage | undefined;
  /** The target keys that crawled page itself declares — empty when it declares none. */
  declares: (target: string) => ReadonlySet<string>;
}

const NO_TARGETS: ReadonlySet<string> = new Set<string>();

/**
 * Walk the crawl's hreflang declarations, one page's set at a time.
 *
 * Batched by PAGE rather than by row, because a set is only judgeable whole: a
 * batch that split a page's declarations in half would report a cluster as
 * missing an x-default it declares in the next batch. The `distinct page_id`
 * sub-select is what makes the boundary land between pages.
 *
 * With `withTargets`, each batch also resolves what its targets are — the
 * `pages` row behind each one, and the declarations that page makes back — in
 * two queries for the whole batch. Nothing outlives its batch, so RAM is
 * O(batch × declarations per page), not O(URLs).
 */
async function eachDeclarationSet(
  db: Db,
  crawlId: string,
  opts: { withTargets: boolean },
  /**
   * Returning `"stop"` ends the walk after this set — for the caller whose
   * accumulator cannot go on bounded (see `missingXDefaultFindings`). A caller
   * that can count past its cap returns nothing and gets the whole crawl.
   */
  visit: (set: DeclarationSet, targets: TargetContext) => void | "stop",
): Promise<void> {
  let cursor = "";
  for (;;) {
    // The page ids first, and the cursor advanced from them, so a page id whose
    // `pages` row is missing (see PageWriter's insert race) costs its own
    // declarations and not the rest of the walk.
    const ids = await db.execute<{ page_id: string }>(sql`
      select distinct h.page_id
      from hreflang h
      where h.crawl_id = ${crawlId} and h.page_id > ${cursor}
      order by h.page_id
      limit ${HREFLANG_PAGE_BATCH}`);
    if (ids.rows.length === 0) return;
    const pageIds = ids.rows.map((r) => String(r.page_id));
    cursor = pageIds[pageIds.length - 1]!;

    const rows = await db.execute<{
      page_id: string;
      page_url: string;
      fetch_class: string;
      status_code: number | null;
      canonical_html: string | null;
      canonical_header: string | null;
      hreflang_code: string;
      target_url: string;
      source: string;
    }>(sql`
      select h.page_id, p.url as page_url, p.fetch_class, p.status_code,
             p.canonical_html, p.canonical_header,
             h.hreflang_code, h.target_url, h.source
      from hreflang h
      join pages p on p.id = h.page_id
      where h.crawl_id = ${crawlId}
        and h.page_id = any(${sql.param(pageIds)}::text[])`);

    const sets = new Map<string, DeclarationSet>();
    const members = new Map<string, Map<string, Set<string>>>();
    const codes = new Map<string, Set<string>>();
    /** Declaring pages dropped as canonicalised elsewhere, so the test runs once each. */
    const invisible = new Set<string>();
    for (const row of rows.rows) {
      const pageId = String(row.page_id);
      if (invisible.has(pageId)) continue;
      let set = sets.get(pageId);
      if (set === undefined) {
        const pageUrl = String(row.page_url);
        // The canonical exclusion, applied in TypeScript rather than in the
        // query: `isCanonicalisedElsewhere` resolves a relative canonical and
        // normalizes both sides, which is what makes this rule's silence and
        // `canonical.points-elsewhere`'s finding the same judgement rather than
        // two string comparisons that agree most of the time.
        if (
          isCanonicalisedElsewhere({
            url: pageUrl,
            canonicalHtml: row.canonical_html,
            canonicalHeader: row.canonical_header,
          })
        ) {
          invisible.add(pageId);
          continue;
        }
        set = {
          pageId,
          pageUrl,
          pageKey: targetKey(pageUrl),
          targets: [],
          codes: [],
          sources: [],
          sourcesByTarget: new Map(),
          hasXDefault: false,
          auditable: isAuditable({
            fetchClass: String(row.fetch_class),
            statusCode: row.status_code === null ? null : Number(row.status_code),
          }),
        };
        sets.set(pageId, set);
        members.set(pageId, new Map<string, Set<string>>());
        codes.set(pageId, new Set<string>());
      }
      const member = targetKey(String(row.target_url));
      const memberSources = members.get(pageId)!;
      const named = memberSources.get(member) ?? new Set<string>();
      named.add(String(row.source));
      memberSources.set(member, named);
      codes.get(pageId)!.add(String(row.hreflang_code).trim());
      if (isXDefault(String(row.hreflang_code))) set.hasXDefault = true;
    }
    for (const set of sets.values()) {
      const memberSources = members.get(set.pageId)!;
      set.targets = [...memberSources.keys()].sort();
      set.codes = [...codes.get(set.pageId)!].sort();
      set.sourcesByTarget = new Map(
        [...memberSources].map(([member, named]) => [member, [...named].sort()]),
      );
      set.sources = [...new Set([...memberSources.values()].flatMap((named) => [...named]))].sort();
    }

    const context = opts.withTargets
      ? await targetContext(db, crawlId, [...sets.values()])
      : { page: () => undefined, declares: () => NO_TARGETS };
    for (const set of sets.values()) {
      if (visit(set, context) === "stop") return;
    }
  }
}

/** The two lookups a batch of declaration sets needs about its targets. */
async function targetContext(
  db: Db,
  crawlId: string,
  sets: DeclarationSet[],
): Promise<TargetContext> {
  const wanted = [...new Set(sets.flatMap((s) => s.targets))];
  if (wanted.length === 0) {
    return { page: () => undefined, declares: () => NO_TARGETS };
  }

  // One array parameter rather than one placeholder per URL, so Postgres can
  // reuse the plan across batches (the link-targets pattern).
  const targetRows = await db.execute<{
    id: string;
    url: string;
    fetch_class: string;
    status_code: number | null;
    is_indexable: boolean | null;
    canonical_html: string | null;
    canonical_header: string | null;
  }>(sql`
    select p.id, p.url, p.fetch_class, p.status_code, p.is_indexable,
           p.canonical_html, p.canonical_header
    from pages p
    where p.crawl_id = ${crawlId} and p.url = any(${sql.param(wanted)}::text[])
      -- A robots-blocked row (Phase 23 T3) was recorded and NEVER REQUESTED,
      -- so it is read the way an alternate nobody fetched always was: absent
      -- from this map, and counted by hreflang.alternates-not-crawled.
      and not ${ROBOTS_BLOCKED("p")}`);
  const byUrl = new Map<string, TargetPage>();
  for (const row of targetRows.rows) {
    // The other half of the canonical exclusion: a target that canonicalises
    // elsewhere is not a cluster member, so it is left out of this map and
    // every rule reading it treats the alternate the way it treats one nobody
    // fetched — as a URL this crawl cannot judge.
    if (
      isCanonicalisedElsewhere({
        url: String(row.url),
        canonicalHtml: row.canonical_html,
        canonicalHeader: row.canonical_header,
      })
    ) {
      continue;
    }
    byUrl.set(String(row.url), {
      id: String(row.id),
      url: String(row.url),
      fetchClass: String(row.fetch_class),
      statusCode: row.status_code === null ? null : Number(row.status_code),
      isIndexable: row.is_indexable,
    });
  }

  // What each crawled target declares back. Only the targets that HAVE a page
  // row are asked about — a URL the crawl never fetched has no declarations to
  // read, and pretending otherwise is what the return-link rule's silence on
  // uncrawled targets exists to avoid.
  const crawled = [...byUrl.keys()];
  const back = new Map<string, Set<string>>();
  if (crawled.length > 0) {
    const backRows = await db.execute<{ page_url: string; target_url: string }>(sql`
      select p.url as page_url, h.target_url
      from hreflang h
      join pages p on p.id = h.page_id
      where h.crawl_id = ${crawlId} and p.url = any(${sql.param(crawled)}::text[])`);
    for (const row of backRows.rows) {
      const key = String(row.page_url);
      const declared = back.get(key) ?? new Set<string>();
      declared.add(targetKey(String(row.target_url)));
      back.set(key, declared);
    }
  }

  return {
    page: (target) => byUrl.get(target),
    declares: (target) => back.get(target) ?? NO_TARGETS,
  };
}

/**
 * The two join rules share this shape: for every member of a page's cluster
 * that the crawl actually fetched, decide whether it is a finding.
 *
 * A member the crawl never fetched is skipped everywhere, and deliberately: a
 * URL we did not request says nothing about what it declares or whether it can
 * be indexed, and "unknown" is not a finding (hard rule 1).
 *
 * The finding is one per (page, member) PAIR, so a cluster wired one way round
 * is O(pages × languages) of them: capped at `caps.listing` like every other
 * URL-scoped rule. The walk runs to the end whatever the cap says — nothing
 * about it grows with what is kept — so the count behind the cap is exact
 * (`noteTruncation`): only the LISTING stops at the cap, never the counting.
 * An uncapped run keeps every pair and writes no note.
 *
 * Every finding's evidence ends with `sources`: where the page declared that
 * member (HTML, `Link` header, sitemap), which is where the annotation is fixed.
 */
async function declarationFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  fires: (
    set: DeclarationSet,
    target: TargetPage,
    context: TargetContext,
  ) => Record<string, unknown> | null,
  caps: RuleCaps,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  await eachDeclarationSet(db, crawlId, { withTargets: true }, (set, context) => {
    for (const member of set.targets) {
      const target = context.page(member);
      if (target === undefined) continue;
      const fired = fires(set, target, context);
      if (fired === null) continue;
      const evidence = { ...fired, sources: set.sourcesByTarget.get(member)! };
      total += 1;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(self, {
          pageId: set.pageId,
          pageUrl: set.pageUrl,
          evidence,
          dedupeKey: `${set.pageUrl}→${member}`,
        }),
      );
    }
  });
  return noteTruncation(findings, total);
}

/**
 * The missing-x-default sets, keyed by the hash of their target list, with the
 * member the finding will be attached to.
 */
interface IncompleteSet {
  targets: string[];
  firstMember: string;
}

/**
 * One finding per distinct declaration set that names no fallback.
 *
 * The unit is the SET, not the page: every page of a cluster declares the same
 * alternates, so a per-page finding would bill one missing `x-default` once per
 * translation. Identity is the sorted target list, hashed, which is also the
 * dedupe key — two pages that name the same alternates are one cluster whether
 * or not either of them is in the other's list.
 *
 * The finding is attached to the lexically first member of the set. A cluster
 * has no page that owns it, so any choice is arbitrary; a deterministic one at
 * least means the same crawl re-run writes the same row, and the fix — add one
 * link tag to the cluster's template — is the same wherever it is filed.
 *
 * The accumulator holds one hash and one TARGET LIST per distinct cluster, and
 * a shop that ships a cluster per product has one per page — so unlike the
 * scans above, this one cannot count past its cap for free: knowing the total
 * means keeping every hash. It stops instead, one cluster past
 * `caps.listing`, and reports a LOWER BOUND (`noteAtLeastTruncation`). What
 * it did not scan it does not claim to have counted (the `content.near-
 * duplicate` precedent).
 *
 * UNCAPPED, the accumulator is the one this file has to be honest about: with
 * `findingCap: null` it holds every distinct cluster on the site, which is
 * O(clusters) rather than O(cap). That is the operator's own trade — the whole
 * picture costs the memory the whole picture takes — and it is bounded by the
 * number of DISTINCT target lists, not by pages: a shop shipping one cluster per
 * product is the bad case, and it is the one the default cap exists for. The
 * walk still stops nothing early, so the note is absent rather than wrong.
 */
async function missingXDefaultFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const incomplete = new Map<string, IncompleteSet>();
  /** 1 once the walk has seen a cluster it could not keep, 0 while it fits. */
  let beyondCap = 0;
  await eachDeclarationSet(db, crawlId, { withTargets: false }, (set) => {
    // A page naming one URL is not a cluster: there is no other version to
    // fall back FROM, so there is nothing missing.
    if (set.hasXDefault || set.targets.length < 2) return;
    const key = createHash("sha256").update(set.targets.join("\n")).digest("hex");
    if (incomplete.has(key)) return;
    if (caps.listing !== null && incomplete.size >= caps.listing) {
      // One cluster past the cap is all the walk needs to prove there are more.
      beyondCap = 1;
      return "stop";
    }
    incomplete.set(key, { targets: set.targets, firstMember: set.targets[0]! });
    return;
  });
  if (incomplete.size === 0) return [];

  // The member the finding lands on may be any URL in the cluster, including
  // one this crawl never fetched (an alternate on another host is the usual
  // case). Its page id is looked up so the finding attaches to a real row where
  // one exists, and is honestly null where it does not.
  const members = [...new Set([...incomplete.values()].map((s) => s.firstMember))];
  const pageIds = new Map<string, string>();
  for (let i = 0; i < members.length; i += MEMBER_LOOKUP_BATCH) {
    const chunk = members.slice(i, i + MEMBER_LOOKUP_BATCH);
    const rows = await db.execute<{ id: string; url: string }>(sql`
      select p.id, p.url from pages p
      where p.crawl_id = ${crawlId} and p.url = any(${sql.param(chunk)}::text[])`);
    for (const row of rows.rows) pageIds.set(String(row.url), String(row.id));
  }

  const findings = [...incomplete].map(([key, set]) =>
    queryFinding(X_DEFAULT, {
      pageId: pageIds.get(set.firstMember) ?? null,
      pageUrl: set.firstMember,
      evidence: { targets: set.targets, setSize: set.targets.length },
      dedupeKey: key,
    }),
  );
  return noteAtLeastTruncation(findings, incomplete.size + beyondCap);
}

/**
 * A page that declares alternates and is not one of them.
 *
 * An hreflang cluster is a set of equals and every member has to name the WHOLE
 * set, itself included: Google's documented rule is that a page whose own URL
 * is absent from the set it declares has its annotations discarded, so the
 * cluster it was trying to join fails as a whole rather than losing one member.
 * That makes this a different fault from `hreflang.missing-return-link` — there
 * the OTHER page is at fault, here the page in front of you is — and the same
 * check answers both, so it carries the same `checkIds`.
 *
 * Gated on `isAuditable` because the claim is about a page that serves content:
 * a redirect or a 404 that happens to carry an inherited alternates block is
 * not a version anyone can rank, and its own row already says why. Pages
 * canonicalised elsewhere are gone before this sees them (the note above).
 *
 * The cluster is compared by `targetKey`, so a page declaring itself with a
 * fragment or with its query parameters in another order still counts as
 * naming itself.
 *
 * One finding per PAGE (the dedupe key is the page URL), capped like every
 * other URL-scoped rule; the walk runs to the end whatever the cap says, so the
 * count behind the cap is exact.
 */
async function missingSelfReferenceFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  await eachDeclarationSet(db, crawlId, { withTargets: false }, (set) => {
    if (!set.auditable) return;
    if (set.targets.includes(set.pageKey)) return;
    total += 1;
    if (caps.listing !== null && findings.length >= caps.listing) return;
    findings.push(
      queryFinding(SELF_REFERENCE, {
        pageId: set.pageId,
        pageUrl: set.pageUrl,
        // `codes` is what the page declared, `targets` where those codes point.
        // The page's own URL is NOT repeated here: the runner stamps it onto
        // every finding's details (`{ pageUrl, ...evidence }` in src/rules/
        // run.ts), and a second copy would be the same string twice.
        //
        // There is NO `ownLanguageTarget` field either: naming the alternate
        // that stands in for this page would mean knowing the page's own
        // language, and the crawl stores no language for a page (`pages` has no
        // `lang` column), so the field would be a guess. The copy says so rather
        // than the evidence carrying a null nobody can read.
        //
        // `sources` is every source that annotated the page: the fix is to add
        // the self-reference wherever the set is generated.
        evidence: { codes: set.codes, targets: set.targets, sources: set.sources },
        dedupeKey: set.pageUrl,
      }),
    );
    return;
  });
  return noteTruncation(findings, total);
}

/**
 * The NOT MEASURED marker for the alternates this crawl never fetched.
 *
 * `hreflang.missing-return-link` reads back-links only from targets that HAVE a
 * `pages` row, which is right — a URL nobody requested says nothing about what
 * it declares — but on a multi-market site that is most of the cluster: the
 * crawl that motivated Phase 19 declared 2,632 alternates, 1,880 of them
 * against five sibling country domains (1,870 distinct URLs) that were not in
 * scope and none of which were fetched. Silence there read
 * as "the return links are fine", which is the always-passes hole hard rule 1
 * forbids. This is the marker that says it out loud, once per crawl.
 *
 * ALL OF IT IS SQL, and deliberately: the answer is a GROUP BY over the
 * hreflang table, and the alternative — streaming the declarations and counting
 * hosts in a Map — would hold one entry per distinct target URL in memory.
 *
 *  - the declaring page must be auditable (fetched OK with a 200) and not
 *    canonicalised elsewhere, so the marker counts alternates that a rule would
 *    otherwise have had to judge;
 *  - `alternates` is the DISTINCT alternate URLs on that host with no `pages`
 *    row — what crawling the host would cost;
 *  - `pages` is how many pages OF THIS CRAWL name at least one of them — how
 *    much of this audit is resting on the gap;
 *  - `total` sums `alternates` over every host, listed or not.
 *
 * The comparison to `pages.url` is the raw stored target rather than
 * `targetKey`'s normalized form (SQL cannot run `normalizeUrl`). The two
 * disagree only where an alternate carries a fragment, an unusual
 * query-parameter order or an upper-case host, and the direction of the error
 * is over-reporting a fetched URL as unfetched — a marker that names one host
 * too many, never a silence.
 */
async function alternatesNotCrawledFindings(db: Db, crawlId: string): Promise<Finding[]> {
  const rows = await db.execute<{
    host: string;
    alternates: number;
    pages: number;
    host_count: number;
    total: number;
  }>(sql`
    with uncrawled as (
      select h.target_url, h.page_id
      from hreflang h
      join pages p on p.id = h.page_id
      where h.crawl_id = ${crawlId}
        and ${FETCHED_OK("p")}
        and not ${CANONICALISED_ELSEWHERE("p")}
        and not exists (
          select 1 from pages t
          where t.crawl_id = ${crawlId} and t.url = h.target_url
            -- Recorded but never requested (robots.txt, Phase 23 T3) is still
            -- "not requested by this crawl": the marker's own words.
            and not ${ROBOTS_BLOCKED("t")})
    ),
    by_host as (
      select
        -- The authority between "://" and the first "/", "?" or "#", lower-cased.
        -- A target with no scheme separator at all (a mailto: alternate) has no
        -- host to group under and keeps its scheme instead, so it is still
        -- counted and still legible rather than dropped.
        coalesce(
          lower(substring(t.target_url from '://([^/?#]+)')),
          split_part(t.target_url, ':', 1) || ':'
        ) as host,
        count(distinct t.target_url)::int as alternates,
        count(distinct t.page_id)::int as pages
      from uncrawled t
      group by 1
    )
    select host, alternates, pages,
           (select count(*) from by_host)::int as host_count,
           (select coalesce(sum(alternates), 0) from by_host)::int as total
    from by_host
    order by alternates desc, host asc
    limit ${ALTERNATE_HOST_CAP}`);

  if (rows.rows.length === 0) return [];
  const hostCount = Number(rows.rows[0]!.host_count);
  const total = Number(rows.rows[0]!.total);
  const hosts = rows.rows.map((r) => ({
    host: String(r.host),
    alternates: Number(r.alternates),
    pages: Number(r.pages),
  }));
  return [
    queryFinding(NOT_CRAWLED, {
      pageId: null,
      pageUrl: null,
      evidence: {
        total,
        hosts,
        // `hostsTruncated`, not `truncated`: this says the HOST LIST inside one
        // finding was cut. `truncated` is what a capped LISTING of findings
        // writes (`noteTruncation`), and one evidence object must not spell two
        // different facts the same way (the `robots.check-skipped` precedent).
        ...(hostCount > hosts.length
          ? { hostsTruncated: { reported: hosts.length, total: hostCount } }
          : {}),
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * Hreflang rules are `kind: "query"` rather than page rules because hreflang
 * declarations live in their own table, one row per declaration — they are not
 * a column on `pages` a page rule could read.
 */
export const hreflangRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: INVALID_CODE.id,
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: INVALID_CODE.severity,
    columns: [
      { key: "code", label: "hreflang" },
      { key: "targetUrl", label: "Alternate URL" },
      { key: "occurrences", label: "Occurrences" },
      { key: "targetUrls", label: "Alternate URLs", optional: true },
      { key: "sources", label: "Declaration Source" },
    ],
    ...copyFor(INVALID_CODE.id),
    rulesetVersion: RULESET_VERSION,
    // The validity test runs in JS over the crawl's hreflang rows, streamed
    // once — acceptable at this scale. A site with millions of declarations
    // would want the pattern pushed into SQL.
    run: async (db, crawlId): Promise<Finding[]> => {
      const res = await db.execute<{
        page_id: string;
        hreflang_code: string;
        target_url: string;
        source: string;
        page_url: string;
        canonical_html: string | null;
        canonical_header: string | null;
      }>(sql`
        select h.page_id, h.hreflang_code, h.target_url, h.source, p.url as page_url,
               p.canonical_html, p.canonical_header
        from hreflang h join pages p on p.id = h.page_id
        where h.crawl_id = ${crawlId}`);

      // ONE FINDING PER DISTINCT (page, trimmed code) — not per declaration
      // row, which is what this used to be.
      //
      // A page can carry several broken codes and each is a separate thing to
      // fix, so the finding is still finer-grained than the page. But it cannot
      // be per ROW: `hreflang` has no unique constraint and nothing upstream
      // enforces one, so the same code lands twice on one page whenever a
      // template emits its alternates block twice, or a code is declared in
      // both the HTML and the sitemap. Per-row findings then shared a
      // `dedupeKey`, and since the run stopped absorbing collisions the second
      // insert aborted the ENTIRE judgement on `issues_dedupe` — one page's
      // malformed template taking down the crawl's whole audit. The duplicate
      // is a fact about the site, not a rule defect, so it is grouped here
      // rather than left to collide.
      //
      // The analyzer stores the attribute verbatim, so `hreflang="en-GB "` — a
      // formatting artefact, not a mistake — arrives with its whitespace. Trim
      // before judging it, and group on the trimmed form: `"en_GB"` and
      // `"en_GB "` are one mistake declared twice.
      interface Group {
        pageId: string;
        pageUrl: string;
        code: string;
        occurrences: number;
        targets: Set<string>;
        sources: Set<string>;
      }
      const groups = new Map<string, Group>();
      // The canonical exclusion, per page rather than per row: this rule does
      // not use the declaration-set walk, so it applies the same test itself.
      const canonicalised = new Map<string, boolean>();
      for (const row of res.rows) {
        const code = String(row.hreflang_code).trim();
        if (isXDefault(code) || HREFLANG_CODE.test(code)) continue;
        const pageUrl = String(row.page_url);
        const pageId = String(row.page_id);
        let elsewhere = canonicalised.get(pageId);
        if (elsewhere === undefined) {
          elsewhere = isCanonicalisedElsewhere({
            url: pageUrl,
            canonicalHtml: row.canonical_html,
            canonicalHeader: row.canonical_header,
          });
          canonicalised.set(pageId, elsewhere);
        }
        if (elsewhere) continue;
        const dedupeKey = `${pageUrl}#${code}`;
        let group = groups.get(dedupeKey);
        if (group === undefined) {
          group = {
            pageId,
            pageUrl,
            code,
            occurrences: 0,
            targets: new Set(),
            sources: new Set(),
          };
          groups.set(dedupeKey, group);
        }
        group.occurrences += 1;
        group.targets.add(String(row.target_url));
        group.sources.add(String(row.source));
      }

      return [...groups].map(([dedupeKey, group]) => {
        // Sorted, so the evidence a repeat run writes is the same evidence:
        // the query has no ORDER BY, and which row of a duplicated pair
        // arrives first is Postgres' business.
        const targets = [...group.targets].sort();
        const sources = [...group.sources].sort();
        return queryFinding(INVALID_CODE, {
          pageId: group.pageId,
          pageUrl: group.pageUrl,
          evidence: {
            code: group.code,
            targetUrl: targets[0]!,
            // The multiplicity, carried rather than dropped: a code declared
            // three times is three lines of template to fix, and the report
            // would otherwise say "one". `targetUrls` appears only when it
            // holds something `targetUrl` does not.
            occurrences: group.occurrences,
            ...(targets.length > 1 ? { targetUrls: targets } : {}),
            // Always, since Phase 26c: a code only the sitemap or a Link
            // header declares is fixed there, not in the template.
            sources,
          },
          dedupeKey,
        });
      });
    },
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: X_DEFAULT.id,
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: X_DEFAULT.severity,
    columns: [
      { key: "targets", label: "Alternate URLs" },
      { key: "setSize", label: "Cluster Size" },
    ],
    ...copyFor(X_DEFAULT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => missingXDefaultFindings(db, crawlId, capsOr(caps)),
  }),

  // An hreflang annotation is only honoured when it is reciprocated: a page
  // naming an alternate that does not name it back is an annotation search
  // engines discard.
  //
  // Silent when the target was never crawled — a URL we did not fetch has no
  // declarations to be missing, and "unknown" is not a finding (hard rule 1).
  // `targetHasHreflang` separates the two shapes of the fault for the report:
  // a page with no annotations at all, and a page whose cluster forgot one
  // member.
  defineRule<QueryRule>({
    kind: "query",
    id: RETURN_LINK.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: RETURN_LINK.severity,
    columns: [
      { key: "target", label: "URL Not Returning Link" },
      { key: "targetHasHreflang", label: "Target Declares hreflang" },
      { key: "sources", label: "Declaration Source" },
    ],
    ...copyFor(RETURN_LINK.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      declarationFindings(
        RETURN_LINK,
        db,
        crawlId,
        (set, target, context) => {
          const back = context.declares(target.url);
          return back.has(set.pageKey)
            ? null
            : { target: target.url, targetHasHreflang: back.size > 0 };
        },
        capsOr(caps),
      ),
  }),

  // An alternate that points at a redirect or at a page excluded from the
  // index names a version search engines cannot serve. Unlike the canonical
  // pair, this is ONE rule over both shapes: an hreflang cluster is a set of
  // equals, and the fix — point the annotation at the URL that actually serves
  // that language — is the same whether the target moved or opted out.
  // `targetFetchClass` says which it was.
  //
  // The `is_indexable` half is gated on `isAuditable` — the same guard
  // `canonical.non-indexable-target` uses, and for the same reason. The writer
  // sets `is_indexable` false for every 404, 5xx, blocked response and network
  // failure as well as for a noindex, so testing it alone would report a dead
  // alternate under copy about "the exclusion" — a robots directive that page
  // never had, on a page that returned no HTML to carry one. An alternate
  // whose URL is gone therefore produces NO finding from this rule: the
  // crawl's own evidence about that URL (its `pages` row, `links.broken-
  // internal`, `http.server-error`, `crawl.blocked`) is what reports it, and
  // saying it twice under the wrong title is worse than saying it once.
  defineRule<QueryRule>({
    kind: "query",
    id: NON_INDEXABLE.id,
    checkIds: ["CHECK-26"],
    category: CATEGORY,
    severity: NON_INDEXABLE.severity,
    columns: [
      { key: "target", label: "URL Not Returning Link" },
      { key: "targetFetchClass", label: "Target Fetch Class" },
      { key: "targetIndexable", label: "Target Indexable" },
      { key: "sources", label: "Declaration Source" },
    ],
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      declarationFindings(
        NON_INDEXABLE,
        db,
        crawlId,
        (_set, target) =>
          target.fetchClass === "redirect" ||
          (isAuditable(target) && target.isIndexable === false)
            ? {
                target: target.url,
                targetFetchClass: target.fetchClass,
                targetIndexable: target.isIndexable,
              }
            : null,
        capsOr(caps),
      ),
  }),

  // The other half of reciprocity, and the half a crawl can always answer: a
  // page's own URL must be in the set it declares. See
  // `missingSelfReferenceFindings`.
  defineRule<QueryRule>({
    kind: "query",
    id: SELF_REFERENCE.id,
    checkIds: ["CHECK-24"],
    category: CATEGORY,
    severity: SELF_REFERENCE.severity,
    columns: [
      { key: "codes", label: "hreflang" },
      { key: "targets", label: "Alternate URLs" },
      { key: "sources", label: "Declaration Source" },
    ],
    ...copyFor(SELF_REFERENCE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => missingSelfReferenceFindings(db, crawlId, capsOr(caps)),
  }),

  // A check we could not run is visible, never silent (hard rule 7). One
  // site-scoped finding naming the hosts whose alternates this crawl never
  // fetched, at info severity: what it reports is the boundary of this crawl's
  // evidence, not a fault found on the site. It claims both checks that read a
  // fetched alternate — the return links of CHECK-24 and the indexability of
  // CHECK-26 — because neither can be answered for a URL nobody requested.
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_CRAWLED.id,
    checkIds: ["CHECK-24", "CHECK-26"],
    category: CATEGORY,
    severity: NOT_CRAWLED.severity,
    columns: [
      { key: "total", label: "Alternates" },
      { key: "hosts", label: "Hosts" },
      { key: "hostsTruncated", label: "Hosts Truncated", optional: true },
    ],
    ...copyFor(NOT_CRAWLED.id),
    rulesetVersion: RULESET_VERSION,
    // The reason states only what the query established. It used to add "most
    // of them sit on other domains", which was true of the crawl that provoked
    // the rule and is not a thing the finding knows: an alternate on THIS host
    // that robots.txt disallowed, or that no page links to, produces exactly
    // the same finding. The hosts are in the evidence, so a reader who wants to
    // know where the alternates sit reads them rather than being told.
    marker:
      "The hreflang alternates these pages declare were not requested by this crawl, so their return links and indexability were not checked; crawl those domains or add them as start URLs.",
    run: (db, crawlId) => alternatesNotCrawledFindings(db, crawlId),
  }),
];
