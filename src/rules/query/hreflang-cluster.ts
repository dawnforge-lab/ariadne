/**
 * ONE HREFLANG CLUSTER IS ONE PAGE, for the duplicate rules (Phase 22 §2).
 *
 * The owner, reading the raelon.ca crawl: "duplicate content is being reported
 * on pages that are canonicalized or have the hreflang rules in place … if a
 * page is indexable or not or it has other rules in place that doesn't make it
 * an error." A bilingual site that has done internationalisation CORRECTLY —
 * `/policies/refund-policy` and `/fr/policies/refund-policy`, each naming the
 * other as its alternate — publishes two URLs with one title, one meta
 * description and one H1 whenever a string has not been translated, and this
 * engine reported every one of them as a duplicate group. That is the remedy
 * reported as the fault: hreflang is the mechanism that tells a search engine
 * these two ARE one page in two languages.
 *
 * So for `title.duplicate`, `meta-description.duplicate`, `h1.duplicate-text`
 * and `content.near-duplicate`, two judged pages that declare each other as
 * hreflang alternates UNDER DIFFERENT LANGUAGE CODES count as one member. The
 * group's size is the number of distinct clusters in it, and below two there is
 * no finding at all.
 *
 * `content.exact-duplicate` is deliberately NOT collapsed: byte-identical
 * bodies across two locales means the translation is missing, which is a real
 * finding on a real pair of URLs.
 *
 * ## What "declare each other" means here, exactly
 *
 * Both directions must be in the `hreflang` table, and the two codes must
 * differ:
 *
 *  - A declares some URL whose key is B's, and B declares some URL whose key is
 *    A's — reciprocity, the same property `hreflang.missing-return-link`
 *    reports the absence of. A one-way declaration collapses nothing: an
 *    annotation nobody returns is one a search engine discards, so the two
 *    pages really are two pages competing with each other.
 *  - the code A uses for B differs from the code B uses for A, compared
 *    lower-cased and trimmed. Two URLs claiming each other as `en` are not a
 *    translation pair — they are the same language twice, which is the
 *    duplicate this rule exists to report, and `x-default` naming `x-default`
 *    is the same story. A pair that carries several codes collapses if ANY
 *    reciprocated pairing differs, which is what makes the ordinary
 *    `en`/`fr` + shared `x-default` block collapse rather than trip on its
 *    own fallback.
 *  - both pages must be JUDGED. An alternate that is itself noindexed or
 *    canonicalised elsewhere is not in the duplicate rules' cohort, so folding
 *    a group member into it would name a URL the group does not contain.
 *
 * ## Mutual, and therefore order-independent
 *
 * Two pages share a `cluster_key` ONLY IF THEY DECLARE EACH OTHER — which is
 * what the client-facing copy says ("pages that declare each other as hreflang
 * alternates count as one page") and is a pairwise property, so no URL outside
 * the pair may decide it.
 *
 * The key is therefore built from the page's CLOSED RECIPROCAL NEIGHBOURHOOD —
 * its own URL together with the URLs of every judged page it reciprocates with
 * — and two pages share a key exactly when those neighbourhoods are EQUAL, the
 * representative being the lexically smallest URL in the class. Equal
 * neighbourhoods imply mutual declaration: each neighbourhood contains its own
 * page, so if A's set equals B's then A is in B's set and B is in A's, which is
 * the reciprocal pair itself. Nothing in the fold compares one URL against
 * another; `min` only picks a name for a class that has already been decided by
 * set equality, so the answer cannot move when a URL is renamed.
 *
 * A COMPLETE cluster — every member naming every member, the shape Google
 * requires and `hreflang.missing-self-reference` reports the absence of — gives
 * every member the same neighbourhood and collapses to one, at two languages or
 * at ten. An INCOMPLETE one does not: with A↔B and B↔C but not A↔C the three
 * neighbourhoods are {A,B}, {A,B,C} and {B,C}, so the group keeps three
 * members. That is the honest answer for a cluster broken in exactly the way
 * the hreflang rules report by name, and it errs towards reporting rather than
 * towards silence — the direction a duplicate rule must err in.
 *
 * The earlier one-hop key (smallest URL among the page's own and its
 * alternates') is what this replaces: it let a page OUTSIDE the duplicate group
 * decide the group's size. A and C, each reciprocal only with a hub B that does
 * not share their title, folded into one member when B's URL sorted first and
 * stayed two when it sorted last — the same site, two answers, chosen by a
 * string comparison against a URL the finding never mentions.
 *
 * ## It is SQL, and it is one CTE
 *
 * Four rules share it, so the collapse is one definition rather than four that
 * agree until one is edited, and no part of it is a table read into memory
 * (hard rule 3). Nothing here fetches (hard rule 2).
 */
