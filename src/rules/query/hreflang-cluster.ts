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
 * ## One hop, not a closure
 *
 * `cluster_key` is the lexically smallest URL among the page's own URL and its
 * reciprocal alternates — one hop out, exactly as the spec defines it, not a
 * transitive closure. On a complete cluster (every member naming every member,
 * which is the shape Google requires and `hreflang.missing-self-reference`
 * reports the absence of) every member computes the same key and the cluster
 * collapses to one. On an INCOMPLETE one — A↔B and B↔C but not A↔C — A and C
 * can compute different keys and the group keeps two members. That is the
 * honest answer for a cluster that is broken in exactly the way the hreflang
 * rules report by name, and it errs towards reporting rather than towards
 * silence.
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
 * The three CTEs, for a caller to place immediately after its own `with`.
 *
 * They are emitted together because the last one is the only one anybody wants
 * and the first two are how it is computed without a correlated subquery in a
 * join predicate: each side's comparison key is projected once, and the joins
 * are then plain equalities Postgres can hash.
 *
 *  - `hreflang_declared` — this crawl's declarations, with the target as a
 *    `URL_MATCH_KEY`;
 *  - `hreflang_judged` — the crawl's judged pages, with their own URL as the
 *    same kind of key;
 *  - `hreflang_cluster(crawl_id, page_id, cluster_key)` — ONE ROW PER PAGE THAT
 *    HAS AT LEAST ONE RECIPROCAL ALTERNATE. A page with none is absent, which
 *    is what `CLUSTER_KEY` below coalesces into "a cluster of one, keyed by its
 *    own URL": an inner join here would silently drop every page on a site with
 *    no hreflang at all, which is most sites and every one of this engine's own
 *    fixtures.
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
    ),
    hreflang_cluster as (
      select a.crawl_id, a.id as page_id, least(a.url, min(b.url)) as cluster_key
      from hreflang_judged a
      join hreflang_declared ha on ha.page_id = a.id
      join hreflang_judged b on b.url_key = ha.target_key and b.id <> a.id
      join hreflang_declared hb on hb.page_id = b.id
        and hb.target_key = a.url_key
        and lower(btrim(hb.hreflang_code)) <> lower(btrim(ha.hreflang_code))
      group by a.crawl_id, a.id, a.url
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
