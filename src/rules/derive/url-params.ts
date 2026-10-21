/**
 * The `url_params` derivation: what query parameters this crawl's URLs carry.
 *
 * A derivation is not a rule. It accuses nobody and writes no findings — it
 * fills an inventory table (`url_params`) that the agent reads as context when
 * it judges a site's parameter handling, and that a rule may join against. The
 * split matters: rules stay read-only and produce `issues`, derivations write
 * their own table and produce nothing else. `runRules` runs them in between,
 * in a fixed order, so a rule can rely on the inventory being current for the
 * crawl it is judging.
 *
 * Everything below happens in SQL. The aggregation is over every URL the crawl
 * stored — the robots-blocked rows of Phase 23 T3 included, deliberately: a
 * parameter the site links to and disallows is still a parameter the site
 * publishes (see `url.param-volumes`) — tens of thousands of rows on a real
 * site — and pulling them into
 * JavaScript to count parameter names would be the memory contract broken for
 * no reason (hard rule 6).
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";

/**
 * The parameter names that identify a click's source rather than a page's
 * content: campaign tags and ad-click ids.
 *
 * One definition, exported, because two things read it — this derivation's
 * `is_tracking` flag and `url.tracking-params-internal`, which builds its SQL
 * pattern from the same array. A second list would drift, and the drift would
 * be invisible: the inventory would flag a param the rule stays silent about.
 *
 * Matched case-sensitively and exactly. `utm_source` is what analytics reads;
 * `UTM_Source` is a param the site invented that no analytics tool consumes,
 * and flagging it as a tracking param would be a claim about a tool's behaviour
 * that is not true.
 */
export const TRACKING_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "twclid",
  "ttclid",
];

/**
 * Sample URLs kept per parameter. The inventory answers "which params does this
 * site use, and how much"; five URLs are enough to see the shape of one, and
 * the count beside them is the exact number, never the length of this array.
 */
export const PARAM_SAMPLE_URLS = 5;

export interface UrlParamsDerivation extends Record<string, number> {
  /** Distinct parameter names written for the crawl. */
  params: number;
}

/**
 * Rebuild `url_params` for one crawl from its `pages` rows.
 *
 * Idempotent by construction: the crawl's rows are deleted and re-inserted
 * inside one transaction, so running it twice leaves exactly what running it
 * once did, and a param that disappeared from the crawl (a re-crawl into the
 * same row) disappears from the inventory instead of lingering as a claim about
 * URLs that no longer exist. The two statements share a transaction because the
 * table is otherwise briefly empty for a crawl that has params — a reader
 * between them would see "this site uses no parameters", which is false.
 *
 * The unit of `occurrence_count` is URLs, not occurrences: `?tag=a&tag=b` is
 * one URL carrying `tag`, and counting it twice would say the site has more
 * parameter pages than it has pages.
 *
 * Parameter names are taken from the raw query string, undecoded, because that
 * is the spelling the site published and the one a client will search their
 * templates for. A `%75tm_source` would therefore be inventoried under its
 * literal name rather than silently folded into `utm_source` — which is
 * correct: nothing consumes it as a campaign tag either.
 */
export async function deriveUrlParams(db: Db, crawlId: string): Promise<UrlParamsDerivation> {
  // A crawl id nothing knows aggregates to nothing, and an empty inventory for
  // a crawl that does not exist reads exactly like a site that uses no
  // parameters. Ask the crawls table first (hard rule 7, and `runRules`' own
  // precedent).
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveUrlParams: no such crawl '${crawlId}'`);

  return db.transaction(async (tx) => {
    await tx.execute(sql`delete from url_params where crawl_id = ${crawlId}`);

    // `pairs` splits each URL's query string on `&` and takes the name before
    // the first `=`; a valueless `?debug` keeps its bare name. `distinct` is
    // what makes the count a count of URLs.
    //
    // The samples come from a lateral with its own `limit`, not from
    // `array_agg(...)[1:5]`: the second builds the whole array first, so a
    // param on a hundred thousand URLs would be assembled in full and then
    // thrown away.
    const inserted = await tx.execute(sql`
      with pairs as (
        select distinct p.url,
               split_part(kv, '=', 1) as param_name
        from pages p
        cross join lateral unnest(
          string_to_array(substr(p.url, position('?' in p.url) + 1), '&')
        ) as kv
        where p.crawl_id = ${crawlId} and position('?' in p.url) > 0
      ),
      named as (select url, param_name from pairs where param_name <> ''),
      counted as (
        select param_name, count(*)::int as occurrence_count
        from named
        group by param_name
      )
      insert into url_params (crawl_id, param_name, occurrence_count, sample_urls, is_tracking)
      select ${crawlId}, c.param_name, c.occurrence_count, s.sample_urls,
             c.param_name = any(${sql.param([...TRACKING_PARAMS])}::text[])
      from counted c
      cross join lateral (
        select coalesce(array_agg(sample.url), array[]::text[]) as sample_urls
        from (
          select n.url from named n
          where n.param_name = c.param_name
          order by n.url
          limit ${PARAM_SAMPLE_URLS}
        ) sample
      ) s`);

    // `rowCount` is the number of rows the insert wrote — one per distinct
    // param name. Reported rather than recounted, so the number cannot claim
    // more than the statement actually did.
    const written = inserted.rowCount;
    if (written === null) {
      throw new Error(
        `deriveUrlParams: crawl '${crawlId}' — the insert reported no row count, ` +
          "so how much inventory was written is unknown",
      );
    }
    return { params: written };
  });
}
