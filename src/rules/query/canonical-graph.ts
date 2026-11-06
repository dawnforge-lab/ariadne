import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pages } from "../../db/schema.js";
import { isAuditable, resolveEffectiveCanonical, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { CANONICAL_MAX_HOPS } from "../thresholds.js";
import { cappedListing, capsOr } from "./crawl-evidence.js";
import { eachCanonicalTargetBatch, type ResolvedTarget } from "./link-targets.js";

const CATEGORY = "canonical";

const CHAIN: RuleIdentity = { id: "canonical.chain", severity: "warning" };
const UNLINKED: RuleIdentity = { id: "canonical.unlinked", severity: "info" };

/** One page's walk down its canonical chain. */
interface Walk {
  source: ResolvedTarget;
  /** Crawled 200 pages reached, starting at the source's own target. */
  hops: string[];
  /** Every URL on the walk so far, the source included: a revisit is a loop. */
  seen: Set<string>;
  /** Where the last hop's canonical points: the URL still to be looked up. */
  next: string;
  loop: boolean;
  hopLimitReached: boolean;
  /**
   * The URL the walk could not follow because it is not a crawled 200 page
   * (a 404, a redirect, or never fetched): where the chain ends as far as the
   * crawl can tell. Null when the chain ended on a page that names itself.
   */
  unresolvedNext: string | null;
}

/**
 * Pages whose canonical target is itself canonicalised to a third URL.
 *
 * The first hop comes from `eachCanonicalTargetBatch`, the same resolved
 * source/target pairs the two target rules judge; a pair whose target is not a
 * fetched 200 page is dropped there (a 404 target is `canonical.non-200-target`'s
 * finding, and a target the crawl never fetched is evidence we do not have), and
 * so is a target that canonicalises to itself, which is a healthy single hop.
 *
 * Every hop after the first is one round per batch: the URLs still being
 * followed are looked up with a single `= any(...)` query, each walk takes its
 * row, and the walks that have nowhere further to go leave the round. A walk
 * ends when
 *  - the hop's page is not a crawled 200 page, or canonicalises to itself
 *    (the chain ended),
 *  - the next URL is one the walk has already been through, the source
 *    included (a loop: `loop: true`, and it is not also a hop-limit chain), or
 *  - it has followed `CANONICAL_MAX_HOPS` hops and the page still points
 *    elsewhere (`hopLimitReached`). A cycle longer than the limit is cut off here
 *    before it can revisit anything, so it is reported as a long chain and not as
 *    a loop; the limit is also what keeps the work bounded.
 *
 * Memory is O(batch x hops): a walk holds at most `CANONICAL_MAX_HOPS` URLs, and
 * nothing outlives its batch (hard rules 3 and 6). Each member of a loop is its
 * own source, so each is reported once, with `loop: true`.
 *
 * The finding belongs to the page that STARTS the chain, and its `hops` are the
 * resolved URLs from its own target onward, so the evidence shows the whole
 * path to the end. In A -> B -> C where C is self-canonical, A is the finding
 * (`hops: [B, C]`) and B is not: B's target is C, one hop.
 */
async function chainFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  // Findings are listed in the order the walk meets them: batches by
  // `pages.id`, each in declaring-URL order (`eachCanonicalTargetBatch`).
  const out = cappedListing(self, caps);
  await eachCanonicalTargetBatch(db, crawlId, async (batch) => {
    const walks: Walk[] = [];
    for (const t of batch) {
      if (!isAuditable(t.target)) continue;
      const onward = resolveEffectiveCanonical(t.target);
      if (onward === null || onward.resolved === null || !onward.pointsElsewhere) continue;
      walks.push({
        source: t,
        hops: [t.target.url],
        // `pages.url` is the frontier key, which is `normalizeUrl` output
        // (see `eachCanonicalTargetBatch`), so it is already the normalised
        // form every resolved canonical is compared in.
        seen: new Set([t.page.url, t.target.url]),
        next: onward.resolved,
        loop: false,
        hopLimitReached: false,
        unresolvedNext: null,
      });
    }

    let active = walks;
    while (active.length > 0) {
      const lookup: Walk[] = [];
      for (const w of active) {
        if (w.seen.has(w.next)) w.loop = true;
        else if (w.hops.length >= CANONICAL_MAX_HOPS) w.hopLimitReached = true;
        else lookup.push(w);
      }
      if (lookup.length === 0) break;

      // One statement per round, whatever the batch holds. `pages.url` is the
      // frontier key and a resolved canonical is `normalizeUrl` output, so the
      // two compare directly.
      const rows = await db
        .select({
          id: pages.id,
          url: pages.url,
          fetchClass: pages.fetchClass,
          statusCode: pages.statusCode,
          canonicalHtml: pages.canonicalHtml,
          canonicalHeader: pages.canonicalHeader,
        })
        .from(pages)
        .where(
          sql`${pages.crawlId} = ${crawlId} and ${pages.url} = any(${sql.param([
            ...new Set(lookup.map((w) => w.next)),
          ])}::text[])`,
        );
      const byUrl = new Map(rows.map((r) => [r.url, r]));

      active = [];
      for (const w of lookup) {
        const row = byUrl.get(w.next);
        if (row === undefined || !isAuditable(row)) {
          w.unresolvedNext = w.next;
          continue;
        }
        w.hops.push(row.url);
        w.seen.add(row.url);
        const onward = resolveEffectiveCanonical(row);
        if (onward === null || onward.resolved === null || !onward.pointsElsewhere) continue;
        w.next = onward.resolved;
        active.push(w);
      }
    }

    for (const w of walks) {
      out.add({
        pageId: w.source.page.id,
        pageUrl: w.source.page.url,
        dedupeKey: w.source.page.url,
        evidence: {
          canonical: w.source.canonical,
          hops: w.hops,
          loop: w.loop,
          // Present only when true: an absent key is "the walk reached an end".
          ...(w.hopLimitReached ? { hopLimitReached: true } : {}),
          // Likewise present only when the chain runs into a URL the crawl has
          // no 200 page for, so the finding names where it was last seen going.
          ...(w.unresolvedNext !== null ? { unresolvedNext: w.unresolvedNext } : {}),
        },
      });
    }
  });
  return out.done();
}

