/**
 * The social query rules (Phase 26b, CHECK-87): one share title or description
 * on many pages, and a share image a platform cannot use.
 *
 * `social.og-duplicate` is `title.duplicate`'s shape over `og_title` and
 * `og_description` (src/rules/query/field-duplicates.ts, reused rather than
 * restated): one finding per shared value, on the JUDGED cohort, hreflang
 * alternates one member, rel=prev pages set aside, blanks never grouped. Both
 * columns predate extraction 2, so it judges every crawl (deviation 1).
 *
 * `social.image-broken` reads `pages.social` and the `resources` row the
 * crawler wrote for each judged og/X image, found by the key the analyzer
 * stored beside it (`social.imageRefs`) (deviation 3: a `resources` row, kind
 * `image`, with NO `page_resources` edge, so no resource rule, mixed-content
 * rule or page-weight metric sees it). It opens with `v2Gate`: a crawl not
 * wholly written by extraction 2 is refused, and `extraction.not-recorded`
 * speaks for it.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { pages, resources } from "../../db/schema.js";
import type { SocialFacts } from "../../crawl/parse/page-facts.js";
import { JUDGED, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { SOCIAL_IMAGE_MAX_BYTES } from "../thresholds.js";
import { assertCrawl, cappedListing, capsOr, noteTruncation } from "./crawl-evidence.js";
import { duplicateGroups, type DuplicateField } from "./field-duplicates.js";
import { v2Gate } from "./page-facts.js";
import { resourceCheckAskedNothing } from "./resources.js";

const CATEGORY = "on-page" as const;
const CHECKS = ["CHECK-87"];

const DUPLICATE: RuleIdentity = { id: "social.og-duplicate", severity: "info" };
const IMAGE_BROKEN: RuleIdentity = { id: "social.image-broken", severity: "warning" };

/** The two fields `social.og-duplicate` groups, in listing order. */
const OG_FIELDS: ReadonlyArray<{ tag: string; field: DuplicateField }> = [
  { tag: "og:title", field: { column: "og_title", evidenceKey: "value" } },
  { tag: "og:description", field: { column: "og_description", evidenceKey: "value" } },
];

/**
 * The og:title groups, then the og:description groups, under ONE cap and ONE
 * exact note. Each field is grouped by `duplicateGroups` with the run's caps,
 * so neither listing can be longer than the cap; the concatenation is then cut
 * to the cap and noted with the two exact totals summed. Two separately noted
 * listings would put two notes on one rule, and a reader takes one.
 *
 * `dedupeKey` is prefixed with the tag: one text used as a title on some pages
 * and as a description on others is two groups with one value hash.
 *
 * The evidence is `field` (written here), then what `duplicateGroups` writes
 * for every group: `value` (its `evidenceKey`), `count`, `pages`,
 * `alternatesCollapsed` and `paginationExcluded`.
 */
async function ogDuplicateFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const listed: Finding[] = [];
  let total = 0;
  for (const { tag, field } of OG_FIELDS) {
    const groups = await duplicateGroups(db, crawlId, self, field, caps);
    total += groups.total;
    for (const f of groups.findings) {
      listed.push({
        ...f,
        evidence: { field: tag, ...f.evidence },
        dedupeKey: `${tag}:${f.dedupeKey}`,
      });
    }
  }
  const kept = caps.listing === null ? listed : listed.slice(0, caps.listing);
  return noteTruncation(kept, total);
}

/** Pages read per round trip by the image scan: a batch, never the table. */
export const SOCIAL_IMAGE_BATCH = 500;

type ImageProblem =
  | { problem: "relative" }
  | { problem: "invalid" }
  | { problem: "status"; statusCode: number }
  | { problem: "too-large"; bytes: number }
  /**
   * The image's status is unknown on a crawl whose file check DID run: no
   * request was made for it (a budget stopped short of it, or no row was
   * written for it), or one was made and got no answer (`fetch_error`, a
   * refusal, a robots block). `fetchClass` says which; null is "never asked".
   * NOT a verdict of broken (hard rule 7): the resource markers count only
   * files a page loads, so without this entry nothing would speak for it. On
   * a crawl whose check asked about nothing it is never listed (see
   * `fetchedVerdict`).
   */
  | { problem: "not-fetched"; fetchClass: string | null };

/** One og/X image of one page, before its `resources` row is read. */
type Candidate =
  | { tag: string; url: string; verdict: ImageProblem }
  | { tag: string; url: string; resolved: string };

/** Any URL scheme (`https:`, `data:`, `mailto:` ...). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEME = /^https?:/i;

/**
 * What can be said of an image value before any fetch. A share image is
 * fetched by the platform from the address as written, so it must be absolute
 * http(s): a value with no scheme at all (`/og.png`, `//cdn/og.png`) is
 * `relative`; one with another scheme, one `new URL` refuses, or one the
 * analyzer could not resolve (`ref` null) is `invalid`.
 *
 * Otherwise its `resources` row is looked up by `ref`: the string the analyzer
 * resolved from the WHOLE value and wrote as that row's key
 * (`SocialFacts.imageRefs`, `shareImageRef`). The rule never resolves `url`
 * itself: `url` is the stored value, cut at `SOCIAL_URL_MAX`, and resolving it
 * would miss the row of every longer image (final review I1). One resolution,
 * read back, cannot drift from the crawler's.
 */
function candidate(tag: string, url: string, ref: string | null): Candidate {
  if (!HAS_SCHEME.test(url)) return { tag, url, verdict: { problem: "relative" } };
  if (!HTTP_SCHEME.test(url) || !URL.canParse(url) || ref === null) {
    return { tag, url, verdict: { problem: "invalid" } };
  }
  return { tag, url, resolved: ref };
}

