/**
 * The Phase 26a calibration: Screaming Frog and Ariadne crawl the same fixture
 * site, and the two tools' findings are compared filter by filter.
 *
 * BLACK BOX. Everything this script knows about Screaming Frog is what the SEO
 * Spider's own command line prints and exports when it crawls pages WE wrote:
 * the CSV a filter exports, the issue names its Issues Overview report lists,
 * the columns of its Internal tab. Nothing here reads, or was written from, the
 * SEO Spider's code, its jars or its configuration files (CLAUDE.md rule 8).
 * The SEO Spider runs at the configuration it starts with when given no
 * `--config`, and this script never passes one.
 *
 *   DATABASE_URL=… npx tsx scripts/calibrate-sf.ts
 *   DATABASE_URL=… npx tsx scripts/calibrate-sf.ts --report-only <run dir>
 *   DATABASE_URL=… npx tsx scripts/calibrate-sf.ts --resume-ariadne <run dir>
 *   DATABASE_URL=… npx tsx scripts/calibrate-sf.ts --sf-config <sf-run>/config/<file>.json
 *
 * `--sf-config` passes a SEO Spider configuration file (its JSON format) as
 * `--config`. The file must live under the ignored `sf-run/` workspace and is
 * never committed; the gate doc describes what it changes
 * (`SF_CONFIG_DESCRIPTION`). The script confirms from the SEO Spider's own log
 * that it loaded the file, and records the analysis setting it ran with
 * (`autoAnalyseFromLog`).
 *
 * The full run:
 *
 *  1. starts the fixture site with every harness fixture AND the calibration
 *     ladders (test/fixtures/pages/calibration-p26.ts), plus the two helper
 *     origins the harness fixtures need;
 *  2. crawls it with the SEO Spider headless, exporting every filter in
 *     `SF_FILTERS` and the data tabs in `SF_DATA_TABS`, into a fresh run
 *     directory under the git-ignored workspace (`CALIBRATE_OUT`, default
 *     below; any path outside it is refused, see `assertUnderSfRun`). A listed filter that produced no export file is a THROW: an
 *     absent file would otherwise read as "SF flags nothing", the silent gap
 *     hard rule 7 forbids;
 *  3. crawls the same site with `runCrawl` and judges it with `runRules`, as
 *     test/fixtures/harness.test.ts does (no render pass: no rule this report
 *     compares reads a rendered column), uncapped so no listing is truncated,
 *     and writes the pages and findings it needs to `ariadne.json` in the run
 *     directory before deleting the crawl;
 *  4. writes docs/gates/phase-26a-calibration.md.
 *
 * `--report-only` repeats step 4 from a run directory a full run left behind;
 * `--resume-ariadne <run dir>` repeats steps 3 and 4 against the Screaming Frog
 * exports a run already holds (its `meta.json` is written as soon as the SEO
 * Spider exits), so a failure after the slow half does not cost it again.
 *
 * Every divergence (a URL one tool lists under a mapped filter and the other
 * does not) must carry a reason from `REASONS`. One that does not is written
 * into the report as UNEXPLAINED and the script exits non-zero after writing
 * it, so an unexplained divergence cannot reach a green gate.
 */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import { closeFetchAgents } from "../src/crawl/http.js";