/**
 * Canonicalised pages whose canonical target no other page links to.
 *
 * THE COHORT is every fetched 200 HTML page canonicalised elsewhere (the pairs
 * `eachCanonicalTargetBatch` yields) whose target is also a fetched 200 page.
 * It is NOT the judged cohort, because the judged cohort excludes pages
 * canonicalised elsewhere by definition and the rule would have nothing to read.
 * Indexability of the source does not matter: a noindexed duplicate that names
 * an unlinked page still names it.
 *
 * "Linked" is a `links` row with `target_url` equal to the target's URL,
 * `is_internal`, and a source page that is not the target itself: a page that
 * links only to itself is as unreachable as one nobody links to. The
 * canonicalised page's own link to the target counts, since it is a link. The
 * lookup is one statement per batch, `distinct` over the batch's target URLs
 * (hard rule 3: the links table is never loaded into memory).
 *
 * FILED ON THE SOURCE PAGE, the page whose canonical names the unlinked target,
 * with the source URL as the dedupe key. The unit is a canonical declaration,
 * like `canonical.non-200-target`'s, and filing on the target would collapse
 * every duplicate pointing at it into one row and lose the per-page list the fix
 * is made from. The evidence carries the raw `canonical` and the URL it
 * resolved to.
 */
async function unlinkedFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const out = cappedListing(self, caps);
  await eachCanonicalTargetBatch(db, crawlId, async (batch) => {
    const cohort = batch.filter((t) => isAuditable(t.target));
    if (cohort.length === 0) return;

    const linked = await db.execute<{ target_url: string }>(sql`
      select distinct l.target_url
      from links l
      join pages tp on tp.crawl_id = l.crawl_id and tp.url = l.target_url
      where l.crawl_id = ${crawlId}
        and l.is_internal
        and l.target_url = any(${sql.param([...new Set(cohort.map((t) => t.resolvedTo))])}::text[])
        and l.source_page_id <> tp.id`);
    const hasInlink = new Set(linked.rows.map((r) => r.target_url));

    for (const t of cohort) {
      if (hasInlink.has(t.resolvedTo)) continue;
      out.add({
        pageId: t.page.id,
        pageUrl: t.page.url,
        dedupeKey: t.page.url,
        evidence: { canonical: t.canonical, resolvedTo: t.resolvedTo },
      });
    }
  });
  return out.done();
}

export const canonicalGraphRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: CHAIN.id,
    checkIds: ["CHECK-17", "CHECK-19"],
    category: CATEGORY,
    severity: CHAIN.severity,
    columns: [
      { key: "canonical", label: "Canonical Link Element" },
      { key: "hops", label: "Canonical Chain" },
      { key: "loop", label: "Loop" },
      { key: "hopLimitReached", label: "Hop Limit Reached", optional: true },
      { key: "unresolvedNext", label: "Next URL Not Crawled As 200", optional: true },
    ],
    ...copyFor(CHAIN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => chainFindings(CHAIN, db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: UNLINKED.id,
    checkIds: ["CHECK-17"],
    category: CATEGORY,
    severity: UNLINKED.severity,
    columns: [
      { key: "canonical", label: "Canonical Link Element" },
      { key: "resolvedTo", label: "Canonical Target" },
    ],
    ...copyFor(UNLINKED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => unlinkedFindings(UNLINKED, db, crawlId, capsOr(caps)),
  }),
];
