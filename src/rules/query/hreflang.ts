import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { isAuditable, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import {
  noteAtLeastTruncation,
  noteTruncation,
  URL_FINDING_CAP,
} from "./crawl-evidence.js";

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

const INVALID_CODE: RuleIdentity = { id: "hreflang.invalid-code", severity: "warning" };
const X_DEFAULT: RuleIdentity = { id: "hreflang.missing-x-default", severity: "info" };
const RETURN_LINK: RuleIdentity = { id: "hreflang.missing-return-link", severity: "warning" };
const NON_INDEXABLE: RuleIdentity = { id: "hreflang.non-indexable-target", severity: "warning" };

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
 */
interface DeclarationSet {
  pageId: string;
  pageUrl: string;
  /** The comparison key for `pageUrl`. */
  pageKey: string;
  targets: string[];
  hasXDefault: boolean;
}

/** A crawled page an alternate points at. */
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
      hreflang_code: string;
      target_url: string;
    }>(sql`
      select h.page_id, p.url as page_url, h.hreflang_code, h.target_url
      from hreflang h
      join pages p on p.id = h.page_id
      where h.crawl_id = ${crawlId}
        and h.page_id = any(${sql.param(pageIds)}::text[])`);

    const sets = new Map<string, DeclarationSet>();
    const members = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const pageId = String(row.page_id);
      let set = sets.get(pageId);
      if (set === undefined) {
        const pageUrl = String(row.page_url);
        set = { pageId, pageUrl, pageKey: targetKey(pageUrl), targets: [], hasXDefault: false };
        sets.set(pageId, set);
        members.set(pageId, new Set<string>());
      }
      members.get(pageId)!.add(targetKey(String(row.target_url)));
      if (isXDefault(String(row.hreflang_code))) set.hasXDefault = true;
    }
    for (const set of sets.values()) {
      set.targets = [...members.get(set.pageId)!].sort();
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
  }>(sql`
    select p.id, p.url, p.fetch_class, p.status_code, p.is_indexable
    from pages p
    where p.crawl_id = ${crawlId} and p.url = any(${sql.param(wanted)}::text[])`);
  const byUrl = new Map<string, TargetPage>();
  for (const row of targetRows.rows) {
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
 * is O(pages × languages) of them: capped at `URL_FINDING_CAP` like every other
 * URL-scoped rule. The walk runs to the end whatever the cap says — nothing
 * about it grows with what is kept — so the count behind the cap is exact
 * (`noteTruncation`): only the LISTING stops at the cap, never the counting.
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
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  await eachDeclarationSet(db, crawlId, { withTargets: true }, (set, context) => {
    for (const member of set.targets) {
      const target = context.page(member);
      if (target === undefined) continue;
      const evidence = fires(set, target, context);
      if (evidence === null) continue;
      total += 1;
      if (findings.length >= URL_FINDING_CAP) continue;
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
 * `URL_FINDING_CAP`, and reports a LOWER BOUND (`noteAtLeastTruncation`). What
 * it did not scan it does not claim to have counted (the `content.near-
 * duplicate` precedent).
 */
async function missingXDefaultFindings(db: Db, crawlId: string): Promise<Finding[]> {
  const incomplete = new Map<string, IncompleteSet>();
  /** 1 once the walk has seen a cluster it could not keep, 0 while it fits. */
  let beyondCap = 0;
  await eachDeclarationSet(db, crawlId, { withTargets: false }, (set) => {
    // A page naming one URL is not a cluster: there is no other version to
    // fall back FROM, so there is nothing missing.
    if (set.hasXDefault || set.targets.length < 2) return;
    const key = createHash("sha256").update(set.targets.join("\n")).digest("hex");
    if (incomplete.has(key)) return;
    if (incomplete.size >= URL_FINDING_CAP) {
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
        page_url: string;
      }>(sql`
        select h.page_id, h.hreflang_code, h.target_url, p.url as page_url
        from hreflang h join pages p on p.id = h.page_id
        where h.crawl_id = ${crawlId}`);
      // The analyzer stores the attribute verbatim, so `hreflang="en-GB "` — a
      // formatting artefact, not a mistake — arrives with its whitespace. Trim
      // before judging it; surrounding space is not what makes a code invalid.
      return res.rows
        .map((r) => ({ ...r, code: String(r.hreflang_code).trim() }))
        .filter(({ code }) => !isXDefault(code) && !HREFLANG_CODE.test(code))
        .map((r) =>
          queryFinding(INVALID_CODE, {
            pageId: String(r.page_id),
            pageUrl: String(r.page_url),
            evidence: { code: r.code, targetUrl: r.target_url },
            // One finding per declaration, not per page: a page can carry
            // several broken codes and each is a separate thing to fix.
            dedupeKey: `${String(r.page_url)}#${r.code}`,
          }),
        );
    },
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: X_DEFAULT.id,
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: X_DEFAULT.severity,
    ...copyFor(X_DEFAULT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => missingXDefaultFindings(db, crawlId),
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
    ...copyFor(RETURN_LINK.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      declarationFindings(RETURN_LINK, db, crawlId, (set, target, context) => {
        const back = context.declares(target.url);
        return back.has(set.pageKey)
          ? null
          : { target: target.url, targetHasHreflang: back.size > 0 };
      }),
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
    ...copyFor(NON_INDEXABLE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      declarationFindings(NON_INDEXABLE, db, crawlId, (_set, target) =>
        target.fetchClass === "redirect" || (isAuditable(target) && target.isIndexable === false)
          ? {
              target: target.url,
              targetFetchClass: target.fetchClass,
              targetIndexable: target.isIndexable,
            }
          : null,
      ),
  }),
];
