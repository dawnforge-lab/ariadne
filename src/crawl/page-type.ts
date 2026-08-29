/**
 * `page_type` derivation: the bucket every page-type-scoped metric and every
 * "this template is broken, not this page" finding groups by.
 *
 * TWO PHASES, and both live in this file because `page_type` means one thing
 * and one file should own it.
 *
 * **Phase 1, per URL, at persist time — `derivePageType`.** Two sources, in
 * order:
 *  1. Client patterns — substring matches against the pathname, first match
 *     wins. This is how a site says "/products/ means product" in words the
 *     rule engine can group by, and it always beats the guess.
 *  2. The detected URL template from the absorbed url-utils
 *     (`/blog/2024/my-great-post` -> `/blog/:id/:slug`), used verbatim as the
 *     type. Upstream's conventions are kept as-is, including the slug rule
 *     that leaves two-part segments literal — see `detectUrlTemplate`.
 *
 * A URL on its own cannot say whether `/collections/all-white` is a template
 * or a page, so phase 1 alone answers "one type per URL shape" — and on a real
 * site that is 196 types over 551 pages (the Phase 6 gate crawl, re-measured
 * unchanged in Phase 7), of which 190 occurred exactly once. A cohort of one is
 * not a cohort, and a per-template breakdown cannot be produced from ids nobody
 * can guess.
 *
 * **Phase 2, over the population, at crawl end — `inferPageTemplates`.** The
 * question phase 1 cannot ask is a question about the OTHER URLs: does
 * `/collections/` have a family of pages behind it, or is that one page? The
 * crawl is the only actor that holds the whole population and knows when it is
 * complete, so it answers it before it closes its own row — see
 * `collapseTemplates` for the rule and src/crawl/loop.ts for the placement
 * argument.
 *
 * A null or empty `page_type` is untouched by both phases: it is `(untyped)` at
 * every read site (`UNTYPED`, src/rules/metric/cohort.ts) and this file never
 * invents a bucket to put those pages in.
 *
 * Original to Ariadne; `detectUrlTemplate` is OpenSEO's (see url-utils.ts).
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { crawls } from "../db/schema.js";
import { detectUrlTemplate } from "./parse/url-utils.js";

export interface PageTypePattern {
  /** Matched as a plain substring of the pathname — not a glob, not a regex. */
  pattern: string;
  pageType: string;
}

/**
 * The page type for one absolute URL.
 *
 * Throws on a URL that will not parse. Callers hand this URLs that already
 * passed url-policy and the frontier, so an unparseable one is a defect
 * upstream of here and must surface as one rather than as a bogus bucket.
 */
export function derivePageType(
  url: string,
  clientPatterns?: PageTypePattern[],
): string {
  // Patterns match the path only: a "/products/" in a query string or in the
  // host is not a product page, and matching the whole URL would say it was.
  const { pathname } = new URL(url);
  if (clientPatterns !== undefined) {
    for (const { pattern, pageType } of clientPatterns) {
      if (pathname.includes(pattern)) return pageType;
    }
  }
  return detectUrlTemplate(pathname);
}

// --------------------------------------------------------------------------
// Phase 2: template inference over the crawl's population.
// --------------------------------------------------------------------------

/** The placeholder a collapsed family's last segment takes. */
const SLUG = ":slug";

/**
 * How many distinct paths a family needs before its members are read as one
 * template rather than as pages that happen to share a first segment.
 *
 * Three, and the number is a judgement about what "a template" means, not a
 * tuning knob: two pages under `/services/` are two pages a site wrote by hand;
 * three or more are a shape something generates. Set it to 2 and a site with
 * exactly two service pages loses their names; set it to 10 and a small
 * agency's real templates never form.
 */
export const MIN_COHORT = 3;

/** One parse-time page type and how much of the crawl carries it. */
export interface TemplateMember {
  /** The `page_type` as phase 1 wrote it. */
  pageType: string;
  /**
   * Distinct URL PATHS carrying it — not pages. A page type is a function of
   * the path, so counting pages would let one page's query-string variants
   * (`/services/seo?ref=a`, `?ref=b`) look like a family of three.
   */
  paths: number;
}

/**
 * The family a page type belongs to, named as the collapse would name it, or
 * null for a type that has no family and must be left exactly as it is.
 *
 * Two exclusions, both deliberate:
 *
 *  - **A type that is not its own `detectUrlTemplate` output is not ours.** A
 *    client pattern names a type in the site's own words (`product`,
 *    `Category page`); this pass has no business rewriting a name somebody
 *    chose. The test is structural rather than a config lookup, so it holds for
 *    a resumed crawl whose patterns are not in this process. Its one blind spot
 *    is a client type spelled exactly like a path (`/products`), which is
 *    indistinguishable from a detected template and is treated as one.
 *
 *  - **A single-segment type has no family.** `/about`, `/cart`, `/search` and
 *    `/` are named routes, and the only family that could hold them is
 *    `/:slug`, which names nothing — it would fuse the cart and the search page
 *    into one bucket and call it a template. They stay themselves. This is the
 *    "small honest tail" a real site keeps, and it is why this pass invents no
 *    `(other)` bucket: every page keeps a type that means something.
 */
function familyOf(pageType: string): string | null {
  if (detectUrlTemplate(pageType) !== pageType) return null;
  const segments = pageType.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `/${[...segments.slice(0, -1), SLUG].join("/")}`;
}