import { runCrawl, type CrawlConfig } from "../src/crawl/loop.js";
import { closeDb, createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { crawls, issues, pages } from "../src/db/schema.js";
import { buildRegistry } from "../src/rules/index.js";
import { RULESET_VERSION } from "../src/rules/registry/registry.js";
import { runRules } from "../src/rules/run.js";
import { serpWidth } from "../src/rules/serp-width.js";
import * as T from "../src/rules/thresholds.js";
import { startFixtureApp } from "../test/fixtures/app.js";
import { startAssetHost } from "../test/fixtures/assets.js";
import { allFixtures } from "../test/fixtures/fixture.js";
import {
  CALIBRATION_PREFIX,
  DEPTH_CHAIN_LENGTH,
  EXTERNAL_OUTLINK_LADDER,
  INTERNAL_OUTLINK_LADDER,
  OUTLINK_TARGET_PATH,
  RESPONSE_TIME_LADDER,
  calibrationFixtures,
} from "../test/fixtures/pages/calibration-p26.js";
import { startOffsiteHost } from "../test/fixtures/pages/render-p5.js";
import { LOCAL_TENANT } from "../src/api/tenant.js";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_OUT = join(
  REPO,
  ".superpowers/sdd/2026-11-05-phase-26a-rules-over-existing-data/sf-run",
);
const REPORT_PATH = join(REPO, "docs/gates/phase-26a-calibration.md");

/**
 * Refuse any output or run directory outside the git-ignored `sf-run/`
 * workspace. Screaming Frog's exports must never land where `git add` could
 * pick them up (licence hygiene, CLAUDE.md rule 8), so the path is checked
 * twice: it must be `DEFAULT_OUT` or below it, and git must say it is ignored.
 * Exported for the test.
 */
export function assertUnderSfRun(path: string): string {
  const abs = resolve(path);
  if (abs !== DEFAULT_OUT && !abs.startsWith(`${DEFAULT_OUT}${sep}`)) {
    throw new Error(`refusing ${abs}: calibration output must live under ${DEFAULT_OUT}`);
  }
  try {
    execFileSync("git", ["-C", REPO, "check-ignore", "-q", abs], { stdio: "ignore" });
  } catch {
    throw new Error(`refusing ${abs}: git does not ignore it, so Screaming Frog exports there could be committed`);
  }
  return abs;
}
const SF_BIN = "screamingfrogseospider";
const SF_TASK_NAME = "ariadne-calibration-26a";
/** Generous: the crawl is ~1,400 local URLs plus ~100 external checks. */
const SF_TIMEOUT_MS = 45 * 60_000;

// ----------------------------------------------------------------- the table

type Family =
  | "security"
  | "resources"
  | "directives"
  | "canonical"
  | "hreflang"
  | "pagination"
  | "links"
  | "url"
  | "sitemap"
  | "pixel"
  | "threshold";

interface SfFilter {
  /** `Tab:Filter` for `--export-tabs`, or `Report` / `Submenu:Report` for `--save-report`. */
  name: string;
  kind: "tab" | "report";
  /** The export file, when it is not the filter name's slug (reports are named irregularly). */
  file?: string;
  ruleIds: readonly string[];
  family: Family;
  /**
   * Why this filter cannot be compared on the fixture site at all, when it
   * cannot. The comparison is still run and printed, so the claim is visible.
   */
  notCalibratable?: string;
  /**
   * Which URL of an Ariadne finding names the same thing the filter lists,
   * when that is not the page the finding is on: Screaming Frog lists a
   * mistyped stylesheet itself, Ariadne lists the page that loads it and
   * names the stylesheet in the evidence. Default: the finding's page.
   */
  ariadneSubject?: (details: Record<string, unknown>) => string;
}

/** HTTPS-only: the fixture site is plain HTTP on 127.0.0.1 (plan deviation 1). */
const HTTPS_ONLY =
  "HTTPS-only rule: the fixture site is plain HTTP on 127.0.0.1, so Ariadne's rule has no cohort here by design (plan deviation 1). Proven by DB tests; checked by hand on the lavishalice re-judge.";

export const SF_FILTERS: readonly SfFilter[] = [
  // security + resources
  { name: "Security:Missing HSTS Header", kind: "tab", ruleIds: ["security.hsts-missing"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:Missing Content-Security-Policy Header", kind: "tab", ruleIds: ["security.headers-missing"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:Missing X-Content-Type-Options Header", kind: "tab", ruleIds: ["security.headers-missing"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:Missing X-Frame-Options Header", kind: "tab", ruleIds: ["security.headers-missing"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:Missing Secure Referrer-Policy Header", kind: "tab", ruleIds: ["security.headers-missing"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:HTTP URLs", kind: "tab", ruleIds: ["security.http-url"], family: "security", notCalibratable: HTTPS_ONLY },
  { name: "Security:Mixed Content", kind: "tab", ruleIds: ["security.mixed-content"], family: "security", notCalibratable: HTTPS_ONLY },
  {
    name: "Security:Bad Content Type",
    kind: "tab",
    ruleIds: ["resources.bad-content-type"],
    family: "resources",
    ariadneSubject: (d) => {
      if (typeof d["resourceUrl"] !== "string") throw new Error("resources.bad-content-type finding has no resourceUrl");
      return d["resourceUrl"];
    },
  },
  // directives
  { name: "Directives:Nofollow", kind: "tab", ruleIds: ["indexability.nofollow"], family: "directives" },
  { name: "Directives:None", kind: "tab", ruleIds: ["indexability.nofollow"], family: "directives" },
  { name: "Directives:NoSnippet", kind: "tab", ruleIds: ["directives.restrictive"], family: "directives" },
  { name: "Directives:Max-Snippet", kind: "tab", ruleIds: ["directives.restrictive"], family: "directives" },
  { name: "Directives:Max-Image-Preview", kind: "tab", ruleIds: ["directives.restrictive"], family: "directives" },
  { name: "Directives:NoImageIndex", kind: "tab", ruleIds: ["directives.restrictive"], family: "directives" },
  { name: "Directives:Unavailable_After", kind: "tab", ruleIds: ["directives.unavailable-after"], family: "directives" },
  // canonical
  { name: "Canonicals:Canonical Is Relative", kind: "tab", ruleIds: ["canonical.relative"], family: "canonical" },
  { name: "Canonicals:Contains Fragment URL", kind: "tab", ruleIds: ["canonical.fragment"], family: "canonical" },
  {
    name: "Canonicals:Unlinked",
    kind: "tab",
    ruleIds: ["canonical.unlinked"],
    family: "canonical",
    // Screaming Frog lists the unlinked canonical TARGET; Ariadne's finding is
    // on the page that declares it and names the target in `resolvedTo`.
    ariadneSubject: (d) => {
      if (typeof d["resolvedTo"] !== "string") throw new Error("canonical.unlinked finding has no resolvedTo");
      return d["resolvedTo"];
    },
  },
  { name: "Canonicals:Canonical Chains", kind: "report", file: "canonical_chains.csv", ruleIds: ["canonical.chain"], family: "canonical" },
  // hreflang
  { name: "Hreflang:Inconsistent Language & Region Return Links", kind: "tab", ruleIds: ["hreflang.inconsistent-return-code"], family: "hreflang" },
  { name: "Hreflang:Multiple Entries", kind: "tab", ruleIds: ["hreflang.multiple-entries"], family: "hreflang" },
  { name: "Hreflang:Self Reference Only", kind: "tab", ruleIds: ["hreflang.self-only"], family: "hreflang" },
  { name: "Hreflang:Unlinked hreflang URLs", kind: "tab", ruleIds: ["hreflang.unlinked-target"], family: "hreflang" },
  // pagination
  { name: "Pagination:Non-200 Pagination URLs", kind: "tab", ruleIds: ["pagination.non-indexable-target"], family: "pagination" },
  { name: "Pagination:Non-Indexable", kind: "tab", ruleIds: ["pagination.non-indexable-target"], family: "pagination" },
  { name: "Pagination:Pagination Loop", kind: "tab", ruleIds: ["pagination.loop"], family: "pagination" },
  { name: "Pagination:Sequence Error", kind: "tab", ruleIds: ["pagination.sequence-error"], family: "pagination" },
  // links
  { name: "Links:Internal Nofollow Outlinks", kind: "tab", ruleIds: ["links.internal-nofollow"], family: "links" },
  { name: "Links:Non-Indexable Page Inlinks Only", kind: "tab", ruleIds: ["links.only-from-non-indexable"], family: "links" },
  { name: "Links:Outlinks To Localhost", kind: "tab", ruleIds: ["links.localhost"], family: "links" },
  { name: "Links:Non-Descriptive Anchor Text In Internal Outlinks", kind: "tab", ruleIds: ["links.non-descriptive-anchor"], family: "links" },
  { name: "Links:Pages With High Internal Outlinks", kind: "tab", ruleIds: ["links.high-outlinks"], family: "links" },
  { name: "Links:Pages With High External Outlinks", kind: "tab", ruleIds: ["links.high-outlinks"], family: "links" },
  // url
  { name: "URL:Uppercase", kind: "tab", ruleIds: ["url.uppercase"], family: "url" },
  { name: "URL:Underscores", kind: "tab", ruleIds: ["url.underscores"], family: "url" },
  { name: "URL:Non ASCII Characters", kind: "tab", ruleIds: ["url.non-ascii"], family: "url" },
  { name: "URL:Contains Space", kind: "tab", ruleIds: ["url.spaces"], family: "url" },
  { name: "URL:Multiple Slashes", kind: "tab", ruleIds: ["url.multiple-slashes"], family: "url" },
  { name: "URL:Repetitive Path", kind: "tab", ruleIds: ["url.repetitive-path"], family: "url" },
  { name: "URL:Internal Search", kind: "tab", ruleIds: ["url.internal-search"], family: "url" },
  // sitemap
  { name: "Sitemaps:XML Sitemap with over 50k URLs", kind: "tab", ruleIds: ["sitemap.over-50k-urls"], family: "sitemap" },
  // pixel width
  { name: "Page Titles:Over X Pixels", kind: "tab", ruleIds: ["title.pixel-too-long"], family: "pixel" },
  { name: "Page Titles:Below X Pixels", kind: "tab", ruleIds: ["title.pixel-too-short"], family: "pixel" },
  { name: "Meta Description:Over X Pixels", kind: "tab", ruleIds: ["meta-description.pixel-too-long"], family: "pixel" },
  { name: "Meta Description:Below X Pixels", kind: "tab", ruleIds: ["meta-description.pixel-too-short"], family: "pixel" },
  // the thresholds this calibration reads, and the one it keeps
  { name: "Links:Pages With High Crawl Depth", kind: "tab", ruleIds: ["structure.deep-page"], family: "threshold" },
  { name: "Content:Low Content Pages", kind: "tab", ruleIds: ["content.thin"], family: "threshold" },
];

/** Exports read for the ladders' measured values, not compared as findings. */
const SF_DATA: readonly SfFilter[] = [
  { name: "Internal:HTML", kind: "tab", ruleIds: [], family: "threshold" },
  { name: "Page Titles:All", kind: "tab", ruleIds: [], family: "pixel" },
  { name: "Meta Description:All", kind: "tab", ruleIds: [], family: "pixel" },
  { name: "Issues Overview:All Issues", kind: "report", file: "issues_overview_report_all.csv", ruleIds: [], family: "threshold" },
];

/**
 * The 40 rules Phase 26a added. Each is either compared through `SF_FILTERS`
 * or listed in `NO_COUNTERPART` with the reason; the script throws if one is
 * neither, so a 26a rule cannot be left out of the calibration silently.
 */
const P26A_RULES = [
  "security.hsts-missing", "security.headers-missing", "security.headers-not-recorded",
  "security.http-url", "security.mixed-content", "resources.bad-content-type",
  "indexability.nofollow", "directives.restrictive", "directives.unavailable-after",
  "canonical.relative", "canonical.fragment", "canonical.chain", "canonical.unlinked",
  "hreflang.inconsistent-return-code", "hreflang.multiple-entries", "hreflang.self-only",
  "hreflang.unlinked-target", "pagination.non-indexable-target", "pagination.loop",
  "pagination.sequence-error", "links.internal-nofollow", "links.only-from-non-indexable",
  "links.localhost", "links.non-descriptive-anchor", "links.high-outlinks", "url.uppercase",
  "url.underscores", "url.non-ascii", "url.spaces", "url.multiple-slashes",
  "url.repetitive-path", "url.internal-search", "sitemap.over-50k-urls",
  "sitemap.url-too-long", "sitemap.cross-host-loc", "sitemap.lastmod-invalid",
  "title.pixel-too-long", "title.pixel-too-short", "meta-description.pixel-too-long",
  "meta-description.pixel-too-short",
] as const;

const NO_COUNTERPART: Record<string, string> = {
  "security.headers-not-recorded":
    "A marker about OUR data (a crawl stored before response headers were recorded). Screaming Frog has no notion of a crawl written by an older extractor, so there is nothing to compare.",
  "sitemap.url-too-long":
    "Screaming Frog 25.1 has no filter for an over-long `<loc>` (no such tab filter in `--help export-tabs` and no such issue in its Issues Overview), and at its default configuration it does not read XML sitemaps at all.",
  "sitemap.cross-host-loc":
    "No Screaming Frog filter for a `<loc>` on another host (none in `--help export-tabs` or the Issues Overview), and its default configuration does not read XML sitemaps.",
  "sitemap.lastmod-invalid":
    "No Screaming Frog filter for an invalid `<lastmod>` (none in `--help export-tabs` or the Issues Overview), and its default configuration does not read XML sitemaps.",
};

/**
 * Why a URL one tool lists and the other does not is not a defect. Keyed by
 * filter name; each entry matches URL keys (path + sorted query on the fixture
 * origin, the full URL elsewhere) on one side. `"*"` matches every key.
 */
interface Reason {
  side: "sf-only" | "ariadne-only";
  /**
   * Set on a reason that records an OWNER DECISION rather than a measurement or
   * design difference; the summary row then says so instead of "explained".
   */
  status?: "owner-decided";
  /** A key pattern, every key (`"*"`), or a test on the key and both tools' data. */
  match: RegExp | "*" | ((key: string, ctx: ReasonContext) => boolean);
  reason: string;
}

/**
 * What a reason may consult: Screaming Frog's data and Ariadne's, so a reason
 * states a fact the run CHECKS rather than one it assumes. Exported so the
 * predicates can be tested against a hand-built context.
 */
export interface ReasonContext {
  /** Whether the SEO Spider's post-crawl analysis ran (its own log line, `RunMeta.autoAnalyse`). */
  autoAnalyse: boolean;
  /** The `--sf-config` file the SEO Spider ran with, parsed, or null on its starting configuration. */
  sfConfig: Record<string, Record<string, unknown>> | null;
  /** The scheme of the crawled fixture site, `http:` or `https:`. */
  siteScheme: string;
  /** Rows in THIS filter's Screaming Frog export (the context is per filter). */
  sfRowCount: number;
  /** Screaming Frog's `Internal:HTML` row for the key, projected (see `readExport`). */
  sf(key: string): Record<string, string> | undefined;
  /** Screaming Frog's own pixel width of the key's title or description, or null. */
  sfWidth(kind: "title" | "description", key: string): number | null;
  /** `serpWidth` of the title or description Ariadne stored for the key, or null. */
  ourWidth(kind: "title" | "description", key: string): number | null;
  /** Whether Ariadne wrote a finding of this rule for the key. */
  fired(ruleId: string, key: string): boolean;
  /** The evidence of Ariadne's finding of this rule on the key, or undefined. */
  details(ruleId: string, key: string): Record<string, unknown> | undefined;
  /** How Ariadne's crawl found the key (`pages.discovered_via`: seed, link, sitemap, redirect), or undefined. */
  ourDiscoveredVia(key: string): string | undefined;
}

/** The largest |SF width − serpWidth| a title divergence may show and still be "the measure" (ladder: 0–12 px). */
export const TITLE_WIDTH_GAP_PX = 12;
/** …and a description divergence (ladder: within 2 px, SF in whole pixels). */
export const META_WIDTH_GAP_PX = 2;

/**
 * Whether a pixel-filter divergence is the measurement difference and nothing
 * else: both tools measured the string, each tool's verdict is the one its OWN
 * width gives against the bound (strict, as both filters are), they disagree
 * only because the bound lies between the two widths, and the widths are no
 * further apart than the ladder showed. A `serpWidth` regression moves our
 * width away from SF's and fails the gap test, so it is not explained away.
 */
export function measureExplains(
  kind: "title" | "description",
  bound: number,
  dir: "over" | "below",
  side: Reason["side"],
  key: string,
  ctx: ReasonContext,
): boolean {
  const sfw = ctx.sfWidth(kind, key);
  const ours = ctx.ourWidth(kind, key);
  if (sfw === null || ours === null) return false;
  const flags = (w: number): boolean => (dir === "over" ? w > bound : w < bound);
  const consistent = side === "sf-only" ? flags(sfw) && !flags(ours) : !flags(sfw) && flags(ours);
  const gap = kind === "title" ? TITLE_WIDTH_GAP_PX : META_WIDTH_GAP_PX;
  return consistent && Math.abs(sfw - ours) <= gap;
}

/** A reason that holds only when this filter's Screaming Frog export has no rows at all. */
export const sfExportEmpty = (_key: string, ctx: ReasonContext): boolean => ctx.sfRowCount === 0;

/**
 * "The analysis did not run": the export is empty AND the SEO Spider's own log
 * says the post-crawl analysis was off. On an analysis-on run it never holds,
 * so an empty export there needs a reason of its own.
 */
export const analysisOffAndEmpty = (key: string, ctx: ReasonContext): boolean =>
  !ctx.autoAnalyse && sfExportEmpty(key, ctx);

/** The SEO Spider never fetched this URL: it has no row in its Internal export. */
const sfNeverFetched = (key: string, ctx: ReasonContext): boolean => ctx.sf(key) === undefined;

/** A reason that holds only on a plain-HTTP crawl, where the HTTPS-only rules have no cohort. */
const httpSite = (_key: string, ctx: ReasonContext): boolean => ctx.siteScheme === "http:";

/**
 * Screaming Frog's crawl analysis did not run. Its startup log prints the
 * configuration it runs with, and that line reads `mAutoAnalyse=false`; the
 * CLI has no option to run the analysis, and the brief forbids a custom
 * `--config`. The filters given this reason came back EMPTY although the
 * fixture site has pages with the condition (and, for crawl depth, pages
 * more than a thousand links deep), which is what a filter populated only by
 * that analysis looks like from outside. Black box: that is an inference from
 * the output, not a reading of how the SEO Spider works.
 */
/**
 * Thresholds where the owner chose a value other than Screaming Frog's
 * boundary. Each entry records the boundary the ladder showed and the value
 * kept, so the verdict and the reason are CHECKED against the run: if Screaming
 * Frog's boundary moves, or the constant moves, the run reports a MISMATCH or an
 * unexplained divergence rather than reusing this entry.
 */
export const OWNER_THRESHOLDS: Record<string, { sfLastClear: number; kept: number; decided: string }> = {
  DEEP_DEPTH: { sfLastClear: 3, kept: 5, decided: "2026-11-06" },
};

/** The fixture page with the site's one EXTERNAL private-address link (authored-p26.ts). */
const PRIVATE_HOST_LINK_PATH = "/authored26/private-host-link";

const ANALYSIS_OFF =
  "Screaming Frog's export is empty although the fixture has the condition. Its startup log reports `mAutoAnalyse=false`: the post-crawl analysis did not run at the configuration it starts with, and this filter is one it leaves empty without it (inferred from the output). Not calibratable at this configuration; see the controller decisions.";

/**
 * The canonical trap: `/index/canonical-conflict` (absorbed.ts) declares its
 * canonical as its own URL plus `?via=html`, so every canonical target names a
 * deeper one. A crawler that fetches canonical targets walks it without end;
 * Screaming Frog did, to a crawl depth over a thousand. Its URLs are kilobytes
 * long, so lists fold them to a count.
 */
const CANONICAL_TRAP_KEY = /^\/index\/canonical-conflict\?via=/;

/** The fixture's canonical trap: URLs Ariadne never fetched. */
const TRAP =
  "A URL of the canonical trap: `/index/canonical-conflict` declares its canonical as its own URL plus `?via=html`, so each canonical target names a deeper one. Screaming Frog fetches canonical targets and walked the trap over a thousand deep; Ariadne discovers URLs from links and sitemaps, not from canonical targets, so it never fetched one. A fixture artefact (absorbed.ts, `canonicalConflict`), not a rule difference.";

const TITLE_MEASURE =
  "Width measurement, not the bound (checked per URL): both tools measured this title, each tool's verdict is the one its own width gives against the same bound (561 / 200), the bound lies between the two widths, and they differ by no more than 12 px. Screaming Frog's title widths run 0–12 px wider than `serpWidth` on the ladder (the gap tracks wide letters such as `m`). Our glyph table is measured by us in Chromium at 20px Arial (spec: nothing copied).";

const META_ROUNDING =
  "Measurement at the bound (checked per URL): both tools measured this description, each tool's verdict is the one its own width gives against the same bound (985 / 400), the bound lies between the two widths, and they differ by no more than 2 px. Screaming Frog reports description widths in whole pixels; ours is to one decimal (985.1 > 985, 399.1 < 400 on the ladder).";

const HTTPS_DESIGN =
  "Screaming Frog reports this on every page of a plain-HTTP site. Ariadne judges security headers only on pages fetched over https: (a plain-HTTP page cannot send HSTS, and on an http: site the missing HTTPS is the finding), and `security.http-url` only on an https: site, where an HTTPS page's link to an http: URL on the site's own host is the downgrade (on an http: site every internal link is http:). HTTPS-only by design (plan deviation 1).";

export const REASONS: Record<string, readonly Reason[]> = {
  "Security:Missing Content-Security-Policy Header": [{ side: "sf-only", match: httpSite, reason: HTTPS_DESIGN }],
  "Security:Missing X-Content-Type-Options Header": [{ side: "sf-only", match: httpSite, reason: HTTPS_DESIGN }],
  "Security:Missing X-Frame-Options Header": [{ side: "sf-only", match: httpSite, reason: HTTPS_DESIGN }],
  "Security:Missing Secure Referrer-Policy Header": [{ side: "sf-only", match: httpSite, reason: HTTPS_DESIGN }],
  "Security:HTTP URLs": [{ side: "sf-only", match: httpSite, reason: HTTPS_DESIGN }],
  "Canonicals:Canonical Is Relative": [
    { side: "sf-only", match: CANONICAL_TRAP_KEY, reason: TRAP },
    {
      side: "sf-only",
      match: /^\/authored\/canonical-multiple$/,
      reason:
        "The page has two canonical tags; the second (`/control`) is relative and is what Screaming Frog flags. Ariadne keeps the FIRST canonical (absolute, self-referential) as `canonical_html` and reports the page as `canonical.multiple` (critical), which is the finding that matters: a search engine ignores both tags.",
    },
    {
      side: "sf-only",
      match: /^\/index\/canonical-conflict$/,
      reason:
        "The relative canonical is in the HTTP `Link` header (`</index/canonical-conflict?via=header>`). `canonical.relative` judges the raw HTML `<link rel=canonical>` (spec: \"raw `canonical_html` is relative\"); a relative Link-header target is resolved against the request URL (RFC 8288), and this page is reported for the HTML/header disagreement as `canonical.html-header-conflict`.",
    },
  ],
  "Canonicals:Unlinked": [
    { side: "ariadne-only", match: analysisOffAndEmpty, reason: ANALYSIS_OFF },
    {
      side: "sf-only",
      match: CANONICAL_TRAP_KEY,
      reason:
        "A canonical target of the canonical trap. Screaming Frog crawls canonical targets and lists each unlinked one; Ariadne does not enqueue canonical targets, so it never fetched these, and `canonical.unlinked` judges only a target it crawled as an auditable page (the first, `?via=html`, is the canonical of `/index/canonical-conflict`, which Ariadne reports as `canonical.points-elsewhere` and `canonical.html-header-conflict`). Crawl scope, not the rule.",
    },
  ],
  "Canonicals:Canonical Chains": [
    { side: "sf-only", match: CANONICAL_TRAP_KEY, reason: TRAP },
    {
      side: "sf-only",
      match: /^\/authored\/canonical-multiple$/,
      reason:
        "Two canonical tags. Screaming Frog's chain report follows the page's second canonical (`/control`); Ariadne keeps the first, which names the page itself, so there is no chain to walk, and reports the page as `canonical.multiple` (critical).",
    },
    {
      side: "sf-only",
      match: /^\/index\/canonical-conflict$/,
      reason:
        "The HTML canonical names `?via=html`, a URL no `<a>` links. Ariadne does not enqueue canonical targets, so the target was never fetched and the walk has no second hop to read; Screaming Frog fetches canonical targets and found the chain (the trap above). The page is reported as `canonical.points-elsewhere` and `canonical.html-header-conflict`. Crawl scope, not the rule.",
    },
  ],
  "Hreflang:Self Reference Only": [
    {
      side: "ariadne-only",
      // Checked: the analysis ran, the filter works (it lists other pages), SF
      // crawled this page, and our evidence shows a SECOND self annotation
      // (`x-default`) beside the language code.
      match: (k, ctx) => {
        const codes = ctx.details("hreflang.self-only", k)?.["hreflang"];
        return (
          ctx.autoAnalyse &&
          ctx.sfRowCount > 0 &&
          ctx.sf(k) !== undefined &&
          Array.isArray(codes) &&
          codes.length > 1 &&
          codes.includes("x-default")
        );
      },
      reason:
        "Definition difference, shown by a probe: Screaming Frog lists `/calib26/hreflang/self-only-single` (ONE alternate, `en`, to itself) and not this page, whose alternates are `en` AND `x-default`, both to itself. It counts a page with a self `x-default` beside its self language code as more than self-reference only. `hreflang.self-only` reports any page whose only hreflang TARGET is itself, whatever codes name it, since such a page offers no alternate either way. Flagged for the controller; the rule is unchanged.",
    },
    {
      side: "ariadne-only",
      match: analysisOffAndEmpty,
      reason:
        "Screaming Frog's export is empty. The fixture's alternates (`en` and `x-default`) both name the page itself. Either its definition does not count an `x-default` to self as self-reference only, or the filter needs the post-crawl analysis that did not run (`mAutoAnalyse=false`); black-box, the two cannot be told apart at this configuration.",
    },
  ],
  "Hreflang:Unlinked hreflang URLs": [
    { side: "ariadne-only", match: analysisOffAndEmpty, reason: ANALYSIS_OFF },
    {
      side: "ariadne-only",
      // Checked: SF has no Internal row for the URL; Ariadne's crawl reached it
      // through the sitemap (`pages.discovered_via`); and the configuration SF
      // ran with follows neither of the other two paths to it.
      match: (k, ctx) =>
        ctx.autoAnalyse &&
        sfNeverFetched(k, ctx) &&
        ctx.ourDiscoveredVia(k) === "sitemap" &&
        ctx.sfConfig?.["crawlConfig"]?.["crawlHreflang"] === false &&
        ctx.sfConfig?.["crawlConfig"]?.["crawlSitemaps"] === false,
      reason:
        "Screaming Frog never fetched this URL (it has no row in its Internal export). No `<a>` on the site links it; it is named by an hreflang annotation and listed in the sitemap. Ariadne's crawl reached it through the sitemap (`discovered_via` = `sitemap`): Ariadne does not enqueue hreflang targets, only links, redirects, the seed and sitemap entries. The configuration the SEO Spider ran with has `crawlConfig.crawlHreflang` = `false` and `crawlConfig.crawlSitemaps` = `false`, so it had no path to the page and cannot list an unlinked hreflang URL it never crawled. Crawl scope, not the rule.",
    },
  ],
  "Pagination:Non-Indexable": [
    {
      side: "sf-only",
      match: (k, ctx) => ctx.fired("pagination.canonical-to-other", k),
      reason:
        "Screaming Frog lists the series page that is itself non-indexable (canonicalised to page 1). `pagination.non-indexable-target` is about a rel=next/prev TARGET that is non-200 or noindex; a series page canonicalised to another is reported by `pagination.canonical-to-other`, which fires on this URL.",
    },
  ],
  "Pagination:Pagination Loop": [{ side: "ariadne-only", match: analysisOffAndEmpty, reason: ANALYSIS_OFF }],
  "Pagination:Sequence Error": [
    {
      side: "sf-only",
      match: (k, ctx) => ctx.fired("pagination.non-indexable-target", k),
      reason:
        "The page's rel=next target answers 404, so there is no rel=prev to compare. Ariadne reports it as `pagination.non-indexable-target` (fires here) and `pagination.sequence-error` skips a target it cannot audit, so one defect is one finding.",
    },
    {
      side: "sf-only",
      match: /^\/authored26\/sequence-b$/,
      reason:
        "Screaming Frog also checks the REVERSE direction: this page's rel=prev names `/`, and `/` declares no rel=next back to it. `pagination.sequence-error` checks one direction — A's next is B, and B's prev is not A (the spec's definition) — and reports the pair once, on A (`/authored26/sequence-a`, in both). Design difference; whether to add the reverse check is a controller decision.",
    },
  ],
  "Links:Non-Indexable Page Inlinks Only": [{ side: "ariadne-only", match: analysisOffAndEmpty, reason: ANALYSIS_OFF }],
  "Links:Outlinks To Localhost": [
    {
      side: "sf-only",
      // Every SF-only page EXCEPT the one page whose external private link
      // Ariadne must report: a miss there is a defect, never this reason.
      match: (k) => k !== PRIVATE_HOST_LINK_PATH,
      reason:
        "The fixture site itself is served on 127.0.0.1, so Screaming Frog lists every page that links anywhere on its own (loopback) host. `links.localhost` reads EXTERNAL links only (plan deviation 7): a site crawled on a private address does not report itself. The one external private-address link on the site (`/authored26/private-host-link`, to 10.1.2.3) is in both.",
    },
  ],
  "URL:Underscores": [
    {
      side: "sf-only",
      match: (k) => k.includes("?") && !k.split("?")[0]!.includes("_"),
      reason:
        "The underscore is in the query string (`utm_source`), not the path. The `url.*` rules judge the path only (review focus 5); a tracking parameter on an internal URL is `url.tracking-params-internal`'s finding.",
    },
  ],
  "Page Titles:Over X Pixels": [
    { side: "sf-only", match: (k, ctx) => measureExplains("title", T.TITLE_PX_MAX, "over", "sf-only", k, ctx), reason: TITLE_MEASURE },
    { side: "ariadne-only", match: (k, ctx) => measureExplains("title", T.TITLE_PX_MAX, "over", "ariadne-only", k, ctx), reason: TITLE_MEASURE },
  ],
  "Page Titles:Below X Pixels": [
    {
      side: "sf-only",
      match: (k, ctx) => ctx.fired("page.html-too-large", k),
      reason:
        "A document over the 2 MiB body cap: Ariadne keeps no body for it (`page.html-too-large` fires here), so it has no title to measure. Screaming Frog read a title from it.",
    },
    { side: "sf-only", match: (k, ctx) => measureExplains("title", T.TITLE_PX_MIN, "below", "sf-only", k, ctx), reason: TITLE_MEASURE },
    { side: "ariadne-only", match: (k, ctx) => measureExplains("title", T.TITLE_PX_MIN, "below", "ariadne-only", k, ctx), reason: TITLE_MEASURE },
  ],
  "Meta Description:Over X Pixels": [
    { side: "sf-only", match: (k, ctx) => measureExplains("description", T.META_PX_MAX, "over", "sf-only", k, ctx), reason: META_ROUNDING },
    { side: "ariadne-only", match: (k, ctx) => measureExplains("description", T.META_PX_MAX, "over", "ariadne-only", k, ctx), reason: META_ROUNDING },
  ],
  "Meta Description:Below X Pixels": [
    { side: "sf-only", match: (k, ctx) => measureExplains("description", T.META_PX_MIN, "below", "sf-only", k, ctx), reason: META_ROUNDING },
    { side: "ariadne-only", match: (k, ctx) => measureExplains("description", T.META_PX_MIN, "below", "ariadne-only", k, ctx), reason: META_ROUNDING },
  ],
  "Links:Pages With High Crawl Depth": [
    { side: "ariadne-only", match: analysisOffAndEmpty, reason: ANALYSIS_OFF },
    {
      side: "sf-only",
      status: "owner-decided",
      // Checked: SF's own crawl depth for the URL lies between the boundary it
      // showed and the value the owner kept, the constant IS the kept value, and
      // Ariadne did not report the page.
      match: (k, ctx) => {
        const owner = OWNER_THRESHOLDS["DEEP_DEPTH"]!;
        const depth = Number(ctx.sf(k)?.["Crawl Depth"]);
        return (
          ctx.autoAnalyse &&
          T.DEEP_DEPTH === owner.kept &&
          Number.isInteger(depth) &&
          depth > owner.sfLastClear &&
          depth <= owner.kept &&
          !ctx.fired("structure.deep-page", k)
        );
      },
      reason:
        "Threshold difference, owner-decided (2026-11-06): Screaming Frog flags a page more than 3 links deep, ours more than 5 (`DEEP_DEPTH`). This page is 4 or 5 links deep by Screaming Frog's own crawl depth, which equals our click depth on the ladder, so only the threshold separates the two tools. The owner kept 5 as a product choice.",
    },
    { side: "sf-only", match: CANONICAL_TRAP_KEY, reason: TRAP },
  ],
  "Content:Low Content Pages": [
    {
      side: "sf-only",
      match: (k, ctx) => {
        const words = Number(ctx.sf(k)?.["Word Count"]);
        return words >= T.THIN_WORDS && words < 200;
      },
      reason:
        "Screaming Frog counts 150–199 words on this page. Its low-content floor is 200 words of the whole page (observed: every page it lists has at most 199, every indexable page it does not list has at least 200); ours is `THIN_WORDS` (150) words of MAIN content, template-aware by design, and the spec keeps it.",
    },
    {
      side: "sf-only",
      match: (k, ctx) => ctx.fired("crawl.unreadable-encoding", k) || ctx.fired("page.html-too-large", k),
      reason:
        "Ariadne kept no readable body for this URL — a content-coding it did not ask for (`crawl.unreadable-encoding`) or a document over the 2 MiB cap (`page.html-too-large`), both of which fire here — so it has no word count to judge. Screaming Frog decoded or truncated it and counted what it read.",
    },
    {
      side: "sf-only",
      match: /^\/css\/p26-wrong-type\.css$/,
      reason:
        "A stylesheet the fixture serves as `text/html` (the `resources.bad-content-type` fixture). Screaming Frog takes the content type at its word and parses it as a page with almost no words; Ariadne fetches it as a resource of the page that loads it and reports the wrong type, which both tools agree on (Security:Bad Content Type).",
    },
    { side: "sf-only", match: CANONICAL_TRAP_KEY, reason: TRAP },
  ],
};



/**
 * The report's prose sections: what the calibration found that is not a row
 * of a table. Written here, beside the reasons, so a re-run carries them.
 */
/**
 * What the `--sf-config` file is, for the owner to reproduce it. The file is
 * not committed (it is the SEO Spider's, and lives under the git-ignored
 * sf-run/); this sentence is.
 */
const SF_CONFIG_DESCRIPTION =
  "The file is the SEO Spider's own configuration as its MCP server returns it (`--mcp-streamable-http-server`, tool `sf_get_config_spider` with no category, the full JSON), saved unchanged except for ONE setting: `crawlAnalysisConfig.autoAnalyse` from `false` to `true` (Configuration > Crawl Analysis > Auto-analyse at End of Crawl), so the post-crawl analysis runs when the crawl ends. Every other setting, the filter thresholds included, is what the SEO Spider returned. The owner's own settings were not changed (nothing was set over MCP).";

function runNotes(meta: RunMeta): string[] {
  return [
  "## Findings that need a decision",
  "",
  meta.autoAnalyse
    ? "1. **The post-crawl filters, calibrated with Screaming Frog's analysis on.** This run passed `--sf-config` (see The run): the SEO Spider's own configuration with its post-crawl analysis switched on and nothing else changed, and its log confirms `mAutoAnalyse=true`. The six filters that came back empty with the analysis off now read: Pagination Loop and Non-Indexable Page Inlinks Only match exactly; Canonicals:Unlinked matches on the canonical targets both tools judge (the rest is the canonical trap); Pages With High Crawl Depth matches from depth 6 and differs at depths 4 and 5 by an owner-decided threshold (item 5); Hreflang Unlinked differs only because the SEO Spider had no path to the page (crawl scope: it follows neither hreflang annotations nor sitemaps at this configuration, and Ariadne found the page in the sitemap); Hreflang Self Reference Only differs by definition, item 6."
    : "1. **Screaming Frog's post-crawl analysis did not run.** Its startup log reports `mAutoAnalyse=false` at the configuration it starts with, the CLI has no option to run the analysis, and the brief forbids a custom `--config` (and changing the owner's SEO Spider settings). Six mapped filters came back empty although the fixture has the condition: Canonicals:Unlinked, Hreflang:Unlinked hreflang URLs, Pagination:Pagination Loop, Links:Non-Indexable Page Inlinks Only, Links:Pages With High Crawl Depth (empty even at depth 1,000+), and Hreflang:Self Reference Only (which may also be a definition difference). Those five rules and `DEEP_DEPTH` are therefore NOT calibrated by this run. To calibrate them the owner would supply a configuration with crawl analysis on (a saved `.seospiderconfig`, passed as `--config`); the script needs no other change.",
  "2. **`pagination.sequence-error` and a missing rel=prev (carried ruling).** Screaming Frog flags the page whose rel=next target declares NO rel=prev at all (`/calib26/pagination/no-prev-a` is in both lists), so our rule's behaviour on a missing prev matches it; nothing to change. Screaming Frog ALSO checks the reverse direction (B's prev is X, and X's next is not B: `/authored26/sequence-b`, SF only). Ours checks one direction, as the spec defines it (A's next is B, and B's prev is not A), and reports on A. On this fixture the reverse finding is the same defect (B's prev is wrong) seen from B, and ours already reports it on A. The reverse check would additionally catch a page whose rel=prev names a page that does not name it back when NO page names it as next; ours is silent there. Recommendation: leave the rule as the spec defines it; the controller decides whether the reverse direction is worth a second finding.",
  "3. **Title width measure.** Screaming Frog's title widths run 0–12 px wider than `serpWidth` on the ladder's strings (descriptions agree within 2 px). The bounds are the same numbers, so titles within about 12 px of a bound can be flagged by one tool only. Keeping our own measured table is the spec's requirement; no change proposed.",
  "4. **`HIGH_EXTERNAL_OUTLINKS` moved from 100 to 10** (owner confirmed). Screaming Frog's default flags a page with more than 10 unique external outlinks. That is a much busier finding than the starting value (any page with a footer of social links and a few citations); it is info severity.",
  ...(meta.autoAnalyse
    ? [
        "5. **`DEEP_DEPTH` stays 5: owner decision (2026-11-06).** Screaming Frog flags the click-depth ladder from depth 4 and not at depth 3, and its crawl depths on the chain equal ours, so the two tools differ only by threshold: pages 4 and 5 links deep are SF only. The owner kept 5 as a product choice. The script records it in `OWNER_THRESHOLDS` and checks it against every run: if Screaming Frog's boundary or the constant moves, the row turns into a MISMATCH and the pages into unexplained divergences.",
        "6. **`hreflang.self-only` and a self `x-default`.** A probe page whose one alternate (`en`) is itself IS listed by Screaming Frog; the harness fixture, whose alternates `en` and `x-default` are both itself, is not. Ours reports both, because neither page names any other version of itself. Recommendation: keep ours (an `x-default` to self adds no alternate); the controller decides.",
      ]
    : []),
  "",
  "## Notes on the run",
  "",
  "- **HTTPS-only rules** (`security.hsts-missing`, `security.headers-missing`, `security.http-url`, `security.mixed-content`) cannot be calibrated on a plain-HTTP site: Ariadne's rules have no cohort here by design. Screaming Frog reports the header filters and HTTP URLs on every page of an HTTP site, which is a design difference, not a calibration.",
  "- **The canonical trap.** `/index/canonical-conflict` (absorbed from badseo) builds its canonical as its own URL plus `?via=html`, so every canonical target names a deeper one. Screaming Frog fetches canonical targets and walked it over 2,000 URLs and 1,000 levels deep; Ariadne does not enqueue canonical targets and fetched only the page itself. Every trap URL in a divergence list carries that reason. The fixture is unchanged: the harness pins it.",
  "- **Sitemaps.** Screaming Frog's startup log reports `mCrawlSitemaps=false`: at its starting configuration it does not read XML sitemaps, so the sitemap rules have no counterpart and pages reachable only through the sitemap are crawled by Ariadne alone.",
  "- **Screaming Frog's crawl list.** Every run of this script leaves a crawl named `ariadne-calibration-26a` in the SEO Spider's own crawl list (`--list-crawls`; the calibration's development left several, plus `ariadne-trial`, `ariadne-trial-analysis` and `ariadne-mcp-trial`). They are the owner's to delete (`--delete-crawl <id>`); the script does not delete them.",
  "",
  ];
}

// ------------------------------------------------------------------ CSV + keys

/**
 * RFC 4180 CSV, BOM tolerated: the SEO Spider quotes every field.
 *
 * `ragged` admits rows SHORTER than the header, as the SEO Spider's chain
 * reports write them (a two-hop chain stops after its second hop's columns,
 * under a header that names ten); the missing fields read as "". A row LONGER
 * than its header is never admitted.
 */
export function parseCsv(text: string, ragged = false): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (header === undefined) throw new Error("empty CSV: not even a header row");
  return body.map((r) => {
    if (r.length > header.length || (!ragged && r.length !== header.length)) {
      throw new Error(`CSV row has ${r.length} fields, header has ${header.length}: ${r.join(",")}`);
    }
    return Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]));
  });
}

/** The comparison key: path + sorted query on the fixture origin, else the whole URL. */
function keyOf(url: string, origin: string): string {
  const u = new URL(url);
  if (u.origin !== origin) return u.href;
  const params = [...u.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1,
  );
  const search = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  return `${u.pathname}${search}`;
}

/** `Tab:Filter` -> the export's file name pattern (`X` is the configured number). */
function filePattern(f: SfFilter): RegExp {
  if (f.file !== undefined) return new RegExp(`^${f.file.replace(/\./g, "\\.")}$`);
  // As the SEO Spider names its exports (observed): tab and filter joined by
  // "_", each lower-cased with every character that is not a letter, digit or
  // space or underscore dropped ("Non-200" -> "non200", "&" -> nothing,
  // "Unavailable_After" keeps its "_") and runs of spaces
  // turned into one "_".
  const slug = f.name
    .split(":")
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9 _]/g, "")
        .trim()
        .replace(/ +/g, "_"),
    )
    .join("_");
  return new RegExp(`^${slug.replace(/(^|_)x(_|$)/g, "$1(\\d+)$2")}\\.csv$`);
}

