import { sql } from "drizzle-orm";
import {
  pgTable, text, integer, bigint, boolean, jsonb, timestamp, real,
  primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const crawls = pgTable("crawls", {
  id: text("id").primaryKey(),                 // e.g. crawl_<ulid>
  siteUrl: text("site_url").notNull(),
  config: jsonb("config_jsonb").notNull(),
  rulesetVersion: text("ruleset_version").notNull(),
  status: text("status").notNull().default("running"), // running|finished|failed|cancelled
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  pagesTotal: integer("pages_total"),
  renderPassCount: integer("render_pass_count").notNull().default(0),
  // Three crawl-level evidence blobs the query rules read instead of fetching
  // (hard rule 3: rules read the database). All three are nullable, and a null
  // does NOT mean the same thing in each — what a rule may conclude from one
  // depends on when its writer runs:
  //
  //  - `discovery` (what robots.txt said and what the sitemap walk found) is
  //    written by `runCrawl` unconditionally, immediately after `discover()`
  //    and before the frontier is seeded or anything branches on it. There is
  //    no path that crawls a site and leaves it null. A null is therefore not
  //    "not attempted": it is a row no completed discovery produced — one that
  //    predates the column, or a crawl that died inside discovery — and the
  //    robots and sitemap rules THROW on it rather than judging a site on
  //    evidence that is not there (hard rule 7). See
  //    src/rules/query/crawl-evidence.ts.
  //  - `hostProbe` (the www/apex/http variant walk) is skipped entirely when
  //    the caller passes `probeHosts: false`, and has no "skipped" shape to
  //    record that in. A null here genuinely is "not attempted", and a rule
  //    reading it must report a skipped check rather than a finding.
  //  - `notfoundProbe` (the synthetic-404 sample the soft-404 rule compares
  //    pages against) always ends up written once the crawl reaches that step:
  //    either a sample, or a `{ skipped: <reason> }` object naming why it was
  //    not taken. A null means the crawl never got that far — it is still
  //    running, or it failed before the probe — which is again "not attempted"
  //    and again a skipped check, not a finding.
  discovery: jsonb("discovery_jsonb"),
  hostProbe: jsonb("host_probe_jsonb"),
  notfoundProbe: jsonb("notfound_probe_jsonb"),
});

export const pages = pgTable("pages", {
  id: text("id").primaryKey(),
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  urlNormalised: text("url_normalised").notNull(),
  pageType: text("page_type"),
  statusCode: integer("status_code"),
  fetchClass: text("fetch_class").notNull(),   // ok|redirect|client_error|server_error|blocked|timeout|network_error|non_html|too_large
  contentType: text("content_type"),
  redirectUrl: text("redirect_url"),
  // The same target as `redirect_url`, put through `normalizeUrl` — the
  // spelling `pages.url` is keyed by, and therefore the only spelling a join
  // to `pages` can use. `redirect_url` keeps the resolved `Location` verbatim,
  // because that is what the server sent and what the evidence quotes; a
  // `Location` carrying a fragment or unsorted query params is the same URL as
  // the page row the crawl created from it, and only this column says so.
  //
  // Null in three cases, and they are one fact: there is no crawlable target.
  // No redirect at all, a 3xx with no usable `Location`, and a target the URL
  // policy refused all leave `redirect_url` null too.
  redirectUrlNormalised: text("redirect_url_normalised"),
  depth: integer("depth").notNull(),
  discoveredVia: text("discovered_via").notNull(), // seed|link|sitemap|redirect
  title: text("title"),
  metaDescription: text("meta_description"),
  canonicalHtml: text("canonical_html"),
  canonicalHeader: text("canonical_header"),
  // How many <link rel=canonical> elements the HTML declared. `canonical_html`
  // keeps the first; this counts them all, because "more than one canonical"
  // (CHECK-18) is a finding a single-value column cannot express.
  canonicalCount: integer("canonical_count").notNull().default(0),
  robotsMeta: text("robots_meta"),
  xRobotsTag: text("x_robots_tag"),
  isIndexable: boolean("is_indexable"),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  ogImage: text("og_image"),
  h1Count: integer("h1_count").notNull().default(0),
  h2Count: integer("h2_count").notNull().default(0),
  h3Count: integer("h3_count").notNull().default(0),
  h4Count: integer("h4_count").notNull().default(0),
  h5Count: integer("h5_count").notNull().default(0),
  h6Count: integer("h6_count").notNull().default(0),
  headingOrder: integer("heading_order").array(),
  wordCount: integer("word_count"),
  textRatio: real("text_ratio"),
  contentHash: text("content_hash"),
  // The analyzer's simhash is in the UNSIGNED 64-bit range; this column is a
  // SIGNED Postgres bigint. Persistence stores `BigInt.asIntN(64, value)` and
  // readers recover the analyzer's value with `BigInt.asUintN(64, stored)`.
  // The bit pattern — all a hamming distance cares about — is identical either
  // way, so the round trip is lossless. See src/crawl/parse/simhash.ts.
  simhash: bigint("simhash", { mode: "bigint" }),
  // JSON-LD blocks on this page that would not parse (invalid JSON, or over
  // the analyzer's per-block cap). A count, not a silence: a page whose
  // structured data does not parse is an audit finding.
  structuredDataParseErrors: integer("structured_data_parse_errors")
    .notNull()
    .default(0),
  responseTimeMs: integer("response_time_ms"),
  htmlBytes: integer("html_bytes"),
  domSize: integer("dom_size"),
  imagesTotal: integer("images_total").notNull().default(0),
  imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
  // <img> without both width and height — the CLS signal (CHECK-49).
  imagesMissingDimensions: integer("images_missing_dimensions").notNull().default(0),
  hasAmp: boolean("has_amp").notNull().default(false),
  // <meta name=viewport> present — the mobile-readiness signal (CHECK-52).
  hasViewport: boolean("has_viewport").notNull().default(false),
  // Placeholder copy shipped to production (CHECK-40).
  hasLoremIpsum: boolean("has_lorem_ipsum").notNull().default(false),
  // Body text carrying a "page not found" phrase (CHECK-13). One of the two
  // soft-404 signals; the other is a simhash match against the site's own 404
  // template. A phrase alone is not a verdict — a real article about broken
  // links contains the words too — so the rule pairs it with a word count.
  hasSoft404Phrases: boolean("has_soft404_phrases").notNull().default(false),
  relNext: text("rel_next"),
  relPrev: text("rel_prev"),
  // The raw-HTML half of CHECK-34, written by `PageWriter` off the analyzer's
  // single pass: anchors carrying an href inside a <nav> / a <footer>, counted
  // exactly as `document.querySelectorAll('nav a[href]').length` counts them
  // (see the analyzer's parity oracle). NOT NULL with a 0 default because a
  // page with no HTML has no nav — a 200 that served a PDF, a 404, a timeout —
  // and 0 is that fact, not a missing value.
  navLinkCount: integer("nav_link_count").notNull().default(0),
  footerLinkCount: integer("footer_link_count").notNull().default(0),
  // Which of the analyzer's `FRAMEWORK_MARKERS` the raw HTML carried, in that
  // constant's order. A jsonb array rather than a text[] because it is read as
  // a set (`framework_markers @> '["__NEXT_DATA__"]'`), and NOT NULL with an
  // empty-array default on the same reasoning as the two counters: no markers
  // is a fact about the page, never an absence of evidence.
  frameworkMarkers: jsonb("framework_markers")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  rendered: boolean("rendered").notNull().default(false),
  renderedWordCount: integer("rendered_word_count"),
  renderedLinkCount: integer("rendered_link_count"),
  // The render pass's side of the comparison, ALL WRITTEN BY THE RENDER PASS
  // (src/crawl/render, P5-T4) and by nothing else — the crawl's HTML path
  // leaves every one of them null. Nullable, and the null is the whole point:
  // it means this page was NOT rendered, which is what `isAuditable` gates on.
  // A rendered page with genuinely zero nav links stores 0; a page nobody
  // rendered stores null, and no rule may read the two as the same thing.
  renderedNavLinkCount: integer("rendered_nav_link_count"),
  renderedFooterLinkCount: integer("rendered_footer_link_count"),
  // Links the rendered DOM exposes that look like faceted-navigation filters —
  // the crawl-budget signal a raw-HTML crawl cannot see at all.
  renderedFilterLinkCount: integer("rendered_filter_link_count"),
  // Where the page navigated itself to while rendering (a JS redirect): a URL
  // the HTTP layer never saw a Location header for.
  renderedRedirectUrl: text("rendered_redirect_url"),
  // Why a render that was ATTEMPTED produced nothing. Non-null here and null
  // in the four columns above is a rendered-and-failed page, which is a
  // different fact from a page that was never rendered (hard rule 7: the
  // failure is a recorded row, not a silently unrendered page).
  renderError: text("render_error"),
}, (t) => [
  uniqueIndex("pages_crawl_url").on(t.crawlId, t.url),
  index("pages_crawl_normalised").on(t.crawlId, t.urlNormalised),
  index("pages_crawl_type").on(t.crawlId, t.pageType),
  // The rule runner's page cursor: `where crawl_id = $1 and id > $2 order by
  // id limit 500`. Without this the runner sorts the crawl's whole page set
  // once per batch, which is the memory contract's cost moved into Postgres.
  index("pages_crawl_id").on(t.crawlId, t.id),
  // The simhash bands `content.near-duplicate` joins on: four 16-bit slices of
  // the signed simhash, each one an expression index so the pair join's
  // `(a.simhash >> k) & 65535 = (b.simhash >> k) & 65535` can be answered from
  // an index instead of by examining every pair. Measured on 5,000 pages: 2.9s
  // without them (nested loop, quadratic), 0.11s with them (BitmapOr across all
  // four arms).
  //
  // TEXTUAL COUPLING, and it is not a soft one. Postgres matches an expression
  // index by comparing the expression's parse tree with the query's, so:
  //
  //  - band 0 MUST be written `(simhash >> 0) & 65535`, exactly as the rule
  //    writes it. `int8shr(simhash, 0)` is NOT constant-folded away, so an
  //    index on the simpler `simhash & 65535` does not match the rule's band-0
  //    predicate and that arm falls back to a sequential scan;
  //  - one arm that fails to match kills the WHOLE BitmapOr — Postgres cannot
  //    use indexes for an OR unless every branch is indexable — and it does so
  //    silently, as a slow query rather than an error.
  //
  // So these four expressions and the four band predicates in
  // `nearDuplicateFindings` (src/rules/query/content.ts) must stay spelled
  // identically. Change one, change the other, and re-check with EXPLAIN.
  index("pages_simhash_band0").on(t.crawlId, sql`((${t.simhash} >> 0) & 65535)`),
  index("pages_simhash_band1").on(t.crawlId, sql`((${t.simhash} >> 16) & 65535)`),
  index("pages_simhash_band2").on(t.crawlId, sql`((${t.simhash} >> 32) & 65535)`),
  index("pages_simhash_band3").on(t.crawlId, sql`((${t.simhash} >> 48) & 65535)`),
]);

export const links = pgTable("links", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  sourcePageId: text("source_page_id").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  anchor: text("anchor"),
  rel: text("rel"),
  isInternal: boolean("is_internal").notNull(),
  isNofollow: boolean("is_nofollow").notNull().default(false),
  position: integer("position").notNull(),
}, (t) => [
  index("links_crawl_target_url").on(t.crawlId, t.targetUrl),
  index("links_crawl_target_page").on(t.crawlId, t.targetPageId),
  index("links_crawl_source").on(t.crawlId, t.sourcePageId),
]);

