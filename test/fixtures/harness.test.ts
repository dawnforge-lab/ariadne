/**
 * The end-to-end net.
 *
 * One local HTTP site, crawled once by the REAL crawler, RENDERED once by a
 * real Chromium, judged once by the REAL rule runner, asserted from the
 * `issues` and `metrics` tables. Nothing here stubs a fetch, hand-builds a
 * `pages` row, or calls a rule directly: if the analyzer stops extracting a
 * signal, or the writer stops persisting it, or a rule stops reading it, this
 * file fails, and none of the unit suites would.
 *
 * The crawl, the render pass and the rule run happen once, in `beforeAll`, in
 * that order — which is the order production runs them, and the only order the
 * render pass permits: `runRenderPass` refuses a crawl whose row still says
 * `running`, and the diff rules read columns the render pass writes. Every
 * assertion below reads the same result, so adding a fixture costs a page fetch
 * and a render, not a crawl.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { closeFetchAgents } from "../../src/crawl/http.js";
import { runCrawl, type CrawlConfig, type CrawlSummary } from "../../src/crawl/loop.js";
import { renderedHtmlFilename } from "../../src/crawl/render/renderer.js";
import { runRenderPass, type RenderPassSummary } from "../../src/crawl/render/run-render.js";
import { RENDER_DEFAULTS } from "../../src/crawl/render/select.js";
import { RENDER_PASS_EVIDENCE } from "../../src/rules/metric/render-metrics.js";
import {
  shapeMetricTable,
  type StoredMetricRow,
} from "../../src/rules/registry/metric-table.js";
import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  crawls,
  hreflang,
  issues,
  metrics,
  pages,
  resources,
  sitemapUrls,
} from "../../src/db/schema.js";
import { isCanonicalisedElsewhere, isJudged } from "../../src/rules/helpers.js";
import { buildRegistry } from "../../src/rules/index.js";

import {
  NEAR_DUPLICATE_MIN_MAIN_WORDS,
  SOFT_404_WORDS,
  THIN_WORDS,
} from "../../src/rules/query/content.js";
import { runRules } from "../../src/rules/run.js";
import type { Registry } from "../../src/rules/registry/registry.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
import { allFixtures } from "./fixture.js";
import { startFixtureApp, type FixtureApp } from "./app.js";
import { HEAVY_IMAGE_BYTES, startAssetHost, type AssetHost } from "./assets.js";
import {
  P11_BROKEN_PATH,
  P11_HEAVY_IMAGE,
  P11_HEAVY_PATH,
  P11_MISSING_IMAGE,
} from "./pages/authored-p11.js";
import { IMAGE_WEIGHT_WARN } from "../../src/rules/query/resources.js";
import {
  DUP_H1,
  DUP_META,
  DUP_TITLE,
  SHARED_META,
  SHARED_TITLE,
} from "./pages/absorbed.js";
import {
  P7_HIDDEN_CHROME_PATH,
  P7_RENDERABLE_WORD_COUNT,
  P7_SHARED_H1,
  P7_SHARED_H1_PATHS,
  P7_WORD_COUNT,
} from "./pages/authored-p7.js";
import {
  CSR_CHROME_WORDS,
  CSR_EXPECTED,
  startOffsiteHost,
  type OffsiteHost,
} from "./pages/render-p5.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Rules NO fixture can claim, because their firing condition is a property of an
 * unhealthy crawl, of a site this one cannot also be, or of the absence of
 * something another fixture had to publish.
 *
 * There is no second list beside this one any more. Phase 2 left ten rules
 * unclaimed and Phase 3 left twenty-two; Task 9 authored the pages, the sitemap
 * and the second host name they needed, and the assertion at the bottom of this
 * file is now the strict "every registered rule fires somewhere" it was always
 * meant to become. Adding an id here is a claim that no page could provoke it,
 * and it needs a paragraph of its own saying why, plus the test that covers the
 * rule directly.
 *
 * `links.orphan-skipped` fires only when the crawl did not finish — a frontier
 * that never drained, or a crawl stopped at its page cap. This harness asserts
 * the opposite in its first test (`frontier.pending === 0`, and `maxPages: 500`
 * against a site of a few dozen pages), so a fixture that made this rule speak
 * would be a fixture that broke the crawl. Its behaviour is covered by
 * `test/rules/link-graph-query.test.ts`, which builds the incomplete crawls
 * directly.
 *
 * `robots.missing` fires when the site ANSWERS 4xx for /robots.txt. The fixture
 * app serves one for the whole site — allow-all bar `/private/`, which is what
 * lets the crawl reach every fixture — and a robots.txt either exists for a site
 * or does not. No page could provoke this without removing the file the rest of
 * the harness depends on. `test/rules/robots-query.test.ts` builds both sites
 * directly.
 *
 * `robots.check-skipped` fires when the stored robots.txt cannot be re-parsed
 * soundly: a file past the 500KB read cap, or one the server never served. The
 * first would mean a fixture app serving half a megabyte of directives, the
 * second a crawl that fails outright (an unreachable robots.txt is a complete
 * disallow, so `runCrawl` closes the crawl as failed and nothing is crawled at
 * all). Both are properties of an unhealthy crawl, like `links.orphan-skipped`
 * above, and both are covered by the same DB test file.
 *
 * `host.probe-skipped` fires when the crawl recorded no host probe at all,
 * which happens only when a crawl is started with `probeHosts: false`. This
 * harness runs one crawl, with the probe on — asserted below, since
 * `host.http-serves-200` and `host.legacy-host-reachable` both fire from it — so
 * provoking this rule would mean turning off the evidence three other host rules
 * read. A property of how the crawl was started, like the two skips above, and
 * covered by `test/rules/host-query.test.ts`.
 *
 * `host.duplicate-host-200` needs the www and apex spellings of one host to
 * BOTH answer 200 over https. The fixture app is plain HTTP addressed by an IP
 * literal: an IP has no `www.` twin (see `hostnameSpellings`), and nothing on the
 * loopback serves TLS a crawl would accept, so neither half of the condition can
 * exist here however many pages or names are added. Its sibling
 * `host.legacy-host-reachable` IS claimed, by the second name this same server
 * answers to (`app.legacyBase`, passed as `legacyHosts`) — that one needs a
 * reachable extra origin, which is buildable, while this one needs two TLS
 * spellings of one host, which is not. Covered by the same DB test file, which
 * builds the probe rows directly.
 *
 * `sitemap.missing` fires when robots.txt declares no `Sitemap:` line. It fired
 * on every crawl of this site until Task 9, and it can never fire again: the
 * fixture app now declares two sitemaps, which is what the five rules joining
 * `sitemap_urls` to `pages` needed to have anything at all to read. The trade is
 * one way round — a site with a sitemap cannot also be a site without one — and
 * this is the direction that buys five claimed rules for one exempted. The rule
 * itself is covered directly by `test/rules/sitemap-query.test.ts`, which builds
 * a crawl whose discovery evidence names no sitemap source.
 *
 * `content.thin-skipped` fires on a CRAWL written before the analyzer computed
 * `main_word_count` — one where not a single page carries a count of its own
 * content (Phase 19 §11 moved it there from the pre-Phase-7 renderable column,
 * and made it site-scoped). This harness runs the real crawler, which computes
 * that count on the same pass as every other column, so the marker's condition
 * is false BY CONSTRUCTION here: producing the crawl it reports would mean
 * hand-writing `pages` rows, which is the one thing this file exists not to do.
 * Its firing, its silence on a current crawl, and its partition with the rule it
 * stands in for are covered directly in test/rules/content-query.test.ts. The
 * rule itself, `content.thin`, DOES fire here.
 *
 * `h1.duplicate-skipped` is the same shape as the thin skip, one column over.
 * It fires when a crawl stored H1 counts and no H1 TEXT — a row written before
 * `pages.h1_text` existed — and the real crawler writes both off one parse for
 * every page it reads, so no fixture can produce that crawl. Its condition is a
 * property of a pre-Phase-7 crawl rather than of a page, and building one here
 * would mean hand-writing `pages` rows, which is the one thing this file exists
 * not to do. Covered directly by test/rules/field-duplicates.test.ts, which
 * builds the pre-P7 shape and asserts the pair's partition over it — including
 * the case that must NOT skip, a site whose indexable pages genuinely carry no
 * h1 at all. The rule it stands in for, `h1.duplicate-text`, DOES fire here,
 * on a pair of pages authored to share a heading and nothing else.
 *
 * `schema.none-on-site` is the same trade in the structured-data family. Its
 * condition is "this crawl stored no JSON-LD of any type", and
 * `/authored3/product-incomplete` and `/authored3/reviews` had to publish some
 * for `schema.product-incomplete` and `schema.self-serving-reviews` to be
 * claimed at all. One rule out, two in. Its sibling `schema.breadcrumb-absent`
 * survives and is asserted below: no fixture publishes a `BreadcrumbList`, and
 * none should — it is the only site-scoped structured-data rule a site with
 * markup can still provoke. `test/rules/structured-data-query.test.ts` covers
 * the exempted rule directly, on a crawl with no blocks at all.
 */
const SKIP_HARNESS_CLAIMS: string[] = [
  "content.thin-skipped",
  // P19-T2's NOT MEASURED marker, unprovokable here for the same reason as the
  // thin skip above it: its condition is a property of a PRE-0018 CRAWL, not of
  // a page. It fires when the crawl holds auditable indexable pages and not one
  // of them carries a `main_simhash` — the main-content fingerprint the
  // near-duplicate rule compares — and this harness runs the current analyzer,
  // which computes that fingerprint on the same pass as every other column, for
  // every page with main content to measure. Every fixture page is served with
  // its whole body inside `<main>` (see `renderDocument` in test/fixtures/
  // render.ts), so the column is populated site-wide by the time the rules run
  // and the marker's condition is false BY CONSTRUCTION. Producing the crawl it
  // reports would mean hand-writing `pages` rows, which is the one thing this
  // file exists not to do. Its firing, its silence on a current crawl, its
  // silence on a crawl where only SOME pages lack the fingerprint, and its
  // partition with the rule it stands in for are covered directly in
  // test/rules/content-query.test.ts. The rule itself, `content.near-duplicate`,
  // DOES fire here — three pairs of the click-chain, pinned by distance below.
  "content.near-duplicate-skipped",
  // P11-T3's NOT MEASURED marker. It fires when a crawl holds no `resources`
  // rows at all while its pages counted images — a crawl written before
  // migration 0013, or one whose resource extraction never ran. This harness
  // runs the current crawler over a site that serves five images, one of them a
  // heavy PNG, plus one reference the app answers 404 for, so the table is full
  // by the time the rules run and the marker is unprovokable here BY
  // CONSTRUCTION rather than for want of a fixture. Its condition is covered
  // directly in test/rules/resources-query.test.ts, in both directions.
  "resources.not-recorded",
  // P12-T2's sibling marker, unprovokable here for the mirror-image reason. It
  // fires when a crawl recorded its files and asked about NONE of them — the
  // operator's `fetchResources: false`, or a pass interrupted before its first
  // request. This harness runs the pass to completion over a site that serves
  // real assets, so every row carries a class and the marker's condition (no row
  // decided) is false by construction. Both of its reasons are covered directly
  // in test/rules/resources-query.test.ts, along with the boundary against the
  // marker above it.
  "resources.not-fetched",
  // P13-T2's third and last marker, unprovokable here for the same
  // by-construction reason as its two siblings. It fires only when EVERY
  // resource row is a decided unknown class — refused, robots_denied,
  // robots_unreachable, fetch_error — with no `ok`, no broken and no unasked
  // row. This harness serves five real images (one weighed at 404), so the
  // census is dominated by `ok` and carries a `client_error`, and the marker's
  // condition (every row a decided unknown) is false by construction. Its
  // firing, its silence on partial/broken/unasked crawls, and the three-way
  // boundary against both siblings are covered directly in
  // test/rules/resources-query.test.ts.
  "resources.all-unknown",
  // P14-T1's fourth and last marker, unprovokable here for the same
  // by-construction reason as its three siblings. It fires only on a PARTIAL
  // pass whose decided rows are all a decided unknown class and whose rest is
  // still unasked (null), with no `ok` and no broken row. This harness runs the
  // pass to completion over a site that serves five real images (one weighed at
  // 404), so the census carries `ok` and `client_error` rows and no unasked
  // null — the mix this marker needs cannot occur. Its firing, its silence on
  // ok/broken/all-null/all-decided crawls, and the four-way boundary against its
  // siblings are covered directly in test/rules/resources-query.test.ts.
  "resources.partial-unknown",
  // P17-T3's transient half of the 5xx split, and the ONLY entry on this list
  // that is exempt because of what the fixture site DELIBERATELY IS NOT.
  //
  // It fires on a page whose first fetch was a server error and whose SECOND
  // — taken by the crawl's own recheck pass, INSERTION 3c — got a non-5xx
  // answer from the site. Provoking it needs a FLAPPING route: 503 to the crawl,
  // 200 to the look a minute later. The design ruled that route out of the
  // shared fixture app on purpose (§5.6): this app serves one site to one crawl
  // that every other file in the suite reads, and a stateful route would change
  // what that crawl sees depending on which test ran first and how many times
  // the page was fetched — the render pass, the resource pass and the 404 probe
  // all issue requests of their own. A fixture whose answer depends on request
  // ORDER is the one thing this file exists not to have.
  //
  // So `/status/server-error` stays a STATELESS 503, which means the recheck
  // asks it and gets 503 again — CONFIRMED, `http.server-error` at `critical`,
  // exactly as before the split. Both halves of that are asserted below ("the
  // 5xx re-verification pass ran on the fixture crawl"), including the negative
  // that belongs here: this rule fired on NO fixture, which is what proves the
  // split does not leak a confirmed outage into the transient bucket.
  //
  // The rule itself is covered end to end on servers that CAN flap: the pass's
  // nine cases in test/crawl/recheck.test.ts, the whole-loop wiring in
  // test/db/migration-0016.test.ts, and the rule's own predicate over the entire
  // `FetchClass` union — including the exclusivity guard that no 5xx page can
  // fire both rules or neither — in test/rules/status.test.ts.
  "http.server-error-transient",
  "h1.duplicate-skipped",
  "host.duplicate-host-200",
  "host.probe-skipped",
  "links.orphan-skipped",
  "robots.check-skipped",
  "robots.missing",
  "schema.none-on-site",
  "sitemap.missing",
];

/**
 * The settle this harness renders with.
 *
 * Production settles for three seconds (`RENDERER_DEFAULTS.settleMs`), which
 * over seventy pages would be three and a half minutes of waiting for
 * scripts that finished in five milliseconds. The DEFAULT is pinned by
 * test/crawl/renderer.test.ts rather than exercised again by this file, so what
 * this number has to be is *wide enough that no fixture's script can lose the
 * race*, not realistic.
 *
 * THE MARGIN, stated: the slowest script on this site is either redirect page's
 * timer, armed for `REDIRECT_DELAY_MS` (5ms, test/fixtures/pages/render-p5.ts).
 * 500ms is a **100×** margin against it. The previous pairing here was 30ms
 * against 300ms — 10×, ledgered as such — and a 7.5× margin of exactly that
 * shape is what a loaded machine broke in test/crawl/renderer.test.ts during
 * the phase-5 review. A settle only ever ends by expiring, so widening it costs
 * wall and nothing else: 73 renders at concurrency 4 pay about 3.5 extra
 * seconds for it.
 */
const RENDER_SETTLE_MS = 500;

/**
 * THE RULES THE FIXTURE CRAWL ACTUALLY TRIPS, named.
 *
 * The column guard below can only speak for rules that wrote a finding on this
 * crawl — 71 of the 86 that find, the remainder being the site-scoped markers
 * and the rules `SKIP_HARNESS_CLAIMS` explains. It used to assert only "at
 * least twenty of them", which is a floor a fixture could fall fifty rules
 * through without going red.
 *
 * So the floor is this LIST. It is derived, not designed: it is what the crawl
 * produced when it was written, and it is checked as a SUBSET of what fires —
 * a rule joining the list is a fixture doing more and needs no edit here, a
 * rule leaving it is the guard going quiet about a rule and fails by name. The
 * static half of the same claim, over all 86 whether they fire or not, is
 * test/rules/registry.test.ts ("every declared column names a key its own
 * rule's source writes").
 */
const FIXTURE_COLUMN_RULES: readonly string[] = [
  "canonical.cross-domain",
  "canonical.html-header-conflict",
  "canonical.missing",
  "canonical.multiple",
  "canonical.non-200-target",
  "canonical.non-indexable-target",
  "canonical.points-elsewhere",
  "content.csr-dependent",
  "content.exact-duplicate",
  "content.near-duplicate",
  "content.placeholder",
  "content.soft-404",
  "content.thin",
  "crawl.blocked",
  "directive.canonical-noindex-conflict",
  "filters.js-only",
  "h1.duplicate-text",
  "headings.h1-missing",
  "headings.h1-multiple",
  "headings.level-skip",
  "host.http-serves-200",
  "host.legacy-host-reachable",
  "hreflang.alternates-not-crawled",
  "hreflang.invalid-code",
  "hreflang.missing-return-link",
  "hreflang.missing-self-reference",
  "hreflang.missing-x-default",
  "hreflang.non-indexable-target",
  "http.server-error",
  "images.legacy-format",
  "images.missing-alt",
  "images.missing-dimensions",
  "images.oversized",
  "indexability.meta-header-conflict",
  "indexability.noindex",
  "links.broken-internal",
  "links.orphan",
  "links.to-server-error",
  "meta-description.duplicate",
  "meta-description.missing",
  "meta-description.too-long",
  "meta-description.too-short",
  "mobile.viewport-missing",
  "nav.js-only",
  "pages.not-in-sitemap",
  "pagination.canonical-to-other",
  "pagination.next-not-linked",
  "pagination.next-target-uncrawled",
  "performance.slow-response",
  "redirect.chain",
  "redirect.js",
  "redirect.loop",
  "resources.broken",
  "resources.uncached",
  "robots.blocks-sitemap-urls",
  "schema.breadcrumb-absent",
  "schema.product-incomplete",
  "schema.self-serving-reviews",
  "sitemap.invalid",
  "sitemap.non-200",
  "sitemap.non-indexable",
  "sitemap.redirected",
  "sitemap.uncrawled",
  "structure.deep-page",
  "title.duplicate",
  "title.missing",
  "title.too-long",
  "title.too-short",
  "url.normalisation-variants",
  "url.parameter-pages-indexable",
  "url.tracking-params-internal",];