interface Export {
  file: string;
  /** The number SF wrote in place of `X`, when the filter has one. */
  configured: number | null;
  rows: Record<string, string>[];
}

/** The one export file a filter wrote, or a throw naming what was found instead. */
function locateExport(f: SfFilter, files: readonly string[]): { file: string; configured: number | null } {
  const pattern = filePattern(f);
  const hits = files.filter((name) => pattern.test(name));
  if (hits.length !== 1) {
    throw new Error(
      `filter "${f.name}" matched ${hits.length} export files (${hits.join(", ") || "none"}) for ${pattern}`,
    );
  }
  const file = hits[0]!;
  const m = pattern.exec(file)!;
  return { file, configured: m[1] === undefined ? null : Number(m[1]) };
}

/** Columns every read keeps: what `sfKey` reads. */
const ADDRESS_COLUMNS = ["Address", "URL Encoded Address"] as const;

const exportCache = new Map<string, Export>();

/**
 * One export, parsed once and kept PROJECTED to the columns asked for. The
 * exports run to tens of megabytes (the canonical trap's URLs are kilobytes
 * each and appear in several columns of every row), and holding every column
 * of every export at once exhausted a 4 GB heap.
 */
function readExport(dir: string, f: SfFilter, files: readonly string[], columns: readonly string[] = []): Export {
  const { file, configured } = locateExport(f, files);
  const keep = [...ADDRESS_COLUMNS, ...columns];
  const cacheKey = `${dir}\n${file}\n${keep.join("\t")}`;
  const cached = exportCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const rows = parseCsv(readFileSync(join(dir, file), "utf8"), f.kind === "report").map((r) => {
    const out: Record<string, string> = {};
    for (const c of keep) if (r[c] !== undefined) out[c] = r[c];
    for (const c of columns) {
      if (r[c] === undefined) throw new Error(`${file} has no column "${c}"`);
    }
    return out;
  });
  const exp = { file, configured, rows };
  exportCache.set(cacheKey, exp);
  return exp;
}

