import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";

const CATEGORY = "redirects";

/**
 * How many pages one walk may visit. A redirect graph is a functional graph —
 * one target per page — so the only way to walk forever is a cycle, and the
 * cycle test below already stops those. The cap is here for the other case: a
 * chain long enough that reporting every hop helps nobody, and that would make
 * the recursive CTE's intermediate rows grow with the site.
 *
 * A chain cut short by the cap is reported with `truncated: true` rather than
 * silently presented as if it ended there.
 */
export const MAX_REDIRECT_HOPS = 10;

/** A chain is worth reporting from this many redirect hops up. */
const CHAIN_HOPS = 2;

/**
 * One terminal row of a walk: the last page reached from a given seed, with the
 * URLs and page ids of everything visited on the way.
 */
interface WalkRow extends Record<string, unknown> {
  /** The URL the walk started from. */
  head: string;
  /** URLs visited, in order, starting at the head. */
  chain: string[];
  /** `pages.id` for each URL in `chain`, same order. */
  ids: string[];
  depth: number;
  /** True when the last URL in `chain` had already been visited by this walk. */
  is_cycle: boolean;
  /**
   * Where the terminal page redirects to AS THE SERVER SPELLED IT, or null when
   * it answers for itself. Evidence only — every comparison uses the normalised
   * twin below, because `chain` is made of `pages.url` frontier keys.
   */
  redirect_url: string | null;
  /**
   * The same target through `normalizeUrl`: the spelling `pages.url` is keyed
   * by, and therefore the walk's join key, its cycle test and its
   * "was this crawled" test. Null exactly when `redirect_url` is.
   */
  redirect_url_normalised: string | null;
  /** The terminal page's own status code. */
  status_code: number | null;
  /**
   * Whether `redirect_url_normalised` has a `pages` row — i.e. whether the walk
   * could have gone on.
   */
  tail_crawled: boolean;
}

/**
 * Walk the redirect graph forward from a set of seed URLs, in SQL.
 *
 * The recursion follows `pages.redirect_url_normalised` to the `pages` row for
 * that URL, carrying the visited URLs along as an array so a revisit is
 * detectable in the same step that makes it (`p.url = any(w.chain)`), and
 * stopping at `MAX_REDIRECT_HOPS`. Non-redirect pages are visited too: the 200
 * (or the 404) a chain lands on is the most useful thing the evidence can name.
 *
 * The join is on the NORMALISED target, never on the published one.
 * `pages.url` is `normalizeUrl` output — fragment stripped, query params sorted
 * — so a `Location` reading `/b#section` matches no row under its own spelling
 * while naming a page the crawl certainly fetched. Joining the published
 * spelling made such a chain stop dead one hop in: a false negative in both
 * rules, invisible because a chain that ends is what most chains do.
 *
 * Only the deepest row per seed comes back — the terminal state of that walk.
 * Intermediate rows exist inside the CTE and are discarded by Postgres, so the
 * result set is one row per seed rather than one per hop.
 */
async function walkFrom(db: Db, crawlId: string, seedUrls: SQL): Promise<WalkRow[]> {
  const result = await db.execute<WalkRow>(sql`
    with recursive seeds as (${seedUrls}),
    walk as (
      select s.url as head, p.url as url, p.redirect_url as redirect_url,
             p.redirect_url_normalised as redirect_url_normalised,
             p.status_code as status_code, 1 as depth,
             array[p.url] as chain, array[p.id] as ids, false as is_cycle
      from seeds s
      join pages p on p.crawl_id = ${crawlId} and p.url = s.url
      union all
      select w.head, p.url, p.redirect_url, p.redirect_url_normalised,
             p.status_code, w.depth + 1,
             w.chain || p.url, w.ids || p.id, p.url = any(w.chain)
      from walk w
      join pages p on p.crawl_id = ${crawlId} and p.url = w.redirect_url_normalised
      where w.depth < ${MAX_REDIRECT_HOPS} and not w.is_cycle
    )
    select w1.head, w1.chain, w1.ids, w1.depth, w1.is_cycle,
           w1.redirect_url, w1.redirect_url_normalised, w1.status_code,
           exists (
             select 1 from pages q
             where q.crawl_id = ${crawlId} and q.url = w1.redirect_url_normalised
           ) as tail_crawled
    from walk w1
    where w1.depth = (select max(w2.depth) from walk w2 where w2.head = w1.head)`);
  return result.rows;
}

interface RedirectWalk {
  /** Terminal rows of the walks that started at a chain head. */
  fromHeads: WalkRow[];
  /** Terminal rows of the walks that started at a redirect no head reaches. */
  headless: WalkRow[];
}