/**
 * The render budget this harness runs with: 100% of the crawl, both other knobs
 * at their production defaults.
 *
 * Deliberate, and the whole reason `render.coverage`'s row below can be pinned
 * as arithmetic rather than as an outcome. At 100% the budget is the crawl's
 * page count (84), which is comfortably more than the 71 pages suspicion and
 * the per-type sample between them nominate — so nothing is cut, `truncated` is
 * false, and the selected set is exactly the candidate set. A smaller percentage
 * would make the assertion a statement about which candidates happened to sort
 * first, which proves nothing about the fixtures this task added. The BUDGET CUT
 * itself is covered directly by test/crawl/render-select.test.ts.
 */
const RENDER_BUDGET_PCT = 100;

let db: Db;
let app: FixtureApp;
/** The second origin `/render/js-redirect-offsite` sends the browser to. */
let offsite: OffsiteHost;
/** The third origin: the CDN the hub carries one image from (P11-T2). */
let assetHost: AssetHost;
let summary: CrawlSummary;
let render: RenderPassSummary;
/**
 * Where this run's serialised post-JavaScript documents go.
 *
 * A temporary directory rather than the production `renders/`, and removed in
 * `afterAll` with the crawl row: a suite that left seventy HTML files in the
 * repository would be indistinguishable from a real pass's evidence, and the
 * next run's `crawlId` would make a second copy rather than replacing the
 * first.
 */
let renderHtmlRoot: string;
let registry: Registry;

/**
 * Path -> the `pages` row the crawl wrote for it. The whole row, not just the
 * path: an assertion about what a page fired means nothing without the fetch
 * outcome beside it, because most rules are gated on `isAuditable` and a page
 * that 404s or redirects fires nothing at all (see the control assertion).
 *
 * The key is pathname + query, and a collision throws rather than merging. Two
 * URLs that differ only in their query string are two pages and two sets of
 * findings; letting them share a key would let one page's finding satisfy
 * another page's expectation, which is the one failure this whole file exists
 * to prevent.
 */
const pageByPath = new Map<string, PageRecord>();
/** Path -> the rule ids that fired on the page at that path. */
const issuesByPath = new Map<string, Set<string>>();
/**
 * `${path}\n${ruleId}` -> the details the rule wrote. A rule id alone says a
 * finding landed; the details say it landed on the right evidence, which is
 * what makes a fixture load-bearing rather than decorative.
 *
 * **LAST WRITE WINS.** A rule that writes SEVERAL findings for one page — the
 * two hreflang join rules do, one per member of a cluster, and so does
 * `content.near-duplicate` per pair — leaves only the last of them here, and
 * which one that is depends on the order the rows came back in. Pin those from
 * the `issues` table instead, reading the whole set for the rule id and
 * asserting it as a set (`the hreflang clusters` and `the duplicate rules`
 * below do exactly that).
 */
const detailsByPath = new Map<string, unknown>();
/**
 * Findings that belong to no URL, by rule id, with the evidence each one wrote.
 *
 * An ARRAY per rule, because a site-scoped rule may legitimately speak more than
 * once: `host.http-serves-200` writes one finding per plaintext spelling, and
 * this site has two names. The keys are asserted exactly and the multi-finding
 * rules are asserted by their evidence, so a rule that changed shape — or one
 * whose skip condition started matching a healthy crawl — surfaces here instead
 * of vanishing.
 */
const siteFindings = new Map<string, unknown[]>();
/**
 * Path -> the hreflang codes the page at that path declared, sorted, read
 * straight from the `hreflang` table. This is the input side of the site-scoped
 * rule: it says which fixture contributed which declaration, so a fixture that
 * stopped contributing fails an assertion instead of quietly not mattering.
 */
const hreflangByPath = new Map<string, string[]>();
/**
 * Metric id -> its rows for this crawl, keyed by `"<scope>|<scopeValue>"`.
 *
 * The metric layer's half of this file. A metric rule writes no `issues` row —
 * it produces a table of numbers rather than an accusation — so none of the
 * maps above can see one, and until this map existed the harness could not tell
 * a metric that ran from a metric that did not.
 *
 * The key is the rest of the `metrics` primary key (`crawl, metric, scope,
 * scopeValue`), so a duplicate here would be a row the runner's upsert should
 * have collapsed; it throws rather than overwriting, for the same reason
 * `pageByPath` does.
 */
const metricsById = new Map<string, Map<string, unknown>>();

/** One metric's site row, or a failure naming the metric that has none. */
function siteMetric(metricId: string): unknown {
  const value = metricsById.get(metricId)?.get("site|");
  if (value === undefined) throw new Error(`${metricId} wrote no site row for this crawl`);
  return value;
}

/**
 * A details blob serialised with its keys in a fixed order, for sorting.
 *
 * `JSON.stringify` alone would not do: `issues.details` is a jsonb column, and
 * Postgres stores an object's keys ordered by length and then by bytes rather
 * than as written — so the first characters of the serialised form would be
 * whichever key happened to be shortest, and the sort below would order findings
 * by a field nobody chose. Sorting the keys puts the blob's fields in a fixed,
 * readable order instead, so the sequence an assertion is written against comes
 * from the evidence rather than from how Postgres happened to store it.
 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, member]) => `${key}:${stableKey(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Every finding one rule wrote on this crawl, as its details blobs, sorted.
 *
 * The escape hatch from `detailsByPath` for a rule that writes SEVERAL findings
 * for one page: that map is keyed by path and rule and therefore keeps only the
 * last of them. The sort is by serialised content rather than by any one field,
 * because these queries have no ORDER BY and the row order is the planner's
 * business — the SET is what the assertion is about.
 */
async function findingSet(ruleId: string): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.crawlId, summary.crawlId), eq(issues.ruleId, ruleId)));
  return rows
    .map((row) => row.details)
    .sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : 1));
}

beforeAll(async () => {
  db = createDb(databaseUrl());
  await runMigrations(db);
  // Before the app: `/render/js-redirect-offsite` reads this origin on every
  // request and throws if it is not up, rather than serving a page that
  // redirects nowhere (see test/fixtures/pages/render-p5.ts).
  offsite = await startOffsiteHost();
  // Before the app for the same reason: the hub reads this origin on every
  // request and throws if it is not up (see test/fixtures/assets.ts).
  assetHost = await startAssetHost();
  app = await startFixtureApp(allFixtures());

  const config: CrawlConfig = {
    siteUrl: app.base,
    maxPages: 500,
    maxDepth: 10,
    userAgent: "AriadneBot-fixture",
    perHostDelayMs: 0,
    maxConcurrency: 8,
    // The second name the fixture server answers to. It is the same machine and
    // the same site — which is exactly what a legacy domain from a rebrand is —
    // and it is the only way `host.legacy-host-reachable` can be exercised
    // through the real probe rather than from hand-built evidence.
    legacyHosts: [app.legacyBase],
    // The sanctioned test-only use: the fixture site is on 127.0.0.1.
    allowPrivate: true,
    // The second sanctioned test-only field (P17-T5). This site serves a 5xx
    // (`/status/server-error`), so the loop's INSERTION 3c re-asks it — and
    // would wait out the real `MIN_RECHECK_GAP_MS` first, a minute added to
    // every run of the slowest file in the suite. What this harness asserts
    // about the recheck is WHICH ROW carries a second observation and WHICH
    // RULE fires on it, and neither claim depends on the length of the gap; the
    // 60 seconds is asserted as the constant it is in test/crawl/recheck.test.ts.
    recheckMinGapMs: 200,
    // Stored on the `crawls` row by `startCrawl`, and read back out of it by
    // `render.coverage` — which is why the budget lives in the CRAWL config
    // rather than being handed to the render pass alone. The metric describes
    // the selection that actually happened, and it can only do that if the two
    // read the same object.
    renderBudgetPct: RENDER_BUDGET_PCT,
  };
  summary = await runCrawl(db, config);

  // The crawl is `finished` by the time `runCrawl` returns (`closeCrawl` writes
  // the status before the summary is built), which is what lets the render pass
  // run at all: it refuses a crawl whose row still says `running`.
  //
  // The same config object, plus the one knob that is not a crawl's business.
  // A `CrawlConfig` satisfies `RenderPassConfig` structurally on purpose, so
  // the render cannot end up with a different user agent or a different
  // per-host delay from the crawl it belongs to (hard rule 9).
  renderHtmlRoot = await mkdtemp(join(tmpdir(), "ariadne-harness-renders-"));
  render = await runRenderPass(db, summary.crawlId, {
    ...config,
    settleMs: RENDER_SETTLE_MS,
    renderHtmlDir: renderHtmlRoot,
  });

  registry = buildRegistry();
  await runRules(db, summary.crawlId, registry);

  const pageRows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
  const pathById = new Map<string, string>();
  for (const page of pageRows) {
    const url = new URL(page.url);
    // Query included: `/x?a=1` and `/x` are two pages with two sets of
    // findings, and a fixture that asserts about one must never be handed the
    // other's. A collision is our defect, not a page to merge into.
    const key = `${url.pathname}${url.search}`;
    const existing = pageByPath.get(key);
    if (existing !== undefined) {
      throw new Error(
        `two pages rows share the key ${key}: ${existing.url} and ${page.url}`,
      );
    }
    pageByPath.set(key, page);
    pathById.set(page.id, key);
  }

  for (const row of await db.select().from(issues).where(eq(issues.crawlId, summary.crawlId))) {
    // A null page id is a site-scoped finding: it belongs to the crawl, not to
    // a URL, so it maps to no path — which is what keeps it off /control.
    if (row.pageId === null) {
      siteFindings.set(row.ruleId, [...(siteFindings.get(row.ruleId) ?? []), row.details]);
      continue;
    }
    const path = pathById.get(row.pageId);
    if (path === undefined) {
      throw new Error(`issue ${row.ruleId} names page ${row.pageId}, which has no pages row`);
    }
    const fired = issuesByPath.get(path) ?? new Set<string>();
    fired.add(row.ruleId);
    issuesByPath.set(path, fired);
    detailsByPath.set(`${path}\n${row.ruleId}`, row.details);
  }

  for (const row of await db
    .select()
    .from(hreflang)
    .where(eq(hreflang.crawlId, summary.crawlId))) {
    const path = pathById.get(row.pageId);
    if (path === undefined) {
      throw new Error(
        `hreflang ${row.hreflangCode} names page ${row.pageId}, which has no pages row`,
      );
    }
    const codes = hreflangByPath.get(path) ?? [];
    codes.push(row.hreflangCode);
    hreflangByPath.set(path, codes);
  }
  for (const codes of hreflangByPath.values()) codes.sort();

  for (const row of await db.select().from(metrics).where(eq(metrics.crawlId, summary.crawlId))) {
    const byScope = metricsById.get(row.metricId) ?? new Map<string, unknown>();
    const key = `${row.scope}|${row.scopeValue}`;
    if (byScope.has(key)) {
      throw new Error(`two metrics rows share the key ${row.metricId} ${key}`);
    }
    byScope.set(key, row.value);
    metricsById.set(row.metricId, byScope);
  }
}, 120_000);

afterAll(async () => {
  // The crawl row cascades to pages, issues and the frontier.
  if (db !== undefined && summary !== undefined) {
    await db.delete(crawls).where(eq(crawls.id, summary.crawlId));
  }
  if (db !== undefined) await closeDb(db);
  if (renderHtmlRoot !== undefined) await rm(renderHtmlRoot, { recursive: true, force: true });
  await closeFetchAgents();
  if (app !== undefined) await app.close();
  if (offsite !== undefined) await offsite.close();
  if (assetHost !== undefined) await assetHost.close();
});