// ------------------------------------------------------------------ the runs

interface AriadnePage {
  key: string;
  url: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  responseTimeMs: number | null;
  clickDepth: number | null;
  /** `pages.discovered_via`: how the crawl found the URL (seed, link, sitemap, redirect). */
  discoveredVia: string;
}
interface AriadneIssue {
  ruleId: string;
  key: string | null;
  details: unknown;
}
interface AriadneResult {
  crawlId: string;
  /** The fixture origin Ariadne crawled (keys are relative to it). */
  base: string;
  pagesCrawled: number;
  rulesetVersion: string;
  pages: AriadnePage[];
  issues: AriadneIssue[];
}
interface RunMeta {
  base: string;
  sfVersion: string;
  sfArgs: string[];
  startedAt: string;
  runDir: string;
  /**
   * The `--config` file the SEO Spider ran with, relative to `sf-run/`, and its
   * sha256; absent when it ran on its starting configuration.
   */
  sfConfig?: { path: string; sha256: string };
  /**
   * Whether the SEO Spider's post-crawl analysis ran, as ITS OWN log line says
   * (`mAutoAnalyse=true|false`). Read from the log, never assumed from the
   * config we passed: the reasons and notes that depend on it state a fact.
   */
  autoAnalyse: boolean;
}

/**
 * `mAutoAnalyse=…` from the SEO Spider's run log: the setting it actually ran
 * with. A log carrying no such line, or two different values, is a throw.
 */
