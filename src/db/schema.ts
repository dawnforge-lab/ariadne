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
  // (hard rule 3: rules read the database). Each is nullable because each
  // records something the crawl may not have done: `discovery` is what robots
  // and sitemap discovery found, `hostProbe` is the www/apex/http variant
  // walk, `notfoundProbe` is the synthetic-404 sample the soft-404 rule
  // compares pages against. A null means "not attempted", which the rules
  // report as a skipped check rather than passing over in silence.
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
  rendered: boolean("rendered").notNull().default(false),
  renderedWordCount: integer("rendered_word_count"),
  renderedLinkCount: integer("rendered_link_count"),
}, (t) => [
  uniqueIndex("pages_crawl_url").on(t.crawlId, t.url),
  index("pages_crawl_normalised").on(t.crawlId, t.urlNormalised),
  index("pages_crawl_type").on(t.crawlId, t.pageType),
  // The rule runner's page cursor: `where crawl_id = $1 and id > $2 order by
  // id limit 500`. Without this the runner sorts the crawl's whole page set
  // once per batch, which is the memory contract's cost moved into Postgres.
  index("pages_crawl_id").on(t.crawlId, t.id),
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
}, (t) => [index("sd_crawl_type").on(t.crawlId, t.schemaType)]);

export const sitemapUrls = pgTable("sitemap_urls", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  sitemapSource: text("sitemap_source").notNull(),
  lastmod: text("lastmod"),
  pageId: text("page_id"),
}, (t) => [primaryKey({ columns: [t.crawlId, t.url] })]);

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
  scope: text("scope").notNull(),       // site|page_type
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
