/**
 * The resource rules: what the crawl learned by asking for the files its pages
 * point at (P11-T3).
 *
 * THE SUBJECT IS THE FILE, NOT THE PAGE, which is why nothing here moved to the
 * judged cohort in Phase 22 §1: a broken image is broken for every page that
 * references it, and the referencing-page sample is a way to find it rather
 * than the thing being judged. The page-scoped cohort would silence a genuinely
 * broken asset because the one page sampled for it canonicalises elsewhere.
 *
 * Every rule here reads `resources` and `page_resources` and NOTHING ELSE about
 * the network — the resource fetch pass (src/crawl/resources/fetch-resources.ts)
 * is the only thing in this engine that asks a server for an asset, and a rule
 * that fetched would be hard rule 2's violation. What is stored is metadata:
 * status, content-type, transferred bytes, the two cache headers. No bodies, no
 * image decoding (owner decision 2), so nothing here can say a JPEG is
 * over-compressed or an image is larger than its layout box.
 *
 * ## THE UNFETCHED-IS-UNKNOWN BOUNDARY, which every rule below is built around
 *
 * `resources.fetch_class` is null for a reference the pass has not asked about —
 * because it has not run, was interrupted, or a cap stopped short of the row.
 * That is the null-vs-zero doctrine's newest citizen and the column comment in
 * src/db/schema.ts says so. Four more classes are unknowns of a different
 * shape, and none of them is a fault of the site's:
 *
 *  - `refused` — OUR policy refused the URL (SSRF, a non-http scheme). We never
 *    asked.
 *  - `robots_denied` — the host's robots.txt was read and disallowed it. We were
 *    not allowed to ask, and honouring that is hard rule 9.
 *  - `robots_unreachable` — the host could not tell us its rules, which RFC 9309
 *    §2.3.1.4 makes a complete disallow, so again we never asked (P12-T1). An
 *    unknown for the stronger reason: the host that would have answered was
 *    down, usually a third party's CDN and usually transiently.
 *  - `fetch_error` — we asked and the request did not complete (a timeout, a
 *    DNS or connection failure). Nobody told us anything about the file.
 *
 * A rule that lumped any of those in with `client_error`/`server_error` would
 * report a site as broken on evidence that says only "we do not know" (hard
 * rules 1 and 7). So each rule below excludes them from its verdict AND counts
 * them into its evidence, because a silence whose reason is invisible is the
 * same defect one step later: a page whose every resource is unfetched produces
 * no finding, and the reader has to be able to see why.
 *
 * ## THE SERVED HTML'S REFERENCES, AND ONLY THOSE
 *
 * The rows these rules read come from the analyzer over the HTML the server
 * sent. The render pass runs the same analyzer over the post-JavaScript DOM and
 * its resource refs are deliberately discarded (P11-T1), so an asset a
 * client-rendered site injects at runtime is invisible here. Every piece of copy
 * in this family carries that qualification, because "no oversized images" on a
 * site whose images arrive by script is a sentence about our evidence and not
 * about the site.
 *
 * ## WHICH CHECK EACH RULE CLAIMS, and why the plan's proposal was not it
 *
 * The Phase 11 plan proposed filing `resources.broken` under CHECK-49 for images
 * and CHECK-48 for scripts and stylesheets, with the implementer to verify the
 * split against the checklist's own text. Verified, and it does not hold:
 *
 *  - **CHECK-48** is "Render-blocking resources and JS bundle size", and its
 *    Evaluate line is `render-blocking resources > 3 or unused JS > 50%`. A
 *    stylesheet that 404s is neither a render-blocking count nor unused
 *    JavaScript. What this phase DOES answer there is bundle SIZE, which is a
 *    measurement rather than a fault — so the claim sits on `page.weight`
 *    (src/rules/metric/resource-metrics.ts), not here.
 *  - **CHECK-49** is "Image optimisation and responsive images", whose Evaluate
 *    line names `>100KB images` and modern formats. That is exactly
 *    `images.oversized` and `images.legacy-format`, and it is NOT a broken
 *    image: a file that 404s has no optimisation to discuss.
 *  - **CHECK-51** is "JavaScript errors and broken network requests", and its
 *    DevTools recipe is literally `list_network_requests — filter 4xx/5xx`. A
 *    resource that answered 4xx or 5xx IS a failed network request, and the
 *    engine now sees them across a whole crawl rather than on the three pages a
 *    browser session opens. `resources.broken` claims that check, for every kind
 *    at once — the fault is the same fault whether the file was an image, a
 *    stylesheet or a script — and the checklist entry now says which half of
 *    CHECK-51 the engine answers (console errors remain browser work).
 *
 * The checklist was edited in the same commit as these rules, hard rule 10's
 * discipline: CHECK-47's "nothing else about performance", CHECK-49's "image
 * WEIGHT and FORMAT are not measured (the crawler does not fetch image bytes)"
 * and CHECK-50's "caching headers … not stored" were all made false by this
 * phase and are gone.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
// The one class these rules name positively, imported rather than spelled `'ok'`
// in three statements: the fetch pass owns the vocabulary, and a bare literal
// here would typecheck for ever against a renamed one while the weight and
// caching rules quietly measured nothing (P11-T4 I-2).
import {
  RESOURCE_CAP_REASON,
  RESOURCE_OFF_REASON,
  RESOURCE_OK_CLASS,
  type ResourceFetchClass,
} from "../../crawl/resources/fetch-resources.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { IMAGE_WEIGHT_WARN } from "../thresholds.js";

/** Verdict thresholds live in `../thresholds.js`; re-exported so every existing import still resolves. */
export { IMAGE_WEIGHT_WARN } from "../thresholds.js";

/** Broken resources listed on one page's finding. The count is never sampled. */
export const BROKEN_SAMPLE_RESOURCES = 10;

/** Referencing pages listed on one oversized-image finding. */
export const OVERSIZED_SAMPLE_PAGES = 10;

/** URLs listed on the site-wide uncached finding. */
export const UNCACHED_SAMPLE_RESOURCES = 20;

/**
 * The two classes that mean A SERVER TOLD US THE FILE WAS NOT THERE.
 *
 * `fetch_error` is deliberately absent: a request that never completed is not a
 * server's verdict, and a flaky network on our side would otherwise be reported
 * to a client as their broken site. `refused`, `robots_denied` and
 * `robots_unreachable` are absent for the stronger reason that we never asked at
 * all. All four are counted as unknowns instead — see `UNKNOWN_CLASSES`.
 */
const BROKEN_CLASSES = ["client_error", "server_error"] as const;

/**
 * The classes that mean WE DO NOT KNOW, plus the null that means the same thing
 * and cannot be written in an `= any(...)` list.
 *
 * Every rule that reports a page's resources carries a count over this set, so a
 * reader can tell a page with two broken files and nothing else from a page with
 * two broken files and forty the pass never reached.
 *
 * `robots_unreachable` joined the list when P12-T1 split it out of
 * `robots_denied`, and it is an unknown for the stronger of the two reasons: we
 * never asked, AND the host that would have told us was down. A rule that
 * counted it as a fault would be reporting a third party's outage as a client's
 * broken site.
 *
 * TYPED AS `ResourceFetchClass[]`, not left as a bare tuple: the fetch pass owns
 * this vocabulary and a member renamed there must not leave a literal here
 * silently matching nothing. The compiler is what checks the four names against
 * the list they come from — the same discipline `RESOURCE_OK_CLASS` gets one
 * import above, applied where a set rather than a single name is needed
 * (P11-T4 I-2).
 */
const UNKNOWN_CLASSES: readonly ResourceFetchClass[] = [
  "refused",
  "robots_denied",
  "robots_unreachable",
  "fetch_error",
];

/** `fetch_class` is one of the unknowns, null included. */
const isUnknownClass = sql`(r.fetch_class is null
  or r.fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[]))`;