describe("the fixture site end to end", () => {
  it("crawls cleanly and reaches every fixture", () => {
    expect(summary.status).toBe("finished");
    expect(summary.frontier.pending).toBe(0);
    // Exactly one: `/status/blocked`, the fixture that answers 403 to every
    // crawler. A block is retried three times under widening per-host spacing
    // (Task 6b) and then settles as a classified `blocked` page row and a
    // FAILED frontier row — the same disposition a spent timeout gets, because
    // in both cases the URL's own outbound links were never read.
    expect(summary.frontier.failed).toBe(1);

    // Asserted from the `pages` rows, not from the findings: a fixture that
    // fires nothing (the control) still has to have been fetched, and a fixture
    // the hub forgot to link would otherwise surface as a missing finding,
    // which reads like a broken rule rather than an unreachable page.
    for (const fixture of allFixtures()) {
      expect([...pageByPath.keys()], `${fixture.path} was never crawled`).toContain(
        fixture.path,
      );
    }
  });

  it("every fixture's expected issues fire on its path", () => {
    for (const fixture of allFixtures()) {
      const fired = [...(issuesByPath.get(fixture.path) ?? new Set<string>())].sort();

      // The authored fixtures declare the COMPLETE set (see `Fixture.exact`):
      // each is the control page with one thing deliberately broken, so a rule
      // they did not name is a rule that should not have fired, and a
      // containment assertion would let it through in silence.
      if (fixture.exact === true) {
        expect(
          fired,
          `${fixture.path} must fire exactly the issues it declares`,
        ).toEqual([...fixture.expectedIssues].sort());
        continue;
      }

      // The absorbed pages declare a floor: upstream built them to demonstrate
      // one issue, not to be quiet about the rest.
      for (const ruleId of fixture.expectedIssues) {
        expect(fired, `${fixture.path} should fire ${ruleId}`).toContain(ruleId);
      }
    }
  });

  /**
   * PHASE 22 §1, END TO END: the pages this site serves that are NOT judged —
   * three noindexed and seven canonicalised elsewhere — carry none of the rules
   * that moved to the judged cohort.
   *
   * The unit tests pin each rule's silence over rows inserted by hand; this
   * pins it over pages a real crawler fetched from a real server, on the two
   * fixtures the spec named (`/index/canonicalized`, `/index/noindex-meta`) and
   * on the eight beside them. Before this phase `/index/canonicalized` carried
   * `content.thin` and `/index/noindex-meta` carried it too — findings about
   * pages that had already handed their signals elsewhere or asked to be left
   * out of the index.
   */
  it("no rule that moved to the judged cohort fires on a page outside it", () => {
    // The list from the spec's §1, first list, as rule ids. Each is checked
    // against the registry first: a renamed rule would otherwise make this
    // sweep quietly weaker instead of failing.
    const MOVED = [
      "title.missing", "title.too-short", "title.too-long", "title.duplicate",
      "meta-description.missing", "meta-description.too-short",
      "meta-description.too-long", "meta-description.duplicate",
      "headings.h1-missing", "headings.h1-multiple", "headings.level-skip",
      "h1.duplicate-text", "content.placeholder", "content.thin",
      "content.near-duplicate", "content.exact-duplicate", "images.missing-alt",
      "images.missing-dimensions", "mobile.viewport-missing",
      "performance.slow-response", "schema.product-incomplete",
      "schema.self-serving-reviews", "links.orphan", "structure.deep-page",
      "pages.not-in-sitemap", "url.parameter-pages-indexable",
    ];
    const known = new Set(registry.all().map((r) => r.id));
    expect(MOVED.filter((id) => !known.has(id)), "not rule ids any more").toEqual([]);

    const setAside: string[] = [];
    for (const [path, page] of pageByPath) {
      if (page.fetchClass !== "ok" || page.statusCode !== 200) continue;
      if (isJudged(page)) continue;
      setAside.push(path);
      const fired = [...(issuesByPath.get(path) ?? new Set<string>())];
      expect(
        fired.filter((id) => MOVED.includes(id)).sort(),
        `${path} is outside the judged cohort and must carry none of the moved rules`,
      ).toEqual([]);
    }

    // THE SWEEP IS NOT VACUOUS, in both directions. There are pages outside the
    // cohort on this site — the two the spec named among them — and the rules
    // above do fire on the pages that ARE judged, so the silence observed is
    // the cohort's doing and not a ruleset that stopped working.
    expect(setAside.sort()).toContain("/index/canonicalized");
    expect(setAside).toContain("/index/noindex-meta");
    expect(setAside.length).toBe(10);
    const firedSomewhere = new Set([...issuesByPath.values()].flatMap((ids) => [...ids]));
    expect(MOVED.filter((id) => firedSomewhere.has(id)).length).toBeGreaterThan(10);
  });

  it("no rule fires on the control page", () => {
    // "Fired nothing" is only evidence if the page was actually audited. Almost
    // every page rule is gated on `isAuditable`, so a control that regressed to
    // a 404, a redirect or a body the analyzer could not read would fire
    // nothing and pass this assertion while proving the opposite of what it
    // claims. The fetch outcome is checked first, from the page row.
    const control = pageByPath.get("/control");
    if (control === undefined) {
      throw new Error("/control has no pages row: the control page was never crawled");
    }
    expect(control.fetchClass, "/control must be a clean fetch to prove anything").toBe("ok");
    expect(control.statusCode).toBe(200);
    // A null word count means no analysis ran — the page rules read a row with
    // nothing in it, which is silence for the wrong reason.
    expect(control.wordCount, "/control must have been analyzed").not.toBeNull();

    // The hub at `/` legitimately fires rules — it is a page, not the control.
    expect([...(issuesByPath.get("/control") ?? new Set<string>())]).toEqual([]);
  });

  it("the two word counts reach the database as the hidden-chrome page's own arithmetic", () => {
    // P7-T1's end-to-end claim. The fixture states both numbers as sums of the
    // words in each of its blocks (test/fixtures/pages/authored-p7.ts); the
    // analyzer unit test asserts `analyzePage` reproduces them from the same
    // markup; this asserts the row a REAL crawl of that page wrote, which is
    // the only assertion that covers the writer and the columns as well.
    const page = pageByPath.get(P7_HIDDEN_CHROME_PATH);
    if (page === undefined) {
      throw new Error(`${P7_HIDDEN_CHROME_PATH} has no pages row: it was never crawled`);
    }
    expect(page.fetchClass).toBe("ok");
    expect(page.statusCode).toBe(200);
    expect(page.wordCount).toBe(P7_WORD_COUNT);
    expect(page.renderableWordCount).toBe(P7_RENDERABLE_WORD_COUNT);
    // The template's words are in NEITHER column — the correction that moved
    // `word_count` itself — and the hidden blocks are in the first only.
    expect(page.wordCount! - page.renderableWordCount!).toBe(82);
    // And the h1 the analyzer captured for Task 2's rule to read, written by
    // the same pass and stored by the same writer.
    expect(page.h1Text).toBe("A page whose markup hides most of its words");
    // And the column Task 4 now writes: this page is linked from the hub and
    // from nowhere else, so it is one click from the home page. It was pinned as
    // NULL here while the column existed and nothing filled it — "not written
    // yet" being a state a test has to be able to state — and the click-depth
    // assertion further down is where that column is now measured in full.
    expect(page.clickDepth).toBe(1);
  });

  it("the site-scoped findings are the two host names, the sitemap's own faults and the missing breadcrumbs", async () => {
    // Six rules write a null-page finding on this crawl, and each of them is a
    // statement about the SITE rather than about a URL:
    //
    //  - `host.http-serves-200` twice, because this server answers to two names
    //    and both of them serve a page over plain HTTP. That is CHECK-14, true
    //    of both spellings, and reporting it once would hide one of them.
    //  - `host.legacy-host-reachable` for the second of those names, which the
    //    crawl was given as `legacyHosts`: an origin that is not one of the
    //    site's own spellings and still serves the site under its own name.
    //    Between them these two prove the probe RAN, which is what puts
    //    `host.probe-skipped` in `SKIP_HARNESS_CLAIMS` rather than anywhere else.
    //  - `robots.blocks-sitemap-urls` and `sitemap.uncrawled` for the same URL,
    //    `/private/hidden`: robots.txt disallows it, so the crawl never enqueued
    //    it, so it has no `pages` row. Two rules, two fixes — take it out of the
    //    sitemap, or stop disallowing it — which is why they are not one finding.
    //  - `sitemap.invalid` for the second declared document, which answers 200
    //    with an HTML error page.
    //  - `schema.breadcrumb-absent`, because no fixture publishes a
    //    `BreadcrumbList` and the site is well past the five-page floor.
    //  - `hreflang.alternates-not-crawled` (P19-T3), the NOT MEASURED marker
    //    for alternates this crawl never fetched. Two fixtures name a language
    //    version on a host that does not exist — `https://de.example/willkommen`
    //    and `https://en-gb.example/opening-hours` — so the return links and
    //    indexability of those two URLs are unknown, and the marker says so
    //    once for the crawl rather than staying silent about it. It is site-
    //    scoped because the gap is a property of the crawl, not of a page.
    //
    // Everything else must stay off this list. `links.orphan-skipped` and
    // `robots.check-skipped` write null-page findings only when the crawl was
    // incomplete or its robots.txt unreadable — this crawl drains its frontier,
    // stops well short of maxPages and reads a five-line robots.txt — and
    // `robots.missing` needs a site that answers 4xx for it. `sitemap.missing`
    // and `schema.none-on-site` were both live here until Task 9 and can never
    // fire again, which is what their `SKIP_HARNESS_CLAIMS` paragraphs are about.
    expect([...siteFindings.keys()].sort()).toEqual([
      "host.http-serves-200",
      "host.legacy-host-reachable",
      "hreflang.alternates-not-crawled",
      // P11-T3. `/img/control-outline.svg` is served with no `cache-control`
      // and no `expires` (test/fixtures/assets.ts, where it says so), and the
      // rule speaks once for the site rather than once per file — which is why
      // a resource finding provoked by an image ON THE CONTROL PAGE leaves the
      // control page's own assertion of silence intact. A resource is not a
      // page, and the control's silence is about its markup.
      "resources.uncached",
      "robots.blocks-sitemap-urls",
      "schema.breadcrumb-absent",
      "sitemap.invalid",
      "sitemap.uncrawled",
    ]);

    // The breadcrumb finding carries how many pages of this site the ruleset
    // judged, and the number is checked against the `pages` rows the crawl
    // actually wrote rather than pinned as a literal, so adding a fixture does
    // not turn into an unrelated failure here. The evidence key is still
    // `indexablePages` — no key was removed in Phase 22 §1 — but the cohort
    // behind it is `isJudged`, read here through the rule layer's own predicate
    // so the two cannot drift.
    const indexablePages = [...pageByPath.values()].filter((p) => isJudged(p)).length;
    expect(indexablePages).toBeGreaterThanOrEqual(5);
    // `runRules` writes `pageUrl` into every details blob; a site-scoped finding
    // names no page, so it is null here.
    expect(siteFindings.get("schema.breadcrumb-absent")).toEqual([
      { pageUrl: null, indexablePages },
    ]);

    // Both plaintext spellings, each with the single hop its chain walked: the
    // fixture server answered the root itself rather than redirecting anywhere.
    // Sorted, because the order the two variants are probed in is the probe's
    // business and not something this assertion should depend on.
    const httpVariants = (siteFindings.get("host.http-serves-200") ?? [])
      .map((d) => (d as { variant: string }).variant)
      .sort();
    expect(httpVariants).toEqual([`${app.base}/`, `${app.legacyBase}/`].sort());
    for (const finding of siteFindings.get("host.http-serves-200") ?? []) {
      const variant = (finding as { variant: string }).variant;
      expect(finding).toMatchObject({
        pageUrl: variant,
        hops: [{ url: variant, statusCode: 200, fetchClass: "ok", location: null }],
      });
    }

    // The legacy name, and only that one: the site's own spellings are excluded
    // by subtraction from `hostProbeStarts`, so a rule that started reporting
    // them would show up here as a second entry rather than as a silent change.
    expect(siteFindings.get("host.legacy-host-reachable")).toEqual([
      {
        pageUrl: `${app.legacyBase}/`,
        variant: `${app.legacyBase}/`,
        hops: [
          { url: `${app.legacyBase}/`, statusCode: 200, fetchClass: "ok", location: null },
        ],
      },
    ]);

    // The blocked URL, from both sides. `matchedBy` quotes the line of the file
    // that decided, which is what makes the finding a place in a document rather
    // than a claim to be taken on trust.
    const blockedUrl = `${app.base}/private/hidden`;
    expect(siteFindings.get("robots.blocks-sitemap-urls")).toEqual([
      {
        pageUrl: blockedUrl,
        url: blockedUrl,
        userAgent: "AriadneBot-fixture",
        matchedBy: { line: 3, text: "Disallow: /private/" },
      },
    ]);
    expect(siteFindings.get("sitemap.uncrawled")).toEqual([
      // `attempted: false` is the shape that matters: there is no `pages` row at
      // all, because the crawl refused to enqueue a URL robots.txt disallows.
      // A URL that was fetched and failed would carry a fetch class instead.
      // `offOrigin: false` says which of the two never-attempted cases this is:
      // the URL is on this site and the robots disallow is the real reason, so
      // the copy's first cause is the true one here.
      { pageUrl: blockedUrl, url: blockedUrl, attempted: false, offOrigin: false },
    ]);

    expect(siteFindings.get("sitemap.invalid")).toEqual([
      {
        pageUrl: null,
        failures: [
          {
            url: `${app.base}/sitemap-broken.xml`,
            // The HTML error page that document serves opens with a doctype, and
            // a DTD in a sitemap is refused before the XML parser is handed the
            // bytes. See the fixture app's own comment.
            reason: "refused: <!DOCTYPE declaration in a sitemap (entity-expansion risk)",
          },
        ],
        failureCount: 1,
      },
    ]);
  });

  /**
   * NO RULE'S EVIDENCE MAY CARRY A `pageUrl` KEY.
   *
   * `runRules` writes a finding's details as `{pageUrl: f.pageUrl, ...f.evidence}`
   * (src/rules/run.ts). The spread is LAST, so a rule that happened to name a
   * field `pageUrl` inside its evidence would silently overwrite the page the
   * finding was filed against — and `pageUrl` is not decoration: P10-T3's
   * cross-crawl compare joins on `(rule_id, details_jsonb->>'pageUrl')`, so an
   * override would move a finding onto another URL in every diff, quietly and
   * for ever. Nothing else in the codebase would notice: the row is well formed,
   * the count is right, and the URL is a URL.
   *
   * ## Why this is a runtime check and not a source scan
   *
   * A source scan is the tempting version — it would cover every rule whether or
   * not it fires — and it does not survive contact with the ruleset. Of the 41
   * `evidence:` sites in `src/rules/`, forty are object literals a brace-match
   * could read, and the forty-first is `evidence: evidenceOf(row)` in
   * sitemap.ts, where `evidenceOf` is a PARAMETER and the real literals are
   * arrow functions passed in from the rule definitions below it. Following that
   * statically is writing a resolver, and a guard whose own correctness needs a
   * guard is not a guard. So this asserts the OBSERVABLE consequence over a real
   * judged crawl instead.
   *
   * ## What that covers, stated rather than implied
   *
   * The fixture site is built to trip rules, and the count of distinct rules
   * that actually fired is asserted below rather than described — so this test
   * says how much of the ruleset it speaks for, and a fixture change that
   * narrowed the run would fail here rather than quietly weakening the guard.
   *
   * Two gaps, both named where they sit: a rule that fires on NO fixture page is
   * not covered at all, and a finding with no `page_id` has no `pages` row to be
   * checked against (see the second assertion).
   */
  it("never lets a rule's evidence overwrite the page URL a finding was filed against", async () => {
    // THE OVERRIDE, in the only form it can take: a finding whose stored
    // `pageUrl` is not the URL of the page it names. `is distinct from` rather
    // than `<>` so a null on either side counts as a mismatch instead of
    // dropping out of the comparison.
    const moved = await db.execute<{ rule_id: string; page_url: string; evidence_url: string }>(sql`
      select i.rule_id, p.url as page_url, i.details_jsonb->>'pageUrl' as evidence_url
        from issues i
        join pages p on p.id = i.page_id
       where i.crawl_id = ${summary.crawlId}
         and i.details_jsonb->>'pageUrl' is distinct from p.url`);
    expect(moved.rows).toEqual([]);

    // A `page_id`-LESS FINDING IS NOT THE SAME AS A SITE-SCOPED ONE, and this
    // test asserted otherwise until the fixture said no. `host.http-serves-200`,
    // `host.legacy-host-reachable`, `robots.blocks-sitemap-urls` and
    // `sitemap.uncrawled` all name a real URL with a null `page_id`: a host
    // variant that was probed but never crawled, or a URL robots.txt kept out of
    // the frontier. There is no `pages` row to check them against, so there is no
    // independent source of truth for their `pageUrl` and no assertion here that
    // would be sound. THAT IS THE HOLE IN THIS GUARD, named rather than papered
    // over — and it is small, because the shape a mistake takes is a value that
    // is not a URL at all, which the next assertion does catch.
    const notAUrl = await db.execute<{ rule_id: string; url: string }>(sql`
      select i.rule_id, i.details_jsonb->>'pageUrl' as url
        from issues i
       where i.crawl_id = ${summary.crawlId}
         and i.details_jsonb->>'pageUrl' is not null
         and i.details_jsonb->>'pageUrl' !~ '^https?://'`);
    expect(notAUrl.rows).toEqual([]);

    // And the key is PRESENT on every row, null or not: `issue_urls` and the
    // compare both read it, and an absent key and a null one are the same
    // `->>` result but not the same fact.
    const keyless = await db.execute<{ rule_id: string }>(sql`
      select distinct i.rule_id from issues i
       where i.crawl_id = ${summary.crawlId}
         and not (i.details_jsonb ? 'pageUrl')`);
    expect(keyless.rows).toEqual([]);

    // HOW MUCH OF THE RULESET THIS SPEAKS FOR. Derived from the run, not
    // written down: the assertion is that the fixture site exercises a
    // substantial share of the ruleset, so a fixture change that stopped
    // tripping rules fails here instead of leaving the guard nominally green
    // over almost nothing.
    const fired = await db.execute<{ n: number }>(sql`
      select count(distinct rule_id)::int as n from issues where crawl_id = ${summary.crawlId}`);
    expect(Number(fired.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(
      FIXTURE_COLUMN_RULES.length,
    );
  });

  /**
   * EVERY COLUMN A RULE DECLARES IS A COLUMN THAT EXISTS, AND EVERY EVIDENCE
   * KEY IS A COLUMN SOMEBODY SEES.
   *
   * `RuleMeta.columns` is a claim about what a rule writes, and `defineRule`
   * cannot check it: a declaration is metadata and the evidence only exists
   * once a rule has run over a real crawl. This is where it is checked, in both
   * directions, because both directions are a real failure:
   *
   *  - a declared column that never appears is a HEADING WITH NOTHING UNDER IT
   *    — a report that promises a fact the rule cannot produce;
   *  - an evidence key no column names is a COLUMN NOBODY SEES. Evidence is the
   *    report now: a rule that measured something and did not declare it has
   *    put the answer where only a JSON reader will find it.
   *
   * ## The three keys a rule may write without declaring, and why each
   *
   *  - `pageUrl` — `runRules` writes it, not the rule (and the test above
   *    forbids a rule from writing one at all). It is the `address` column.
   *  - `truncated` — the CAP MACHINERY writes it onto the last finding of a
   *    capped run (`noteOnLast`, src/rules/query/crawl-evidence.ts). It is not a
   *    fact about the page in that row; every surface reads it as the listing's
   *    own note, and the CSV gives it a fixed trailing column of its own.
   *  - `statusCode` — nine rules record the status of the page their finding
   *    names, and the standard `Status Code` column already prints it FROM THE
   *    PAGE ROW. Declaring it would put two columns under one heading, filled
   *    from two sources. That exemption is only sound if the two sources always
   *    agree, so the second assertion below checks exactly that rather than
   *    trusting the paragraph.
   *
   * And one key a rule may write without declaring BECAUSE IT IS MEASURED to be
   * the address: a rule whose evidence restates the URL its finding is filed
   * against (`targetUrl` on the link rules, `url` on the sitemap rules,
   * `variant` on the host probes, `fromUrl` on the JavaScript redirect). The
   * exemption is not a list — it is computed from the rows: a key qualifies
   * only if EVERY finding of that rule has it equal to that finding's own
   * `pageUrl`. A rule whose key sometimes differs is a rule that is saying
   * something new, and it needs a column.
   */
  it("declares a column for every evidence key it writes, and writes every column it declares", async () => {
    const FRAMEWORK_KEYS = new Set(["pageUrl", "truncated", "statusCode"]);

    const rows = await db
      .select()
      .from(issues)
      .where(eq(issues.crawlId, summary.crawlId));
    const byRule = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const blob = row.details as Record<string, unknown>;
      const list = byRule.get(row.ruleId);
      if (list === undefined) byRule.set(row.ruleId, [blob]);
      else list.push(blob);
    }
    // The guard speaks for the rules that FIRED, and this is the list of them —
    // named, not counted, because "at least twenty" was true of a fixture that
    // had stopped tripping fifty. A rule that falls out of the fixture fails
    // here by name; a rule that joins it is welcome and does not (the coverage
    // sweep at the end of this file is what makes joining compulsory).
    expect(
      [...byRule.keys()].sort(),
      "these rules used to write findings on the fixture crawl and no longer do — " +
        "the column guard is now silent about them",
    ).toEqual(expect.arrayContaining([...FIXTURE_COLUMN_RULES]));
    expect(byRule.size).toBeGreaterThanOrEqual(FIXTURE_COLUMN_RULES.length);

    const undeclared: string[] = [];
    const unwritten: string[] = [];
    for (const [ruleId, blobs] of byRule) {
      const rule = registry.all().find((r) => r.id === ruleId);
      if (rule === undefined) throw new Error(`no registry rule '${ruleId}'`);
      const declared = new Map((rule.columns ?? []).map((c) => [c.key, c]));

      const written = new Set<string>();
      for (const blob of blobs) for (const key of Object.keys(blob)) written.add(key);

      for (const key of written) {
        if (declared.has(key) || FRAMEWORK_KEYS.has(key)) continue;
        // Measured, not listed: does this key just restate the finding's URL?
        const restatesAddress = blobs.every(
          (blob) => !(key in blob) || blob[key] === blob["pageUrl"],
        );
        if (restatesAddress) continue;
        undeclared.push(`${ruleId}.${key}`);
      }
      for (const [key, column] of declared) {
        if (column.optional === true) continue;
        if (!blobs.some((blob) => key in blob)) unwritten.push(`${ruleId}.${key}`);
      }
    }

    expect(
      undeclared.sort(),
      "these evidence keys are columns nobody sees — declare them in the rule's " +
        "`columns`, or stop writing them",
    ).toEqual([]);
    expect(
      unwritten.sort(),
      "these declared columns are headings with nothing under them — the rule " +
        "never writes the key. Fix the key, or mark the column `optional: true` " +
        "if the rule writes it only sometimes",
    ).toEqual([]);
  });

  /**
   * THE EXEMPTION ABOVE, CHECKED RATHER THAN ASSERTED: a rule's own
   * `statusCode` is the status of the page its finding names.
   *
   * The standard `Status Code` column is read off the `pages` row through the
   * left join, and nine rules ALSO record a `statusCode` in their evidence. The
   * column-check above lets them, on the ground that the two are the same
   * number by construction. If they ever were not, the report would print one
   * of them and silently drop the other — so the ground is a query, not a
   * comment.
   */
  it("never lets a rule's own statusCode disagree with the page row the finding names", async () => {
    const disagreed = await db.execute<{ rule_id: string; page: number | null; said: string }>(sql`
      select i.rule_id, p.status_code as page, i.details_jsonb->>'statusCode' as said
        from issues i
        join pages p on p.id = i.page_id
       where i.crawl_id = ${summary.crawlId}
         and i.details_jsonb ? 'statusCode'
         and i.details_jsonb->>'statusCode' is distinct from p.status_code::text`);
    expect(disagreed.rows).toEqual([]);

    // THE OTHER HALF OF THE SAME EXEMPTION: a finding with no page row. The
    // join above cannot see one, and the standard `Status Code` column is null
    // beside it by construction (§4.4: null means NOBODY FETCHED IT). An
    // evidence `statusCode` there would be a number with nothing to check it
    // against, printed under a heading the surface says is null — so the rule
    // is that a page-less finding carries no status of its own. A null or
    // absent key is fine; it says the same nothing the column does.
    const unanchored = await db.execute<{ rule_id: string; said: string }>(sql`
      select i.rule_id, i.details_jsonb->>'statusCode' as said
        from issues i
       where i.crawl_id = ${summary.crawlId}
         and i.page_id is null
         and i.details_jsonb->>'statusCode' is not null`);
    expect(
      unanchored.rows,
      "these findings name no page row, so nothing can check the status they " +
        "record — drop the key, or file the finding against the page",
    ).toEqual([]);
  });

  it("the sitemap's deliberate mistakes land on the URLs that carry them", () => {
    // One entry per fault, each on the page the entry names — the join is
    // `sitemap_urls.url = pages.url` and these three assertions are what proves
    // the two spellings agree end to end, through the crawler that wrote both.
    expect(detailsByPath.get("/status/not-found\nsitemap.non-200")).toEqual({
      pageUrl: `${app.base}/status/not-found`,
      url: `${app.base}/status/not-found`,
      statusCode: 404,
      fetchClass: "client_error",
    });
    expect(detailsByPath.get("/redirect/chain-1\nsitemap.redirected")).toEqual({
      pageUrl: `${app.base}/redirect/chain-1`,
      url: `${app.base}/redirect/chain-1`,
      statusCode: 301,
      redirectUrl: `${app.base}/redirect/chain-2`,
    });
    expect(detailsByPath.get("/index/noindex-meta\nsitemap.non-indexable")).toEqual({
      pageUrl: `${app.base}/index/noindex-meta`,
      url: `${app.base}/index/noindex-meta`,
      // WHICH KIND, since Phase 22 §1 gave this rule the canonicalised case as
      // well. `/index/canonicalized` is the fixture that carries the other
      // value, and both are listed in this site's sitemap.
      reason: "noindex",
      robotsMeta: "noindex, follow",
      xRobotsTag: null,
    });

    // And the other direction: the indexable pages the sitemap does not list.
    // Two KINDS of omission — `/authored3/unlisted` is the page the file
    // forgot, and the deep click-path's seven rungs are left out because a
    // sitemap entry is enqueued at depth 0 and would flatten the chain (see
    // `Fixture.inSitemap`). Asserted as the exact set, so a fixture that fell
    // off the sitemap by accident fails here rather than passing quietly.
    const unlisted = [...issuesByPath]
      .filter(([, ids]) => ids.has("pages.not-in-sitemap"))
      .map(([path]) => path)
      .sort();
    expect(unlisted).toEqual([
      "/authored3/unlisted",
      "/deep/1",
      "/deep/2",
      "/deep/3",
      "/deep/4",
      "/deep/5",
      "/deep/6",
      "/deep/7",
    ]);
  });

  it("a <loc> spelled with a fragment and unsorted parameters joins its own page", async () => {
    // The end-to-end half of the normalization seam. `/authored3/loc-variant`
    // is published by `/sitemap.xml` as `?sort=asc&ref=sitemap#top` and fetched
    // by the crawl as `?ref=sitemap&sort=asc`: one URL, two spellings, written
    // by two different parts of this system. Read from the tables rather than
    // asserted from the fixture constants, so what is proved is what the
    // crawler stored.
    const path = "/authored3/loc-variant?ref=sitemap&sort=asc";
    const published = `${app.base}/authored3/loc-variant?sort=asc&ref=sitemap#top`;
    const page = pageByPath.get(path);
    if (page === undefined) throw new Error("the loc-variant fixture was never crawled");

    // The published spelling is stored verbatim — the `<loc>` is evidence, and
    // normalising the column would destroy the line a client goes and edits —
    // and the join column beside it is the frontier key of the page above.
    const [entry] = await db
      .select()
      .from(sitemapUrls)
      .where(and(eq(sitemapUrls.crawlId, summary.crawlId), eq(sitemapUrls.url, published)));
    if (entry === undefined) throw new Error(`no sitemap_urls row for ${published}`);
    expect(entry.urlNormalised).toBe(page.url);

    // And so neither of the two findings that spelling used to invent exists.
    // They are looked for in two places because they land in two: an entry that
    // matches no page row is site-scoped and reaches `siteFindings`, while
    // `pages.not-in-sitemap` names the page and lands on its path.
    expect([...(issuesByPath.get(path) ?? new Set<string>())]).not.toContain(
      "pages.not-in-sitemap",
    );
    const uncrawled = (siteFindings.get("sitemap.uncrawled") ?? []).map(
      (d) => (d as { url: string }).url,
    );
    expect(uncrawled).not.toContain(published);
  });

  it("the paginated series proves all three pagination rules", () => {
    const url = (path: string): string => `${app.base}${path}`;

    // Page 2: the canonical folds it into page 1, and its rel=next names a page
    // nothing links to. Page 1 is the control for both and fires nothing, which
    // the exact-set assertion above already holds.
    expect(detailsByPath.get("/authored3/paged-2\npagination.canonical-to-other")).toEqual({
      pageUrl: url("/authored3/paged-2"),
      canonical: url("/authored3/paged-1"),
      resolvedTo: url("/authored3/paged-1"),
      relPrev: url("/authored3/paged-1"),
    });
    expect(detailsByPath.get("/authored3/paged-2\npagination.next-not-linked")).toEqual({
      pageUrl: url("/authored3/paged-2"),
      relNext: url("/authored3/paged-3"),
      resolvedTo: url("/authored3/paged-3"),
    });

    // Page 3: its own rel=next names a page no link and no sitemap entry
    // mentions, so the crawl never fetched it and the engine can say nothing
    // about it beyond that.
    expect(detailsByPath.get("/authored3/paged-3\npagination.next-target-uncrawled")).toEqual({
      pageUrl: url("/authored3/paged-3"),
      relNext: url("/authored3/paged-4"),
      resolvedTo: url("/authored3/paged-4"),
    });
    expect(pageByPath.has("/authored3/paged-4")).toBe(false);
  });

  it("the orphans are exactly the two pages nothing links to", () => {
    // Both reached the crawl through the sitemap and nothing else, which is what
    // `discoveredVia` and `inSitemap` say. `/authored3/paged-3` is the
    // load-bearing one: it renders its own URL as a link, the way a pagination
    // control does, and an anti-join that counted a page's link to ITSELF as an
    // inbound link would report it as reachable.
    const orphans = [...issuesByPath]
      .filter(([, ids]) => ids.has("links.orphan"))
      .map(([path]) => path)
      .sort();
    expect(orphans).toEqual(["/authored3/paged-3", "/structure/orphan"]);

    for (const path of orphans) {
      expect(detailsByPath.get(`${path}\nlinks.orphan`), path).toEqual({
        pageUrl: `${app.base}${path}`,
        inSitemap: true,
        discoveredVia: "sitemap",
        // The caveat, qualifying the finding: one URL (`/status/blocked`, the
        // 403 fixture) was never read, so its outbound links are unknown and
        // "nothing links to this page" is a verdict with one page missing from
        // the evidence. That is the caveat doing its job, not a defect.
        caveat: { failedPages: 1 },
      });
    }
  });

  it("the hreflang fixtures' declarations reach the rules that judge them", async () => {
    // Which fixture declared what, asserted exactly — both as the map of
    // declarations that went in, and as the findings that came out.
    //
    // This is what makes each hreflang fixture load-bearing rather than
    // decorative. Asserting the rule id alone would be satisfied by whichever
    // page happened to declare a cluster, and the others could be deleted
    // without a test noticing. Pinning the codes, and the targets each finding
    // carries, means removing a page or changing what it declares fails here.
    expect(Object.fromEntries(hreflangByPath)).toEqual({
      "/authored/hreflang-bad-code": ["english-uk"],
      "/authored/hreflang-no-xdefault": ["de", "en"],
      "/authored3/hreflang-a": ["en", "fr", "x-default"],
      "/authored3/hreflang-b": ["en", "fr", "x-default"],
      "/authored3/hreflang-noindex": ["de", "en", "x-default"],
      "/authored3/hreflang-one-way": ["de", "en", "x-default"],
    });

    // The x-default finding belongs to the two-alternate cluster, not to the
    // single bad-code declaration: a page naming one URL is not a cluster and
    // has nothing to fall back from. It lands on the lexically first member of
    // the set, which here is the fixture's own URL — the German alternate is on
    // another host the crawl never fetched, and is named in the evidence all
    // the same.
    const declared = pageByPath.get("/authored/hreflang-no-xdefault");
    if (declared === undefined) throw new Error("the no-xdefault fixture was never crawled");
    expect(
      detailsByPath.get("/authored/hreflang-no-xdefault\nhreflang.missing-x-default"),
    ).toEqual({
      pageUrl: declared.url,
      targets: [declared.url, "https://de.example/willkommen"],
      setSize: 2,
    });

    // And the bad-code page, whose one declaration is not a set, carries no
    // x-default finding at all.
    expect([
      ...(issuesByPath.get("/authored/hreflang-bad-code") ?? new Set<string>()),
    ]).not.toContain("hreflang.missing-x-default");

    // P19-T3. The self-reference rule fires on exactly one page of this site:
    // the bad-code fixture, whose single alternate names a page on another host
    // and therefore publishes a set this page is not a member of. Every other
    // hreflang fixture names itself, which is why they are silent here and why
    // this list is one entry rather than six.
    expect(await findingSet("hreflang.missing-self-reference")).toEqual([
      {
        pageUrl: `${app.base}/authored/hreflang-bad-code`,
        codes: ["english-uk"],
        targets: ["https://en-gb.example/opening-hours"],
      },
    ]);

    // And the marker for the other side of the same gap: the two alternates on
    // hosts this crawl never fetched, grouped by host. `alternates` counts the
    // distinct URLs, `pages` the pages of this crawl that name them — one each
    // here, from two different fixtures — and `total` sums the hosts. No
    // `hostsTruncated`, because two hosts is nowhere near the fifty the list
    // stops at.
    expect(await findingSet("hreflang.alternates-not-crawled")).toEqual([
      {
        pageUrl: null,
        total: 2,
        hosts: [
          { host: "de.example", alternates: 1, pages: 1 },
          { host: "en-gb.example", alternates: 1, pages: 1 },
        ],
      },
    ]);

    // The two join rules write one finding per CLUSTER MEMBER, so a page can
    // carry several and `detailsByPath` would keep only the last of them (see
    // its declaration). Both are read as whole sets out of `issues` instead.
    expect(await findingSet("hreflang.missing-return-link")).toEqual([
      {
        pageUrl: `${app.base}/authored3/hreflang-noindex`,
        target: `${app.base}/index/noindex-meta`,
        targetHasHreflang: false,
      },
      {
        pageUrl: `${app.base}/authored3/hreflang-one-way`,
        target: `${app.base}/authored3/hreflang-mute`,
        targetHasHreflang: false,
      },
    ]);
    // The reciprocated pair is absent from that list, which is the whole point
    // of having it: `/authored3/hreflang-a` and `-b` name each other and fire
    // nothing.
    expect(await findingSet("hreflang.non-indexable-target")).toEqual([
      {
        pageUrl: `${app.base}/authored3/hreflang-noindex`,
        target: `${app.base}/index/noindex-meta`,
        targetFetchClass: "ok",
        targetIndexable: false,
      },
    ]);
  });

  it("the soft 404 fires on wording alone, because the site has no 404 template", async () => {
    // The rule has two signal paths and this site can only offer one. The
    // crawl's own probe asks for a URL that cannot exist and the fixture app
    // answers a real 404, so there is no 200 body to fingerprint and the
    // template path is unavailable — asserted from the stored probe rather than
    // inferred from the finding, because "no template" and "a template that
    // happened not to match" are different crawls with the same silence.
    const [crawlRow] = await db
      .select({ probe: crawls.notfoundProbe })
      .from(crawls)
      .where(eq(crawls.id, summary.crawlId));
    expect(crawlRow?.probe).toMatchObject({ statusCode: 404, simhash: null });

    // So the only signal left is the wording, and the page's length is what
    // makes that wording mean something: over `THIN_WORDS` (or it would be a
    // thin page as well) and under `SOFT_404_WORDS` (or an article about broken
    // links would qualify). The bounds are read from the rules rather than
    // restated, so a threshold that moves fails here instead of drifting.
    const details = detailsByPath.get("/authored3/soft-404\ncontent.soft-404") as {
      signals: string[];
      wordCount: number;
      renderableWordCount: number;
    };
    expect(details.signals).toEqual(["phrases"]);
    // The bounds are applied to the RENDERABLE count, which is the column the
    // ceiling reads since Phase 7. This fixture hides nothing, so the two are
    // the same number and the bounds hold on both — asserted on both, so a
    // fixture that later grew a hidden block would fail here rather than
    // quietly changing which number the assertion was about.
    expect(details.renderableWordCount).toBeGreaterThanOrEqual(THIN_WORDS);
    expect(details.renderableWordCount).toBeLessThan(SOFT_404_WORDS);
    expect(details.renderableWordCount).toBe(details.wordCount);
    // `hammingToTemplate` appears only when a distance was computed; there was
    // no template, so the blob carries the three fields above and nothing else.
    expect(details).toEqual({
      pageUrl: `${app.base}/authored3/soft-404`,
      signals: ["phrases"],
      wordCount: details.wordCount,
      renderableWordCount: details.renderableWordCount,
    });
  });

  it("the URL-hygiene fixtures name the right URLs", () => {
    // Two spellings of one path, both answering 200. The finding lands on the
    // group's first URL under the DATABASE's collation — the lowercase one on
    // the documented postgres:16 container; see the fixture's own paragraph —
    // and the other member is in the evidence beside it, in the same order.
    expect(detailsByPath.get("/authored3/case\nurl.normalisation-variants")).toEqual({
      pageUrl: `${app.base}/authored3/case`,
      urlNormalised: `${app.base}/authored3/case`.toLowerCase(),
      variants: [`${app.base}/authored3/case`, `${app.base}/authored3/Case`],
      count: 2,
    });

    // One page, two findings, about two different things: the LINK that carries
    // a campaign tag, and the PAGE that declares the tagged address canonical.
    const tracked = `${app.base}/authored3/tracked?utm_source=newsletter`;
    expect(
      detailsByPath.get(
        "/authored3/tracked?utm_source=newsletter\nurl.tracking-params-internal",
      ),
    ).toEqual({
      pageUrl: tracked,
      targetUrl: tracked,
      params: ["utm_source"],
      // The hub's link, and only that one. The sitemap lists the same URL and is
      // not a link, which is what this count would notice if the rule ever
      // started reading `sitemap_urls`.
      inlinkCount: 1,
    });
    expect(
      detailsByPath.get(
        "/authored3/tracked?utm_source=newsletter\nurl.parameter-pages-indexable",
      ),
    ).toEqual({ pageUrl: tracked, url: tracked, params: ["utm_source"] });
  });

  it("the structured-data fixtures name the field that is missing and the rating that is self-serving", () => {
    // The field names are what a client goes and adds, so they are pinned rather
    // than counted: the Product block carries a name and a priced offer and no
    // image, and eight of the twelve recommended fields are absent too. The two
    // that are NOT absent are the pair read out of the offer — the fixture's
    // offer carries both a currency and an availability — which is this
    // collection's proof that the widened CHECK-44 profile reads them from
    // inside `offers` rather than looking for top-level keys.
    expect(
      detailsByPath.get("/authored3/product-incomplete\nschema.product-incomplete"),
    ).toEqual({
      pageUrl: `${app.base}/authored3/product-incomplete`,
      missingRequired: ["image"],
      missingRecommended: [
        "brand",
        "gtin",
        "mpn",
        "aggregateRating",
        "review",
        "color",
        "material",
        "size",
      ],
    });

    expect(detailsByPath.get("/authored3/reviews\nschema.self-serving-reviews")).toEqual({
      pageUrl: `${app.base}/authored3/reviews`,
      schemaType: "Organization",
      fields: ["aggregateRating"],
    });
  });

  it("the duplicate rules see the site's real duplicates, end to end", async () => {
    // The simhash round trip, through the real crawler for once: an unsigned
    // 64-bit value from the analyzer, stored as a signed bigint by the writer,
    // compared by four band equalities and a `bit_count` XOR inside Postgres.
    // The unit tests hand-build those rows; only this one proves the value that
    // reaches the column is the value the SQL reads.
    expect(detailsByPath.get("/content/duplicate-a\ncontent.exact-duplicate")).toEqual({
      pageUrl: `${app.base}/content/duplicate-a`,
      // The two absorbed copies are byte-identical by construction.
      contentHash: expect.any(String),
      urls: [`${app.base}/content/duplicate-a`, `${app.base}/content/duplicate-b`],
      count: 2,
      // ONE type, not two, since P8-T5. Both pages used to be their own page
      // type — `duplicate-a` is two hyphen-parts, so the slug rule left it
      // literal — and the crawl-end template inference now reads the eight
      // pages under `/content/` as one family and types them all
      // `/content/:slug`. The distinct-array is what the rule reports, so a
      // duplicate pair that spans one template says so in one entry.
      pageTypes: ["/content/:slug"],
    });

    // The click-chain's rungs are one template with a number substituted, so
    // several of them land inside the three-bit band.
    //
    // **THE SAME RELATIONSHIPS AFTER P19-T2 MOVED THE FINGERPRINT** from the
    // whole visible text to the main content, and the reason is a property of
    // this fixture site rather than a coincidence: `renderDocument` wraps every
    // page's whole body in `<main>` and the site has no shared navigation,
    // header or footer at all, so the main-content text IS the visible text and
    // the two fingerprints are the same number. The distances below are
    // therefore unchanged, and they would not have been on a real templated
    // site — which is exactly the divergence the change was made for. The other
    // filters do not bite either: each rung clears
    // `NEAR_DUPLICATE_MIN_MAIN_WORDS` comfortably while still sitting under
    // `content.thin`'s floor — the two thresholds are 50 and 150, and a page
    // between them is both thin AND comparable, which is what these rungs are —
    // and every fixture page declares a self-referential canonical, so none is
    // canonicalised elsewhere.
    //
    // **WHAT THE §11 AMENDMENT CHANGED HERE IS THE SHAPE, NOT THE SIMILARITY.**
    // The rule reported PAIRS and now reports PAGES, so the three pairs
    // `/deep/2 ~1~ /deep/6`, `/deep/2 ~3~ /deep/4` and `/deep/2 ~3~ /deep/5` are
    // four findings: `/deep/2`, which has three near-duplicates, and one each on
    // `/deep/4`, `/deep/5` and `/deep/6`, which have only `/deep/2`. Each row
    // names its own partners with their distances, so the relationships below
    // are the same three facts read from four directions — and the assertion is
    // still about the fingerprints rather than about two pages happening to be
    // similar.
    //
    // Read from the `issues` rows rather than from `detailsByPath`, which is
    // keyed by path and rule and would keep only one row per page anyway.
    const near = (
      await db
        .select()
        .from(issues)
        .where(
          and(eq(issues.crawlId, summary.crawlId), eq(issues.ruleId, "content.near-duplicate")),
        )
    )
      .map((row) => {
        const d = row.details as {
          pageUrl: string;
          nearDuplicates: number;
          closest: { url: string; hamming: number; mainWords: number }[];
        };
        const partners = d.closest
          .map((c) => `${c.url.replace(app.base, "")}~${String(c.hamming)}`)
          .join(" ");
        return `${d.pageUrl.replace(app.base, "")} (${String(d.nearDuplicates)}): ${partners}`;
      })
      .sort();
    expect(near).toEqual([
      // Nearest first, ties broken by URL: /deep/6 is one bit away, the other
      // two are three.
      "/deep/2 (3): /deep/6~1 /deep/4~3 /deep/5~3",
      "/deep/4 (1): /deep/2~3",
      "/deep/5 (1): /deep/2~3",
      "/deep/6 (1): /deep/2~1",
    ]);
    // Every page's own main-content length travels with it, and it is the same
    // number on both sides of a relationship — the rungs are one template.
    const words = (
      await db
        .select()
        .from(issues)
        .where(
          and(eq(issues.crawlId, summary.crawlId), eq(issues.ruleId, "content.near-duplicate")),
        )
    ).map((row) => (row.details as { mainWords: number }).mainWords);
    for (const w of words) {
      expect(w).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_MAIN_WORDS);
      expect(w).toBeLessThan(THIN_WORDS);
    }

    // And nowhere else. A GROUP is reported once, on its first member; a page
    // with a near-duplicate is reported on itself and once — so a fifth
    // near-duplicate row, or a second exact-duplicate one, would mean a rule had
    // changed shape.
    const duplicated = [...issuesByPath]
      .filter(([, ids]) => ids.has("content.exact-duplicate") || ids.has("content.near-duplicate"))
      .map(([path]) => path)
      .sort();
    expect(duplicated).toEqual([
      "/content/duplicate-a",
      "/deep/2",
      "/deep/4",
      "/deep/5",
      "/deep/6",
    ]);
  });

  it("the field-level duplicates find the site's repeated titles, descriptions and headings", async () => {
    // P7-T2, end to end: three rules, each grouping ONE column of `pages` over
    // the indexable 200s, on a site that carries a deliberately different pair
    // for each of them. Every group below is hand-derived from the fixture
    // collection — the values come from the fixture modules themselves rather
    // than being restated here, so a page that changed its title fails as a
    // mismatch instead of quietly leaving the assertion describing nothing.
    //
    // THE SITE'S GROUPS, in full:
    //
    //   title          `/content/duplicate-a` + `-b`        (identical pages)
    //                  `/content/duplicate-title-a` + `-b`  (one catalogue title)
    //   description    `/content/duplicate-a` + `-b`
    //                  `/content/duplicate-meta-a` + `-b`   (one shared sentence)
    //   h1 text        `/content/duplicate-a` + `-b`
    //                  `/authored7/shared-h1-a` + `-b`      (heading and nothing else)
    //
    // Nothing else on this site repeats any of the three, which is what makes
    // these exact sets rather than containment checks: a rule grouping on
    // whitespace, on nulls, or on the wrong column would show up here as an
    // extra group rather than as a silence nobody notices.
    //
    // ONE PAIR SHARES A TITLE AND IS DELIBERATELY ABSENT (Phase 22 §2):
    // `/authored3/hreflang-a` and `/authored3/hreflang-b` both serve "Opening
    // hours" and declare each other reciprocally as `en` and `fr`, which makes
    // them one member of any duplicate group and therefore no group. The
    // assertion below is what states that — an exact set with no third title
    // group in it — and both fixtures carry `exact: true` with no expected
    // issues, so the same fact is asserted from the page's side as well.
    const at = (path: string): string => `${app.base}${path}`;
    const group = (value: Record<string, unknown>, paths: string[]): Record<string, unknown> => ({
      pageUrl: at(paths[0]!),
      ...value,
      count: paths.length,
      pages: paths.map(at),
      // ZERO ON EVERY GROUP HERE, and the one group that WOULD have carried a
      // number is the one that no longer exists: `/authored3/hreflang-a` and
      // `-b` now publish the same `<title>` and declare each other as `en`/`fr`
      // alternates, so they are one cluster, one member, and no group at all
      // (Phase 22 §2). Every group below is a pair with no hreflang between
      // them, so nothing was folded into anything.
      alternatesCollapsed: 0,
    });

    expect(await findingSet("title.duplicate")).toEqual([
      group({ title: DUP_TITLE }, ["/content/duplicate-a", "/content/duplicate-b"]),
      group({ title: SHARED_TITLE }, [
        "/content/duplicate-title-a",
        "/content/duplicate-title-b",
      ]),
    ]);

    // `findingSet` sorts by the SERIALISED evidence with its keys in
    // alphabetical order, so the first field that differs decides the order —
    // `pageUrl` for the titles above, and the description itself here, which is
    // why the bakery's sentence sorts before the latte recipe's.
    expect(await findingSet("meta-description.duplicate")).toEqual([
      group({ metaDescription: SHARED_META }, [
        "/content/duplicate-meta-a",
        "/content/duplicate-meta-b",
      ]),
      group({ metaDescription: DUP_META }, ["/content/duplicate-a", "/content/duplicate-b"]),
    ]);

    // The heading rule's second group is the one that proves the column: those
    // two pages have different titles, different descriptions and different
    // prose, so a rule that had grouped on any other column would report one
    // group here instead of two.
    expect(await findingSet("h1.duplicate-text")).toEqual([
      group({ h1Text: P7_SHARED_H1 }, [...P7_SHARED_H1_PATHS]),
      group({ h1Text: DUP_H1 }, ["/content/duplicate-a", "/content/duplicate-b"]),
    ]);

    // The h1 text reached the column from the real crawler, on both pages of
    // the authored pair. Read from the `pages` rows rather than inferred from
    // the finding: "the rule grouped them" and "the analyzer captured the same
    // string twice" are different claims, and the second is what the first
    // rests on.
    for (const path of P7_SHARED_H1_PATHS) {
      expect(pageByPath.get(path)?.h1Text, path).toBe(P7_SHARED_H1);
    }
    // And the two pages differ in every other column the duplicate rules read,
    // which is the arrangement the pair exists to provide.
    const [a, b] = P7_SHARED_H1_PATHS.map((path) => pageByPath.get(path));
    expect(a?.title).not.toBe(b?.title);
    expect(a?.metaDescription).not.toBe(b?.metaDescription);
    expect(a?.contentHash).not.toBe(b?.contentHash);

    // Every finding lands on its group's first member and nowhere else: three
    // rules over six groups, and only three pages carry any of them.
    const carriers = [...issuesByPath]
      .filter(([, ids]) =>
        ["title.duplicate", "meta-description.duplicate", "h1.duplicate-text"].some((id) =>
          ids.has(id),
        ),
      )
      .map(([path]) => path)
      .sort();
    expect(carriers).toEqual([
      P7_SHARED_H1_PATHS[0],
      "/content/duplicate-a",
      "/content/duplicate-meta-a",
      "/content/duplicate-title-a",
    ].sort());
  });

  it("the redirect volume counts the URLs and the links into them", () => {
    // `redirect.volume`'s site row, hand-derived like the three metrics above.
    //
    // redirectPages = 4. Every `/redirect/*` fixture that answers a 3xx:
    // `/redirect/chain-1`, `/redirect/chain-2`, `/redirect/loop` and
    // `/redirect/trailing-slash`. The slash form `/redirect/trailing-slash/` is
    // the 200 at the end of that hop and is not one of them.
    //
    // totalPages = 84, the whole crawl — the same count `render.coverage` above
    // starts from, and deliberately not the 73-page cohort: a redirect is a
    // share of what was fetched.
    //
    // ratioPct = 100 × 4 / 84 = 4.761… -> 4.8 at one decimal place.
    //
    // redirectInlinks = 4, and the number being equal to `redirectPages` here is
    // a property of this site rather than of the metric: the hub links each of
    // the four exactly once, and nothing else on the site links a redirect at
    // all (`/links/broken-internal-link` links a 404, the deep chain links the
    // rung below, the paginated series links itself, `/render/healthy` links
    // itself). On a real site the second number is the larger one — see the
    // unit test in test/rules/crawl-metrics.test.ts, where one redirecting URL
    // in a footer is 1 page and 5 inlinks.
    //
    // chains = 1 and loops = 1: `/redirect/chain-1` heads the one chain and
    // `/redirect/loop` is the one cycle, which is what those two fixtures are
    // for and what the `expectedIssues` on them already assert from the other
    // side.
    expect(siteMetric("redirect.volume")).toEqual({
      redirectPages: 4,
      redirectInlinks: 4,
      totalPages: 84,
      ratioPct: 4.8,
      chains: 1,
      loops: 1,
    });
  });

  it("every metric rule wrote its table for this crawl", () => {
    // The metric layer's coverage assertion, and the reason the rule sweep
    // below can stop skipping the kind. A metric writes no `issues` row, so
    // "did it fire" is a question only the `metrics` table can answer — and
    // every one of the twelve CAN answer it here: ten always emit a site row,
    // `inlinks.sources-by-type` emits one per target cohort type and this site
    // has 16 of them, and `content.template-similarity` emits one per type with
    // two fingerprinted pages, which the `/deep/:id`, `/head/:slug`,
    // `/content/:slug`, `/authored/:slug`, `/authored3/:slug`, `/authored7/:slug`,
    // `/index/:slug` and `/render/:slug` templates give it. There is no
    // exemption paragraph to write.
    //
    // BOTH COUNTS MOVED IN P8-T5, and the second test below pins the first of
    // them. The crawl-end template inference (`inferPageTemplates`) reads this
    // site's 61 parse-time page types as 17 templates: `detectUrlTemplate`'s
    // slug rule leaves a two-part segment literal ("my-account" is more often a
    // route than a slug), so `/head/empty-h1`, `/content/duplicate-a` and
    // `/authored7/hidden-chrome` each used to be a page type of one page. They
    // are now members of the family they were always part of. What does NOT
    // collapse is as deliberate: `/`, `/control` and `/kitchen-sink` sit at the
    // root, where there is no family name to collapse under; `/perf/slow-response`
    // is the only page under `/perf/`; and `/structure/` has exactly two pages
    // (`no-outgoing-links` and `orphan`), which is under MIN_COHORT — two pages
    // are two pages, so they keep the names `/structure/:slug` and
    // `/structure/orphan`.
    //
    // `render.coverage` is among the nine, and since P5-T6 its row is no longer
    // all selection and no evidence: this harness runs the render pass over the
    // crawl, so `pagesRendered` and `renderFailures` describe a selection that
    // was computed AND spent. The whole row is pinned two tests below.
    //
    // P7-T4 makes it twelve — ten that always emit a site row, since
    // `structure.click-depth-distribution` reads a column the derivation phase
    // fills on every run and answers over the same cohort as the rest.
    //
    // P10-T2 makes it thirteen. `site.health` always emits its site row: it
    // counts the crawl's own findings over the auditable pages, and a crawl
    // with neither still has a census to state.
    //
    // P11-T3 makes it fourteen. `page.weight` always emits its site row too —
    // it aggregates over the shared cohort, so an empty cohort is a row of
    // zeroes and null statistics rather than a missing table, and a crawl that
    // recorded no resources at all still has each page's HTML to weigh.
    expect([...metricsById.keys()].sort()).toEqual([
      "content.metrics-by-type",
      "content.template-similarity",
      "hreflang.coverage",
      "inlinks.distribution",
      "inlinks.extremes",
      "inlinks.sources-by-type",
      "page.weight",
      "redirect.volume",
      "render.coverage",
      "site.health",
      "sitemap.structure",
      "structure.click-depth-distribution",
      "structure.depth-distribution",
      "url.param-volumes",
    ]);
    // And that set is the registry's, not a list that happens to agree with it:
    // a metric added without a fixture that provokes it fails here.
    expect([...metricsById.keys()].sort()).toEqual(
      registry
        .byKind("metric")
        .map((rule) => rule.id)
        .sort(),
    );
  });

  /**
   * EVERY METRIC'S TABLE RENDERS, AND EVERY KEY IS ON IT — the metric twin of
   * the column guard above, and the same argument in both directions.
   *
   * `MetricRule.table` is a claim about what a metric writes, and `defineRule`
   * cannot check it: a declaration is metadata, and the values only exist once a
   * rule has run over a real crawl. So both directions are checked here, because
   * both are a real failure:
   *
   *  - a declared column whose key is NULL ON EVERY ROW is a heading with
   *    nothing under it — usually a misspelled key, which no type catches
   *    because a metric's value is jsonb;
   *  - a value key NO COLUMN OR SUMMARY READS is a number the metric measured
   *    and nobody sees. The table is the report now: what is not on it does not
   *    exist for a client.
   *
   * The nesting is checked at the level the shaper reads: the top-level keys of
   * a stored value against the declaration's own top level, and — for the two
   * shapers that reach inside — the keys of a measure's object or of a list
   * element against the columns that read them. `expandMap`'s entries are the
   * site's own template names and are data rather than keys, so only the field
   * holding the map is checked.
   */
  it("renders every metric's table, with no empty column and no unmapped key", () => {
    const emptyColumns: string[] = [];
    const unmapped: string[] = [];

    for (const rule of registry.byKind("metric")) {
      const byScope = metricsById.get(rule.id);
      if (byScope === undefined) throw new Error(`no metrics rows for '${rule.id}'`);
      const stored: StoredMetricRow[] = [...byScope].map(([key, value]) => {
        const [scope, ...rest] = key.split("|");
        return { scope: scope ?? "", scopeValue: rest.join("|"), value };
      });

      // (0) It renders at all. A shaper that throws over a real crawl's rows is
      // a declaration that has never met the values it describes.
      const table = shapeMetricTable(rule.id, rule.table, stored);
      expect(table.rows.length, `${rule.id} shaped no rows from ${stored.length}`)
        .toBeGreaterThan(0);

      // (1) Every declared column is filled at least once, summary included.
      for (const column of [...table.columns, ...table.summary]) {
        if (column.key === "scope" || column.key === "measure") continue;
        const filled =
          table.rows.some((row) => row[column.key] !== null && row[column.key] !== undefined) ||
          table.summary.some((entry) => entry.key === column.key && entry.value !== null);
        if (!filled) emptyColumns.push(`${rule.id}.${column.key}`);
      }

      // (2) Every key the stored values carry is read by some column.
      const declaration = rule.table;
      const paths = (column: { key: string; from?: readonly string[] }): string[] =>
        [...(column.from ?? [column.key])].map((path) => path.split(".")[0] ?? path);
      const top = new Set<string>();
      const nested = new Set<string>();
      if (declaration.shape === "perScope") {
        for (const column of declaration.columns) for (const key of paths(column)) top.add(key);
      } else if (declaration.shape === "perScopeMeasure") {
        for (const measure of declaration.measures) top.add(measure.key);
        for (const column of declaration.scopeColumns) for (const key of paths(column)) top.add(key);
        for (const column of declaration.columns) for (const key of paths(column)) nested.add(key);
      } else if (declaration.shape === "expandList") {
        for (const source of declaration.lists) top.add(source.field);
        for (const column of declaration.summary) for (const key of paths(column)) top.add(key);
        for (const column of declaration.columns) for (const key of paths(column)) nested.add(key);
      } else {
        top.add(declaration.field);
      }

      const inner = (value: unknown, where: string): void => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return;
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!nested.has(key)) unmapped.push(`${rule.id}.${where}.${key}`);
        }
      };
      for (const row of stored) {
        const value = row.value as Record<string, unknown>;
        for (const [key, held] of Object.entries(value)) {
          if (!top.has(key)) {
            unmapped.push(`${rule.id}.${key}`);
            continue;
          }
          if (declaration.shape === "perScopeMeasure" && declaration.measures.some((m) => m.key === key)) {
            inner(held, key);
          }
          if (declaration.shape === "expandList" && Array.isArray(held)) {
            for (const element of held) inner(element, key);
          }
        }
      }
    }

    expect(
      emptyColumns.sort(),
      "these metric columns are null on every row of a real crawl — a heading with " +
        "nothing under it, which is almost always a key the metric does not write",
    ).toEqual([]);
    expect(
      unmapped.sort(),
      "these metric value keys are on no column and in no summary — numbers the " +
        "metric measured and no reader can see. Declare a column for each, or stop " +
        "writing it",
    ).toEqual([]);
  });

  it("the metric cohorts are this site's templates, not its URLs (P8-T5)", () => {
    // The claim the paragraph above makes, made mechanical. `inlinks.sources-by-type`
    // writes one row per target cohort type, so its key set IS the set of
    // templates the metric layer groups this site by — and before the
    // crawl-end template inference it was fifty of them, most holding one page.
    //
    // Hand-derived from the fixture collection: the seventeen below are the
    // nineteen types the crawl ends with, minus two that keep no page in the
    // cohort every metric shares:
    //   `/status/:slug`  all three `/status/*` fixtures answer 403, 404 or 500;
    //   `/index/:slug`   all four are outside the JUDGED cohort since Phase 22
    //                    §1 — `/index/noindex-meta` and `/index/noindex-header`
    //                    carry a noindex, and `/index/canonicalized` and
    //                    `/index/canonical-conflict` both declare a canonical
    //                    naming another URL. A whole template can leave the
    //                    metric tables that way, and that is the cohort doing
    //                    its job: nothing in `/index/` is a page this site is
    //                    asking anyone to rank.
    // Each `:slug` entry is a family the inference collapsed; each literal entry
    // is a page with no family, and there is no `(untyped)` row because this
    // site's every URL has a path the detector can read.
    //
    // P11-T3's two pages are LITERAL entries rather than an `/authored11/:slug`
    // family, and that is the inference behaving as designed rather than an
    // oversight: `/authored11/` holds exactly two pages, which is under
    // MIN_COHORT, and two pages are two pages — the `/structure/` precedent two
    // rows below, which has the same shape for the same reason.
    expect([...(metricsById.get("inlinks.sources-by-type") ?? new Map()).keys()].sort()).toEqual(
      [
        "page_type|/",
        "page_type|/authored/:slug",
        "page_type|/authored11/broken-resource",
        "page_type|/authored11/heavy-image",
        "page_type|/authored3/:slug",
        "page_type|/authored7/:slug",
        "page_type|/content/:slug",
        "page_type|/control",
        "page_type|/deep/:id",
        "page_type|/head/:slug",
        "page_type|/kitchen-sink",
        "page_type|/links/:slug",
        "page_type|/perf/slow-response",
        "page_type|/redirect/:slug",
        "page_type|/render/:slug",
        "page_type|/structure/:slug",
        "page_type|/structure/orphan",
      ].sort(),
    );

    // And what the crawl itself said it did, on its way out: 63 parse-time
    // types over 84 pages became 19, and 48 pages were retyped. P11-T3's two
    // pages arrive as two parse-time types and stay two: `/authored11/` is a
    // two-page directory, under MIN_COHORT, so there is nothing to collapse
    // them into and neither is counted as retyped — which is why this commit
    // moved the first two numbers by two and the third not at all. The summary
    // carries it because "the types were collapsed" and "there was nothing to
    // collapse" are different facts about a crawl and a null field is neither.
    expect(summary.pageTemplates).toEqual({
      typesBefore: 63,
      typesAfter: 19,
      pagesRetyped: 48,
    });
  });

  it("the three quotable site metrics carry the numbers this site actually has", () => {
    // The quotability gate made mechanical. Every number below is hand-derived
    // from the fixture collection — the pages it serves, the anchors it renders
    // and the sitemap it publishes — rather than copied from what the SQL
    // produced, which would assert only that the query is deterministic.
    //
    // THE COHORT, which two of the three are computed over. The crawl writes 84
    // `pages` rows: the 83 fixtures plus the hub at `/`. Seventeen of them are
    // not a JUDGED page and are therefore outside the cohort every metric
    // shares (fetched OK, 200, indexable, NOT canonicalised elsewhere —
    // `JUDGED`, src/rules/helpers.ts):
    //
    //   noindex (3): /index/noindex-meta, /index/noindex-header,
    //                /authored/noindex-conflict
    //   errors  (3): /status/not-found 404, /status/server-error 503,
    //                /status/blocked 403
    //   redirects(4): /redirect/chain-1, /redirect/chain-2, /redirect/loop,
    //                /redirect/trailing-slash
    //   canonicalised elsewhere (7), PHASE 22 §1's exclusion:
    //                /index/canonicalized, /index/canonical-conflict,
    //                /authored/canonical-crossdomain, /authored/canonical-noindex
    //                (which is also noindexed — counted once, here, because
    //                canonicalised takes precedence), /authored3/canonical-to-404,
    //                /authored3/canonical-to-noindex, /authored3/paged-2
    //
    // 84 - 17 = 67 cohort pages, where before Phase 22 it was 73: the six
    // indexable pages in the canonicalised list are what moved, and
    // `/authored/canonical-noindex` moved between two exclusions rather than in
    // or out. The seven `/render/*` fixtures P5-T6 added are all judged pages
    // and all inside it; so are P7-T1's `/authored7/hidden-chrome`, P7-T2's
    // `/authored7/shared-h1-a` and `-b`, and P11-T3's
    // `/authored11/broken-resource` and `/authored11/heavy-image` — healthy
    // indexable 200s whose defect is a FILE rather than a tag. The
    // `schema.breadcrumb-absent` assertion above counts the same set out of
    // `pageByPath` and is asserted against the same rows, which is a second
    // reading of this number from a different direction.
    const COHORT = 67;

    // THE LINK GRAPH. Every anchor the site renders, and there are only five
    // kinds: the hub at `/` links the 75 fixtures whose `linkedFromHub` is not
    // false; `/links/broken-internal-link` links `/status/not-found`;
    // `/deep/N` links `/deep/N+1` for N = 1…6 (the seventh rung ends the chain);
    // the paginated series links `paged-1 -> paged-2`, `paged-2 -> paged-1`,
    // `paged-3 -> paged-2` and `paged-3 -> paged-3`; and `/render/healthy`
    // links itself. Nothing else on the site renders an `<a>` — the render
    // fixtures' menus and facets are built by JavaScript, which the crawl pass
    // never runs, and that is the whole point of them.
    //
    // Inlinks per cohort page — DISTINCT source pages, a page's link to itself
    // never counted (the `links.orphan` lesson, and the reason `/render/healthy`
    // appears in the "hub alone" row below rather than in one of its own):
    //
    // THE SOURCE SIDE IS NOT THE COHORT, deliberately (`cohortFilter`): a page
    // that is noindexed or canonicalised elsewhere still LINKS, and the link it
    // makes is still a link. Only the page being MEASURED has to be judged —
    // which is why `/authored3/paged-1` below still counts the inlink from
    // `paged-2`, a page Phase 22 took out of the cohort.
    //
    //   0  `/`                       nothing links the hub. `/redirect/chain-2`
    //                                REDIRECTS to it, and a redirect is not a link.
    //   0  /structure/orphan         not hub-linked, and nothing else names it
    //   0  /authored3/paged-3        not hub-linked; only paged-3 links paged-3
    //   2  /authored3/paged-1        the hub, paged-2
    //   1  /deep/2 … /deep/7         the rung above (6 pages)
    //   1  every other cohort page   the hub alone —
    //                                67 - 3 - 1 - 6 = 57 pages
    //
    // `/authored3/paged-2` — the hub, paged-1 and paged-3, three inlinks and the
    // old maximum — is gone from the measured side: it canonicalises to page
    // one, so Phase 22 §1 stopped judging it.
    //
    // Sorted, that is 0,0,0 then sixty-three 1s (the 57 above plus the 6 deep
    // rungs) then 2. Sum = 63 + 2 = 65, so mean = 65/67 = 0.9701… -> 0.97 at the
    // two decimal places the SQL rounds to.
    //
    // n = 67, so `percentile_cont` interpolates at pos = q * 66 over v0…v66,
    // where v0…v2 = 0, v3…v65 = 1, v66 = 2:
    //   p25    pos 16.5  -> between v16 and v17, both 1 -> 1
    //   median pos 33    -> v33, which is 1
    //   p75    pos 49.5  -> between v49 and v50, both 1 -> 1
    //   p95    pos 62.7  -> between v62 and v63, both 1 -> 1
    // Every one lands inside the run of 1s, so each interpolates between two
    // equal values and the interpolation changes nothing.
    expect(siteMetric("inlinks.distribution")).toEqual({
      count: COHORT,
      min: 0,
      p25: 1,
      median: 1,
      p75: 1,
      p95: 1,
      max: 2,
      mean: 0.97,
    });

    // HREFLANG COVERAGE. Six pages publish a declaration — exactly the six the
    // `hreflang` table assertion above pins, and all six are indexable 200s
    // inside the cohort (the "noindex" in `/authored3/hreflang-noindex` is
    // about the page its alternate points AT, not about itself). The unit is
    // the page, not the declaration: `/authored3/hreflang-a` names three
    // alternates and is one covered page.
    //
    // 100 * 6 / 67 = 8.9552… -> 9 at the one decimal place the SQL rounds to.
    // (It read 8.2 over the 73-page cohort before Phase 22 §1 narrowed it; the
    // numerator did not move — none of the six declaring pages is canonicalised
    // — so the coverage percentage rose because the denominator shrank.)
    expect(siteMetric("hreflang.coverage")).toEqual({
      pagesWithHreflang: 6,
      indexablePages: COHORT,
      coveragePct: 9,
    });
    // The two counts are read from the tables the harness already holds, so a
    // fixture that stopped declaring hreflang, or a page that stopped being
    // indexable, fails as a disagreement between two readings rather than as
    // an unexplained number.
    expect(hreflangByPath.size).toBe(6);
    // Counted through the rule layer's own predicate rather than a copy of it:
    // `isJudged` is what the metric queries' `JUDGED` is the SQL twin of, so
    // this reading and the metric's agree by construction or not at all.
    expect([...pageByPath.values()].filter((p) => isJudged(p)).length).toBe(COHORT);

    // SITEMAP STRUCTURE. robots.txt declares two documents and only one of them
    // contributes an entry: `/sitemap-broken.xml` answers 200 with an HTML
    // error page and is refused before the XML parser sees it (the
    // `sitemap.invalid` finding above is the other half of that fact), so
    // `docs` counts one — this column counts documents that contributed a
    // `sitemap_urls` row, not documents fetched.
    //
    // `/sitemap.xml` publishes the hub, every fixture whose `inSitemap` is not
    // false, and the one URL robots.txt blocks:
    //   1 (the hub, `/`)
    // + 67 (fixtures listed, of the 83 — the same sixteen opt out)
    // + 1 (/private/hidden)
    // = 69 entries, all distinct, so the walk's first-source-wins dedupe drops
    // none of them.
    //
    // 69 is nowhere near `SITEMAP_URL_CAP` (50,000), so no document breaches
    // it; no document was dropped for exceeding the read cap; and the walk
    // stopped at no entry cap — which is what makes every count above exact
    // rather than a floor.
    expect(siteMetric("sitemap.structure")).toEqual({
      docs: 1,
      totalUrls: 69,
      oversizedDocsSkipped: 0,
      urlCapBreaches: 0,
      entryCapReached: false,
    });
    // The per-document row beneath it, which is where `docs: 1` is spent: the
    // one document, with the same 69 entries under its own URL. Asserted as the
    // exact key set, so the broken document appearing here — or the good one
    // vanishing — is a failure rather than a number nobody reads.
    expect([...(metricsById.get("sitemap.structure") ?? new Map()).keys()].sort()).toEqual([
      `sitemap_doc|${app.base}/sitemap.xml`,
      "site|",
    ]);
    expect(metricsById.get("sitemap.structure")?.get(`sitemap_doc|${app.base}/sitemap.xml`)).toEqual(
      { urls: 69, breaches50k: false },
    );
  });

  it("click depth is the walk the site publishes, and the sitemap-only pages have none", () => {
    // THE CLICK-DEPTH DISTRIBUTION, hand-derived from the same link inventory
    // the inlink assertion above uses — the hub's 73 anchors, the deep chain,
    // the paginated series, the one broken link and `/render/healthy`'s
    // self-link. Nothing else on this site renders an `<a>`.
    //
    // The cohort is the same 67 JUDGED pages. Breadth-first from the hub at
    // `/`, which is the crawl's seed:
    //
    //   0    `/`                     1 page, the entry point
    //   1    every cohort page the hub links   58 pages —
    //        the hub links 75 fixtures, SEVENTEEN of which are outside the
    //        cohort (3 noindex, 3 errors, 4 redirects, 7 canonicalised
    //        elsewhere — the list at `COHORT` above), so 75 - 17 = 58
    //   2-7  /deep/2 … /deep/7       6 pages, one per rung: the hub links
    //        /deep/1 (depth 1) and each rung links only the next
    //   null /structure/orphan, /authored3/paged-3   2 pages
    //
    // 1 + 58 + 6 + 2 = 67, which is the cohort back again. The six pages that
    // left it in Phase 22 §1 were all one click from the hub, so every one of
    // them came out of the depth-1 run.
    //
    // The two nulls are EXACTLY the two pages `links.orphan` names, and that is
    // this metric's whole reason for existing: both reached the crawl through
    // the sitemap, both are recorded at DISCOVERY depth 0, and neither is one
    // click from anywhere. `paged-3` is the load-bearing one — it renders its
    // own URL as a link, so a search that followed a page's self-link would
    // have reached it and reported one null instead of two.
    //
    // The 65 pages that HAVE a depth, sorted: v0 = 0, v1…v58 = 1, then
    // v59…v64 = 2,3,4,5,6,7. n = 65, so `percentile_cont` interpolates at
    // pos = q * 64:
    //   mean   = (0 + 58 + (2+3+4+5+6+7)) / 65 = 85/65 = 1.30769… -> 1.31
    //   p25    pos 16   -> v16 = 1
    //   median pos 32   -> v32 = 1
    //   p75    pos 48   -> v48 = 1
    //   p95    pos 60.8 -> v60=3, v61=4 -> 3 + 0.8*1 = 3.8
    expect(siteMetric("structure.click-depth-distribution")).toEqual({
      count: 67,
      nullCount: 2,
      min: 0,
      p25: 1,
      median: 1,
      p75: 1,
      p95: 3.8,
      max: 7,
      mean: 1.31,
    });

    // The same two facts read off the pages table rather than out of the metric,
    // so the number above is corroborated by the column it was computed from.
    const cohort = [...pageByPath].filter(
      ([, p]) => p.fetchClass === "ok" && p.statusCode === 200 && p.isIndexable,
    );
    expect(cohort).toHaveLength(73);
    expect(
      cohort.filter(([, p]) => p.clickDepth === null).map(([path]) => path).sort(),
    ).toEqual(["/authored3/paged-3", "/structure/orphan"]);
    expect(pageByPath.get("/deep/7")?.clickDepth).toBe(7);

    // AND THE WHOLE POINT, in one comparison. Sixty-five of these pages are at
    // DISCOVERY depth 0 — the hub, plus every cohort page the sitemap lists,
    // since a sitemap entry is enqueued as a seed. Exactly ONE of them is a zero
    // click from the home page, because there is only one home page. An audit
    // reading the discovery column would have reported this site as almost
    // entirely one click deep; it is the Phase 6 gate's 437-of-443 in miniature.
    //
    // 65 = 73 cohort pages - 8 that the sitemap does not list (`/deep/1`…`/7`
    // and `/authored3/unlisted`, the set the `pages.not-in-sitemap` assertion
    // above pins), and those 8 carry the depth the frontier reached them at.
    expect(cohort.filter(([, p]) => p.depth === 0)).toHaveLength(65);
    expect(cohort.filter(([, p]) => p.clickDepth === 0).map(([path]) => path)).toEqual(["/"]);
  });

  it("the render pass spent the budget the fixture site's own arithmetic predicts", async () => {
    // `render.coverage`'s site row, hand-derived end to end. Every number below
    // comes from the fixture collection and the selection rules
    // (src/crawl/render/select.ts), not from what the SQL produced.
    //
    // pagesCrawled = 84. The 83 fixtures plus the hub — the same count the
    // cohort derivation two tests above starts from.
    //
    // selectionBudget = min(ceil(84 × 100/100), renderMaxPages 500) = 84.
    // The percentage is taken over EVERY crawled URL, not over the renderable
    // ones, so the denominator is 84 and not the 77-page cohort below.
    //
    // THE SELECTION COHORT is `fetch_class = 'ok'` AND `status_code = 200`, and
    // deliberately NOT `is_indexable` — a noindex page built by JavaScript is
    // exactly the evidence this pass collects. So it is 84 minus the seven
    // pages that are neither: /status/not-found, /status/server-error,
    // /status/blocked, and the four `/redirect/*` hops. 84 - 7 = 77.
    //
    // selectionSuspects = 65. Only ONE of the four suspicion triggers can fire
    // on this site: no fixture is a 50KB document with under 50 words, and no
    // titleless fixture is over 25KB (/head/missing-title is 1.3KB). The thin
    // trigger reads `renderable_word_count` since Phase 7 and STILL fires on
    // nothing here, which is arithmetic rather than luck: its byte half is what
    // excludes every fixture, and the fixture that hides the most is
    // `/authored7/hidden-chrome` at 2.3KB with 187 renderable words — two
    // orders of magnitude inside the byte threshold and three times over the
    // word one. The trigger that does fire is "this page links nowhere", and
    // the cohort pages that DO link somewhere are exactly twelve:
    //
    //   /                            the hub, 75 links
    //   /links/broken-internal-link  1 link, to /status/not-found
    //   /deep/1 … /deep/6            1 link each, to the rung below (6 pages)
    //   /authored3/paged-1, -2, -3   the paginated series (3 pages)
    //   /render/healthy              1 link, to itself — which is a `links` row
    //                                and therefore not "links nowhere", while
    //                                being invisible to every inbound count
    //
    // 77 - 12 = 65. `/render/csr-content` carries a `__NEXT_DATA__` marker as
    // well, which is a second trigger on a page the first had already caught:
    // `min(tier)` means it is counted once. P7-T1's `/authored7/hidden-chrome`
    // renders no anchor of its own — its one hidden drawer holds none — so it
    // joins the suspects rather than the twelve, and P7-T2's two shared-heading
    // pages render none either (the `article` helper emits an image and no
    // anchor), so all three are suspects. That is why this number has moved by
    // three across the phase while `selectionSampled` has not moved at all.
    // P11-T3's two pages are the same shape again — prose, one image, no anchor
    // — so both are suspects, which is this commit's +2.
    //
    // selectionSampled = 6, and it MOVED FROM 9 IN P8-T5 — the one number in
    // this file that the template inference changes, and the change is the
    // point of it. The sample takes `renderSamplePerType` (3) pages of every
    // page type in URL order, and a page that is both a suspect and a sample
    // member counts on the SUSPECT side — so this number counts only the twelve
    // above, and only where they fall inside their type's first three rows.
    // The crawl now types this site with 19 templates instead of 63, so:
    //
    //   /                            1 — the only page of its type
    //   /links/broken-internal-link  1 — `/links/:slug` has one member
    //   /deep/1, /deep/2, /deep/3    3 — the first three of `/deep/:id`'s seven
    //   /render/healthy              1 — second of `/render/:slug`'s seven, in
    //                                    URL order after `/render/csr-content`
    //
    // 1 + 1 + 3 + 1 = 6, and P11-T3's two pages add none: each is a page type of
    // one and therefore has a seat, and each is also a SUSPECT, which is the
    // side a page on both lists is counted on. The three seats lost are
    // `/authored3/paged-1`, `-2`
    // and `-3`, which used to be three page types of one page each and are now
    // the twelfth, thirteenth and fourteenth rows of `/authored3/:slug` — past
    // the three the sample takes. That is the collapse working: the seats it
    // freed were being spent on pages that exist once, and on a real site they
    // go to templates instead (the Phase 7 gate crawl spent roughly half its
    // sample that way).
    //
    // selectionSelected = min(84, 65 + 6) = 71, selectionTruncated = false:
    // the budget is thirteen seats larger than the need, so nothing was cut.
    //
    // pagesRendered = 70 and renderFailures = 1, and the two are disjoint and
    // sum to the 71 selected — the single-pass invariant this crawl happens to
    // satisfy, because it was selected once. The one failure is
    // `/render/js-redirect-offsite`, whose row shape the next test pins.
    expect(siteMetric("render.coverage")).toEqual({
      pagesCrawled: 84,
      // P12-T4. The end-to-end crawl really did render, so this is the `ran`
      // side of the field — the whole-site case the unit tests bound from the
      // other end. `pagesRendered: 70` below is evidence enough on its own
      // here; the field matters on the crawls where there is none.
      renderPassEvidence: RENDER_PASS_EVIDENCE.ran,
      // P8-T2. The harness renders the AUTOMATIC selection — it names no URLs —
      // and this is the field that says so. The five numbers under it describe
      // that decision and are present only because it was taken.
      selectionMode: "auto",
      selectionBudget: 84,
      selectionSuspects: 65,
      selectionSampled: 6,
      selectionSelected: 71,
      selectionTruncated: false,
      pagesRendered: 70,
      renderFailures: 1,
    });

    // The metric recomputes the selection from SQL; the pass returned it from
    // the statement that actually promoted the frontier rows. Asserting both
    // is what proves `renderSelectionStats` describes the selection that
    // happened rather than one it would make today.
    expect(render.selection.budget).toBe(84);
    expect(render.selection.suspects).toBe(65);
    expect(render.selection.sampled).toBe(6);
    expect(render.selection.truncated).toBe(false);
    expect(render.selection.selected).toHaveLength(71);
    expect(render.rendered).toBe(70);
    expect(render.failures).toBe(1);
    // No URL left behind: the pass was not aborted, so every leased render was
    // recorded and completed.
    expect(render.unrendered).toBe(0);

    // The three `/deep/` pages the selection deliberately does not name — 4, 5
    // and 6, the members of `/deep/:id` past the sample's third seat. Asserted
    // by absence rather than left as arithmetic, because it is the one part of
    // the derivation above that a change to `renderSamplePerType` would silently
    // undo — and the sample size is read from the constant, not restated. (The
    // `/authored3/paged-*` pages are now unnamed for the same reason, on a type
    // eighteen pages long; this one stays the assertion because seven pages and
    // three seats is arithmetic a reader can check by eye.)
    expect(RENDER_DEFAULTS.renderSamplePerType).toBe(3);
    const selectedPaths = new Set(render.selection.selected.map((url) => new URL(url).pathname));
    expect([...selectedPaths].filter((p) => p.startsWith("/deep/")).sort()).toEqual([
      "/deep/1",
      "/deep/2",
      "/deep/3",
      "/deep/7",
    ]);

    // And the one column the pass persists, which nothing else writes.
    const [crawlRow] = await db
      .select({ count: crawls.renderPassCount })
      .from(crawls)
      .where(eq(crawls.id, summary.crawlId));
    expect(crawlRow?.count).toBe(70);
  });

  it("the health rollup agrees with a page-by-page recount (P10-T2)", () => {
    // P10-T2's rollup, over the same crawl and derived a DIFFERENT WAY: the
    // metric answers in one grouped SQL statement, and this recomputes it by
    // walking the harness's own maps in JavaScript — page by page, rule by
    // rule, severity from the registry. Two independent derivations of one set
    // of numbers is the point: a copy of the SQL would agree with the SQL
    // whatever either of them said.
    //
    // The rules the harness's fixture site provokes are many and the numbers
    // move with the fixtures, so what is pinned here is the AGREEMENT plus the
    // properties that must hold on any crawl — the buckets partition the
    // census, and the census plus the pages left out is the whole crawl.
    const severityOf = new Map(registry.all().map((rule) => [rule.id, rule.severity]));
    const RANK = { critical: 1, warning: 2, info: 3 } as const;
    let critical = 0;
    let warningOnly = 0;
    let infoOnly = 0;
    let clean = 0;
    let judged = 0;
    // PHASE 22 §3's two set-aside columns, recounted the same way: a fetched
    // 200 that is not judged is either canonicalised elsewhere or noindexed,
    // and the canonical takes precedence when it is both.
    let canonicalised = 0;
    let noindex = 0;
    for (const [path, page] of pageByPath) {
      if (page.fetchClass !== "ok" || page.statusCode !== 200) continue;
      if (!isJudged(page)) {
        if (isCanonicalisedElsewhere(page)) canonicalised += 1;
        else noindex += 1;
        continue;
      }
      judged += 1;
      let worst = 4;
      for (const ruleId of issuesByPath.get(path) ?? []) {
        const severity = severityOf.get(ruleId);
        if (severity === undefined) throw new Error(`no registry rule '${ruleId}'`);
        worst = Math.min(worst, RANK[severity]);
      }
      if (worst === 1) critical += 1;
      else if (worst === 2) warningOnly += 1;
      else if (worst === 3) infoOnly += 1;
      else clean += 1;
    }
    expect(judged).toBeGreaterThan(0);
    expect(critical + warningOnly + infoOnly + clean).toBe(judged);
    // Both exclusions really happen on this site, so the two columns below are
    // asserted against something rather than against zero.
    expect(canonicalised).toBeGreaterThan(0);
    expect(noindex).toBeGreaterThan(0);
    // The ratio, rounded THE WAY POSTGRES ROUNDS IT. `round(numeric, 4)` is
    // half-away-from-zero on the exact decimal; `toFixed(4)` rounds a binary
    // float, so at an exact .00005 boundary the two can disagree and a future
    // fixture change would surface as a mystery flake rather than as a fault.
    // Integer arithmetic reaches the boundary exactly:
    // `floor(clean·10^4/auditable + 1/2)` written with no division at all, as
    // `floor((2·clean·10^4 + auditable) / (2·auditable))`.
    const cleanRatio =
      Math.floor((2 * clean * 10_000 + judged) / (2 * judged)) / 10_000;
    expect(siteMetric("site.health")).toEqual({
      urlsTotal: judged,
      urlsWithCritical: critical,
      urlsWithWarningOnly: warningOnly,
      urlsWithInfoOnly: infoOnly,
      urlsClean: clean,
      cleanRatio,
      // 84 pages crawled, and the census is the judged ones: the rest are this
      // fixture site's redirects, its 404s, its 5xx and its non-HTML, plus the
      // two set-aside columns beside them.
      pagesNotAuditable: 84 - judged - canonicalised - noindex,
      urlsCanonicalised: canonicalised,
      urlsNoindex: noindex,
    });
    // THE PARTITION, end to end (Phase 22 §3): every URL this crawl has a row
    // for is in exactly one of the four columns. The rule asserts it over its
    // own SQL; this adds the four numbers the METRIC published — not the four
    // this test counted — and checks them against the crawl's page count read
    // from a third place again.
    const health = siteMetric("site.health") as Record<string, number>;
    expect(
      health["urlsTotal"]! +
        health["urlsCanonicalised"]! +
        health["urlsNoindex"]! +
        health["pagesNotAuditable"]!,
    ).toBe(84);
    expect(pageByPath.size).toBe(84);
  });

  it("the resource findings carry what the asset server actually answered (P11-T3)", () => {
    // THE END-TO-END CLAIM OF THE WHOLE PHASE, in one test: a number the fixture
    // server declared in a response header travels through the resource fetch
    // pass, the `resources` row and the rule into a finding a client reads.
    // Nothing between those two ends is stubbed — the pass sends a real HEAD to
    // a real server for every file these pages reference.
    //
    // The heavy image first. `HEAVY_IMAGE_BYTES` is the length
    // test/fixtures/assets.ts declares for `/img/p11-heavy-hero.png`, so
    // asserting the finding's `bytes` against the CONSTANT rather than against a
    // literal is what makes this a claim about the pipeline instead of a
    // snapshot of it. `bytesSource: "header"` is the second half: the server
    // answered the HEAD with a `content-length`, so the pass believed the claim
    // rather than spending a GET to count — which is the branch the overwhelming
    // majority of the real web takes, and the one the copy calls a claim.
    expect(detailsByPath.get(`${P11_HEAVY_PATH}\nimages.oversized`)).toEqual({
      pageUrl: `${app.base}${P11_HEAVY_PATH}`,
      resourceUrl: `${app.base}${P11_HEAVY_IMAGE}`,
      bytes: HEAVY_IMAGE_BYTES,
      bytesSource: "header",
      contentType: "image/png",
      threshold: IMAGE_WEIGHT_WARN,
      // One page carries it, and that page is the one the finding hangs on.
      referencingPages: 1,
      samplePages: [`${app.base}${P11_HEAVY_PATH}`],
    });
    // The same file, judged a second time on the type the server sent. The two
    // rules are deliberately not exclusive — the format finding is a subset of
    // the weight one — and this is where that overlap is visible end to end.
    expect(detailsByPath.get(`${P11_HEAVY_PATH}\nimages.legacy-format`)).toMatchObject({
      resourceUrl: `${app.base}${P11_HEAVY_IMAGE}`,
      contentType: "image/png",
      bytes: HEAVY_IMAGE_BYTES,
    });

    // The broken one. The app serves no asset at this path, so the pass got a
    // real 404 and the row says `client_error` — and `fetchReason` is null
    // because a plain 404 needs no explanation beyond its status. The
    // CF-MITIGATED shape, where the reason is the only thing that stops the
    // status reading as an absurdity, is pinned in the rule's own suite; no
    // fixture server here impersonates a WAF.
    expect(detailsByPath.get(`${P11_BROKEN_PATH}\nresources.broken`)).toEqual({
      pageUrl: `${app.base}${P11_BROKEN_PATH}`,
      brokenCount: 1,
      // Nothing on this page went unasked: the crawl finished, no cap bit, and
      // the site's robots.txt allows `/img/`. A zero here is therefore a
      // measurement rather than a default, and it is the number that says the
      // "1 broken" beside it is the whole story for this page.
      unknownResources: 0,
      resources: [
        {
          url: `${app.base}${P11_MISSING_IMAGE}`,
          kind: "image",
          statusCode: 404,
          fetchClass: "client_error",
          fetchReason: null,
        },
      ],
    });

    // The site-scoped caching finding, provoked by the ONE asset the fixture
    // site deliberately serves with no `cache-control` — an image on the
    // control page, which is why this finding is site-scoped and the control's
    // own silence is intact. The count is exact and the sample names it.
    const uncached = siteFindings.get("resources.uncached") ?? [];
    expect(uncached).toHaveLength(1);
    expect(uncached[0]).toMatchObject({
      pageUrl: null,
      uncachedResources: 1,
      sampleResources: [`${app.base}/img/control-outline.svg`],
      // Every other file this crawl asked for answered with a header, and none
      // of them went unasked.
      unknownResources: 0,
    });

    // And the table beside them. The page-weight row is a FLOOR on this crawl —
    // one referenced file (the 404) could not be weighed — and the row says so
    // rather than quietly reporting the pages as lighter than they are.
    const weight = siteMetric("page.weight") as {
      resourcesReferenced: number;
      resourcesWeighed: number;
      pagesWithUnmeasuredResources: number;
      atLeast: boolean;
      pageWeight: { count: number; max: number };
    };
    // Exactly one reference on this whole site could not be weighed, and it is
    // the 404 above. The difference is asserted rather than the two totals,
    // because the totals move with every fixture that carries an image while
    // the GAP is the property this row exists to state.
    expect(weight.resourcesReferenced - weight.resourcesWeighed).toBe(1);
    expect(weight.pagesWithUnmeasuredResources).toBe(1);
    expect(weight.atLeast).toBe(true);
    // And the distribution is over the same cohort every other metric uses, so
    // its count is the constant the three quotable metrics are pinned against.
    expect(weight.pageWeight.count).toBe(67);
    // The heavy page is the heaviest thing on this site by a wide margin, so
    // the maximum is at least the image the assertion above pinned. Stated as a
    // floor rather than a sum: the page's own HTML is in there too.
    expect(weight.pageWeight.max).toBeGreaterThan(HEAVY_IMAGE_BYTES);
  });

  it("each render rule fires on exactly the fixture built for it", () => {
    // The four rules the render pass exists to feed, each asserted as the exact
    // SET of paths it fired on. A containment check would be satisfied by a
    // rule that had grown eager enough to fire on half the site, which for a
    // diff rule is the likeliest way to be wrong: every one of them compares
    // two counts, and a threshold that slipped would land on the sixty-four
    // other pages this crawl rendered.
    const firedOn = (ruleId: string): string[] =>
      [...issuesByPath]
        .filter(([, ids]) => ids.has(ruleId))
        .map(([path]) => path)
        .sort();

    expect(firedOn("content.csr-dependent")).toEqual(["/render/csr-content"]);
    expect(firedOn("nav.js-only")).toEqual(["/render/js-nav"]);
    expect(firedOn("filters.js-only")).toEqual(["/render/js-filters"]);
    // Both redirect pages, and the second of them is the one whose render
    // FAILED — see the next test.
    expect(firedOn("redirect.js")).toEqual([
      "/render/js-redirect",
      "/render/js-redirect-offsite",
    ]);

    // /render/healthy is the control for all four: rendered by the same
    // browser, in the same pass, and silent. Checked against its page row
    // first, because "fired nothing" proves nothing about a page nobody
    // rendered (the /control assertion's lesson, one pass further on).
    const healthy = pageByPath.get("/render/healthy");
    if (healthy === undefined) throw new Error("/render/healthy has no pages row");
    expect(healthy.rendered).toBe(true);
    expect(healthy.renderError).toBeNull();
    expect([...(issuesByPath.get("/render/healthy") ?? new Set<string>())]).toEqual([]);

    // THE EVIDENCE, page by page, against the markup that produced it.
    //
    // CSR, AND SINCE PHASE 8 THIS IS THE CANCELLATION ASSERTION. The fixture
    // carries chrome in BOTH documents — a 100-word region popover hidden by a
    // CSS class (invisible to the analyzer, which does not cascade) and a
    // 40-word account drawer hidden by the `hidden` attribute (which the
    // analyzer does see) — plus the 200 `lorem` words the script writes into
    // `#app`. Its whole arithmetic is derived in test/fixtures/pages/render-p5.ts
    // and imported here rather than retyped, so the fixture and the assertion
    // cannot drift into agreeing about different numbers.
    //
    // What makes it a proof: `addedWords` is 200 EXACTLY. The hundred words of
    // class-hidden chrome are counted on both sides of the subtraction by the
    // same instrument and cancel to nothing — which is the whole claim of
    // P8-T1, and which the retired `innerText` comparison could not make (on
    // this same page it is silent on both arms; see the fixture's docblock).
    expect(detailsByPath.get("/render/csr-content\ncontent.csr-dependent")).toEqual({
      pageUrl: `${app.base}/render/csr-content`,
      rawWordCount: CSR_EXPECTED.wordCount,
      renderableWordCount: CSR_EXPECTED.renderableWordCount,
      renderedAnalyzerWordCount: CSR_EXPECTED.renderedAnalyzerWordCount,
      renderedRenderableWordCount: CSR_EXPECTED.renderedRenderableWordCount,
      addedWords: CSR_EXPECTED.addedWords,
    });

    // NAV: the raw document contains no `<nav>`, no `<footer>` and no anchor at
    // all; the script builds a twelve-link menu and a four-link footer. 0 < 5
    // and 16 ≥ 10, with six links of margin over the tokenizer's known
    // one-directional undercount of anchors unclosed across a container.
    expect(detailsByPath.get("/render/js-nav\nnav.js-only")).toEqual({
      pageUrl: `${app.base}/render/js-nav`,
      rawNavLinks: 0,
      rawFooterLinks: 0,
      rawLinks: 0,
      renderedNavLinks: 12,
      renderedFooterLinks: 4,
      renderedLinks: 16,
    });

    // FILTERS: the product grid is `<div>`s, so the page contributes no `links`
    // row at all and the raw side is categorically zero — which is what the
    // rule's NOT EXISTS asks, over the deduplicated, protocol-filtered
    // `target_url` the analyzer stored. The script adds eight `?filter=`
    // anchors, three over `FILTER_RENDERED_MIN`.
    expect(detailsByPath.get("/render/js-filters\nfilters.js-only")).toEqual({
      pageUrl: `${app.base}/render/js-filters`,
      rawFilterLinks: 0,
      renderedFilterLinks: 8,
    });

    // REDIRECT, same origin: the browser followed the page's own `location.href`
    // to `/render/target`, so the render SUCCEEDED — what it measured is the
    // destination's DOM, not this page's — and the redirect is recorded beside
    // it. `rendered: true` with a null `renderError` is the shape that says so.
    expect(detailsByPath.get("/render/js-redirect\nredirect.js")).toEqual({
      pageUrl: `${app.base}/render/js-redirect`,
      fromUrl: `${app.base}/render/js-redirect`,
      toUrl: `${app.base}/render/target`,
      statusCode: 200,
      rendered: true,
      renderError: null,
    });
  });

  it("the off-site redirect is a failed render that still carries its evidence", () => {
    // THE ROW SHAPE THE RULE'S NO-`rendered`-GATE EXISTS FOR, proved end to end
    // for the first time here — P5-T5 could only build it by hand.
    //
    // The page answers a plain 200 and then asks the browser for an address on
    // ANOTHER ORIGIN. The render pass aborts that navigation (we record where
    // the page wanted to go and refuse to follow it), which leaves Chromium on
    // its own error surface with no DOM of this site's to measure. So the row
    // is `rendered = false` with all five count columns null and a classified
    // `render_error` — and `rendered_redirect_url` set anyway, because a page
    // that sent itself off-site is a fact worth keeping even when the render
    // that discovered it could not finish.
    const offsiteTarget = `${offsite.base}/promotions`;
    const page = pageByPath.get("/render/js-redirect-offsite");
    if (page === undefined) throw new Error("/render/js-redirect-offsite has no pages row");

    // The fetch layer saw a perfectly healthy page, which is the whole problem.
    expect(page.fetchClass).toBe("ok");
    expect(page.statusCode).toBe(200);

    expect(page.rendered).toBe(false);
    expect(page.renderError).toBe(`off-site navigation: ${offsiteTarget}`);
    expect(page.renderedRedirectUrl).toBe(offsiteTarget);
    // BOTH MEASUREMENT FAMILIES, every column of each and not a sample:
    // "rendered and empty" and "never rendered" are different facts, and a
    // failed render must not leave one count behind that a diff rule could read
    // as a zero. The six analyzer-side columns joined this assertion in P8-T1;
    // `renderedHtmlPath` is in it for a second reason as well — there is no
    // document on disk for a render that never had one, and a path pointing at
    // a file that does not exist would be worse than no path.
    expect(page.renderedWordCount).toBeNull();
    expect(page.renderedLinkCount).toBeNull();
    expect(page.renderedNavLinkCount).toBeNull();
    expect(page.renderedFooterLinkCount).toBeNull();
    expect(page.renderedFilterLinkCount).toBeNull();
    expect(page.renderedAnalyzerWordCount).toBeNull();
    expect(page.renderedRenderableWordCount).toBeNull();
    expect(page.renderedTitle).toBeNull();
    expect(page.renderedH1Count).toBeNull();
    expect(page.renderedCanonical).toBeNull();
    expect(page.renderedHtmlPath).toBeNull();

    // And the finding, which a `rendered = true` gate would have lost outright.
    // It is the ONLY finding on the page: the three diff rules all open with
    // `p.rendered = true`, so they correctly say nothing about a page nobody
    // could measure, and the exact-set assertion is what proves they stayed
    // silent for that reason rather than by luck.
    expect([...(issuesByPath.get("/render/js-redirect-offsite") ?? new Set<string>())]).toEqual([
      "redirect.js",
    ]);
    expect(detailsByPath.get("/render/js-redirect-offsite\nredirect.js")).toEqual({
      pageUrl: `${app.base}/render/js-redirect-offsite`,
      fromUrl: `${app.base}/render/js-redirect-offsite`,
      toUrl: offsiteTarget,
      statusCode: 200,
      rendered: false,
      renderError: `off-site navigation: ${offsiteTarget}`,
    });
  });

  it("the render pass measures the post-JavaScript DOM with the crawl's own analyzer", async () => {
    // P8-T1 end to end: the SECOND measurement family, written by a real
    // Chromium's serialised DOM through the same `analyzeHtml` the crawl ran
    // over the bytes the server sent (src/db/schema.ts, the family blocks).
    //
    // Three pages, chosen because between them they are the whole argument:
    // one where JavaScript adds text, and two where it adds none.
    const csr = pageByPath.get("/render/csr-content");
    const healthy = pageByPath.get("/render/healthy");
    const chromeOnly = pageByPath.get(P7_HIDDEN_CHROME_PATH);
    if (csr === undefined || healthy === undefined || chromeOnly === undefined) {
      throw new Error("one of the three P8 render fixtures has no pages row");
    }

    // 1. THE CSR PAGE — every number the fixture derives, in the row a real
    // crawl and a real render wrote. The `innerText` column is asserted BESIDE
    // the analyzer's, unchanged in meaning and no longer read by any rule: it
    // is 232, a hundred words under the 332 the analyzer counts, and that
    // hundred is exactly the class-hidden popover. Two instruments disagreeing
    // by precisely the chrome is what the whole task is about.
    expect(csr.wordCount).toBe(CSR_EXPECTED.wordCount);
    expect(csr.renderableWordCount).toBe(CSR_EXPECTED.renderableWordCount);
    expect(csr.renderedAnalyzerWordCount).toBe(CSR_EXPECTED.renderedAnalyzerWordCount);
    expect(csr.renderedRenderableWordCount).toBe(CSR_EXPECTED.renderedRenderableWordCount);
    expect(csr.renderedWordCount).toBe(CSR_EXPECTED.renderedWordCount);
    expect(
      csr.renderedRenderableWordCount! - csr.renderedWordCount!,
      "the class-hidden popover, seen by the analyzer and not by the browser",
    ).toBe(CSR_CHROME_WORDS);
    // The three head columns the same analysis produced. Nothing on this page
    // rewrites its own head, so each is the raw column back again — which is
    // the baseline a future `render.title-drift` would be a departure from.
    expect(csr.renderedTitle).toBe(csr.title);
    expect(csr.renderedH1Count).toBe(1);
    expect(csr.renderedCanonical).toBe(`${app.base}/render/csr-content`);

    // 2. AND 3. THE TWO SILENT CONTROLS, which are where the cancellation is
    // visible as an IDENTITY rather than as arithmetic.
    //
    // `/render/healthy` runs no script at all, so the DOM the browser built is
    // the document the server sent and both analyzer counts come back equal to
    // their raw twins. `/authored7/hidden-chrome` is the chrome-only page: a
    // template, a `hidden` drawer, an inline-`display:none` picker and a closed
    // `<details>`, 82 words of markup-hidden text and no JavaScript anywhere.
    // The analyzer suppresses exactly the same 82 words on the rendered side as
    // on the raw one — the markup that hides them survives serialisation — so
    // BOTH pairs match and `content.csr-dependent` has nothing to report.
    for (const [label, page] of [
      ["/render/healthy", healthy],
      [P7_HIDDEN_CHROME_PATH, chromeOnly],
    ] as const) {
      expect(page.rendered, label).toBe(true);
      expect(page.renderedAnalyzerWordCount, label).toBe(page.wordCount);
      expect(page.renderedRenderableWordCount, label).toBe(page.renderableWordCount);
      expect(page.renderedTitle, label).toBe(page.title);
      expect(page.renderedH1Count, label).toBe(page.h1Count);
      expect([...(issuesByPath.get(label) ?? new Set<string>())], label).not.toContain(
        "content.csr-dependent",
      );
    }

    // THE DOCUMENT ON DISK. Every rendered page has one, it is named by the
    // sha256 of the URL asked for, and it is the very string the numbers above
    // were computed from — so an auditor who disbelieves the finding can re-run
    // the analyzer over the evidence itself. Asserted by reading the CSR page's
    // file back and finding in it the paragraph the SCRIPT wrote, which is in
    // no byte the server ever sent.
    expect(csr.renderedHtmlPath).toBe(
      join(renderHtmlRoot, summary.crawlId, renderedHtmlFilename(csr.url)),
    );
    const saved = await readFile(csr.renderedHtmlPath!, "utf8");
    expect(saved).toContain('<div id="app"><p>the quick brown fox');
    expect(saved).toContain('class="chrome-popover"');

    // …and every OTHER rendered page has one too, while no failed render does.
    // Stated as a partition rather than as a spot check: a pass that wrote 70
    // of 71 documents would satisfy any single assertion above.
    const rows = [...pageByPath.values()];
    expect(rows.filter((p) => p.rendered && p.renderedHtmlPath !== null)).toHaveLength(
      render.rendered,
    );
    expect(rows.filter((p) => !p.rendered && p.renderedHtmlPath !== null)).toHaveLength(0);
  });

  it("every registered rule fires on at least one fixture", () => {
    // Fixture paths only. The hub is crawled and judged like any other page,
    // but it proves nothing: a rule "covered" only by the hub would be a rule
    // no fixture was ever written for.
    //
    // `siteFindings` seeds the set. A site-scoped rule has no page to land on —
    // it is provoked by the site as a whole rather than by one fixture's markup
    // — so counting it towards coverage regardless of which page produced it is
    // correct. The assertion above is what holds the contents of that map
    // honest.
    //
    // `metricsById` seeds it for the same reason and with the same warrant. A
    // metric rule writes rows to the `metrics` table and never writes an issue,
    // so "fires" means "wrote its table" for this kind — and the metric
    // assertions above are what hold THAT map honest: the exact id set, and
    // three site rows pinned to hand-derived fixture-site values. The kind used
    // to be filtered out of this sweep on the promise of exactly those
    // assertions; they exist now, so it is not.
    const fired = new Set([...siteFindings.keys(), ...metricsById.keys()]);
    for (const fixture of allFixtures()) {
      for (const ruleId of issuesByPath.get(fixture.path) ?? []) fired.add(ruleId);
    }

    const exempt = new Set(SKIP_HARNESS_CLAIMS);
    const unfired = registry
      .all()
      .map((rule) => rule.id)
      .filter((id) => !fired.has(id) && !exempt.has(id))
      .sort();
    // The strict form, over every kind at last: every registered rule speaks on
    // this one crawl, save the fifteen `SKIP_HARNESS_CLAIMS` names and
    // explains (the count was written as nine when the list held nine and has
    // been carried stale through four phases of markers; P17 corrected it and
    // P19-T2's near-duplicate marker makes fifteen). A
    // new rule arrives here with no fixture and fails immediately, which is the
    // point — the alternative is a rule nobody has ever seen speak.
    expect(
      unfired,
      "a rule that fires nowhere is a rule no fixture proves — author a fixture " +
        "that makes it speak, or add it to SKIP_HARNESS_CLAIMS with a paragraph " +
        "saying why no page could",
    ).toEqual([]);

    // The exemption is asserted, not assumed. An id listed as unfireable that
    // then fires is a rule whose condition is not what the list claims, and it
    // must leave the list rather than sit there as a stale excuse. That
    // discipline is what emptied the pending list P5-T5 left here: the four
    // render finding rules were exempted only until a fixture and a pass could
    // provoke them, and this commit's fixtures do, so the list is gone rather
    // than grown.
    for (const id of SKIP_HARNESS_CLAIMS) {
      expect(fired.has(id), `${id} fired — it is not unfireable, drop the exemption`).toBe(
        false,
      );
      expect(
        registry.all().map((rule) => rule.id),
        `${id} is exempted from coverage but is not a registered rule`,
      ).toContain(id);
    }
  });
});

