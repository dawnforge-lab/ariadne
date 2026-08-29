import { and, asc, eq, gt } from "drizzle-orm";
import robotsParserImport from "robots-parser";

import { onRulesOrigin } from "../../crawl/parse/url-utils.js";
import type { Db } from "../../db/client.js";
import { sitemapUrls } from "../../db/schema.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
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
const BLOCKS: RuleIdentity = { id: "robots.blocks-sitemap-urls", severity: "warning" };
const SKIPPED: RuleIdentity = { id: "robots.check-skipped", severity: "info" };

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
        // No page id: the crawl enqueues nothing robots.txt disallows (see the
        // `enqueue` guard in the crawl loop), so a URL reported here has no
        // `pages` row to attribute the finding to. The URL is the evidence.
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
 * The robots.txt rules.
 *
 * Three ids for one check, because copy is looked up by rule id and the three
 * statements are not interchangeable: "this site serves no robots.txt", "this
 * site's robots.txt blocks URLs its sitemap lists", and "we could not read the
 * robots.txt well enough to say". Rendering the third under either of the
 * others would be a false statement to a client — the `links.orphan-skipped`
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
    checkIds: ["CHECK-03"],
    category: "crawl",
    severity: BLOCKS.severity,
    ...copyFor(BLOCKS.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => blockedFindings(db, crawlId, capsOr(caps)),
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
    ...copyFor(SKIPPED.id),
    rulesetVersion: RULESET_VERSION,
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