/**
 * `fetch_class` is one of the four DECIDED unknowns — null is deliberately NOT
 * one of them. `isUnknownClass` above folds null in because a null row is an
 * unknown to a judging rule's honesty count; `resources.all-unknown` needs the
 * opposite cut. A null row is a row nobody asked about (the `not-fetched`
 * marker's population), and this marker fires only when the crawl DID reach a
 * verdict on every file. So it counts the four classes and never the null.
 */
const isDecidedUnknownClass = sql`r.fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[])`;

/**
 * The content types `images.legacy-format` speaks about: the two raster formats
 * that predate WebP and AVIF and that a modern encoder reliably beats.
 *
 * Compared against the type the SERVER SENT rather than the URL's extension —
 * a CDN that content-negotiates serves `image/webp` from a `.jpg` path, and
 * judging the path would report the one site that already did the work.
 * `image/jpg` is not a registered type and is in the list anyway, because
 * servers send it.
 */
const LEGACY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg"] as const;

/** The bare type: `image/png; charset=binary` is `image/png`, lowercased. */
const bareContentType = sql`btrim(lower(split_part(r.content_type, ';', 1)))`;

/**
 * THE FAMILY'S POPULATION: files a page LOADS, which is a `resources` row with
 * at least one `page_resources` edge (Phase 26b, deviation 3).
 *
 * Since extraction 2 an `og:image` / `twitter:image` URL is a `resources` row
 * too — so the fetch pass learns its status and size for `social.image-broken`
 * — with NO edge, because a browser never loads a share image. Every statement
 * here that reads `resources` WITHOUT going through `page_resources` therefore
 * carries this condition: the file rules (a social image is not a page's file
 * to judge for type, weight, format or caching) and the four markers (they
 * explain the file rules' silence, so they count the same population — an
 * og-only `ok` row must not read as "partial coverage the judging rules carry"
 * when the judging rules cannot see it). `resources.broken` joins through the
 * edges already and needs nothing. Served by `page_resources_crawl_resource`.
 */
const LOADED_BY_A_PAGE = sql`exists (
  select 1 from page_resources pr_loaded
  where pr_loaded.crawl_id = r.crawl_id and pr_loaded.resource_url = r.url
)`;

/**
 * Which `resources` rows a census counts: the files a page loads (the family's
 * population), the og/X share images with no edge (deviation 3), or both.
 */
type CensusRows = "loaded" | "share-only" | "all";

/** How many rows were seen, how many the file check never decided, and why. */
export interface UnaskedCensus {
  seen: number;
  unfetched: number;
  /** Undecided rows stamped `RESOURCE_OFF_REASON` (the check was turned off). */
  offRows: number;
  /** Undecided rows with no reason at all (the check never reached them). */
  unaskedRows: number;
  /** Undecided rows stamped `RESOURCE_CAP_REASON` (a budget claimed them). */
  capRows: number;
}

/**
 * The fetch census `resources.not-fetched` decides on, over the rows `rows`
 * names. One statement for every reader, so "did the file check ask about
 * anything" has one answer (ruling R13).
 */