export const hreflang = pgTable("hreflang", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  hreflangCode: text("hreflang_code").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  source: text("source").notNull(), // html|sitemap|header
}, (t) => [index("hreflang_crawl_page").on(t.crawlId, t.pageId),
           index("hreflang_crawl_target").on(t.crawlId, t.targetUrl)]);

export const structuredData = pgTable("structured_data", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  schemaType: text("schema_type").notNull(),
  raw: jsonb("raw_jsonb").notNull(),
  fieldPresence: jsonb("field_presence_jsonb"),
}, (t) => [
  index("sd_crawl_type").on(t.crawlId, t.schemaType),
  // COUPLED to `deriveFieldPresence`'s batch query (src/rules/derive/field-presence.ts),
  // which streams the crawl's blocks by a `page_id` cursor: `where crawl_id = $1
  // and page_id > $cursor … order by page_id limit N`. Without this index every
  // batch rescans every profiled row of the crawl and the derivation is
  // quadratic in the number of pages carrying structured data — a slow query,
  // never an error, which is exactly the failure that hides. Change the cursor
  // there, change this index here (the `pages_simhash_band*` precedent).
  index("sd_crawl_page").on(t.crawlId, t.pageId),
]);

export const sitemapUrls = pgTable("sitemap_urls", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  // The `<loc>` as the site published it, resolved to absolute and no further.
  // It stays the primary key and the evidence: the report quotes it because it
  // is the line of XML somebody edits.
  url: text("url").notNull(),
  // The same entry put through `normalizeUrl` — fragment stripped, query
  // parameters sorted — which is the spelling `pages.url` is keyed by, and
  // therefore the only spelling that can join the two tables. A `<loc>`
  // reading `/x?b=2&a=1#top` and the page row the crawl created from it
  // (`/x?a=1&b=2`) are one URL, and this column is where they meet.
  //
  // NOT NULL with an empty-string default, which is for rows written before
  // this column existed and for nothing else: the writer always computes a
  // value (and throws if it cannot). An empty string is therefore UNAMBIGUOUS
  // — `normalizeUrl` returns at least `scheme://host/` for every URL it
  // accepts, so no crawl can ever write one — and it is detected and refused,
  // not tolerated (`assertNormalisedSitemap`, src/rules/query/crawl-evidence.ts).
  //
  // Refused rather than tolerated because such a row is not quietly inert: it
  // fails the join, and the rules that fire ON a failed match then fire on
  // everything. `sitemap.uncrawled` reports every entry as a URL the crawl
  // never reached, `pages.not-in-sitemap` reports every indexable 200 (its
  // data gate only asks that the crawl HOLD sitemap rows, which it does),
  // `links.orphan` calls every orphan `inSitemap: false`, and
  // `robots.blocks-sitemap-urls` goes silent about a sitemap it never checked.
  // Maximal noise plus one false all-clear — worse than the pre-switch
  // behaviour, under which almost every row joined.
  //
  // So a pre-Phase-4 crawl is NOT a supported re-judge target: re-crawl the
  // site. Same ruling and same reason as a null `discovery_jsonb`, which the
  // rules refuse rather than judge a site on evidence that is not there
  // (`parseDiscovery`, same file).
  urlNormalised: text("url_normalised").notNull().default(""),
  sitemapSource: text("sitemap_source").notNull(),
  lastmod: text("lastmod"),
  pageId: text("page_id"),
}, (t) => [
  primaryKey({ columns: [t.crawlId, t.url] }),
  // The join column of five rules (the four sitemap ⋈ pages rules and
  // `pages.not-in-sitemap`'s anti-join, plus `links.orphan`'s membership test).
  // The primary key served those joins while they matched on `url`; this index
  // is what keeps a 50k-entry sitemap off a sequential scan now that they match
  // on the normalised spelling.
  index("sitemap_urls_crawl_normalised").on(t.crawlId, t.urlNormalised),
]);