/**
 * Every redirect path in the crawl, as terminal rows.
 *
 * Two passes, because one is not enough. The first walks from the chain HEADS —
 * redirect pages nothing else redirects to — which is where a client's chains
 * actually start and what makes "report the chain once" possible.
 *
 * The second exists for the shape the first cannot see: a cycle whose every
 * member is a redirect target (`a` -> `b` -> `a`, or a page pointing at itself)
 * has no head, so no head walk ever reaches it. Those pages are seeded from
 * themselves. Without this pass a redirect loop with no way in is invisible,
 * which is precisely the loop a visitor can never escape.
 *
 * The two are kept apart because chains are read out of the second pass only in
 * the one case where dropping them would hide something. In a graph where each
 * page has one target, a redirect no head reaches is always a cycle member —
 * walk backwards from it and, with no head to arrive at, the path must close on
 * itself. That holds while the walk is unbounded; with a hop cap, the second
 * pass also picks up the remainder of a chain the cap stopped following.
 *
 * A remainder that terminates normally is already reported at its real head, as
 * a truncated chain, so reporting it again would bill one over-long path as
 * several under a "head" that is really its eleventh hop. A remainder that
 * *itself* runs out of hops is a different matter: nothing anywhere reports it,
 * and it may equally be a ring longer than the cap. `unresolvedHeadless` is
 * what keeps that case visible.
 *
 * Memory: the visited set and the redirect-page list are O(redirect pages), not
 * O(URLs), and neither the links table nor the page table is loaded.
 */
async function redirectWalk(db: Db, crawlId: string): Promise<RedirectWalk> {
  const rows = await walkFrom(
    db,
    crawlId,
    sql`
      select p.url from pages p
      where p.crawl_id = ${crawlId} and p.fetch_class = 'redirect'
        and not exists (
          select 1 from pages q
          where q.crawl_id = ${crawlId}
            and q.fetch_class = 'redirect'
            and q.redirect_url_normalised = p.url)`,
  );

  const visited = new Set<string>();
  for (const row of rows) for (const url of row.chain) visited.add(url);

  const redirects = await db.execute<{ url: string }>(sql`
    select p.url from pages p
    where p.crawl_id = ${crawlId} and p.fetch_class = 'redirect'`);
  const headless = redirects.rows.map((r) => r.url).filter((url) => !visited.has(url));
  if (headless.length === 0) return { fromHeads: rows, headless: [] };

  return {
    fromHeads: rows,
    headless: await walkFrom(
      db,
      crawlId,
      sql`
        select p.url from pages p
        where p.crawl_id = ${crawlId} and p.url = any(${sql.param(headless)}::text[])`,
    ),
  };
}

/**
 * The cycle a terminal row proves, closing repeat included (`[d, e, d]`), or
 * null when the walk proved no cycle.
 *
 * Two ways a walk proves one, and the second matters as much as the first:
 *  - the recursion revisited a URL (`is_cycle`), so the repeat is the last
 *    element of the chain;
 *  - the recursion stopped at the hop cap and the terminal page's target is
 *    already IN the chain. The walk never took that step, so `is_cycle` is
 *    false, but the loop is proven all the same — a chain of p hops into a
 *    cycle of k, with p + k exactly at the cap, would otherwise be reported as
 *    a truncated chain: a warning where the truth is a critical nobody can
 *    reach the content through.
 *
 * The second test compares the NORMALISED target against `chain`, whose members
 * are `pages.url`. Comparing the published `Location` would miss a loop closed
 * by a hop whose target carries a fragment — the loop would be reported as a
 * chain, which is a warning where the truth is a critical.
 */
function cycleOf(row: WalkRow): string[] | null {
  if (row.is_cycle) {
    const repeated = row.chain[row.chain.length - 1]!;
    return row.chain.slice(row.chain.indexOf(repeated));
  }
  if (row.redirect_url_normalised === null) return null;
  const closesAt = row.chain.indexOf(row.redirect_url_normalised);
  return closesAt === -1
    ? null
    : [...row.chain.slice(closesAt), row.redirect_url_normalised];
}

/**
 * True when the walk ran out of hops without either landing somewhere or
 * closing a loop — so what happens past the cap is genuinely unknown.
 */
function hitCapUnresolved(row: WalkRow): boolean {
  return row.redirect_url_normalised !== null && row.tail_crawled && cycleOf(row) === null;
}

/**
 * The walks worth reporting as chains out of the headless pass.
 *
 * Most headless rows are cycles, and `redirect.loop` has them. The exception is
 * a walk that hit the cap without closing: either a ring longer than the cap,
 * or the tail of an over-long chain whose head reported its own truncation.
 * Which of the two it is cannot be known from ten hops, and dropping it would
 * be a redirect path the engine walked, could not resolve, and said nothing
 * about (hard rule 7). It is reported as a truncated chain from the seed —
 * every hop in the evidence is one we actually followed, and `truncated: true`
 * says the path did not end there.
 *
 * Deduped by coverage: seeds are walked in URL order and a seed already inside
 * an emitted walk's chain is skipped, so a 12-page ring is two findings rather
 * than twelve.
 */