export function autoAnalyseFromLog(log: string): boolean {
  const values = new Set([...log.matchAll(/mAutoAnalyse=(true|false)/g)].map((m) => m[1]));
  if (values.size !== 1) {
    throw new Error(`the SEO Spider log states mAutoAnalyse ${values.size === 0 ? "nowhere" : "both ways"}`);
  }
  return values.has("true");
}

function sfVersion(): string {
  // The installed package's own version string: what the SEO Spider is, as the
  // package manager installed it. Not read from the application's files.
  const v = execFileSync("dpkg-query", ["-W", "-f=${Version}", "screamingfrogseospider"], {
    encoding: "utf8",
  }).trim();
  if (v === "") throw new Error("dpkg-query returned no version for screamingfrogseospider");
  return v;
}

function sfArgs(base: string, outDir: string, configPath: string | undefined): string[] {
  const all = [...SF_FILTERS, ...SF_DATA];
  const tabs = all.filter((f) => f.kind === "tab").map((f) => f.name);
  const reports = all.filter((f) => f.kind === "report").map((f) => f.name);
  for (const n of [...tabs, ...reports]) {
    if (n.includes(",")) throw new Error(`filter name contains a comma, which the CLI list cannot carry: ${n}`);
  }
  return [
    "--crawl", `${base}/`,
    "--headless",
    "--output-folder", outDir,
    "--export-format", "csv",
    "--overwrite",
    "--task-name", SF_TASK_NAME,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    "--export-tabs", tabs.join(","),
    "--save-report", reports.join(","),
  ];
}

async function runSf(args: string[], logFile: string): Promise<void> {
  const fd = openSync(logFile, "w");
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(SF_BIN, args, { stdio: ["ignore", fd, fd] });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Screaming Frog did not finish within ${SF_TIMEOUT_MS} ms (log: ${logFile})`));
      }, SF_TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else reject(new Error(`Screaming Frog exited ${code ?? signal} (log: ${logFile})`));
      });
    });
  } finally {
    closeSync(fd);
  }
}

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  return url;
}

async function runAriadne(base: string, legacyBase: string): Promise<AriadneResult> {
  const db = createDb(databaseUrl());
  try {
    await runMigrations(db);
    // The harness's crawl config (test/fixtures/harness.test.ts, beforeAll),
    // with room for the ladders' ~1,100 pages and every listing uncapped.
    const config: CrawlConfig = {
      siteUrl: base,
      maxPages: 3000,
      maxDepth: 20,
      userAgent: "AriadneBot-fixture",
      perHostDelayMs: 0,
      maxConcurrency: 8,
      legacyHosts: [legacyBase],
      allowPrivate: true,
      recheckMinGapMs: 200,
      findingCap: null,
    };
    const summary = await runCrawl(db, LOCAL_TENANT, config);
    // From here the crawl row exists: whatever throws below, it is deleted
    // (with its pages and issues, by cascade) rather than left orphaned in a
    // database the test suite shares.
    try {
      if (summary.status !== "finished") throw new Error(`Ariadne crawl ended ${summary.status}`);
      await runRules(db, summary.crawlId, buildRegistry());

      const origin = new URL(base).origin;
      const pageRows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
      const keyById = new Map<string, string>();
      const outPages: AriadnePage[] = pageRows.map((p) => {
        const key = keyOf(p.url, origin);
        keyById.set(p.id, key);
        return {
          key,
          url: p.url,
          statusCode: p.statusCode,
          title: p.title,
          metaDescription: p.metaDescription,
          responseTimeMs: p.responseTimeMs,
          clickDepth: p.clickDepth,
          discoveredVia: p.discoveredVia,
        };
      });
      const issueRows = await db.select().from(issues).where(eq(issues.crawlId, summary.crawlId));
      const outIssues: AriadneIssue[] = issueRows.map((r) => {
        const key = r.pageId === null ? null : keyById.get(r.pageId);
        if (key === undefined) throw new Error(`issue ${r.ruleId} names page ${r.pageId}, which has no pages row`);
        return { ruleId: r.ruleId, key, details: r.details };
      });
      return {
        crawlId: summary.crawlId,
        base,
        pagesCrawled: pageRows.length,
        rulesetVersion: RULESET_VERSION,
        pages: outPages,
        issues: outIssues,
      };
    } finally {
      await db.delete(crawls).where(eq(crawls.id, summary.crawlId));
    }
  } finally {
    await closeDb(db);
  }
}

/**
 * Crawl with both tools, or — given `resumeDir`, a run whose Screaming Frog
 * half completed — with Ariadne alone against that run's exports. Keys are
 * paths on the fixture origin, so the two halves compare across the port
 * change a second app start brings.
 */
async function fullRun(outRoot: string, resumeDir?: string, sfConfigPath?: string): Promise<string> {
  const startedAt = new Date().toISOString();
  const runDir = resumeDir ?? join(outRoot, `run-${startedAt.replace(/[:.]/g, "-")}`);
  const sfDir = join(runDir, "sf");
  mkdirSync(sfDir, { recursive: true });

  const offsite = await startOffsiteHost();
  const assetHost = await startAssetHost();
  const app = await startFixtureApp([...allFixtures(), ...calibrationFixtures()]);
  try {
    let meta: RunMeta;
    if (resumeDir === undefined) {
      const args = sfArgs(app.base, sfDir, sfConfigPath);
      const version = sfVersion();
      console.log(`fixture site at ${app.base}; Screaming Frog ${version} crawling…`);
      await runSf(args, join(runDir, "sf.log"));
      const log = readFileSync(join(runDir, "sf.log"), "utf8");
      if (sfConfigPath !== undefined && !log.includes(`Config loaded from ${sfConfigPath}`)) {
        throw new Error(`the SEO Spider log does not say it loaded ${sfConfigPath}`);
      }
      meta = {
        base: app.base,
        sfVersion: version,
        sfArgs: args,
        startedAt,
        runDir,
        ...(sfConfigPath === undefined
          ? {}
          : {
              sfConfig: {
                path: relative(DEFAULT_OUT, sfConfigPath),
                sha256: createHash("sha256").update(readFileSync(sfConfigPath)).digest("hex"),
              },
            }),
        autoAnalyse: autoAnalyseFromLog(log),
      };
      writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
    } else {
      meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
      console.log(`resuming ${runDir}: Screaming Frog's half is from ${meta.startedAt}`);
    }
    // Refuse a gap before spending a crawl on the other side.
    const files = readdirSync(sfDir);
    for (const f of [...SF_FILTERS, ...SF_DATA]) locateExport(f, files);
    console.log(`Screaming Frog exports read (${files.length} files); Ariadne crawling ${app.base}…`);
    const ariadne = await runAriadne(app.base, app.legacyBase);
    writeFileSync(join(runDir, "ariadne.json"), JSON.stringify(ariadne));
    console.log(`Ariadne done (${ariadne.pagesCrawled} pages, ${ariadne.issues.length} findings).`);
  } finally {
    await closeFetchAgents();
    await app.close();
    await offsite.close();
    await assetHost.close();
  }
  return runDir;
}

// ------------------------------------------------------------------ the report

const CALIB_TARGET_KEY = new RegExp(`^${OUTLINK_TARGET_PATH.replace(/\//g, "\\/")}\\?n=\\d+$`);


/** Key lists, with the outlink targets and the canonical trap folded to counts. */
function listKeys(keys: readonly string[]): string {
  if (keys.length === 0) return "—";
  const targets = keys.filter((k) => CALIB_TARGET_KEY.test(k));
  const trap = keys.filter((k) => CANONICAL_TRAP_KEY.test(k));
  const rest = keys.filter((k) => !CALIB_TARGET_KEY.test(k) && !CANONICAL_TRAP_KEY.test(k)).sort();
  const parts = rest.map((k) => `\`${k}\``);
  if (targets.length > 0) parts.push(`\`${OUTLINK_TARGET_PATH}?n=…\` ×${targets.length}`);
  if (trap.length > 0) parts.push(`\`/index/canonical-conflict?via=…\` ×${trap.length}`);
  return parts.join(", ");
}