import { sql, type SQL } from "drizzle-orm";

import { JUDGED, URL_MATCH_KEY } from "../helpers.js";

/**
 * The four CTEs, for a caller to place immediately after its own `with`.
 *
 * They are emitted together because the last one is the only one anybody wants
 * and the first three are how it is computed without a correlated subquery in a
 * join predicate: each side's comparison key is projected once, and the joins
 * are then plain equalities Postgres can hash.
 *
 *  - `hreflang_declared` — this crawl's declarations, with the target as a
 *    `URL_MATCH_KEY`;
 *  - `hreflang_judged` — the crawl's judged pages, with their own URL as the
 *    same kind of key. **GATED ON THE CRAWL HAVING ANY HREFLANG AT ALL**: the
 *    `exists` plans as a one-time filter, so on a site with no hreflang row the
 *    scan of the judged pages reads "never executed" instead of being entered
 *    at all (Phase 22 review, item 11). Measured, it buys under a millisecond —
 *    Postgres already stopped materialising this CTE early once the join found
 *    `hreflang_declared` empty (629 judged pages: 14.4ms with the gate, 14.5ms
 *    without; 6,290: 133ms either way). It is kept because it states the
 *    intention in the plan rather than leaving it to that lazy evaluation, and
 *    because it costs one index-only probe of `hreflang_crawl_target`;
 *  - `hreflang_reciprocal` — the symmetric pairs: both directions declared,
 *    under different codes, both pages judged. One row per ordered pair,
 *    `distinct` because a pair that reciprocates under several code pairings is
 *    still one pair;
 *  - `hreflang_cluster(crawl_id, page_id, cluster_key)` — ONE ROW PER PAGE THAT
 *    HAS AT LEAST ONE RECIPROCAL ALTERNATE, keyed by the smallest URL among the
 *    pages whose closed reciprocal neighbourhood is identical to this one's. A
 *    page with none is absent, which is what `CLUSTER_KEY` below coalesces into
 *    "a cluster of one, keyed by its own URL": an inner join here would
 *    silently drop every page on a site with no hreflang at all, which is most
 *    sites and every one of this engine's own fixtures.
 */
export const HREFLANG_CLUSTER_CTES = (crawlId: string): SQL => sql`
    hreflang_declared as (
      select h.page_id, h.hreflang_code, ${URL_MATCH_KEY("h.target_url")} as target_key
      from hreflang h
      where h.crawl_id = ${crawlId}
    ),
    hreflang_judged as (
      select p.id, p.crawl_id, p.url, ${URL_MATCH_KEY("p.url")} as url_key
      from pages p
      where p.crawl_id = ${crawlId} and ${JUDGED("p")}
        and exists (select 1 from hreflang hx where hx.crawl_id = ${crawlId})
    ),
    hreflang_reciprocal as (
      select distinct a.crawl_id, a.id as page_id, a.url, b.url as partner_url
      from hreflang_judged a
      join hreflang_declared ha on ha.page_id = a.id
      join hreflang_judged b on b.url_key = ha.target_key and b.id <> a.id
      join hreflang_declared hb on hb.page_id = b.id
        and hb.target_key = a.url_key
        and lower(btrim(hb.hreflang_code)) <> lower(btrim(ha.hreflang_code))
    ),
    hreflang_neighbourhood as (
      -- The CLOSED neighbourhood: the partners and the page itself, sorted, as
      -- one comparable value. The lateral emits both URLs per pair row so the
      -- page's own URL is in the set without a second pass over the table.
      select r.crawl_id, r.page_id, r.url,
             array_agg(distinct m.member order by m.member) as neighbourhood
      from hreflang_reciprocal r
      cross join lateral (values (r.partner_url), (r.url)) as m(member)
      group by r.crawl_id, r.page_id, r.url
    ),
    hreflang_cluster as (
      select n.crawl_id, n.page_id,
             min(n.url) over (partition by n.crawl_id, n.neighbourhood) as cluster_key
      from hreflang_neighbourhood n
    )`;

/**
 * The cluster a page belongs to: its cluster key, or its own URL when it has no
 * reciprocal alternate. `pageAlias` is the `pages` alias, `clusterAlias` the
 * `hreflang_cluster` row LEFT JOINED onto it.
 *
 * Every caller must use the LEFT join and this coalesce together — see the CTE
 * above for why an inner join would be a rule that stops reporting on a site
 * with no hreflang.
 */
export const CLUSTER_KEY = (pageAlias: string, clusterAlias: string): SQL =>
  sql.raw(`coalesce(${clusterAlias}.cluster_key, ${pageAlias}.url)`);