function unresolvedHeadless(rows: WalkRow[]): WalkRow[] {
  const covered = new Set<string>();
  const out: WalkRow[] = [];
  for (const row of [...rows].sort((a, b) => a.head.localeCompare(b.head))) {
    if (!hitCapUnresolved(row) || covered.has(row.head)) continue;
    out.push(row);
    for (const url of row.chain) covered.add(url);
  }
  return out;
}

/**
 * Chains, one finding per head.
 *
 * A walk that proved a cycle is skipped: `redirect.loop` reports it, and
 * billing the same broken path twice would put a warning and a critical on one
 * fix. Hops are counted rather than pages, so the single redirect every CMS
 * ships (`/x` -> `/x/`) is not a chain — the fires-when is "a redirect whose
 * target is itself a redirect".
 */
function chainFindings(self: RuleIdentity, rows: WalkRow[]): Finding[] {
  const byHead = new Map<string, Finding>();
  for (const row of rows) {
    if (cycleOf(row) !== null) continue;
    const tail = row.redirect_url;
    // The terminal page's target is either a URL the crawl never fetched or the
    // hop the CAP stopped us following — the second has a page row
    // (`tail_crawled`), the first has none. What they share is that this walk
    // did not visit it, and either way it is part of the path and belongs in
    // the evidence.
    //
    // Quoted as the SERVER spelled it, unlike the hops before it, which the
    // walk did visit and which are named by their frontier key. Both cases want
    // that: an uncrawled tail was never fetched under any spelling, so the
    // `Location` header is the only honest thing to print; a cap-stopped tail
    // has a row we could have named, and printing the header instead says what
    // the last visited page sent rather than implying we went on to fetch it —
    // which `truncated: true` is simultaneously denying. The walk itself
    // followed the normalised twin in both cases (see `walkFrom`), so nothing
    // about where the chain goes rests on this string.
    const chain = tail === null ? row.chain : [...row.chain, tail];
    const hops = tail === null ? row.chain.length - 1 : row.chain.length;
    if (hops < CHAIN_HOPS) continue;
    byHead.set(
      row.head,
      queryFinding(self, {
        pageId: row.ids[0] ?? null,
        pageUrl: row.head,
        evidence: {
          chain,
          length: hops,
          // Only a walk that reached a page answering for itself has a final
          // status to report. A truncated or uncrawled tail has none, and
          // guessing one would be inventing evidence.
          finalStatus: tail === null ? row.status_code : null,
          truncated: tail !== null && row.tail_crawled,
        },
        dedupeKey: row.head,
      }),
    );
  }
  return [...byHead.values()];
}

/**
 * Loops, one finding per distinct cycle.
 *
 * Several heads can feed the same cycle and both members of a headless pair
 * walk into it, so findings are keyed by the cycle's members — sorted, hashed —
 * and the first one wins.
 */
function loopFindings(self: RuleIdentity, rows: WalkRow[]): Finding[] {
  const byCycle = new Map<string, Finding>();
  for (const row of rows) {
    const cycle = cycleOf(row);
    if (cycle === null) continue;
    const start = row.chain.indexOf(cycle[0]!);
    const key = createHash("sha1").update([...new Set(cycle)].sort().join("\n")).digest("hex");
    if (byCycle.has(key)) continue;
    byCycle.set(
      key,
      queryFinding(self, {
        // The finding belongs to the first URL inside the cycle, not to a head
        // that merely points into it: the head is fine, the loop is the fault.
        pageId: row.ids[start] ?? null,
        pageUrl: row.chain[start] ?? null,
        evidence: { cycle },
        dedupeKey: key,
      }),
    );
  }
  return [...byCycle.values()];
}

const CHAIN: RuleIdentity = { id: "redirect.chain", severity: "warning" };
const LOOP: RuleIdentity = { id: "redirect.loop", severity: "critical" };

/**
 * The redirect-graph rules. Both read the same walk; each runs it for itself
 * rather than sharing state between rules, because a rule that depended on
 * another rule having run first would be a rule that quietly reports nothing
 * when run alone.
 */
export const redirectRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: CHAIN.id,
    checkIds: ["CHECK-10"],
    category: CATEGORY,
    severity: CHAIN.severity,
    ...copyFor(CHAIN.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId) => {
      const walk = await redirectWalk(db, crawlId);
      return chainFindings(CHAIN, [
        ...walk.fromHeads,
        ...unresolvedHeadless(walk.headless),
      ]);
    },
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: LOOP.id,
    checkIds: ["CHECK-10"],
    category: CATEGORY,
    severity: LOOP.severity,
    ...copyFor(LOOP.id),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId) => {
      const walk = await redirectWalk(db, crawlId);
      return loopFindings(LOOP, [...walk.fromHeads, ...walk.headless]);
    },
  }),
];
