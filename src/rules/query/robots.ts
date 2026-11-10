import { and, asc, eq, gt, sql } from "drizzle-orm";
import robotsParserImport from "robots-parser";

import { onRulesOrigin } from "../../crawl/parse/url-utils.js";
import type { Db } from "../../db/client.js";
import { ROBOTS_BLOCKED_REASON_PREFIX } from "../../crawl/discovery.js";
import { crawls, sitemapUrls } from "../../db/schema.js";
import { queryFinding, ROBOTS_BLOCKED, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  assertNormalisedSitemap,
  capsOr,
  limitTo,
  noteAtLeastTruncation,
  noteTruncation,
  readCrawlEvidence,
  robotsUnreadable,
  userAgentOf,
} from "./crawl-evidence.js";

/** The subset of robots-parser's surface this file uses. */
interface Robots {
  /** `undefined` when no group matches, the URL is unparseable, or it is another host's. */
  isAllowed(url: string, ua?: string): boolean | undefined;
  /** 1-based line of the rule that decided, or -1 when none did. */
  getMatchingLineNumber(url: string, ua?: string): number;
}

/**
 * robots-parser is CommonJS (`module.exports = fn`) with an ESM-shaped
 * `export default` in its .d.ts, so the imported value is the function itself
 * under Node's interop. Same cast, and same reason, as src/crawl/discovery.ts.
 */
const robotsParser = robotsParserImport as unknown as (url: string, robotstxt: string) => Robots;

/** Sitemap URLs read per round trip: a batch, never the whole table. */
export const SITEMAP_URL_BATCH = 500;

const MISSING: RuleIdentity = { id: "robots.missing", severity: "info" };
const BLOCKS: RuleIdentity = { id: "robots.blocks-sitemap-urls", severity: "critical" };
const SKIPPED: RuleIdentity = { id: "robots.check-skipped", severity: "info" };
const INTERNAL: RuleIdentity = { id: "robots.blocks-internal-urls", severity: "warning" };

/**
 * Every sitemap URL of one crawl, in batches, oldest-first by URL.
 *
 * Each entry arrives in both of its spellings: the `<loc>` the site published,
 * and the `normalizeUrl` form the crawler would have fetched it under. The
 * second is what the judgement uses, so this rule asks robots.txt about the
 * very URL the crawler's own enqueue check asked about; the first is what the
 * finding quotes.
 *
 * A crawl's sitemap can hold tens of thousands of entries, so they are streamed
 * by URL cursor and dropped as they are judged: RAM is O(batch), never O(URLs)
 * (hard rule 6). The cursor is the primary key's second column, which makes the
 * scan an index range rather than a repeated sort.
 */
async function eachSitemapUrl(
  db: Db,
  crawlId: string,
  visit: (url: string, urlNormalised: string) => void,
): Promise<void> {
  let cursor = "";
  for (;;) {
    const batch = await db
      .select({ url: sitemapUrls.url, urlNormalised: sitemapUrls.urlNormalised })
      .from(sitemapUrls)
      .where(and(eq(sitemapUrls.crawlId, crawlId), gt(sitemapUrls.url, cursor)))
      .orderBy(asc(sitemapUrls.url))
      .limit(SITEMAP_URL_BATCH);
    if (batch.length === 0) return;
    cursor = batch[batch.length - 1]!.url;
    for (const row of batch) visit(row.url, row.urlNormalised);
  }
}

/**
 * Sitemap URLs the site's own robots.txt disallows for the agent this crawl
 * ran as.
 *
 * The robots.txt text is re-parsed out of `crawls.discovery_jsonb` — a database
 * read, not a fetch (hard rules 2 and 3) — and each entry is asked about
 * individually, because a `Disallow` is a prefix rule with wildcards and the
 * answer cannot be expressed in SQL.
 *
 * Three deliberate silences:
 *  - `isAllowed(...) === false` is the firing condition, NOT
 *    `isDisallowed(...) === true`. robots-parser defines the second as the
 *    negation of the first, so the `undefined` it returns for a URL it cannot
 *    parse, or one belonging to a genuinely different site, inverts into
 *    "disallowed" and would report every such sitemap entry as blocked. A
 *    robots.txt governs its own origin (RFC 9309 §2.2.1); about another site
 *    it says nothing.
 *
 *    "Another origin" here means another SITE, not another spelling of this
 *    one. Every entry is put through `onRulesOrigin` first — the same rewrite
 *    the crawler's own robots check uses — so a sitemap listing
 *    `https://www.site.com/admin` while robots.txt was read from the apex is
 *    judged by the rules that actually governed the crawl. Without it this
 *    rule would report as allowed the very URLs the crawler itself refused to
 *    fetch.
 *  - an absent robots.txt (`raw === null`, outcome `absent`) disallows nothing:
 *    allow-all is the protocol's own reading of a 404 (§2.3.1.3).
 *  - a robots.txt this crawl could not read whole is refused outright, by the
 *    same gate `sitemap.missing` uses; `robots.check-skipped` reports it.
 *
 * The base URL passed to the parser is the site's own `/robots.txt`. If the
 * site redirected that request to another origin, the entries the redirect
 * target's rules govern are on that other origin and read as "not ours" —
 * silence, never a false accusation.
 */