/**
 * The retyping this population implies: `old page type -> new page type`, with
 * only the types that MOVE in it.
 *
 * The rule, in full. Group every member by its family — the whole path with the
 * last segment replaced by `:slug`, so `/collections/all`,
 * `/collections/all-white` and `/collections/:slug` are three members of
 * `/collections/:slug`. A family collapses when both of these hold:
 *
 *  - it has **at least two distinct member types** — otherwise there is nothing
 *    to merge, and renaming a lone `/blog/:id` to `/blog/:slug` would throw
 *    away the fact that its ids are numeric to no one's benefit; and
 *  - its members cover **at least `MIN_COHORT` distinct paths** — the evidence
 *    that a generator, not an author, produced them.
 *
 * When it collapses, every member takes the family name. When it does not,
 * every member keeps its own — a two-page `/services/` stays `/services/seo`
 * and `/services/ppc`, which is the truth about that site.
 *
 * ONE LEVEL ONLY. The last segment is the one that varies; the prefix is the
 * route and is never rewritten, so `/blogs/news/:slug` and `/blogs/press/:slug`
 * stay two templates rather than becoming `/blogs/:slug/:slug`. A site with
 * genuinely many sections keeps them.
 *
 * **Deterministic and idempotent.** The output of a collapse is itself a
 * well-formed template (a self-mapping prefix plus `:slug`), and a collapsed
 * family has exactly one member type, which fails the two-member test. Running
 * this over its own output changes nothing, which is what makes it safe on the
 * resume path.
 */
export function collapseTemplates(
  members: readonly TemplateMember[],
): Map<string, string> {
  const families = new Map<string, { types: string[]; paths: number }>();
  for (const member of members) {
    const family = familyOf(member.pageType);
    if (family === null) continue;
    const seen = families.get(family);
    if (seen === undefined) {
      families.set(family, { types: [member.pageType], paths: member.paths });
      continue;
    }
    seen.types.push(member.pageType);
    seen.paths += member.paths;
  }

  const mapping = new Map<string, string>();
  for (const [family, cohort] of families) {
    if (cohort.types.length < 2) continue;
    if (cohort.paths < MIN_COHORT) continue;
    for (const type of cohort.types) {
      if (type !== family) mapping.set(type, family);
    }
  }
  return mapping;
}

/** What one run of `inferPageTemplates` did, for the crawl summary and the tests. */
export interface PageTemplateInference {
  /** Distinct non-null page types the crawl's pages carried before the pass. */
  typesBefore: number;
  /** Distinct non-null page types they carry after it. */
  typesAfter: number;
  /** Page rows whose `page_type` this pass changed. */
  pagesRetyped: number;
}

/**
 * How many `old -> new` pairs go into one UPDATE. The mapping is at most one
 * entry per distinct page type, so this bounds the SQL text, not the memory.
 */
const RETYPE_BATCH = 500;

/**
 * A row of the population query. A type alias rather than an interface for the
 * reason `deriveFieldPresence`'s `BlockRow` is one: `db.execute<T>` constrains T
 * to `Record<string, unknown>`, and only an alias of an object literal carries
 * the implicit index signature that satisfies it.
 */
type PopulationRow = { page_type: string; paths: number };

/**
 * Collapse one crawl's singleton page types into the templates they belong to.
 *
 * **Memory.** O(distinct page types), never O(URLs) — the grouping is SQL's,
 * and what comes back is one row per type. The worst case a 50k-page crawl can
 * present is 50k distinct types (every URL its own shape), which is a set of
 * strings rather than a set of page rows; the normal case is the few hundred
 * the group-by actually returns. Nothing here reads `pages` row by row.
 *
 * **Idempotent** by recomputation over the population — see `collapseTemplates`
 * for why its output is a fixed point. A resume runs it again over a larger
 * population and gets the answer that population implies, which is the point.
 *
 * A crawl id nothing knows throws rather than reporting a clean zero, which
 * would read exactly like a site whose types were all templates already
 * (hard rule 7, and `deriveFieldPresence`'s precedent).
 */
export async function inferPageTemplates(
  db: Db,
  crawlId: string,
): Promise<PageTemplateInference> {
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`inferPageTemplates: no such crawl '${crawlId}'`);

  // The path of `pages.url`: scheme and authority stripped, query dropped. The
  // stored URL is absolute and fragment-free (`normalizeUrl` guarantees both),
  // so this is the whole of the parsing needed — and it is done in SQL because
  // the alternative is pulling every URL of the crawl into this process.
  const path = sql`split_part(regexp_replace(p.url, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''), '?', 1)`;
  const population = await db.execute<PopulationRow>(sql`
    select p.page_type as page_type, count(distinct ${path})::int as paths
    from pages p
    where p.crawl_id = ${crawlId}
      and p.page_type is not null
      and p.page_type <> ''
    group by p.page_type`);

  const members = population.rows.map((row) => ({ pageType: row.page_type, paths: row.paths }));
  const mapping = collapseTemplates(members);
  const typesBefore = members.length;
  const typesAfter = new Set(
    members.map((m) => mapping.get(m.pageType) ?? m.pageType),
  ).size;
  if (mapping.size === 0) return { typesBefore, typesAfter, pagesRetyped: 0 };

  const pairs = [...mapping].map(([from, to]) => sql`(${from}::text, ${to}::text)`);
  let pagesRetyped = 0;
  for (let i = 0; i < pairs.length; i += RETYPE_BATCH) {
    const batch = pairs.slice(i, i + RETYPE_BATCH);
    const written = await db.execute(sql`
      update pages p
      set page_type = v.new_type
      from (values ${sql.join(batch, sql`, `)}) as v(old_type, new_type)
      where p.crawl_id = ${crawlId}
        and p.page_type = v.old_type`);
    if (written.rowCount === null) {
      throw new Error(
        `inferPageTemplates: crawl '${crawlId}' — the update reported no row count, ` +
          "so how many pages were retyped is unknown",
      );
    }
    pagesRetyped += written.rowCount;
  }
  return { typesBefore, typesAfter, pagesRetyped };
}