async function unaskedCensus(
  db: Db,
  crawlId: string,
  rows: CensusRows,
  ruleId: string,
): Promise<UnaskedCensus> {
  const scope =
    rows === "loaded"
      ? LOADED_BY_A_PAGE
      : rows === "share-only"
        ? sql`not ${LOADED_BY_A_PAGE}`
        : sql`true`;
  const result = await db.execute<{
    seen: number;
    unfetched: number;
    off_rows: number;
    unasked_rows: number;
    cap_rows: number;
  }>(sql`
    select
      count(*)::int as seen,
      count(*) filter (where r.fetch_class is null)::int as unfetched,
      count(*) filter (
        where r.fetch_class is null and r.fetch_reason = ${RESOURCE_OFF_REASON}
      )::int as off_rows,
      count(*) filter (
        where r.fetch_class is null and r.fetch_reason is null
      )::int as unasked_rows,
      count(*) filter (
        where r.fetch_class is null and r.fetch_reason = ${RESOURCE_CAP_REASON}
      )::int as cap_rows
    from resources r
    where r.crawl_id = ${crawlId} and ${scope}`);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${ruleId}: crawl '${crawlId}' resource-census query returned no row`);
  }
  return {
    seen: row.seen,
    unfetched: row.unfetched,
    offRows: row.off_rows,
    unaskedRows: row.unasked_rows,
    capRows: row.cap_rows,
  };
}

/**
 * THE PREDICATE: the file check decided none of the census's rows (an empty
 * census included: nothing was asked). `resources.not-fetched` fires on it, and
 * `social.image-broken` reads it over every row to tell an unfetched share
 * image on a crawl whose check ran (a specific gap it lists) from one on a
 * crawl whose check never asked anything (the marker's fact, said once).
 */
function askedNothing(census: UnaskedCensus): boolean {
  return census.unfetched === census.seen;
}

/**
 * Whether the file check asked about NO `resources` row of this crawl, page
 * files and share images alike: turned off, never run, or budgeted away before
 * its first request. `askedNothing` over the `all` census.
 */
export async function resourceCheckAskedNothing(
  db: Db,
  crawlId: string,
  ruleId: string,
): Promise<boolean> {
  return askedNothing(await unaskedCensus(db, crawlId, "all", ruleId));
}

/**
 * Pages referencing at least one resource a server answered 4xx or 5xx for.
 *
 * PAGE-CENTRIC, unlike `links.broken-internal` next door, and the difference is
 * deliberate: a broken internal link is one dead URL to fix once however many
 * pages point at it, while a broken resource is usually a template referencing a
 * file that moved — the same fault on every page the template renders — and the
 * page is where a client looks at it. The per-file view is not lost: the finding
 * names the files, and one dead file shared by four hundred pages is four
 * hundred findings only up to `caps.listing`, with the exact page count in the
 * truncation note.
 *
 * The `count(*) over ()` sits after the grouping and before the limit, so it
 * counts PAGES — the unit of the finding — and survives the cap.
 *
 * THE JOIN TO `pages` IS AN INNER JOIN, and that is the opposite choice from
 * `heavyImageFindings` below, deliberately. An edge whose `page_id` matches no
 * `pages` row — the lost-conflict case `page_resources`' header describes — has
 * nowhere to go here: this finding IS about a page, so a row with no page would
 * be an accusation naming nobody, carrying a `dedupeKey` built from a URL that
 * does not exist. The file findings are about a FILE and merely borrow a page to
 * point at, so they keep theirs with a `left join lateral` and report the file
 * with a null page beside it. Same table, two directions, two answers.
 *
 * `unknownResources` is the honesty half. It counts the page's references the
 * pass could not decide about, so a finding of "2 broken" on a page with 40
 * unknowns is legible as the partial answer it is.
 */
async function brokenFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const broken = sql`r.fetch_class = any(${sql.param([...BROKEN_CLASSES])}::text[])`;
  const result = await db.execute<{
    page_id: string;
    page_url: string;
    broken_count: number;
    unknown_count: number;
    total_matches: number;
    sample: unknown;
  }>(sql`
    with hit as (
      select pr.page_id, p.url as page_url,
             count(*)::int as broken_count,
             count(*) over ()::int as total_matches
      from page_resources pr
      join resources r on r.crawl_id = pr.crawl_id and r.url = pr.resource_url
      join pages p on p.crawl_id = pr.crawl_id and p.id = pr.page_id
      where pr.crawl_id = ${crawlId} and ${broken}
      group by pr.page_id, p.url
      order by p.url
      ${limitTo(caps.listing)}
    )
    select h.page_id, h.page_url, h.broken_count, h.total_matches,
           s.sample, u.unknown_count
    from hit h
    cross join lateral (
      select coalesce(jsonb_agg(sample.entry order by sample.url), '[]'::jsonb) as sample
      from (
        select r.url,
               jsonb_build_object(
                 'url', r.url,
                 'kind', r.kind,
                 'statusCode', r.status_code,
                 'fetchClass', r.fetch_class,
                 -- The reason travels with the status, always. A cf-mitigated
                 -- 200 lands client_error WITH status 200 (P11-T2), and
                 -- broken (HTTP 200) printed without refused by the server
                 -- beside it is an absurdity a client would be right to reject.
                 'fetchReason', r.fetch_reason
               ) as entry
        from page_resources pr
        join resources r on r.crawl_id = pr.crawl_id and r.url = pr.resource_url
        where pr.crawl_id = ${crawlId} and pr.page_id = h.page_id and ${broken}
        order by r.url
        limit ${BROKEN_SAMPLE_RESOURCES}
      ) sample
    ) s
    cross join lateral (
      select count(*)::int as unknown_count
      from page_resources pr
      join resources r on r.crawl_id = pr.crawl_id and r.url = pr.resource_url
      where pr.crawl_id = ${crawlId} and pr.page_id = h.page_id and ${isUnknownClass}
    ) u
    order by h.page_url`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.page_id,
      pageUrl: row.page_url,
      evidence: {
        brokenCount: row.broken_count,
        unknownResources: row.unknown_count,
        resources: row.sample,
      },
      dedupeKey: row.page_url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * The content types a script may be served as: the WHATWG Fetch standard's
 * "JavaScript MIME type essence" list, legacy spellings included, because a
 * server that sends `text/x-javascript` is declaring a script, not contradicting
 * one.
 */
const JS_CONTENT_TYPES = [
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
] as const;

/**
 * One finding per file whose served type contradicts what the markup said it
 * was: a stylesheet not served as `text/css`, a script not served as JavaScript,
 * an image not served as `image/*`.
 *
 * THE FILE IS THE SUBJECT, as in `heavyImageFindings`, and it is filed the same
 * way: the first referencing page in URL order carries the finding, `dedupeKey`
 * is the file, and the evidence names how many pages reference it and up to
 * `BROKEN_SAMPLE_RESOURCES` of them.
 *
 * ONLY A FILE THE SERVER ANSWERED 200 FOR, and only one the pass classed `ok`.
 * A 404 is `resources.broken`'s finding, and a bot challenge that answers 200
 * with an HTML body lands `client_error` (P11-T2): it is broken, not mistyped,
 * and reporting it here would file one fault twice. A row with no content type
 * has nothing to contradict and is not judged.
 *
 * The type is compared bare, lower-cased and before the first `;`, so
 * `text/css; charset=utf-8` is `text/css`.
 */
async function badContentTypeFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    url: string;
    kind: string;
    content_type: string | null;
    total_matches: number;
    page_count: number;
    sample_pages: string[];
    first_page_id: string | null;
    first_page_url: string | null;
  }>(sql`
    with bad as (
      select r.url, r.kind, r.content_type,
             count(*) over ()::int as total_matches
      from resources r
      where r.crawl_id = ${crawlId}
        and r.status_code = 200
        and r.fetch_class = ${RESOURCE_OK_CLASS}
        -- Deviation 3: a social-only image is no page's file (LOADED_BY_A_PAGE).
        and ${LOADED_BY_A_PAGE}
        and (
          (r.kind = 'css' and ${bareContentType} <> 'text/css')
          or (r.kind = 'js' and ${bareContentType} <> all(${sql.param([...JS_CONTENT_TYPES])}::text[]))
          or (r.kind = 'image' and ${bareContentType} not like 'image/%')
        )
      order by r.url
      ${limitTo(caps.listing)}
    )
    select b.url, b.kind, b.content_type, b.total_matches,
           refs.page_count, refs.sample_pages,
           first_page.page_id as first_page_id, first_page.page_url as first_page_url
    from bad b
    cross join lateral (
      select count(*)::int as page_count,
             coalesce(
               (array_agg(p.url order by p.url))[1:${BROKEN_SAMPLE_RESOURCES}],
               array[]::text[]
             ) as sample_pages
      from page_resources pr
      join pages p on p.crawl_id = pr.crawl_id and p.id = pr.page_id
      where pr.crawl_id = ${crawlId} and pr.resource_url = b.url
    ) refs
    left join lateral (
      select p.id as page_id, p.url as page_url
      from page_resources pr
      join pages p on p.crawl_id = pr.crawl_id and p.id = pr.page_id
      where pr.crawl_id = ${crawlId} and pr.resource_url = b.url
      order by p.url
      limit 1
    ) first_page on true
    order by b.url`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.first_page_id,
      pageUrl: row.first_page_url,
      evidence: {
        resourceUrl: row.url,
        kind: row.kind,
        contentType: row.content_type,
        pageCount: row.page_count,
        samplePages: row.sample_pages,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * One resource-centric finding: the file, its weight, and the pages carrying it.
 *
 * Shared by `images.oversized` and `images.legacy-format`, which differ only in
 * the predicate and in what their copy says — both are about ONE FILE, because
 * an image is uploaded once and referenced by a template, and a finding per
 * referencing page would report one job as three hundred.
 *
 * WHICH PAGE THE FINDING HANGS ON. `pageId`/`pageUrl` name the first referencing
 * page in URL order — the `title.duplicate` precedent, where a group finding
 * takes the first page of its group — so `issue_urls` gives a client somewhere
 * to look while `dedupeKey` and the evidence keep the FILE as the identity. Two
 * consequences, both deliberate: `site.health` counts one page per oversized
 * file rather than every page carrying it, and a resource whose every
 * referencing edge points at a page row the writer never wrote (the
 * lost-conflict case `page_resources`' header describes) still produces a
 * finding, with a null page beside it.
 *
 * The ordering is HEAVIEST FIRST with the URL as tie-break, so a capped run
 * reports the worst files rather than an alphabetical prefix of them, and two
 * runs over one crawl report the same ones (the deterministic-cap lesson).
 */
async function heavyImageFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  extra: ReturnType<typeof sql>,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    url: string;
    bytes: number;
    bytes_source: string | null;
    content_type: string | null;
    total_matches: number;
    referencing_pages: number;
    sample_pages: string[];
    first_page_id: string | null;
    first_page_url: string | null;
  }>(sql`
    with heavy as (
      select r.url, r.bytes, r.bytes_source, r.content_type,
             count(*) over ()::int as total_matches
      from resources r
      where r.crawl_id = ${crawlId}
        and r.kind = 'image'
        -- Only a file the pass actually weighed: ok with a byte count is the
        -- whole population: an unfetched image has no size, and a 404 has no
        -- size worth reporting either.
        and r.fetch_class = ${RESOURCE_OK_CLASS}
        and r.bytes is not null
        and r.bytes > ${IMAGE_WEIGHT_WARN}
        -- Deviation 3: a share image is heavy by design and no page loads it.
        and ${LOADED_BY_A_PAGE}
        and ${extra}
      order by r.bytes desc, r.url
      ${limitTo(caps.listing)}
    )
    select h.url, h.bytes, h.bytes_source, h.content_type, h.total_matches,
           refs.referencing_pages, refs.sample_pages,
           first_page.page_id as first_page_id, first_page.page_url as first_page_url
    from heavy h
    cross join lateral (
      select count(*)::int as referencing_pages,
             coalesce(
               (array_agg(p.url order by p.url))[1:${OVERSIZED_SAMPLE_PAGES}],
               array[]::text[]
             ) as sample_pages
      from page_resources pr
      join pages p on p.crawl_id = pr.crawl_id and p.id = pr.page_id
      where pr.crawl_id = ${crawlId} and pr.resource_url = h.url
    ) refs
    left join lateral (
      select p.id as page_id, p.url as page_url
      from page_resources pr
      join pages p on p.crawl_id = pr.crawl_id and p.id = pr.page_id
      where pr.crawl_id = ${crawlId} and pr.resource_url = h.url
      order by p.url
      limit 1
    ) first_page on true
    order by h.bytes desc, h.url`);

  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.first_page_id,
      pageUrl: row.first_page_url,
      evidence: {
        resourceUrl: row.url,
        bytes: row.bytes,
        // `header` is a claim the server made; `counted` is a measurement we
        // took. The copy explains the difference, so the number is never
        // quoted as more certain than it is.
        bytesSource: row.bytes_source,
        contentType: row.content_type,
        threshold: IMAGE_WEIGHT_WARN,
        referencingPages: row.referencing_pages,
        samplePages: row.sample_pages,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/** A cache header that actually declares something — blank is absent. */
const CACHE_DECLARED = sql`(nullif(btrim(r.cache_control), '') is not null
  or nullif(btrim(r.expires), '') is not null)`;

/**
 * One site-scoped finding: how many of the files this crawl fetched came back
 * with no caching instruction at all.
 *
 * Site-scoped and not per-file, because the answer is a policy rather than a
 * defect in one image: a server either sets caching headers on its static
 * assets or it does not, and a finding per file would be thousands of rows
 * saying one thing. The count is exact and the sample is capped, the shape the
 * duplicate-group rules use.
 *
 * It counts only `ok` rows: a resource nobody asked about has no headers to have
 * been missing, and reporting it would turn an unrun pass into a site's fault.
 * `unknownResources` on the evidence is what keeps that exclusion visible.
 */
async function uncachedFindings(self: RuleIdentity, db: Db, crawlId: string): Promise<Finding[]> {
  const result = await db.execute<{
    uncached: number;
    fetched: number;
    unknown: number;
    sample: string[];
  }>(sql`
    select
      count(*) filter (
        where r.fetch_class = ${RESOURCE_OK_CLASS} and not ${CACHE_DECLARED}
      )::int as uncached,
      count(*) filter (where r.fetch_class = ${RESOURCE_OK_CLASS})::int as fetched,
      count(*) filter (where ${isUnknownClass})::int as unknown,
      coalesce(
        (array_agg(r.url order by r.url)
           filter (where r.fetch_class = ${RESOURCE_OK_CLASS} and not ${CACHE_DECLARED})
        )[1:${UNCACHED_SAMPLE_RESOURCES}],
        array[]::text[]
      ) as sample
    from resources r
    -- Deviation 3: only files a page loads (LOADED_BY_A_PAGE).
    where r.crawl_id = ${crawlId} and ${LOADED_BY_A_PAGE}`);

  const row = result.rows[0];
  if (row === undefined) {
    // An aggregate with no GROUP BY returns one row over any input, including
    // none. No row means the statement did not run the way it reads.
    throw new Error(`${self.id}: crawl '${crawlId}' cache query returned no row`);
  }
  if (row.uncached === 0) return [];
  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        uncachedResources: row.uncached,
        fetchedResources: row.fetched,
        unknownResources: row.unknown,
        sampleResources: row.sample,
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * The NOT MEASURED marker for this whole family (`links.orphan-skipped`,
 * `content.thin-skipped` and `h1.duplicate-skipped`'s sibling).
 *
 * A crawl performed before Phase 11 has no `resources` rows at all, and so does
 * a crawl whose resource extraction never ran. Every judging rule above is then
 * silent, and `page.weight` reports each page's HTML as its whole weight — an
 * answer that reads like a light site and is really a crawl with nothing in it.
 * Two facts sharing one shape is the silent failure hard rule 7 forbids, so the
 * silence is reported rather than left to be inferred.
 *
 * THE CONDITION IS EVIDENCE OF A GAP, NOT AN ABSENCE OF ASSETS. It fires only
 * when the crawl holds no resource row AND at least one page counted an image
 * with the analyzer's own `images_total` — a counter every crawl since Phase 2
 * writes. A site whose served HTML declares no FETCHABLE references (a fully
 * client-rendered page, say) produces no `images_total` either and gets no
 * marker: this rule reports a hole in OUR evidence, never a fact about the site.
 *
 * "Fetchable" is the exact word and not a hedge. `images_total` counts every
 * `<img>` element, while the extraction drops the refs nothing can be asked for
 * — `data:` URIs, `javascript:`, fragment-only — so a page built entirely from
 * inline data URIs, with no external stylesheet or script beside them, counts
 * images and contributes no resource row. On a whole site of such pages this
 * marker fires and is RIGHT to: the resource rules are silent there, and
 * "nothing was measured" is what a reader needs to be told before reading their
 * silence. What the marker never does is mistake a site with no assets at all
 * for a crawl that failed to look — that site counts no images either.
 *
 * WHAT IT STILL DOES NOT COVER, and no longer has to: a crawl whose rows EXIST
 * and were never asked about. `resourcesSeen > 0` there, so this rule is silent
 * by construction — and since P12-T2 that case has its own marker,
 * `resources.not-fetched` below. The two conditions are complements over the
 * same number, which is what makes them mutually exclusive.
 */
async function notRecordedFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  const result = await db.execute<{
    resources_seen: number;
    pages_with_images: number;
    pages_crawled: number;
  }>(sql`
    select
      -- Deviation 3: a social-only row is not a recorded page resource.
      (select count(*)::int from resources r
        where r.crawl_id = ${crawlId} and ${LOADED_BY_A_PAGE}) as resources_seen,
      count(*) filter (where p.images_total > 0)::int as pages_with_images,
      count(*)::int as pages_crawled
    from pages p
    where p.crawl_id = ${crawlId}`);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${self.id}: crawl '${crawlId}' coverage query returned no row`);
  }
  if (row.resources_seen > 0 || row.pages_with_images === 0) return [];
  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        resourcesSeen: row.resources_seen,
        pagesWithImages: row.pages_with_images,
        pagesCrawled: row.pages_crawled,
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * The reasons a crawl can have SEEN every file and asked about none of them, and
 * the vocabulary the finding reports one of.
 *
 * Three values rather than a boolean because they are three different sentences
 * about our evidence, and the difference is what a reader does next. `off` is a
 * DECISION somebody took — a client who asked us not to touch their CDN, a
 * re-crawl that only needed the page census — and the answer is to run the crawl
 * again with the pass on. `notRun` is an ACCIDENT — a crawl stopped before the
 * pass sent its first request — and the answer is to finish the crawl. `cap` is
 * a BUDGET that claimed every row before anything was asked, which is a number
 * the operator chose and can raise. Copy is one text per rule, so the finding
 * says which in its evidence.
 *
 * Each is recognised by the reason string the WRITER puts on the row, not by
 * inference: `RESOURCE_OFF_REASON` from `markResourcesNotAsked`,
 * `RESOURCE_CAP_REASON` from the pass's closing statement, and the absence of
 * any reason at all, which is what a row nothing has touched carries. None of
 * them is a `fetch_class`: no request was made, so no verdict was reached, and
 * the null that means "seen, not yet asked" stands in all three.
 */
export const NOT_FETCHED_REASON = {
  off: "fetch-off",
  notRun: "pass-not-run",
  cap: "budget-cap",
} as const;

/**
 * The sentence that rides beside the class in the evidence, one per reason.
 *
 * On the `host.probe-skipped` model, whose evidence carries a `skipped`
 * sentence: a reader meeting this finding in a listing should not have to look
 * up what `budget-cap` means. Keyed by the reason so the compiler checks that
 * every member of the vocabulary above has one — a fourth reason with no
 * sentence would not compile rather than rendering `undefined` at a client.
 */
const NOT_ASKED_SENTENCE: Record<(typeof NOT_FETCHED_REASON)[keyof typeof NOT_FETCHED_REASON], string> = {
  [NOT_FETCHED_REASON.off]:
    "this crawl recorded every image, stylesheet and script its pages point at and " +
    "asked the site about none of them: it was started with `fetchResources: false`, " +
    "so the census is real and nothing was fetched",
  [NOT_FETCHED_REASON.notRun]:
    "this crawl recorded every image, stylesheet and script its pages point at and " +
    "asked the site about none of them: the fetch pass sent no request at all, which " +
    "is a crawl interrupted before it started asking or one whose pass never ran",
  [NOT_FETCHED_REASON.cap]:
    "this crawl recorded every image, stylesheet and script its pages point at and " +
    "asked the site about none of them: the resource budget (`maxResources`) claimed " +
    "every row before the pass asked about any of them, so the number to raise is the " +
    "one the crawl was started with",
};

/**
 * THE SIBLING MARKER: the crawl saw the files and asked about none of them.
 *
 * `resources.not-recorded` above reports a crawl with NO resource rows — a crawl
 * from before migration 0013, or one whose extraction never ran. This one
 * reports the case its condition deliberately excludes: the rows are there, the
 * census is real, and not one of them was ever put to a server. The four judging
 * rules are exactly as silent on such a crawl as they are on one with no rows at
 * all, and `page.weight` reports each page's HTML as its whole weight — so a
 * reader who meets no marker reads a light, clean site (hard rules 1 and 7).
 *
 * ## WHY A SIBLING RATHER THAN A WIDER `resources.not-recorded`
 *
 * The Phase 11 gate ruled it (phase-11.md §10.3): widening the existing marker's
 * condition would change WHEN AN EXISTING RULE FIRES, which is a verdict change
 * a re-judged crawl would feel. A new rule is additive — a crawl gains a finding
 * it could not receive before, which is the ruleset bump this task makes
 * (0.9.0), and no existing verdict moves. `host.probe-skipped` is the house's
 * precedent for the shape: a marker that reports a crawl OPTION rather than
 * missing data, whose silence is not a pass.
 *
 * The two are MUTUALLY EXCLUSIVE BY CONSTRUCTION and the arithmetic is the whole
 * proof: that rule needs `resourcesSeen == 0`, this one `resourcesSeen > 0`. A
 * test drives both conditions and asserts it, so a later loosening of either has
 * to be deliberate.
 *
 * ## WHAT IT DOES NOT FIRE ON, each for its own reason
 *
 *  - **A pre-0013 crawl.** No rows, so nothing was seen; that is the other
 *    marker's fact and reporting it here would be two findings for one silence.
 *  - **A PARTIAL pass** — a cap that stopped short, an interrupted pass that had
 *    already asked about something. One decided row means the crawl DID measure,
 *    so a marker saying "nothing was measured" would be false. What such a crawl
 *    gets instead is the judging rules' own answer: `unknownResources` rides on
 *    every finding they write. THAT IS COVERAGE ONLY WHERE THEY WRITE ONE — see
 *    the window below, which this rule does not close.
 *  - **A normal completed pass**, where every row carries a class.
 *
 * ## HOW THE PASS ACTUALLY LEAVES ROWS UNASKED, since the reasons are read off
 * ## the rows rather than inferred
 *
 * Three writers, three shapes (`fetch-resources.ts`):
 *
 *  - `markResourcesNotAsked` stamps `RESOURCE_OFF_REASON` on every undecided row
 *    when the operator turned the pass off. It runs INSTEAD of the pass.
 *  - The pass's closing statement stamps `RESOURCE_CAP_REASON` on every
 *    undecided row when the resource BUDGET was claimed. The budget is claimed
 *    per slice at the top of a batch, before any of that slice is asked about —
 *    it is not `admit`'s doing; `admit` refuses on the HOST cap, per row, and
 *    writes its own reason inline.
 *  - An ABORT stamps nothing at all: its rows were interrupted, not budgeted
 *    away, and they keep both nulls. That guard was missing until P12-T2's
 *    review (C-1) and is now the condition on the statement itself.
 *
 * So a census of nothing but `resource-cap` rows means a budget claimed them all
 * before the pass asked about any of them. The pass no longer produces it — one
 * row of the claimed slice is asked about unless the caller aborts, and an abort
 * leaves nulls — but this rule reads a TABLE, not a pass, and a shape it met and
 * threw on would be the silence it exists to end. It is therefore RECOGNISED,
 * off the writer's own constant, rather than guessed at or excluded by argument.
 *
 * What is left is a genuine MIXTURE — two or three reasons in one census, none
 * of them true of the crawl as a whole. No writer produces that, each of the
 * three touching every undecided row or none, so the rule throws with the counts
 * rather than picking one (hard rule 7).
 *
 * ## THE WINDOW THIS MARKER DOES NOT CLOSE — NOW CLOSED BY THE THIRD SIBLING (P13-T2)
 *
 * A crawl whose every resource landed in an UNKNOWN CLASS — `refused`,
 * `robots_denied`, `robots_unreachable`, `fetch_error` — has decided rows, so
 * this rule is silent, and it has no `ok` row, so the four judging rules find
 * nothing to report and `page.weight` counts HTML alone. The
 * `unknownResources` counts that would explain it live ON findings, and no
 * finding was written: six rules quiet, no marker, exactly the shape
 * phase-11.md §10.3 refused to accept as "legible one surface over".
 *
 * It was legible one surface over — `crawl_status.resources` carries `failed`,
 * `robotsDenied`, `robotsUnreachable` and `fetch_error`'s share of `failed`, and
 * CHECK-83 is answered first — but that was never the same as a reader meeting a
 * marker. **`resources.all-unknown` below is that marker**, the third
 * sibling on this model (Phase 14's `resources.partial-unknown` became the
 * fourth), fired by "every row a decided unknown class on a crawl
 * that has rows". Phase 12 ledgered it as an owner-promotable pointer
 * (phase-12.md §10.1) because closing it meant another rule and another ruleset
 * bump; Phase 13 spent that bump (0.9.0 → 0.10.0). The window is closed, and the
 * five places that stated it open — this docblock, `talos-surface.md` §5.3, and
 * the CHECK-83/48/49/50/51 entries in the checklist — now name the marker.
 */
async function notFetchedFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  // Deviation 3: the census of files a page loads (LOADED_BY_A_PAGE).
  let row = await unaskedCensus(db, crawlId, "loaded", self.id);
  const pages = await db.execute<{ pages_crawled: number; pages_with_images: number }>(sql`
    select count(*)::int as pages_crawled,
           count(*) filter (where p.images_total > 0)::int as pages_with_images
    from pages p
    where p.crawl_id = ${crawlId}`);
  const pageRow = pages.rows[0];
  if (pageRow === undefined) {
    throw new Error(`${self.id}: crawl '${crawlId}' page-count query returned no row`);
  }
  if (row.seen === 0) {
    // NO FILE A PAGE LOADS WAS RECORDED. Usually `resources.not-recorded`'s
    // fact. But a crawl whose only rows are og/X share images (deviation 3: no
    // edge) and whose pages count no `<img>` gets no `resources.not-recorded`,
    // and when the file check asked about none of those share images either,
    // `social.image-broken` stays silent about them (ruling R13: it lists an
    // unfetched image only when the check DID run). This marker speaks for them
    // then, over the share-only rows, and only then: never while
    // `resources.not-recorded` fires (the two stay mutually exclusive), and
    // never on a decided share-only row, so an og-only `ok` row can no more
    // quiet `all-unknown` / `partial-unknown` than before (they do not read it).
    if (pageRow.pages_with_images > 0) return [];
    row = await unaskedCensus(db, crawlId, "share-only", self.id);
  }
  const seen = row.seen;
  // Nothing seen is the other marker's fact; one row fewer unfetched than seen
  // means something WAS decided, which is a pass that measured.
  if (seen === 0 || !askedNothing(row)) return [];

  // One reason true of the WHOLE census, or none. Each writer touches every
  // undecided row or none of them, so a count equal to `seen` is the writer
  // identifying itself; anything else is a mixture nobody wrote.
  const reason =
    row.offRows === seen
      ? NOT_FETCHED_REASON.off
      : row.unaskedRows === seen
        ? NOT_FETCHED_REASON.notRun
        : row.capRows === seen
          ? NOT_FETCHED_REASON.cap
          : null;
  if (reason === null) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' asked about none of its ${seen} resources and the ` +
        `unfetched rows carry a mixture of reasons — ${row.offRows} say ` +
        `'${RESOURCE_OFF_REASON}', ${row.capRows} say '${RESOURCE_CAP_REASON}', ` +
        `${row.unaskedRows} say nothing at all, and any remainder says something else ` +
        `again. No writer of ours produces a mixture: each stamps every undecided row ` +
        `or none`,
    );
  }
  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        reason,
        // The sentence beside the class, on the `host.probe-skipped` model: a
        // reader meeting this finding in a listing should not have to look up
        // what `fetch-off` means.
        notAsked: NOT_ASKED_SENTENCE[reason],
        // Equal by arithmetic — the gate above returned already if anything had
        // been decided — and both are reported because the EQUALITY is the
        // finding, in the vocabulary `crawl_status.resources` already uses.
        resourcesSeen: seen,
        resourcesSkipped: row.unfetched,
        pagesCrawled: pageRow.pages_crawled,
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * THE THIRD AND LAST MARKER (P13-T2): the crawl asked, and got nothing usable.
 *
 * The two markers above report a crawl that never learned anything about its
 * files — `resources.not-recorded` because it holds no resource rows,
 * `resources.not-fetched` because the rows are there and not one was put to a
 * server. This one reports the case both of them deliberately exclude: the rows
 * are there, EVERY one of them was put to a server (or refused before we asked,
 * or blocked, or timed out), and not one came back usable. Every row landed in
 * one of the four unknown classes — `refused`, `robots_denied`,
 * `robots_unreachable`, `fetch_error` — so the four judging rules find nothing
 * to report and `page.weight` counts each page's HTML alone, exactly as on a
 * crawl with no rows. A reader meeting no marker reads a light, clean site (hard
 * rules 1 and 7); this marker is what stands between them and that misreading.
 *
 * ## WHY A THIRD SIBLING, AND WHY THE BUMP
 *
 * Phase 12 stated this window and left it open on purpose (phase-12.md §10.1):
 * closing it means another marker, which means another rule and another ruleset
 * bump, and Phase 12's bump was spent. It is additive by the same argument the
 * other two markers are — a crawl gains a finding it could not receive before,
 * no existing verdict moves — which is the 0.9.0 → 0.10.0 bump this task makes.
 * `host.probe-skipped` is still the house precedent: a marker whose silence is
 * not a pass.
 *
 * ## MUTUALLY EXCLUSIVE WITH BOTH SIBLINGS, BY CONSTRUCTION
 *
 * The arithmetic is the whole proof and one test drives all three boundaries:
 *
 *  - `resources.not-recorded` needs `resourcesSeen == 0`; this needs
 *    `resourcesSeen > 0`.
 *  - `resources.not-fetched` needs every row UNFETCHED (`null == seen`); this
 *    needs every row DECIDED into an unknown class (`unknownDecided == seen`,
 *    and a null row is not a decided unknown). A row is null or non-null, never
 *    both, so no crawl satisfies both conditions with `seen > 0`.
 *
 * ## WHAT IT DOES NOT FIRE ON, each for its own reason
 *
 *  - **A crawl with even one `ok` row** — PARTIAL coverage. Something was
 *    measured, so the judging rules answer with their `unknownResources` counts
 *    beside their verdicts, and a marker saying "nothing came back usable" would
 *    be false. This is the same boundary the not-fetched marker draws around a
 *    partial pass.
 *  - **A crawl with even one BROKEN row** (`client_error` / `server_error`). A
 *    4xx/5xx is a usable verdict — `resources.broken` reports it — so the
 *    silence this marker explains is not present. `isDecidedUnknownClass`
 *    excludes broken, so a broken row makes `unknownDecided < seen` and the rule
 *    stays silent while `resources.broken` speaks. The window §10.1 named the
 *    four unknown classes precisely because a broken row is not one of them.
 *  - **A crawl with even one UNASKED row** (`fetch_class` null). That crawl is
 *    the not-fetched marker's, or a partial pass; a null row is not a decided
 *    verdict, so `unknownDecided < seen`. A partial pass whose asked rows are all
 *    unknown and whose rest is unasked — the mix a null row makes here — is
 *    `resources.partial-unknown`'s (P14-T1), the fourth sibling that closes the
 *    window phase-13.md §8 pointer 1 named one layer in from this one.
 *
 * ## THE EVIDENCE
 *
 * The per-class census — a count for each of the four unknown classes, every
 * one named even at zero — and the dominant class, so a reader knows which
 * sentence to read first. `crawl_status.resources` is the discriminator this
 * finding puts a name to: `fetched` at zero with `failed` carrying the census.
 * The dominant is picked by count with `UNKNOWN_CLASSES` order as the tie-break,
 * so two runs over one crawl name the same one (the deterministic-cap lesson).
 */
async function allUnknownFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  const result = await db.execute<{
    resources_seen: number;
    unknown_decided: number;
    census: Record<string, number>;
    pages_crawled: number;
  }>(sql`
    with census as (
      select r.fetch_class as fetch_class, count(*)::int as n
      from resources r
      -- Deviation 3: the census of files a page loads (LOADED_BY_A_PAGE).
      where r.crawl_id = ${crawlId} and ${LOADED_BY_A_PAGE}
      group by r.fetch_class
    )
    select
      (select coalesce(sum(n), 0)::int from census) as resources_seen,
      (select coalesce(sum(n), 0)::int from census
         where fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[])) as unknown_decided,
      (select coalesce(jsonb_object_agg(fetch_class, n), '{}'::jsonb) from census
         where fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[])) as census,
      (select count(*)::int from pages p where p.crawl_id = ${crawlId}) as pages_crawled`);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${self.id}: crawl '${crawlId}' all-unknown census query returned no row`);
  }
  const seen = row.resources_seen;
  // Nothing seen is `resources.not-recorded`'s fact; one row that is NOT a
  // decided unknown — an `ok`, a broken 4xx/5xx, or a still-unasked null —
  // means the silence this marker explains is not present, and one of the other
  // rules speaks instead.
  if (seen === 0 || row.unknown_decided !== seen) return [];

  // Report every class, even at zero, so the shape of the evidence is stable
  // across crawls and a reader is never left wondering whether a class was
  // absent or omitted. Filled from the four names the fetch pass owns.
  const census: Record<string, number> = {};
  for (const cls of UNKNOWN_CLASSES) census[cls] = row.census[cls] ?? 0;
  // Dominant by count, `UNKNOWN_CLASSES` order breaking a tie — deterministic,
  // so the finding is byte-stable over re-runs of one crawl.
  let dominantClass: ResourceFetchClass = UNKNOWN_CLASSES[0]!;
  for (const cls of UNKNOWN_CLASSES) {
    if (census[cls]! > census[dominantClass]!) dominantClass = cls;
  }

  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        resourcesSeen: seen,
        census,
        dominantClass,
        pagesCrawled: row.pages_crawled,
      },
      dedupeKey: "site",
    }),
  ];
}

/**
 * THE FOURTH AND LAST MARKER (P14-T1): a PARTIAL pass whose decided rows are all
 * unknown, and the rest of the census still unasked.
 *
 * The three markers above each report a crawl that is UNIFORM in one way:
 * `resources.not-recorded` has no rows, `resources.not-fetched` has rows and not
 * one was asked about (`null == seen`), `resources.all-unknown` asked about every
 * row and not one came back usable (`decidedUnknown == seen`). This one reports
 * the crawl none of them can: a genuine MIX. Some rows are `null` (the pass never
 * reached them), the rest landed in a decided-unknown class — `refused`,
 * `robots_denied`, `robots_unreachable`, `fetch_error` — and there is no `ok` row
 * and no broken (4xx/5xx) row. So the four judging rules gate on an `ok` class and
 * go quiet, `resources.broken` has no broken row to report, and `page.weight`
 * counts each page's HTML alone — six rules silent, and until this marker not one
 * finding to explain it. A reader meeting no marker reads a light, clean site
 * (hard rules 1 and 7); this marker stands between them and that misreading.
 *
 * This is the window phase-13.md §8 pointer 1 named, one layer in from the §10.1
 * window `resources.all-unknown` closed. The two siblings each drew their boundary
 * around a partial pass and left it to the judging rules' `unknownResources`
 * counts — but those counts ride on findings, and a partial pass with no `ok` row
 * writes none. The silence had no speaker. This marker is it.
 *
 * ## WHY A FOURTH MARKER RATHER THAN A WIDER `resources.not-fetched` OR `all-unknown`
 *
 * Widening either sibling would corrupt a meaning the family keeps sharp.
 * `resources.not-fetched`'s premise is "the crawl asked about NONE of them", and
 * its evidence reports WHICH of three reasons — `fetch-off`, `pass-not-run`,
 * `budget-cap` — read off the null rows' `fetch_reason`. A partial pass DID ask
 * about some (the decided-unknown rows), and those rows carry none of those three
 * reasons, so widening not-fetched would either report a reason that is false of
 * the whole census or throw on the mixture it already refuses (the mixture guard
 * there is about the null rows' reasons, a different question). `resources.all-
 * unknown`'s premise is "the crawl asked about EVERY file", and a partial pass has
 * not finished asking — null rows are not a verdict. Widening it would make "every
 * file answered nothing usable" a sentence about a crawl that never asked about
 * some of its files. A fourth marker keeps each meaning honest.
 *
 * ## MUTUALLY EXCLUSIVE WITH ALL THREE SIBLINGS, BY CONSTRUCTION
 *
 * The four partition the "no `ok`, no broken, silent" space over `seen > 0`
 * exactly, and one test drives all four boundaries. Over `seen > 0` with no `ok`
 * and no broken row, `seen == unfetched + decidedUnknown`, and there are exactly
 * three cases:
 *
 *  - `decidedUnknown == 0` (every row null) → `resources.not-fetched`.
 *  - `unfetched == 0` (every row a decided unknown) → `resources.all-unknown`.
 *  - both `> 0` (the mix) → THIS marker.
 *
 * And `seen == 0` is `resources.not-recorded`'s. An `ok` row hands the crawl to
 * the judging rules (partial coverage they carry with `unknownResources`); a
 * broken row hands it to `resources.broken`. Both disqualify this marker, so it
 * never doubles with a rule that speaks.
 *
 * ## THE EVIDENCE
 *
 * Both halves of the census, so a reader sees the shape whole: `resourcesUnfetched`
 * is the null count (the part the pass never reached), and `census` is the per-
 * class count of the decided unknowns (every class named even at zero, the
 * `all-unknown` shape), with `dominantClass` naming the largest so a reader knows
 * which sentence to read first. The dominant is picked by count with
 * `UNKNOWN_CLASSES` order as the tie-break, so two runs over one crawl name the
 * same one (the deterministic-cap lesson).
 */
async function partialUnknownFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  const result = await db.execute<{
    resources_seen: number;
    ok_rows: number;
    broken_rows: number;
    unknown_decided: number;
    unfetched: number;
    census: Record<string, number>;
    pages_crawled: number;
  }>(sql`
    with census as (
      select r.fetch_class as fetch_class, count(*)::int as n
      from resources r
      -- Deviation 3: the census of files a page loads (LOADED_BY_A_PAGE).
      where r.crawl_id = ${crawlId} and ${LOADED_BY_A_PAGE}
      group by r.fetch_class
    )
    select
      (select coalesce(sum(n), 0)::int from census) as resources_seen,
      (select coalesce(sum(n), 0)::int from census
         where fetch_class = ${RESOURCE_OK_CLASS}) as ok_rows,
      (select coalesce(sum(n), 0)::int from census
         where fetch_class = any(${sql.param([...BROKEN_CLASSES])}::text[])) as broken_rows,
      (select coalesce(sum(n), 0)::int from census
         where fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[])) as unknown_decided,
      (select coalesce(sum(n), 0)::int from census
         where fetch_class is null) as unfetched,
      (select coalesce(jsonb_object_agg(fetch_class, n), '{}'::jsonb) from census
         where fetch_class = any(${sql.param([...UNKNOWN_CLASSES])}::text[])) as census,
      (select count(*)::int from pages p where p.crawl_id = ${crawlId}) as pages_crawled`);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${self.id}: crawl '${crawlId}' partial-unknown census query returned no row`);
  }
  const seen = row.resources_seen;
  // The mix, and only the mix. Nothing seen is `not-recorded`'s. Any `ok` row is
  // partial coverage the judging rules carry; any broken row is `resources.broken`'s
  // — either means the silence this marker explains is not present. Every row null
  // is `not-fetched`'s (`unfetched == seen`); every row a decided unknown is
  // `all-unknown`'s (`unknown_decided == seen`). What is left is both halves
  // present with no usable or broken row beside them.
  if (
    seen === 0 ||
    row.ok_rows > 0 ||
    row.broken_rows > 0 ||
    row.unfetched === 0 ||
    row.unknown_decided === 0
  )
    return [];

  // Report every class, even at zero, so the shape of the evidence is stable
  // across crawls — the `all-unknown` convention. Filled from the four names the
  // fetch pass owns.
  const census: Record<string, number> = {};
  for (const cls of UNKNOWN_CLASSES) census[cls] = row.census[cls] ?? 0;
  // Dominant by count, `UNKNOWN_CLASSES` order breaking a tie — deterministic.
  let dominantClass: ResourceFetchClass = UNKNOWN_CLASSES[0]!;
  for (const cls of UNKNOWN_CLASSES) {
    if (census[cls]! > census[dominantClass]!) dominantClass = cls;
  }

  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        resourcesSeen: seen,
        resourcesUnfetched: row.unfetched,
        census,
        dominantClass,
        pagesCrawled: row.pages_crawled,
      },
      dedupeKey: "site",
    }),
  ];
}