async function blockedFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  const evidence = await readCrawlEvidence(db, crawlId, BLOCKS.id);
  // The fifth reader of `url_normalised`, gated for the same reason as the four
  // that join it — but failing the other way round. An empty spelling is not a
  // URL robots-parser can judge, so it answers `undefined` and this rule stays
  // silent about a sitemap it never actually checked: a false ALL-CLEAR, which
  // is the one outcome worse than a false accusation. Same refusal, same
  // remedy.
  await assertNormalisedSitemap(db, crawlId, BLOCKS.id);
  if (robotsUnreadable(evidence.discovery) !== null) return [];
  const raw = evidence.discovery.robots.raw;
  if (raw === null) return [];

  const userAgent = userAgentOf(evidence, BLOCKS.id, crawlId);
  const robotsUrl = new URL("/robots.txt", evidence.siteUrl).href;
  const rulesOrigin = new URL(robotsUrl).origin;
  const parsed = robotsParser(robotsUrl, raw);
  // Split once, not once per URL: `raw` is up to 500KB and a run may be
  // uncapped, so the naive spelling would rebuild the array once per finding.
  const lines = raw.split(/\r?\n/);

  // The scan continues past the cap rather than stopping at it: `total` is the
  // real number of blocked entries, and a finding that said "200" when the
  // answer was four thousand would understate the fault. Only the count grows
  // past the cap — the findings array does not — so RAM stays O(batch).
  const findings: Finding[] = [];
  let total = 0;
  await eachSitemapUrl(db, crawlId, (url, urlNormalised) => {
    // Judged as the CRAWLER would have seen it — the normalised entry, on the
    // rules origin — and reported under the spelling the sitemap published:
    // `judged` never leaves this function. Judging the published `<loc>`
    // instead would ask robots.txt about a URL with a fragment on it, or with
    // its parameters in an order the crawler never used, and could disagree
    // with the enqueue check that actually governed the crawl.
    const judged = onRulesOrigin(urlNormalised, rulesOrigin);
    if (parsed.isAllowed(judged, userAgent) !== false) return;
    total++;
    if (caps.listing !== null && findings.length >= caps.listing) return;

    // The line that decided, quoted from the file the site serves, so the fix
    // is a place in a file rather than a claim to be taken on trust. -1 means
    // robots-parser matched no numbered rule, and then there is nothing honest
    // to quote.
    const line = parsed.getMatchingLineNumber(judged, userAgent);
    const text = line > 0 ? lines[line - 1] : undefined;
    findings.push(
      queryFinding(BLOCKS, {
        // No page id. The crawl never records a sitemap entry robots.txt
        // disallows as a page row (the `enqueue` guard in the crawl loop: the
        // entry is in `sitemap_urls`, and this rule is its report). Since
        // Phase 23 T3 the same URL MAY have a `disallowed` row because a page
        // also LINKS to it — that is `robots.blocks-internal-urls`' finding,
        // about the link, and this one stays about the sitemap line. The URL
        // is the evidence.
        pageId: null,
        pageUrl: url,
        evidence: {
          url,
          userAgent,
          ...(text === undefined ? {} : { matchedBy: { line, text: text.trim() } }),
        },
        dedupeKey: url,
      }),
    );
  });

  return noteTruncation(findings, total);
}

