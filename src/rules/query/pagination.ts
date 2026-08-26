import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { pages } from "../../db/schema.js";
import { isAuditable, queryFinding, type RuleIdentity } from "../helpers.js";
import { resolveEffectiveCanonical } from "../page/canonical.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type PageRecord,
  type QueryRule,
} from "../registry/registry.js";
import { noteTruncation, URL_FINDING_CAP } from "./crawl-evidence.js";

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

/** A page carrying `rel=next` and/or `rel=prev`, with its next target resolved. */
interface PaginatedPage {
  page: PageRecord;
  /** `rel_next` as declared, or null when the page declares none. */
  relNext: string | null;
  /** `rel_next` resolved against the page URL, or null when it will not resolve. */
  resolvedNext: string | null;
  /** The `pages` row for `resolvedNext`, or null when the crawl never fetched it. */
  nextTarget: { url: string; linked: boolean } | null;
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
 * `isAuditable` gates the scan for the reason every canonical and on-page rule
 * is gated: these columns come from the analyzer, which only runs on an HTML
 * 200, so a page that 404s or redirects has no pagination signals to judge —
 * and a row that somehow carried them would be judged on markup nobody was
 * served.
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
    for (const page of auditable) {
      if (page.relNext === null) continue;
      resolved.set(page.id, normalizeUrl(page.relNext, page.url));
    }

    const wanted = [...new Set([...resolved.values()].filter((u): u is string => u !== null))];
    const targets = new Map<string, { url: string; linked: boolean }>();
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
      const rows = await db.execute<{ url: string; linked: boolean }>(sql`
        select p.url,
               exists (
                 select 1 from links l
                 where l.crawl_id = ${crawlId}
                   and l.target_url = p.url
                   and l.source_page_id <> p.id
               ) as linked
        from pages p
        where p.crawl_id = ${crawlId}
          and p.url = any(${sql.param(wanted)}::text[])`);
      for (const row of rows.rows) {
        targets.set(String(row.url), { url: String(row.url), linked: row.linked });
      }
    }

    for (const page of auditable) {
      const next = page.relNext === null ? null : (resolved.get(page.id) ?? null);
      visit({
        page,
        relNext: page.relNext,
        resolvedNext: next,
        nextTarget: next === null ? null : (targets.get(next) ?? null),
      });
    }
  }
}

/**
 * The shape all three pagination rules take: walk the paginated pages and keep
 * the ones the rule fires on.
 *
 * Capped at `URL_FINDING_CAP` like every other URL-scoped rule — an archive
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
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let total = 0;
  await eachPaginatedPage(db, crawlId, (p) => {
    const evidence = fires(p);
    if (evidence === null) return;
    total += 1;
    if (findings.length >= URL_FINDING_CAP) return;
    findings.push(
      queryFinding(self, {
        pageId: p.page.id,
        pageUrl: p.page.url,
        evidence,
        dedupeKey: p.page.url,
      }),
    );
  });
  return noteTruncation(findings, total);
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
    ...copyFor(NEXT_UNCRAWLED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      paginationFindings(NEXT_UNCRAWLED, db, crawlId, (p) => {
        if (p.relNext === null) return null;
        if (p.resolvedNext === null) {
          return { relNext: p.relNext, resolvedTo: null, unparseable: true };
        }
        return p.nextTarget === null
          ? { relNext: p.relNext, resolvedTo: p.resolvedNext }
          : null;
      }),
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
    ...copyFor(NEXT_NOT_LINKED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      paginationFindings(NEXT_NOT_LINKED, db, crawlId, (p) =>
        p.relNext !== null && p.nextTarget !== null && !p.nextTarget.linked
          ? { relNext: p.relNext, resolvedTo: p.nextTarget.url }
          : null,
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
    ...copyFor(CANONICAL_TO_OTHER.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) =>
      paginationFindings(CANONICAL_TO_OTHER, db, crawlId, ({ page }) => {
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
      }),
  }),
];