/** The first reason that holds for this divergent key, or null. */
export function reasonEntry(filter: string, side: Reason["side"], key: string, ctx: ReasonContext): Reason | null {
  for (const r of REASONS[filter] ?? []) {
    if (r.side !== side) continue;
    const hit = r.match === "*" ? true : r.match instanceof RegExp ? r.match.test(key) : r.match(key, ctx);
    if (hit) return r;
  }
  return null;
}

export function reasonFor(filter: string, side: Reason["side"], key: string, ctx: ReasonContext): string | null {
  return reasonEntry(filter, side, key, ctx)?.reason ?? null;
}

/** Screaming Frog's ladder boundary for one pixel ladder, in its own widths. */
interface PxBoundary {
  /** Widest rung its "Over" filter leaves out. */
  overClear: number | null;
  /** Narrowest rung its "Over" filter lists. */
  overFlagged: number | null;
  /** Widest rung its "Below" filter lists. */
  belowFlagged: number | null;
  /** Narrowest rung its "Below" filter leaves out. */
  belowClear: number | null;
}

interface Comparison {
  filter: SfFilter;
  exp: Export;
  both: string[];
  sfOnly: string[];
  ariadneOnly: string[];
  unexplained: number;
  /** Whether any divergence on this filter is explained by an owner decision. */
  ownerDecided: boolean;
  /** The context this filter's reasons were judged in (its own row count). */
  ctx: ReasonContext;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${JSON.stringify(s)}`);
  return n;
}

/** The first rung a predicate holds on, as a label, or "none". */
function firstFlag<R>(rows: readonly R[], flagged: (r: R) => boolean, label: (r: R) => string): string {
  const hit = rows.find(flagged);
  return hit === undefined ? "none" : label(hit);
}

function writeReport(runDir: string): number {
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
  const ariadne = JSON.parse(readFileSync(join(runDir, "ariadne.json"), "utf8")) as AriadneResult;
  const sfDir = join(runDir, "sf");
  const files = readdirSync(sfDir);
  const origin = new URL(meta.base).origin;
  const sfKey = (row: Record<string, string>): string => {
    const raw = row["URL Encoded Address"] || row["Address"];
    if (raw === undefined || raw === "") throw new Error(`SF row has no Address: ${JSON.stringify(row)}`);
    return keyOf(raw, origin);
  };

  // Every 26a rule accounted for, and every rule id in the table real.
  const registryIds = new Set(buildRegistry().all().map((r) => r.id));
  for (const f of SF_FILTERS) {
    for (const id of f.ruleIds) if (!registryIds.has(id)) throw new Error(`SF_FILTERS names unknown rule ${id}`);
  }
  const mapped = new Set(SF_FILTERS.flatMap((f) => f.ruleIds));
  for (const id of P26A_RULES) {
    if (!registryIds.has(id)) throw new Error(`P26A_RULES names unknown rule ${id}`);
    if (!mapped.has(id) && NO_COUNTERPART[id] === undefined) {
      throw new Error(`26a rule ${id} is neither mapped to a Screaming Frog filter nor listed in NO_COUNTERPART`);
    }
  }

  const findingsByRule = new Map<string, Set<string>>();
  for (const i of ariadne.issues) {
    if (i.key === null) continue;
    const set = findingsByRule.get(i.ruleId) ?? new Set<string>();
    set.add(i.key);
    findingsByRule.set(i.ruleId, set);
  }
  const ariadneOrigin = new URL(ariadne.base).origin;
  /** Our findings for a filter, keyed by the subject the filter lists. */
  const ariadneKeys = (f: SfFilter): Set<string> => {
    if (f.ariadneSubject === undefined) {
      return new Set(f.ruleIds.flatMap((id) => [...(findingsByRule.get(id) ?? [])]));
    }
    const subject = f.ariadneSubject;
    return new Set(
      ariadne.issues
        .filter((i) => f.ruleIds.includes(i.ruleId))
        .map((i) => keyOf(subject(i.details as Record<string, unknown>), ariadneOrigin)),
    );
  };

  const internal = new Map(
    readExport(sfDir, SF_DATA[0]!, files, [
      "Unique Outlinks",
      "Unique External Outlinks",
      "Response Time",
      "Crawl Depth",
      "Word Count",
      "Indexability",
    ]).rows.map((r) => [sfKey(r), r]),
  );
  const fired = (ruleId: string, key: string): boolean => findingsByRule.get(ruleId)?.has(key) ?? false;
  const sfTitles = new Map(readExport(sfDir, SF_DATA[1]!, files, ["Title 1 Pixel Width"]).rows.map((r) => [sfKey(r), r]));
  const sfMetas = new Map(readExport(sfDir, SF_DATA[2]!, files, ["Meta Description 1 Pixel Width"]).rows.map((r) => [sfKey(r), r]));
  const ourPage = new Map(ariadne.pages.map((p) => [p.key, p]));
  if (typeof meta.autoAnalyse !== "boolean") {
    throw new Error(`${runDir}/meta.json has no autoAnalyse: re-run the SEO Spider half with this script`);
  }
  const baseCtx: Omit<ReasonContext, "sfRowCount"> = {
    autoAnalyse: meta.autoAnalyse,
    sfConfig:
      meta.sfConfig === undefined
        ? null
        : (JSON.parse(readFileSync(join(DEFAULT_OUT, meta.sfConfig.path), "utf8")) as Record<string, Record<string, unknown>>),
    siteScheme: new URL(ariadne.base).protocol,
    sf: (key) => internal.get(key),
    sfWidth: (kind, key) =>
      kind === "title"
        ? num(sfTitles.get(key)?.["Title 1 Pixel Width"])
        : num(sfMetas.get(key)?.["Meta Description 1 Pixel Width"]),
    ourWidth: (kind, key) => {
      const page = ourPage.get(key);
      const text = kind === "title" ? page?.title : page?.metaDescription;
      return text === undefined || text === null ? null : serpWidth(text, kind);
    },
    fired,
    ourDiscoveredVia: (key) => ourPage.get(key)?.discoveredVia,
    details: (ruleId, key) =>
      ariadne.issues.find((i) => i.ruleId === ruleId && i.key === key)?.details as Record<string, unknown> | undefined,
  };

  // SF's list of URLs for a rule: the union over every filter mapped to it, so
  // a rule SF splits over several filters is compared against the union and a
  // filter is compared against the rule's whole finding set.
  const comparisons: Comparison[] = [];
  let unexplainedTotal = 0;
  for (const f of SF_FILTERS) {
    const exp = readExport(sfDir, f, files);
    const sf = new Set(exp.rows.map(sfKey));
    const ours = ariadneKeys(f);
    // For a rule split over several SF filters, our findings on a URL that a
    // SIBLING filter lists are not "Ariadne only" for this one.
    const siblings = SF_FILTERS.filter(
      (g) => g !== f && g.ruleIds.some((id) => f.ruleIds.includes(id)),
    );
    const sfSiblings = new Set(siblings.flatMap((g) => readExport(sfDir, g, files).rows.map(sfKey)));
    const both = [...sf].filter((k) => ours.has(k));
    const sfOnly = [...sf].filter((k) => !ours.has(k));
    const ariadneOnly = [...ours].filter((k) => !sf.has(k) && !sfSiblings.has(k));
    const ctx: ReasonContext = { ...baseCtx, sfRowCount: exp.rows.length };
    let unexplained = 0;
    for (const k of sfOnly) if (reasonFor(f.name, "sf-only", k, ctx) === null) unexplained++;
    for (const k of ariadneOnly) if (reasonFor(f.name, "ariadne-only", k, ctx) === null) unexplained++;
    unexplainedTotal += unexplained;
    const ownerDecided = [
      ...sfOnly.map((k) => reasonEntry(f.name, "sf-only", k, ctx)),
      ...ariadneOnly.map((k) => reasonEntry(f.name, "ariadne-only", k, ctx)),
    ].some((r) => r?.status === "owner-decided");
    comparisons.push({ filter: f, exp, both, sfOnly, ariadneOnly, unexplained, ownerDecided, ctx });
  }

  // ---- ladders
  const issuesOverview = readExport(sfDir, SF_DATA[3]!, files, ["Issue Name"]).rows;
  const sfFlagged = (filterName: string): Set<string> => {
    const c = comparisons.find((x) => x.filter.name === filterName);
    if (c === undefined) throw new Error(`no comparison for ${filterName}`);
    return new Set(c.exp.rows.map(sfKey));
  };
  const configured = (filterName: string): number | null =>
    comparisons.find((x) => x.filter.name === filterName)?.exp.configured ?? null;
  const details = (ruleId: string, key: string): Record<string, unknown> | undefined =>
    ariadne.issues.find((i) => i.ruleId === ruleId && i.key === key)?.details as Record<string, unknown> | undefined;

  const out: string[] = [];
  const w = (s = ""): void => {
    out.push(s);
  };

  w("# Phase 26a — Screaming Frog black-box calibration");
  w();
  w(
    "Generated by `scripts/calibrate-sf.ts`. Do not edit by hand: change the script's `REASONS` table and re-run `--report-only` on the run directory, or re-run the whole calibration.",
  );
  w();
  w("## The run");
  w();
  w(`- Run: ${meta.startedAt} (run directory \`${runDir.replace(`${REPO}/`, "")}\`, git-ignored; SF exports are never committed).`);
  w(
    meta.sfConfig === undefined
      ? `- Screaming Frog SEO Spider **${meta.sfVersion}** (Linux package), headless, at the configuration it starts with when given no \`--config\`. Licensed. Its log reports \`mAutoAnalyse=${meta.autoAnalyse}\`.`
      : `- Screaming Frog SEO Spider **${meta.sfVersion}** (Linux package), headless, licensed, with \`--config <sf-run>/${meta.sfConfig.path}\` (sha256 \`${meta.sfConfig.sha256.slice(0, 16)}…\`, git-ignored, not committed). ${SF_CONFIG_DESCRIPTION} Its log reports \`mAutoAnalyse=${meta.autoAnalyse}\`.`,
  );
  w(`- Ariadne ruleset **${ariadne.rulesetVersion}**; \`runCrawl\` + \`runRules\` with the harness crawl config (\`maxPages\` 3000, \`maxDepth\` 20, uncapped listings, no render pass — no compared rule reads a rendered column).`);
  w(`- Site: every harness fixture (\`allFixtures()\`) plus the calibration ladders (\`calibrationFixtures()\`, \`${CALIBRATION_PREFIX}/…\`), served by \`startFixtureApp\` on 127.0.0.1. Screaming Frog crawled ${internal.size} internal HTML URLs; Ariadne wrote ${ariadne.pagesCrawled} \`pages\` rows (HTML and non-HTML, the sitemap-only pages included).`);
  w("- Command (the port is the run's):");
  w();
  w("```");
  w(
    `${SF_BIN} ${meta.sfArgs
      .map((a) => (a.includes(" ") || a.includes("<") || a.includes("&") ? JSON.stringify(a) : a))
      .join(" ")
      .replace(meta.base, "http://127.0.0.1:<port>")
      .replace(join(runDir, "sf"), "<run dir>/sf")
      .replace(DEFAULT_OUT, "<sf-run>")}`,
  );
  w("```");
  w();
  w(
    "**Black box.** Everything here about Screaming Frog is what it printed and exported for pages we wrote: filter exports, the Issues Overview report's issue names, the Internal tab's columns, and the lines of its own run log (which prints the settings it ran with, such as `mAutoAnalyse`), and, for the `--sf-config` run, the configuration its own MCP server returned. No MCP transcript is kept in the repository. No Screaming Frog code, jar, decompiled source or configuration file was read (CLAUDE.md rule 8).",
  );
  w();
  w(
    "URLs are compared by key: path plus sorted query string on the fixture origin, the whole URL elsewhere. `/calib26/target?n=…` is the internal outlink ladder's thousand-and-one targets, folded to a count.",
  );
  w();