export const urlParams = pgTable("url_params", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  paramName: text("param_name").notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
  sampleUrls: text("sample_urls").array().notNull(),
  isTracking: boolean("is_tracking").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.crawlId, t.paramName] })]);

export const issues = pgTable("issues", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  pageId: text("page_id"),
  severity: text("severity").notNull(), // critical|warning|info
  // The ruleset that produced this row. Defaulted rather than backfilled: the
  // empty string is honestly "written before the stamp existed", where a
  // backfilled version number would be a claim about which rules ran that
  // nobody can check.
  rulesetVersion: text("ruleset_version").notNull().default(""),
  dedupeKey: text("dedupe_key").notNull(),
  details: jsonb("details_jsonb").notNull(),
}, (t) => [uniqueIndex("issues_dedupe").on(t.crawlId, t.ruleId, t.dedupeKey),
           index("issues_crawl_rule").on(t.crawlId, t.ruleId)]);

export const metrics = pgTable("metrics", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  metricId: text("metric_id").notNull(),
  // site|page_type|sitemap_doc — `MetricScope` in src/rules/registry/types.ts,
  // which is what the runner validates a metric rule's rows against. A free
  // text column here; the closed set lives there.
  scope: text("scope").notNull(),
  scopeValue: text("scope_value").notNull().default(""),
  value: jsonb("value_jsonb").notNull(),
}, (t) => [primaryKey({ columns: [t.crawlId, t.metricId, t.scope, t.scopeValue] })]);

export const frontier = pgTable("frontier", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  state: text("state").notNull().default("pending"), // pending|leased|done|failed
  depth: integer("depth").notNull(),
  discoveredVia: text("discovered_via").notNull(),
  attempts: integer("attempts").notNull().default(0),
  leaseId: text("lease_id"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.crawlId, t.url] }),
  index("frontier_leasable").on(t.crawlId, t.state, t.leasedUntil),
]);