/**
 * Internal URLs robots.txt kept the crawler out of, each with the line that
 * did it and the internal links that point at it (Phase 23 T3, study D1).
 *
 * THE COHORT IS THE FETCH OUTCOME, NOT `isJudged` — the Phase 22 rule for
 * fetch-outcome rules (status, robots, render): the subject is a URL that was
 * never requested, so there is no page to judge. The rows are exactly
 * `ROBOTS_BLOCKED` (src/rules/helpers.ts): `fetch_class = 'disallowed'` with
 * the crawl loop's `robots.txt: <matching line>` reason. A `disallowed` row our
 * OWN url-policy wrote carries the policy's words instead and is not this
 * rule's — calling a policy refusal a robots.txt block would send a client to
 * edit a file that says nothing about the URL.
 *
 * WHAT IT READS IS WHAT THE CRAWL WROTE. Before Phase 23 such a URL was dropped
 * at enqueue with no row; now the loop records it (never requested — rule 5
 * still runs first, and robots is the reason no fetch follows) and stores the
 * deciding line, quoted from the robots.txt it read, in `fetch_reason`. The
 * line is read back here, not re-derived by re-parsing robots.txt, so the
 * finding says what governed the crawl at the moment it decided.
 *
 * "LINKED FROM CRAWLED PAGES" IS THE CONDITION, as the copy says it is: a
 * blocked row with no internal link pointing at it — the seed, or a URL only a
 * redirect named — is on record (Indexability Status `Blocked by robots.txt`)
 * but is not this finding. Sitemap entries are never recorded as rows at all:
 * `robots.blocks-sitemap-urls` reports those from `sitemap_urls`, and a URL
 * both listed and linked is two facts under two rules, not one counted twice.
 *
 * Target-centric, `links.broken-internal`'s shape and for its reason: one
 * blocked URL linked from every page is one decision to make, and the inlinks
 * report (`GET /crawls/:id/issues/robots.blocks-internal-urls/inlinks`) lists
 * the sources. `inlinks` counts distinct source pages, which is what the copy
 * promises. SQL only (hard rule 3); the `count(*) over ()` window sits after
 * the grouping and before the `limit`, so a capped listing keeps the exact
 * total of blocked URLs (`noteTruncation`).
 *
 * THE CRAWL'S OWN BUDGET IS THE OTHER TRUNCATION. Blocked rows have their own
 * budget (`CrawlConfig.maxBlockedUrls`); past it the loop counts
 * `crawls.robots_blocked_dropped` instead of writing a row. A non-zero count
 * means this list is incomplete in a way no query can repair — the URLs were
 * never written down — and the count is of DISCOVERIES turned away, not
 * distinct URLs, so the only honest magnitude is a floor: at least one more
 * than the rows on record (`noteAtLeastTruncation`). A NULL count is a crawl
 * written before migration 0020: nobody counted, which is not "nothing was
 * turned away", and it is read as unmeasured — no note — never as a fact.
 */
async function internalBlockedFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  // The siblings' gate, for their reason: a crawl row no completed discovery
  // produced (no robots.txt evidence on record) is not a crawl whose blocked
  // URLs can be judged, and it is refused rather than read as "none blocked".
  await readCrawlEvidence(db, crawlId, INTERNAL.id);
  const crawlRows = await db
    .select({ dropped: crawls.robotsBlockedDropped })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const crawl = crawlRows[0];
  if (crawl === undefined) throw new Error(`${INTERNAL.id}: no such crawl '${crawlId}'`);

  const result = await db.execute<{
    page_id: string;
    url: string;
    fetch_reason: string;
    inlinks: number;
    total_matches: number;
  }>(sql`
    with targets as (
      select p.id as page_id, p.url, p.fetch_reason,
             count(distinct l.source_page_id)::int as inlinks,
             count(*) over ()::int as total_matches
      from pages p
      join links l
        on l.crawl_id = ${crawlId} and l.target_url = p.url and l.is_internal
      where p.crawl_id = ${crawlId} and ${ROBOTS_BLOCKED("p")}
      group by p.id, p.url, p.fetch_reason
      order by p.url
      ${limitTo(caps.listing)}
    )
    select page_id, url, fetch_reason, inlinks, total_matches
    from targets
    order by url`);

  const findings = result.rows.map((row) => {
    // `ROBOTS_BLOCKED` selected on this prefix, so a row without it is a
    // predicate and a reader that disagree — our defect, loudly.
    if (!row.fetch_reason.startsWith(ROBOTS_BLOCKED_REASON_PREFIX)) {
      throw new Error(
        `${INTERNAL.id}: crawl '${crawlId}' row ${row.url} was selected as robots-blocked ` +
          `but its reason does not say so: '${row.fetch_reason}'`,
      );
    }
    return queryFinding(INTERNAL, {
      pageId: row.page_id,
      pageUrl: row.url,
      evidence: {
        matchedRule: row.fetch_reason.slice(ROBOTS_BLOCKED_REASON_PREFIX.length),
        inlinks: row.inlinks,
      },
      dedupeKey: row.url,
    });
  });

  const total = result.rows[0]?.total_matches ?? 0;
  if (crawl.dropped !== null && crawl.dropped > 0) {
    return noteAtLeastTruncation(findings, total + 1);
  }
  return noteTruncation(findings, total);
}