  // ---- summary
  w("## Summary by filter");
  w();
  w("| Screaming Frog filter | Ariadne rule | Family | Both | SF only | Ariadne only | Status |");
  w("|---|---|---|---:|---:|---:|---|");
  for (const c of comparisons) {
    const status = c.filter.notCalibratable !== undefined
      ? "not calibratable here"
      : c.sfOnly.length + c.ariadneOnly.length === 0
        ? c.both.length === 0 ? "match (both silent)" : "match"
        : c.unexplained > 0
          ? `**${c.unexplained} UNEXPLAINED**`
          : c.ownerDecided
            ? "threshold divergence, owner-decided"
            : "divergence, explained";
    const configuredNote = c.exp.configured === null ? "" : ` (SF: ${c.exp.configured})`;
    w(
      `| ${c.filter.name}${configuredNote} | ${c.filter.ruleIds.map((id) => `\`${id}\``).join(", ")} | ${c.filter.family} | ${c.both.length} | ${c.sfOnly.length} | ${c.ariadneOnly.length} | ${status} |`,
    );
  }
  w();
  w("### 26a rules with no Screaming Frog counterpart");
  w();
  for (const [id, why] of Object.entries(NO_COUNTERPART)) w(`- \`${id}\` — ${why}`);
  w();

  // ---- ladders
  w("## Ladders");
  w();
  const sfOver = (name: string): string => `SF \`${name.replace("X", String(configured(name)))}\``;

  const pxLadder = (
    kind: "title" | "description",
    prefix: string,
    sfData: Map<string, Record<string, string>>,
    widthCol: string,
    textOf: (p: AriadnePage) => string | null,
    overFilter: string,
    belowFilter: string,
    overRule: string,
    belowRule: string,
  ): PxBoundary => {
    const rungs = [...ourPage.values()]
      .filter((p) => p.key.startsWith(prefix))
      .map((p) => {
        const text = textOf(p);
        const ours = text === null ? null : serpWidth(text, kind);
        const sfw = num(sfData.get(p.key)?.[widthCol]);
        return { key: p.key, ours, sfw };
      })
      .sort((a, b) => (a.ours ?? 0) - (b.ours ?? 0));
    const over = sfFlagged(overFilter);
    const below = sfFlagged(belowFilter);
    w(`| Rung | Ariadne width (px) | SF width (px) | SF − Ariadne | ${sfOver(overFilter)} | \`${overRule}\` | ${sfOver(belowFilter)} | \`${belowRule}\` |`);
    w("|---|---:|---:|---:|:-:|:-:|:-:|:-:|");
    for (const r of rungs) {
      const diff = r.ours === null || r.sfw === null ? "—" : (Math.round((r.sfw - r.ours) * 10) / 10).toString();
      const yn = (b: boolean): string => (b ? "**yes**" : "no");
      w(
        `| \`${r.key}\` | ${r.ours ?? "—"} | ${r.sfw ?? "not crawled"} | ${diff} | ${yn(over.has(r.key))} | ${yn(fired(overRule, r.key))} | ${yn(below.has(r.key))} | ${yn(fired(belowRule, r.key))} |`,
      );
    }
    w();
    // Boundaries in each tool's OWN measure: Screaming Frog's flags against
    // its widths, ours against ours. Sorting by one measure and reading the
    // other's flags would mix the two.
    const sfMeasured = rungs.filter((r) => r.sfw !== null) as Array<{ key: string; ours: number | null; sfw: number }>;
    const maxOf = (xs: number[]): string => (xs.length === 0 ? "none" : String(Math.max(...xs)));
    const minOf = (xs: number[]): string => (xs.length === 0 ? "none" : String(Math.min(...xs)));
    const oursMeasured = rungs.filter((r) => r.ours !== null) as Array<{ key: string; ours: number; sfw: number | null }>;
    w(
      `Upper bound, Screaming Frog in its own widths: widest rung not flagged ${maxOf(sfMeasured.filter((r) => !over.has(r.key)).map((r) => r.sfw))} px, narrowest flagged ${minOf(sfMeasured.filter((r) => over.has(r.key)).map((r) => r.sfw))} px (configured: ${configured(overFilter)}). ` +
        `Ariadne in \`serpWidth\`: widest not flagged ${maxOf(oursMeasured.filter((r) => !fired(overRule, r.key)).map((r) => r.ours))} px, narrowest flagged ${minOf(oursMeasured.filter((r) => fired(overRule, r.key)).map((r) => r.ours))} px.`,
    );
    w();
    w(
      `Lower bound, Screaming Frog in its own widths: widest rung flagged ${maxOf(sfMeasured.filter((r) => below.has(r.key)).map((r) => r.sfw))} px, narrowest not flagged ${minOf(sfMeasured.filter((r) => !below.has(r.key)).map((r) => r.sfw))} px (configured: ${configured(belowFilter)}). ` +
        `Ariadne in \`serpWidth\`: widest flagged ${maxOf(oursMeasured.filter((r) => fired(belowRule, r.key)).map((r) => r.ours))} px, narrowest not flagged ${minOf(oursMeasured.filter((r) => !fired(belowRule, r.key)).map((r) => r.ours))} px.`,
    );
    w();
    const maxN = (xs: number[]): number | null => (xs.length === 0 ? null : Math.max(...xs));
    const minN = (xs: number[]): number | null => (xs.length === 0 ? null : Math.min(...xs));
    return {
      overClear: maxN(sfMeasured.filter((r) => !over.has(r.key)).map((r) => r.sfw)),
      overFlagged: minN(sfMeasured.filter((r) => over.has(r.key)).map((r) => r.sfw)),
      belowFlagged: maxN(sfMeasured.filter((r) => below.has(r.key)).map((r) => r.sfw)),
      belowClear: minN(sfMeasured.filter((r) => !below.has(r.key)).map((r) => r.sfw)),
    };
  };

  w(`### Title pixel width (\`TITLE_PX_MAX\` ${T.TITLE_PX_MAX}, \`TITLE_PX_MIN\` ${T.TITLE_PX_MIN})`);
  w();
  const titleBoundary = pxLadder(
    "title",
    `${CALIBRATION_PREFIX}/title-px/`,
    sfTitles,
    "Title 1 Pixel Width",
    (p) => p.title,
    "Page Titles:Over X Pixels",
    "Page Titles:Below X Pixels",
    "title.pixel-too-long",
    "title.pixel-too-short",
  );
  w(`### Description pixel width (\`META_PX_MAX\` ${T.META_PX_MAX}, \`META_PX_MIN\` ${T.META_PX_MIN})`);
  w();
  const metaBoundary = pxLadder(
    "description",
    `${CALIBRATION_PREFIX}/meta-px/`,
    sfMetas,
    "Meta Description 1 Pixel Width",
    (p) => p.metaDescription,
    "Meta Description:Over X Pixels",
    "Meta Description:Below X Pixels",
    "meta-description.pixel-too-long",
    "meta-description.pixel-too-short",
  );

  const outlinkLadder = (
    side: "internal" | "external",
    ladder: readonly number[],
    filterName: string,
    sfCol: string,
    max: number,
  ): { sfLastClear: number | null; sfFirstFlagged: number | null } => {
    const flagged = sfFlagged(filterName);
    w(`| Distinct ${side} targets | SF \`${sfCol}\` | SF \`${filterName}\` | \`links.high-outlinks\` | Ariadne's count (in the finding) |`);
    w("|---:|---:|:-:|:-:|---:|");
    const rows = ladder.map((n) => {
      const key = `${CALIBRATION_PREFIX}/outlinks/${side}/${n}`;
      const d = details("links.high-outlinks", key);
      const ourCount = d?.[side === "internal" ? "internalOutlinks" : "externalOutlinks"];
      // `crossed` is "internal" | "external" | "both" (link-hygiene.ts).
      const crossed = d !== undefined && (d["crossed"] === side || d["crossed"] === "both");
      return { n, key, sf: internal.get(key)?.[sfCol], sfFlag: flagged.has(key), ours: crossed, ourCount };
    });
    for (const r of rows) {
      w(`| ${r.n} | ${r.sf ?? "not crawled"} | ${r.sfFlag ? "**yes**" : "no"} | ${r.ours ? "**yes**" : "no"} | ${r.ourCount ?? "—"} |`);
    }
    w();
    w(
      `First rung SF flags: ${firstFlag(rows, (r) => r.sfFlag, (r) => String(r.n))}; first rung Ariadne flags: ${firstFlag(rows, (r) => r.ours, (r) => String(r.n))} (current threshold: more than ${max}).`,
    );
    w();
    const clear = rows.filter((r) => !r.sfFlag).map((r) => r.n);
    const hit = rows.filter((r) => r.sfFlag).map((r) => r.n);
    return {
      sfLastClear: clear.length === 0 ? null : Math.max(...clear),
      sfFirstFlagged: hit.length === 0 ? null : Math.min(...hit),
    };
  };
  w(`### Internal outlinks (\`HIGH_INTERNAL_OUTLINKS\` ${T.HIGH_INTERNAL_OUTLINKS})`);
  w();
  const internalBoundary = outlinkLadder("internal", INTERNAL_OUTLINK_LADDER, "Links:Pages With High Internal Outlinks", "Unique Outlinks", T.HIGH_INTERNAL_OUTLINKS);
  w(`### External outlinks (\`HIGH_EXTERNAL_OUTLINKS\` ${T.HIGH_EXTERNAL_OUTLINKS})`);
  w();
  const externalBoundary = outlinkLadder("external", EXTERNAL_OUTLINK_LADDER, "Links:Pages With High External Outlinks", "Unique External Outlinks", T.HIGH_EXTERNAL_OUTLINKS);

  w(`### Response time (\`SLOW_MS\` ${T.SLOW_MS})`);
  w();
  const slowIssues = issuesOverview
    .map((r) => r["Issue Name"] ?? "")
    .filter((n) => /response time|slow|ttfb|latency/i.test(n));
  w(`| Server delay (ms) | SF \`Response Time\` (s) | Ariadne \`response_time_ms\` | \`performance.slow-response\` |`);
  w("|---:|---:|---:|:-:|");
  const slowRows = RESPONSE_TIME_LADDER.map((ms) => {
    const key = `${CALIBRATION_PREFIX}/slow/${ms}`;
    return { ms, key, sf: internal.get(key)?.["Response Time"], ours: ourPage.get(key)?.responseTimeMs, flag: fired("performance.slow-response", key) };
  });
  for (const r of slowRows) w(`| ${r.ms} | ${r.sf ?? "not crawled"} | ${r.ours ?? "—"} | ${r.flag ? "**yes**" : "no"} |`);
  w();
  w(
    `Screaming Frog issues whose name mentions response time, slowness, TTFB or latency in its Issues Overview (all issues, flagged or not): ${slowIssues.length === 0 ? "none" : slowIssues.map((n) => `"${n}"`).join(", ")}. ` +
      "No tab filter for response time exists in `--help export-tabs` either. First rung Ariadne flags: " +
      firstFlag(slowRows, (r) => r.flag, (r) => `${r.ms} ms`) + ".",
  );
  w();

  w(`### Click depth (\`DEEP_DEPTH\` ${T.DEEP_DEPTH})`);
  w();
  const deep = sfFlagged("Links:Pages With High Crawl Depth");
  w("| Level | SF `Crawl Depth` | SF `Pages With High Crawl Depth` | Ariadne `click_depth` | `structure.deep-page` |");
  w("|---:|---:|:-:|---:|:-:|");
  const depthRows = Array.from({ length: DEPTH_CHAIN_LENGTH }, (_, i) => {
    const key = `${CALIBRATION_PREFIX}/depth/${i + 1}`;
    return { level: i + 1, key, sf: internal.get(key)?.["Crawl Depth"], sfFlag: deep.has(key), ours: ourPage.get(key)?.clickDepth, flag: fired("structure.deep-page", key) };
  });
  for (const r of depthRows) {
    w(`| ${r.level} | ${r.sf ?? "not crawled"} | ${r.sfFlag ? "**yes**" : "no"} | ${r.ours ?? "—"} | ${r.flag ? "**yes**" : "no"} |`);
  }
  w();
  w(
    `First level SF flags: ${firstFlag(depthRows, (r) => r.sfFlag, (r) => `${r.level} (SF depth ${r.sf})`)}; first level Ariadne flags: ${firstFlag(depthRows, (r) => r.flag, (r) => `${r.level} (click depth ${r.ours})`)}.`,
  );
  w();
  // The boundary in CRAWL DEPTH (SF's own column, which matches our click
  // depth on this chain), not in chain level.
  const depthOf = (r: (typeof depthRows)[number]): number => {
    const d = num(r.sf);
    if (d === null) throw new Error(`no SF crawl depth for ${r.key}`);
    return d;
  };
  const depthClear = depthRows.filter((r) => !r.sfFlag).map(depthOf);
  const depthHit = depthRows.filter((r) => r.sfFlag).map(depthOf);
  const depthBoundary = {
    sfLastClear: depthClear.length === 0 ? null : Math.max(...depthClear),
    sfFirstFlagged: depthHit.length === 0 ? null : Math.min(...depthHit),
  };

  w(`### Thin content (\`THIN_WORDS\` ${T.THIN_WORDS}, kept)`);
  w();
  const low = sfFlagged("Content:Low Content Pages");
  const wc = [...internal.entries()]
    .map(([k, r]) => ({ k, words: num(r["Word Count"]), flagged: low.has(k), indexable: r["Indexability"] === "Indexable" }))
    .filter((r) => r.words !== null && r.indexable);
  const maxFlagged = Math.max(...wc.filter((r) => r.flagged).map((r) => r.words!));
  const minUnflagged = Math.min(...wc.filter((r) => !r.flagged).map((r) => r.words!));
  w(
    `Over the whole site (indexable HTML, SF's own \`Word Count\`): the most words on a page SF lists as low content is ${maxFlagged}; the fewest on a page it does not list is ${minUnflagged}. No ladder: the spec keeps \`THIN_WORDS\` at 150 unless the run gives a reason, and ours counts main-content words (template-aware, deliberately) where SF counts the page's words.`,
  );
  w();

  // ---- thresholds
  // A threshold this calibration sets from a ladder must sit exactly on the
  // boundary the ladder shows (adjacent rungs, last clear = the threshold), or
  // the report says MISMATCH and the run fails like an unexplained divergence.
  const ladderVerdict = (
    name: string,
    start: number,
    current: number,
    b: { sfLastClear: number | null; sfFirstFlagged: number | null },
  ): string => {
    const adjacent = b.sfLastClear !== null && b.sfFirstFlagged === b.sfLastClear + 1;
    if (!adjacent) {
      unexplainedTotal++;
      return `| \`${name}\` | ${start} | **MISMATCH**: no adjacent clear/flagged rungs (${b.sfLastClear} / ${b.sfFirstFlagged}) | ${current} | — |`;
    }
    if (current !== b.sfLastClear) {
      unexplainedTotal++;
      return `| \`${name}\` | ${start} | clear at ${b.sfLastClear}, flagged at ${b.sfFirstFlagged} | ${current} | **MISMATCH** with the ladder |`;
    }
    return `| \`${name}\` | ${start} | clear at ${b.sfLastClear}, flagged at ${b.sfFirstFlagged} | ${current} | ${current === start ? "confirmed" : "**moved**"} |`;
  };
  // A pixel bound is confirmed only when SF's export NAMES it and SF's own
  // ladder widths put it between the last clear rung and the first flagged one
  // (strict, as the filters are). Either failing is a MISMATCH that fails the run.
  const pxVerdict = (
    name: string,
    start: number,
    current: number,
    filterName: string,
    dir: "over" | "below",
    b: PxBoundary,
  ): string => {
    const named = configured(filterName);
    const label = filterName.replace("X", String(named));
    const [clear, flagged] = dir === "over" ? [b.overClear, b.overFlagged] : [b.belowClear, b.belowFlagged];
    const observed = `SF's filter is "${label}"; in its own widths ${dir === "over" ? `${clear ?? "none"} px not flagged, ${flagged ?? "none"} px flagged` : `${flagged ?? "none"} px flagged, ${clear ?? "none"} px not flagged`}`;
    const ladderAgrees =
      clear !== null &&
      flagged !== null &&
      (dir === "over" ? clear <= current && current < flagged : flagged < current && current <= clear);
    if (named !== current || !ladderAgrees) {
      unexplainedTotal++;
      return `| \`${name}\` | ${start} | ${observed} | ${current} | **MISMATCH** (${named !== current ? "export names another value" : "ladder boundary does not bracket the value"}) |`;
    }
    return `| \`${name}\` | ${start} | ${observed} | ${current} | ${current === start ? "confirmed" : "**moved**"} |`;
  };
  w("## Thresholds");
  w();
  w(
    "Set from the ladders only where the spec calls the value unknown (high outlinks, pixel bounds, slow response, click depth). \"Before\" is the value Phase 26a shipped with before this calibration.",
  );
  w();
  w("| Constant | Before | Screaming Frog 25.1 | Now | Decision |");
  w("|---|---:|---|---:|---|");
  w(ladderVerdict("HIGH_INTERNAL_OUTLINKS", 1000, T.HIGH_INTERNAL_OUTLINKS, internalBoundary));
  w(ladderVerdict("HIGH_EXTERNAL_OUTLINKS", 100, T.HIGH_EXTERNAL_OUTLINKS, externalBoundary));
  w(pxVerdict("TITLE_PX_MAX", 561, T.TITLE_PX_MAX, "Page Titles:Over X Pixels", "over", titleBoundary));
  w(pxVerdict("TITLE_PX_MIN", 200, T.TITLE_PX_MIN, "Page Titles:Below X Pixels", "below", titleBoundary));
  w(pxVerdict("META_PX_MAX", 985, T.META_PX_MAX, "Meta Description:Over X Pixels", "over", metaBoundary));
  w(pxVerdict("META_PX_MIN", 400, T.META_PX_MIN, "Meta Description:Below X Pixels", "below", metaBoundary));
  w(
    `| \`SLOW_MS\` | 1500 | no response-time issue at its default configuration (Issues Overview, tab filters); its measured times match ours | ${T.SLOW_MS} | kept: no SF boundary to read |`,
  );
  if (meta.autoAnalyse) {
    const owner = OWNER_THRESHOLDS["DEEP_DEPTH"]!;
    const adjacent =
      depthBoundary.sfLastClear !== null && depthBoundary.sfFirstFlagged === depthBoundary.sfLastClear + 1;
    if (adjacent && depthBoundary.sfLastClear === owner.sfLastClear && T.DEEP_DEPTH === owner.kept) {
      w(
        `| \`DEEP_DEPTH\` | 5 | clear at ${depthBoundary.sfLastClear}, flagged at ${depthBoundary.sfFirstFlagged} | ${T.DEEP_DEPTH} | threshold divergence, owner-decided (${owner.decided}): SF's boundary is more than ${owner.sfLastClear}, ours more than ${owner.kept} |`,
      );
    } else {
      // The owner's record no longer describes this run: judge it as any ladder.
      w(ladderVerdict("DEEP_DEPTH", 5, T.DEEP_DEPTH, depthBoundary));
    }
  } else {
    w(
      `| \`DEEP_DEPTH\` | 5 | "Pages With High Crawl Depth" empty at every depth, 1 to over 1,000 (post-crawl analysis off); its depths match ours | ${T.DEEP_DEPTH} | kept: no SF boundary to read |`,
    );
  }
  w(
    `| \`THIN_WORDS\` | 150 | low content below 200 words of the whole page (observed: ${maxFlagged} listed, ${minUnflagged} not) | ${T.THIN_WORDS} | kept (spec): ours counts main-content words, template-aware |`,
  );
  w();
  for (const line of runNotes(meta)) w(line);

  // ---- details
  w("## Per filter: URLs and divergences");
  w();
  for (const c of comparisons) {
    w(`### ${c.filter.name} → ${c.filter.ruleIds.map((id) => `\`${id}\``).join(", ")}`);
    w();
    w(`Export \`${c.exp.file}\`${c.exp.configured === null ? "" : `; SF's configured value: ${c.exp.configured}`}.`);
    if (c.filter.notCalibratable !== undefined) {
      w();
      w(`**Not calibratable here.** ${c.filter.notCalibratable}`);
    }
    w();
    w(`- Both (${c.both.length}): ${listKeys(c.both)}`);
    for (const [side, keys] of [["sf-only", c.sfOnly], ["ariadne-only", c.ariadneOnly]] as const) {
      const label = side === "sf-only" ? "SF only" : "Ariadne only";
      if (keys.length === 0) {
        w(`- ${label}: —`);
        continue;
      }
      // Group by reason so a reason that covers many URLs is written once.
      const groups = new Map<string, string[]>();
      for (const k of keys) {
        const r = reasonFor(c.filter.name, side, k, c.ctx) ?? "UNEXPLAINED";
        groups.set(r, [...(groups.get(r) ?? []), k]);
      }
      w(`- ${label} (${keys.length}):`);
      for (const [reason, ks] of groups) {
        w(`  - ${listKeys(ks)}`);
        w(`    - ${reason === "UNEXPLAINED" ? "**UNEXPLAINED**" : `Reason: ${reason}`}`);
      }
    }
    w();
  }

  writeFileSync(REPORT_PATH, `${out.join("\n").trimEnd()}\n`);
  console.log(`wrote ${REPORT_PATH.replace(`${REPO}/`, "")}`);
  return unexplainedTotal;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let runDir: string;
  if (argv[0] === "--report-only") {
    if (argv[1] === undefined || !existsSync(join(argv[1], "meta.json"))) {
      throw new Error("--report-only needs a run directory a full run wrote (it holds meta.json)");
    }
    runDir = assertUnderSfRun(argv[1]);
  } else if (argv[0] === "--resume-ariadne") {
    if (argv[1] === undefined || !existsSync(join(argv[1], "meta.json"))) {
      throw new Error("--resume-ariadne needs a run directory whose Screaming Frog half completed (it holds meta.json)");
    }
    runDir = await fullRun(DEFAULT_OUT, assertUnderSfRun(argv[1]));
  } else if (argv.length === 0 || (argv.length === 2 && argv[0] === "--sf-config")) {
    // `--sf-config <file>`: a SEO Spider configuration (its JSON format) to run
    // with, which must live under the git-ignored sf-run/ like everything else
    // the SEO Spider touches, and must exist.
    const config = argv[0] === "--sf-config" ? assertUnderSfRun(argv[1]!) : undefined;
    if (config !== undefined && !existsSync(config)) throw new Error(`--sf-config: no such file ${config}`);
    runDir = await fullRun(assertUnderSfRun(process.env["CALIBRATE_OUT"] ?? DEFAULT_OUT), undefined, config);
  } else {
    throw new Error(`unknown arguments: ${argv.join(" ")}`);
  }
  const unexplained = writeReport(runDir);
  if (unexplained > 0) {
    console.error(`${unexplained} divergence(s) carry no reason; see the report.`);
    process.exitCode = 1;
  }
}

// Run only when executed, not when a test imports the reasons and helpers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