const CATEGORY = "technical" as const;

const BROKEN: RuleIdentity = { id: "resources.broken", severity: "warning" };
const OVERSIZED: RuleIdentity = { id: "images.oversized", severity: "warning" };
const LEGACY: RuleIdentity = { id: "images.legacy-format", severity: "info" };
const BAD_CONTENT_TYPE: RuleIdentity = { id: "resources.bad-content-type", severity: "info" };
const UNCACHED: RuleIdentity = { id: "resources.uncached", severity: "info" };
const NOT_RECORDED: RuleIdentity = { id: "resources.not-recorded", severity: "info" };
const NOT_FETCHED: RuleIdentity = { id: "resources.not-fetched", severity: "info" };
const ALL_UNKNOWN: RuleIdentity = { id: "resources.all-unknown", severity: "info" };
const PARTIAL_UNKNOWN: RuleIdentity = { id: "resources.partial-unknown", severity: "info" };

export const resourceRules: QueryRule[] = [
  // A failed network request, which is what CHECK-51 asks for by name — see the
  // module header for why neither CHECK-48 nor CHECK-49 is the honest filing.
  defineRule<QueryRule>({
    kind: "query",
    id: BROKEN.id,
    checkIds: ["CHECK-51"],
    category: CATEGORY,
    severity: BROKEN.severity,
    columns: [
      { key: "brokenCount", label: "Broken Resources" },
      { key: "resources", label: "Resources" },
      { key: "unknownResources", label: "Unknown Resources" },
    ],
    ...copyFor(BROKEN.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => brokenFindings(BROKEN, db, crawlId, capsOr(caps)),
  }),

  // The file answered 200 and said it was something other than what the markup
  // called it. Info: a browser ignores a mistyped stylesheet, but an image often
  // still renders, so it is a fault to fix rather than an outage. CHECK-51 is
  // where broken files already live.
  defineRule<QueryRule>({
    kind: "query",
    id: BAD_CONTENT_TYPE.id,
    checkIds: ["CHECK-51"],
    category: CATEGORY,
    severity: BAD_CONTENT_TYPE.severity,
    columns: [
      { key: "resourceUrl", label: "Resource URL" },
      { key: "kind", label: "Type" },
      { key: "contentType", label: "Content Type" },
      { key: "pageCount", label: "Inlinks" },
      { key: "samplePages", label: "Source" },
    ],
    ...copyFor(BAD_CONTENT_TYPE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      badContentTypeFindings(BAD_CONTENT_TYPE, db, crawlId, capsOr(caps)),
  }),

  // CHECK-49's own Evaluate line: `WARN if >100KB images on key pages`. Over
  // every page of the crawl rather than the key ones, which is the difference
  // between a crawl and a browser session.
  defineRule<QueryRule>({
    kind: "query",
    id: OVERSIZED.id,
    checkIds: ["CHECK-49"],
    category: CATEGORY,
    severity: OVERSIZED.severity,
    columns: [
      { key: "resourceUrl", label: "Image URL" },
      { key: "contentType", label: "Content Type" },
      { key: "bytes", label: "Size (Bytes)" },
      { key: "bytesSource", label: "Size Source" },
      { key: "threshold", label: "Threshold (Bytes)" },
      { key: "referencingPages", label: "IMG Inlinks" },
      { key: "samplePages", label: "Source" },
    ],
    ...copyFor(OVERSIZED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      heavyImageFindings(OVERSIZED, db, crawlId, sql`true`, capsOr(caps)),
  }),

  // The other half of CHECK-49's line ("no modern formats"), and INFO rather
  // than warning on purpose: a format is a choice. PNG is the right answer for
  // a screenshot with sharp edges and the only answer for some pipelines, so
  // this reports a candidate for conversion, never a defect. It is a subset of
  // `images.oversized` by construction — same threshold — because a small PNG
  // costs nobody anything and converting it would be work for its own sake.
  defineRule<QueryRule>({
    kind: "query",
    id: LEGACY.id,
    checkIds: ["CHECK-49"],
    category: CATEGORY,
    severity: LEGACY.severity,
    columns: [
      { key: "resourceUrl", label: "Image URL" },
      { key: "contentType", label: "Content Type" },
      { key: "bytes", label: "Size (Bytes)" },
      { key: "bytesSource", label: "Size Source" },
      { key: "threshold", label: "Threshold (Bytes)" },
      { key: "referencingPages", label: "IMG Inlinks" },
      { key: "samplePages", label: "Source" },
    ],
    ...copyFor(LEGACY.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      heavyImageFindings(
        LEGACY,
        db,
        crawlId,
        sql`${bareContentType} = any(${sql.param([...LEGACY_IMAGE_TYPES])}::text[])`,
        capsOr(caps),
      ),
  }),

  // CHECK-50 evaluates `no caching headers`, which was browser work until the
  // pass started recording the two headers. Info: a missing `Cache-Control` on
  // a static asset is a cost rather than an error, and on a hashed-filename
  // build system it is the one thing that is trivially free to fix.
  defineRule<QueryRule>({
    kind: "query",
    id: UNCACHED.id,
    checkIds: ["CHECK-50"],
    category: CATEGORY,
    severity: UNCACHED.severity,
    columns: [
      { key: "uncachedResources", label: "Uncached Resources" },
      { key: "fetchedResources", label: "Fetched Resources" },
      { key: "unknownResources", label: "Unknown Resources" },
      { key: "sampleResources", label: "Resources" },
    ],
    ...copyFor(UNCACHED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => uncachedFindings(UNCACHED, db, crawlId),
  }),

  // The marker claims every check whose silence it explains — the
  // `content.thin-skipped` contract, which claims the checks of the rule it
  // stands in for. CHECK-48 is on the list because `page.weight` is as blind on
  // such a crawl as the four rules above are. CHECK-87 since Phase 26b: a share
  // image's status and size come from the same file check.
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_RECORDED.id,
    checkIds: ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51", "CHECK-85", "CHECK-87"],
    category: CATEGORY,
    severity: NOT_RECORDED.severity,
    columns: [
      { key: "resourcesSeen", label: "Resources Seen" },
      { key: "pagesWithImages", label: "Pages With Images" },
      { key: "pagesCrawled", label: "Pages Crawled" },
    ],
    ...copyFor(NOT_RECORDED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl recorded no image, stylesheet or script references, so file checks were not run; re-crawl the site.",
    run: (db, crawlId) => notRecordedFindings(NOT_RECORDED, db, crawlId),
  }),

  // The sibling marker (P12-T2), claiming the same four checks as the marker
  // beside it and for the same reason: the silence it explains is the same
  // silence — the four judging rules quiet and `page.weight` counting HTML
  // alone. Which of the two speaks is decided by whether the crawl has rows.
  // CHECK-87 since Phase 26b, as its sibling: a share image is fetched by the
  // same file check. When the check asked about nothing this marker (or its
  // sibling) is the one voice for the share images (ruling R13); when it ran,
  // `social.image-broken` lists each share image it missed.
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_FETCHED.id,
    checkIds: ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51", "CHECK-87"],
    category: CATEGORY,
    severity: NOT_FETCHED.severity,
    columns: [
      { key: "reason", label: "Reason" },
      { key: "notAsked", label: "Explanation" },
      { key: "resourcesSeen", label: "Resources Seen" },
      { key: "resourcesSkipped", label: "Resources Skipped" },
      { key: "pagesCrawled", label: "Pages Crawled" },
    ],
    ...copyFor(NOT_FETCHED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "The files the pages reference were listed but not requested (file check off, crawl interrupted, or budget spent), so file checks were not run; re-run with the file check on or resume the crawl.",
    run: (db, crawlId) => notFetchedFindings(NOT_FETCHED, db, crawlId),
  }),

  // The third marker (P13-T2), claiming the same four checks as the two
  // beside it and for the same reason: the silence it explains is the same
  // silence — the four judging rules quiet and `page.weight` counting HTML
  // alone. Which of the three speaks is decided by whether the crawl has rows
  // (none / all-null / all-decided-unknown), and no crawl satisfies two. This
  // one closes the window phase-12.md §10.1 stated and left open.
  defineRule<QueryRule>({
    kind: "query",
    id: ALL_UNKNOWN.id,
    checkIds: ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51"],
    category: CATEGORY,
    severity: ALL_UNKNOWN.severity,
    columns: [
      { key: "dominantClass", label: "Dominant Fetch Class" },
      { key: "census", label: "Fetch Class Census" },
      { key: "resourcesSeen", label: "Resources Seen" },
      { key: "pagesCrawled", label: "Pages Crawled" },
    ],
    ...copyFor(ALL_UNKNOWN.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "Every file the crawl recorded was refused, disallowed, behind an unreachable robots.txt or unanswered, so file checks were not run; crawl again once the block has cleared.",
    run: (db, crawlId) => allUnknownFindings(ALL_UNKNOWN, db, crawlId),
  }),

  // The fourth and last marker (P14-T1), claiming the same four checks as the
  // three beside it and for the same reason: the silence it explains is the same
  // silence — the four judging rules quiet and `page.weight` counting HTML alone.
  // Which of the four speaks is decided by the shape of the census (none /
  // all-null / all-decided-unknown / the mix of null and decided-unknown), and no
  // crawl satisfies two. This one closes the window phase-13.md §8 pointer 1
  // named — the partial pass whose asked rows are all unknown and the rest
  // unasked, with no ok or broken row for any judging rule to ride on.
  defineRule<QueryRule>({
    kind: "query",
    id: PARTIAL_UNKNOWN.id,
    checkIds: ["CHECK-48", "CHECK-49", "CHECK-50", "CHECK-51"],
    category: CATEGORY,
    severity: PARTIAL_UNKNOWN.severity,
    columns: [
      { key: "dominantClass", label: "Dominant Fetch Class" },
      { key: "census", label: "Fetch Class Census" },
      { key: "resourcesSeen", label: "Resources Seen" },
      { key: "resourcesUnfetched", label: "Resources Unfetched" },
      { key: "pagesCrawled", label: "Pages Crawled" },
    ],
    ...copyFor(PARTIAL_UNKNOWN.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "Only some files were tried and none answered usably, so file checks were not run; re-run the crawl to try all files afresh.",
    run: (db, crawlId) => partialUnknownFindings(PARTIAL_UNKNOWN, db, crawlId),
  }),
];