/**
 * The robots.txt rules.
 *
 * Four ids for one check, because copy is looked up by rule id and the four
 * statements are not interchangeable: "this site serves no robots.txt", "this
 * site's robots.txt blocks URLs its sitemap lists", "this site's robots.txt
 * blocks URLs its own pages link to" (Phase 23 T3), and "we could not read the
 * robots.txt well enough to say". Rendering the last under any of the others
 * would be a false statement to a client — the `links.orphan-skipped`
 * precedent.
 *
 * Each reads the crawl row for itself rather than sharing state: a rule that
 * depended on another rule having run first would be a rule that quietly
 * reports nothing when run alone.
 */
export const robotsRules: QueryRule[] = [
  // Fires only on `absent`, which is the site ANSWERING that it has no
  // robots.txt (a 4xx — RFC 9309 §2.3.1.3, allow-all). An `unreachable`
  // robots.txt is a server that could not answer, and calling that "no
  // robots.txt" would tell a client to write a file they may already have.
  // That crawl is reported by `robots.check-skipped`.
  defineRule<QueryRule>({
    kind: "query",
    id: MISSING.id,
    checkIds: ["CHECK-03"],
    category: "crawl",
    severity: MISSING.severity,
    columns: [
      { key: "outcome", label: "robots.txt Outcome" },
      { key: "note", label: "Note" },
    ],
    ...copyFor(MISSING.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const { discovery } = await readCrawlEvidence(db, crawlId, MISSING.id);
      if (discovery.robots.outcome !== "absent") return [];
      return [
        queryFinding(MISSING, {
          pageId: null,
          pageUrl: null,
          evidence: { outcome: discovery.robots.outcome, note: discovery.robots.note },
          dedupeKey: "site",
        }),
      ];
    },
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: BLOCKS.id,
    needsSitemaps: true,
    checkIds: ["CHECK-03"],
    category: "crawl",
    severity: BLOCKS.severity,
    columns: [
      { key: "userAgent", label: "User Agent" },
      { key: "matchedBy", label: "Matched Rule", optional: true },
    ],
    ...copyFor(BLOCKS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => blockedFindings(db, crawlId, capsOr(caps)),
  }),

  // Phase 23 T3 (study D1): the linked URLs robots.txt keeps the crawler out
  // of, recorded by the crawl instead of dropped. A warning where the sitemap
  // twin above is critical: a Disallow on a linked URL may well be intended
  // (a cart, an account area), and the finding asks the site to confirm it;
  // a sitemap that lists what robots.txt forbids contradicts itself. See
  // `internalBlockedFindings` for the cohort and the two truncations.
  defineRule<QueryRule>({
    kind: "query",
    id: INTERNAL.id,
    checkIds: ["CHECK-03"],
    category: "crawl",
    severity: INTERNAL.severity,
    columns: [
      { key: "matchedRule", label: "Matched Robots.txt Line" },
      { key: "inlinks", label: "Inlinks" },
    ],
    ...copyFor(INTERNAL.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => internalBlockedFindings(db, crawlId, capsOr(caps)),
  }),

  // A check we could not run is visible, never silent (hard rule 7). One
  // site-scoped finding naming the reason, at info severity: what it reports is
  // a limit of this crawl's evidence, not a fault found on the site.
  defineRule<QueryRule>({
    kind: "query",
    id: SKIPPED.id,
    checkIds: ["CHECK-03"],
    category: "crawl",
    severity: SKIPPED.severity,
    columns: [
      { key: "skipped", label: "Reason" },
      { key: "outcome", label: "robots.txt Outcome" },
      { key: "robotsTruncated", label: "robots.txt Truncated" },
    ],
    ...copyFor(SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "The robots.txt was truncated at the 500 KB read, could not be fetched, or was fetched empty, so robots.txt checks were not run; fix the file or the server and crawl again.",
    run: async (db, crawlId): Promise<Finding[]> => {
      const { discovery } = await readCrawlEvidence(db, crawlId, SKIPPED.id);
      const skipped = robotsUnreadable(discovery);
      if (skipped === null) return [];
      return [
        queryFinding(SKIPPED, {
          pageId: null,
          pageUrl: null,
          evidence: {
            skipped,
            outcome: discovery.robots.outcome,
            // `robotsTruncated`, not `truncated`: this says the stored
            // robots.txt is a 500KB prefix. `truncated` is the note a capped
            // listing writes into its last finding (`noteTruncation`), and one
            // evidence object must not spell two different facts the same way.
            robotsTruncated: discovery.robots.truncated,
          },
          dedupeKey: "site",
        }),
      ];
    },
  }),
];