/**
 * The resource fetch pass, end to end (P11-T2).
 *
 * Its own suite (test/crawl/fetch-resources.test.ts) drives every branch against
 * servers built to provoke them; what belongs HERE is the claim that the pass is
 * wired into a real crawl of a real site, and that the two origins of the
 * fixture world are asked about their files the way their pages were asked about
 * themselves.
 */
describe("the resource fetch pass ran on the fixture crawl", () => {
  it("asked about every file the pages point at, on both origins", async () => {
    const pass = summary.resources;
    if (pass === null) throw new Error("the crawl reported no resource pass");

    expect(pass.seen).toBeGreaterThan(0);
    expect(pass.cappedByResources).toBe(false);
    expect(pass.cappedByHosts).toBe(false);
    // Nothing left unasked: a cap or an abort would show here, and the null
    // fetch_class of an unasked row is exactly what the rules must not read as
    // a verdict.
    expect(pass.skipped).toBe(0);
    // The site's own origin and the CDN the hub's badge lives on. The legacy
    // spelling (`localhost:port`) is never a resource host: no markup points at
    // it, and the host probe is not this pass's business.
    expect(pass.hosts).toBe(2);

    const rows = await db
      .select()
      .from(resources)
      .where(eq(resources.crawlId, summary.crawlId));
    expect(rows.length).toBe(pass.seen);
    expect(rows.every((row) => row.fetchClass !== null)).toBe(true);
  });

  it("recorded the third-party badge, its host's robots.txt read exactly once", async () => {
    const badge = (
      await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.crawlId, summary.crawlId),
            eq(resources.url, `${assetHost.base}/cdn/hub-badge.svg`),
          ),
        )
    )[0];
    if (badge === undefined) throw new Error("the hub's third-party badge has no resources row");

    expect(badge.fetchClass).toBe("ok");
    expect(badge.statusCode).toBe(200);
    expect(badge.kind).toBe("image");
    expect(badge.contentType).toContain("image/svg+xml");
    // A server that says how big a file is is believed, and the row says the
    // number is a claim rather than a measurement.
    expect(badge.bytesSource).toBe("header");
    expect(badge.bytes).toBeGreaterThan(0);
    expect(badge.cacheControl).toBe("public, max-age=31536000, immutable");

    // One robots.txt for the host, one HEAD for the file — a third-party host
    // is a guest's host, and the pass spends exactly what it must there.
    expect(assetHost.hits.filter((hit) => hit.endsWith("/robots.txt")).length).toBe(1);
    expect(assetHost.hits).toContain("HEAD /cdn/hub-badge.svg");
    expect(assetHost.hits.filter((hit) => hit.startsWith("GET /cdn/"))).toEqual([]);
  });

  it("records the absence of a cache header as an absence, not as a zero", async () => {
    const uncached = (
      await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.crawlId, summary.crawlId),
            eq(resources.url, `${app.base}/img/control-outline.svg`),
          ),
        )
    )[0];
    if (uncached === undefined) throw new Error("/img/control-outline.svg has no resources row");

    expect(uncached.fetchClass).toBe("ok");
    // The server sent none. After a successful fetch that null is the finding
    // P11-T3 reports, and it is a different null from the one an unfetched row
    // carries — which is why `fetch_class` is what a rule gates on.
    expect(uncached.cacheControl).toBeNull();
    expect(uncached.expires).toBeNull();
  });
});