type ResourceRow = {
  url: string;
  fetchClass: string | null;
  statusCode: number | null;
  bytes: number | null;
};

/**
 * The verdict on a resolved image from its `resources` row, or null when there
 * is nothing to list.
 *
 * An image with no status (no row, or a row the file check never decided) is
 * listed as `not-fetched` only when the check DID ask about something on this
 * crawl (ruling R13): then the unfetched image is a specific gap, skipped,
 * capped or failed. When the check asked about nothing (`fetchResources: false`,
 * never run, budget spent first), every image is unfetched for one crawl-wide
 * reason, and `resources.not-fetched` / `resources.not-recorded` (both claim
 * CHECK-87) say so once; a per-page warning saying only "we did not look" would
 * be that one fact filed N times.
 */
function fetchedVerdict(
  row: ResourceRow | undefined,
  checkAskedNothing: boolean,
): ImageProblem | null {
  if (row === undefined || row.statusCode === null) {
    if (checkAskedNothing) return null;
    return { problem: "not-fetched", fetchClass: row === undefined ? null : row.fetchClass };
  }
  if (row.statusCode !== 200) return { problem: "status", statusCode: row.statusCode };
  if (row.bytes !== null && row.bytes > SOCIAL_IMAGE_MAX_BYTES) {
    return { problem: "too-large", bytes: row.bytes };
  }
  return null;
}

/**
 * One finding per judged page whose og:image or twitter:image has a problem.
 * Pages are read in URL order, in batches (`SOCIAL_IMAGE_BATCH`); each batch's
 * resolved images are looked up in ONE `resources` query by array parameter.
 * Node holds one batch (hard rule 6); `cappedListing` keeps the first
 * `caps.listing` and counts every one.
 */
async function imageBrokenFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const gate = await v2Gate(db, crawlId);
  if (!gate.recorded) return [];
  await assertCrawl(db, crawlId, self.id);
  const checkAskedNothing = await resourceCheckAskedNothing(db, crawlId, self.id);

  const out = cappedListing(self, caps);
  let cursor = "";
  for (;;) {
    const batch = await db
      .select({ id: pages.id, url: pages.url, social: pages.social })
      .from(pages)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          gt(pages.url, cursor),
          JUDGED("pages"),
          sql`(${pages.social} -> 'og' ->> 'image' <> '' or ${pages.social} -> 'x' ->> 'image' <> '')`,
        ),
      )
      .orderBy(asc(pages.url))
      .limit(SOCIAL_IMAGE_BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.url;

    const perPage = batch.map((page) => {
      if (page.social === null) {
        throw new Error(`${self.id}: page ${page.url} matched an image with no social column`);
      }
      // jsonb is not checked against the type: a v2 row written before the
      // refs were stored has none, and re-resolving its capped value instead
      // is the drift `imageRefs` exists to remove. Loud; a re-crawl fixes it.
      const refs = page.social.imageRefs as SocialFacts["imageRefs"] | undefined;
      if (refs === undefined) {
        throw new Error(
          `${self.id}: page ${page.url} has a social set with no imageRefs ` +
            `(written before they were recorded); re-crawl`,
        );
      }
      const found: Candidate[] = [];
      const og = page.social.og.image;
      const x = page.social.x.image;
      if (og !== undefined && og !== "") found.push(candidate("og:image", og, refs.og));
      if (x !== undefined && x !== "") found.push(candidate("twitter:image", x, refs.x));
      return { page, found };
    });

    const wanted = [
      ...new Set(
        perPage.flatMap(({ found }) => found.flatMap((c) => ("resolved" in c ? [c.resolved] : []))),
      ),
    ];
    const rows = new Map<string, ResourceRow>();
    if (wanted.length > 0) {
      const fetched = await db
        .select({
          url: resources.url,
          fetchClass: resources.fetchClass,
          statusCode: resources.statusCode,
          bytes: resources.bytes,
        })
        .from(resources)
        .where(and(eq(resources.crawlId, crawlId), inArray(resources.url, wanted)));
      for (const row of fetched) rows.set(row.url, row);
    }

    for (const { page, found } of perPage) {
      const problems = found.flatMap((c) => {
        const verdict =
          "verdict" in c ? c.verdict : fetchedVerdict(rows.get(c.resolved), checkAskedNothing);
        return verdict === null ? [] : [{ tag: c.tag, url: c.url, ...verdict }];
      });
      if (problems.length === 0) continue;
      out.add({
        pageId: page.id,
        pageUrl: page.url,
        evidence: { images: problems },
        dedupeKey: page.url,
      });
    }
  }
  return out.done();
}

export const socialQueryRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: DUPLICATE.id,
    checkIds: CHECKS,
    category: CATEGORY,
    severity: DUPLICATE.severity,
    columns: [
      { key: "field", label: "Tag" },
      { key: "value", label: "Shared Value" },
      { key: "count", label: "Occurrences" },
      { key: "pages", label: "Addresses" },
      { key: "alternatesCollapsed", label: "Alternates Collapsed" },
      { key: "paginationExcluded", label: "Paginated Pages Set Aside (Site-Wide)" },
    ],
    ...copyFor(DUPLICATE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => ogDuplicateFindings(DUPLICATE, db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: IMAGE_BROKEN.id,
    checkIds: CHECKS,
    category: CATEGORY,
    severity: IMAGE_BROKEN.severity,
    columns: [{ key: "images", label: "Image Problems" }],
    ...copyFor(IMAGE_BROKEN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => imageBrokenFindings(IMAGE_BROKEN, db, crawlId, capsOr(caps)),
  }),
];