/**
 * The 5xx re-verification pass, on the one fixture that answers one (P17-T5,
 * §5.6 of docs/superpowers/specs/2026-09-08-5xx-recheck-design.md).
 *
 * DELIBERATELY MINIMAL, and the design says why: no flapping route was added to
 * this app. `/status/server-error` is a STATELESS 503 — it answers the recheck
 * exactly as it answered the crawl — so what this site can prove is the
 * CONFIRMED half of the split, end to end through the real loop, and the
 * negative that goes with it. The transient half needs a route whose answer
 * changes between two requests, which is a route whose answer depends on how
 * many times the suite happened to ask; that lives on its own servers, in
 * test/crawl/recheck.test.ts and test/db/migration-0016.test.ts (see this file's
 * `SKIP_HARNESS_CLAIMS` entry).
 *
 * What is under test here is therefore the SEAM: that a crawl of a real site
 * runs the pass, that the pass finds the site's one server error, that the
 * second observation lands on the row without disturbing the first, and that the
 * rule pair reads it the way the rest of the engine reports it.
 */
describe("the 5xx re-verification pass ran on the fixture crawl", () => {
  it("re-asked the site's one server error and confirmed it", () => {
    const pass = summary.recheck;
    if (pass === null) throw new Error("the crawl reported no recheck pass");

    // One 5xx on the whole site (`/status/server-error`), asked exactly once
    // more. The partition is asserted as arithmetic rather than spot-checked:
    // `confirmed + cleared + inconclusive == rechecked` is the claim
    // `RecheckPassSummary` makes, and a pass that lost a row would satisfy any
    // single equality above it.
    expect(pass).toEqual({
      rechecked: 1,
      confirmed: 1,
      cleared: 0,
      inconclusive: 0,
      capped: false,
      aborted: false,
    });
    expect(pass.confirmed + pass.cleared + pass.inconclusive).toBe(pass.rechecked);
  });

  it("wrote the second observation beside the first without touching it", () => {
    const page = pageByPath.get("/status/server-error");
    if (page === undefined) throw new Error("/status/server-error has no pages row");

    // THE FIRST OBSERVATION, unchanged. This is the assertion that would catch
    // the whole design going wrong at once: a pass that wrote `fetch_class`
    // would move this page into the `ok` cohort every other rule is cut from,
    // as an `ok` page with no title, no words and no links (§2.2, hard rule 1).
    expect(page.fetchClass).toBe("server_error");
    expect(page.statusCode).toBe(503);
    // …and it carries the timestamp the gap is computed from.
    expect(page.fetchedAt).not.toBeNull();

    // THE SECOND, on its own columns. A stateless 503 answers the recheck the
    // way it answered the crawl, so this is CONFIRMED and nothing is cleared.
    expect(page.recheckFetchClass).toBe("server_error");
    expect(page.recheckStatusCode).toBe(503);
    expect(page.recheckAt).not.toBeNull();
    // Null because the recheck simply worked: `recheck_reason` is
    // `fetch_reason`'s twin and says why, when there is a why. A `recheck-cap`
    // here would mean the cap fired on a site with one server error.
    expect(page.recheckReason).toBeNull();
    // The invariant migration-0016 pins over its whole table, on the one row in
    // this crawl that is on the non-null side of it.
    expect(page.recheckAt === null).toBe(page.recheckFetchClass === null);
  });

  it("still reports the confirmed error as critical, and says it was re-verified", () => {
    const fired = issuesByPath.get("/status/server-error") ?? new Set<string>();
    expect([...fired]).toContain("http.server-error");

    // The severity from the REGISTRY rather than from a literal here: the split
    // moved a verdict, and the claim is that the confirmed half kept the one it
    // had (27 critical at ruleset 0.13.0).
    const rule = registry.all().find((r) => r.id === "http.server-error");
    if (rule === undefined) throw new Error("http.server-error is not registered");
    expect(rule.severity).toBe("critical");

    // The evidence, which is where the four-value recheck state lives. A report
    // writer must be able to tell "still broken a minute later" from "nobody
    // asked", and on this crawl it is the former.
    expect(detailsByPath.get("/status/server-error\nhttp.server-error")).toMatchObject({
      statusCode: 503,
      recheck: "confirmed",
      recheckStatusCode: 503,
      recheckFetchClass: "server_error",
    });
  });

  it("fired the transient rule on nothing at all", () => {
    // THE NEGATIVE THAT PROVES THE SPLIT DOES NOT LEAK. `http.server-error` and
    // `http.server-error-transient` are mutually exclusive and jointly
    // exhaustive over `fetch_class = 'server_error'` (§3.1), so on a site whose
    // only 5xx is confirmed the transient rule must be silent — on every
    // fixture, on the hub, and site-wide. If it ever speaks here it is because
    // the predicate reads a confirmed outage as a cleared one, and the finding
    // would be a `warning` where a `critical` belongs.
    //
    // The `SKIP_HARNESS_CLAIMS` sweep above asserts the same silence from the
    // other direction (an exempted rule that fires must leave the list); this
    // one says WHICH SITE it is silent on and why that is the right answer
    // rather than a missing fixture.
    for (const [path, ids] of issuesByPath) {
      expect([...ids], path).not.toContain("http.server-error-transient");
    }
    expect([...siteFindings.keys()]).not.toContain("http.server-error-transient");
  });
});
