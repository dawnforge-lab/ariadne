import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { copyFor, ISSUE_COPY } from "../../src/rules/registry/copy/index.js";
import { buildRegistry } from "../../src/rules/index.js";
import {
  HEADING_MAX_STEP,
  H1_MAX,
  META_MAX,
  META_MIN,
  TITLE_MAX,
  TITLE_MIN,
  URL_MAX,
} from "../../src/rules/page/on-page.js";
import { SLOW_MS } from "../../src/rules/page/technical.js";
// `DEEP_DEPTH` moved with `structure.deep-page` in Phase 9: the rule reads
// `click_depth` and therefore lives with the link-graph rules.
import { DEEP_DEPTH } from "../../src/rules/query/link-graph.js";
import { CHAIN_HOPS } from "../../src/rules/query/redirects.js";
import {
  DUPLICATE_SAMPLE_URLS,
  NEAR_DUPLICATE_COUNT_CAP,
  NEAR_DUPLICATE_HAMMING,
  NEAR_DUPLICATE_MIN_MAIN_WORDS,
  SOFT_404_WORDS,
  TEMPLATE_HAMMING,
  THIN_WORDS,
} from "../../src/rules/query/content.js";
import {
  CSR_MIN_ADDED_WORDS,
  CSR_WORD_MULTIPLE,
  FILTER_RENDERED_MIN,
  NAV_RAW_MAX,
  NAV_RENDERED_MIN,
  NAV_RENDERED_MULTIPLE,
} from "../../src/rules/query/render-diff.js";
import { BREADCRUMB_PAGE_FLOOR } from "../../src/rules/query/structured-data.js";
import {
  EXTREMES_LIST_CAP,
  OTHER_SOURCES,
  SOURCE_TYPE_CAP,
} from "../../src/rules/metric/link-metrics.js";
import {
  TEMPLATE_LOOSE_BITS,
  TEMPLATE_NEAR_BITS,
  TEMPLATE_SAMPLE_PAGES,
} from "../../src/rules/metric/content-metrics.js";
import {
  SITEMAP_DOC_ROWS_CAP,
  SITEMAP_URL_CAP,
} from "../../src/rules/metric/crawl-metrics.js";
import { TOP_PARAMS_CAP } from "../../src/rules/metric/url-metrics.js";
import {
  BROKEN_SAMPLE_RESOURCES,
  IMAGE_WEIGHT_WARN,
  UNCACHED_SAMPLE_RESOURCES,
} from "../../src/rules/query/resources.js";

/**
 * THE CLIENT-FACING COPY, PINNED.
 *
 * Two things are asserted here and they are not the same thing:
 *
 *  1. ACCURACY. Every `it` in the first half states one lesson about what a
 *     rule may claim — each of them a real defect once, found by reading a
 *     finding beside the rule that produced it. The assertions are at the level
 *     of the CLAIM (a concept, a number, a boundary), never at the level of a
 *     sentence: the copy was rewritten wholesale in Phase 20 into the register
 *     of an SEO tool, and a test that pinned its old wording would have to be
 *     rewritten with every pass while pinning nothing that matters.
 *  2. STRUCTURE. The rubric describes at the bottom hold the whole registry to
 *     the shape docs/superpowers/specs/2026-09-10-reports-and-copy-design.md §1
 *     defines: `Area: Condition` titles from a fixed area list, a description of
 *     one to three sentences, a fix with at least one imperative, no engine
 *     vocabulary, a threshold in the title of every rule that fires on one, and
 *     one plain sentence per marker.
 *
 * The reader all of it protects is a site owner with no knowledge of this
 * engine (docs/talos-integration.md, obligation 6): the text reaches them in a
 * report, an action plan or a Talos screen, verbatim and with no glossary.
 *
 * Numbers in the copy are asserted against the rules' own exported constants,
 * so prose and rule cannot drift: change `TITLE_MIN` and this file fails until
 * the sentence changes with it.
 */

/** Every rule the registry builds — the population both halves are asserted over. */
const RULES = buildRegistry().all();

/**
 * Sentences of a paragraph, near enough for a rubric.
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace (or at the end of
 * the string). Known abbreviations are blanked first so "e.g." does not end
 * one: today's copy uses none, and the guard is for the entry written next.
 * Semicolons and colons do NOT end a sentence — the copy joins clauses with
 * both, deliberately.
 */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|approx|no)\.\s/gi;
const sentences = (text: string): string[] =>
  text
    .replace(ABBREVIATIONS, (m) => m.replace(".", " "))
    .split(/(?<=[.!?])["')]?\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The copy of one rule, by id, with a readable failure when the id is unknown. */
const copy = (id: string) => {
  const c = ISSUE_COPY[id];
  if (c === undefined) throw new Error(`no copy for ${id}`);
  return c;
};

/** Title + explanation + how-to-fix, for the negative guards. */
const whole = (id: string): string => {
  const c = copy(id);
  return `${c.title} ${c.explanation} ${c.howToFix}`;
};

// ==========================================================================
// COVERAGE
// ==========================================================================

describe("issue copy: coverage", () => {
  it("throws on an unknown rule id", () => {
    expect(() => copyFor("no.such-rule")).toThrow(/no copy/);
  });

  // Both directions. A rule with no copy already fails at registry build (every
  // rule spreads `copyFor(id)` into its definition), so the direction this
  // catches is the other one: an entry left behind by a rule that was renamed
  // or removed, which nothing else would notice.
  it("covers every rule the registry builds, and nothing else", () => {
    for (const rule of RULES) {
      expect(() => copyFor(rule.id), rule.id).not.toThrow();
    }
    expect(Object.keys(ISSUE_COPY).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  it("has one entry per rule and no duplicates", () => {
    expect(Object.keys(ISSUE_COPY).length).toBe(RULES.length);
    expect(RULES.length).toBeGreaterThan(90);
  });

  it("every entry has substantive, client-facing text", () => {
    for (const [id, c] of Object.entries(ISSUE_COPY)) {
      expect(c.title.length, `${id} title`).toBeGreaterThan(5);
      expect(c.explanation.length, `${id} explanation`).toBeGreaterThan(40);
      expect(c.howToFix.length, `${id} howToFix`).toBeGreaterThan(30);
    }
  });
});

// ==========================================================================
// RESPONSE CODES AND LINKS
// ==========================================================================

describe("copy: response codes and links", () => {
  // The owner's complaint that split CHECK-11 in two: "Internal links point to
  // a URL that returns an error" names no error. Each rule names its status
  // class in the title and its members in the prose, and a title that drifts
  // back to "an error" fails here.
  it("names the status class in both broken-link titles, and its members in the prose", () => {
    const fourXx = copy("links.broken-internal");
    expect(fourXx.title).toContain("4xx");
    expect(fourXx.title).toMatch(/client error/i);
    for (const status of ["404", "410"]) {
      expect(fourXx.explanation, `4xx explanation names ${status}`).toContain(status);
    }
    // 401/403/429 are `blocked`, never `client_error`, so they are NOT in this
    // report — the copy must say where they went rather than list them as members.
    expect(fourXx.explanation).toMatch(/401, 403 or 429 are reported under/i);

    const fiveXx = copy("links.to-server-error");
    expect(fiveXx.title).toContain("5xx");
    expect(fiveXx.title).toMatch(/server error/i);
    for (const status of ["500", "502", "503", "504"]) {
      expect(fiveXx.explanation, `5xx explanation names ${status}`).toContain(status);
    }
  });

  // The 5xx link rule must not re-decide whether the error persisted — that is
  // the linked URL's own finding's subject — and it may not promise the second
  // look happened: the re-check has a budget and a "not run" state, so "every
  // 5xx was asked again" is a claim the engine does not keep.
  it("links.to-server-error points at the re-check without promising it ran", () => {
    const c = copy("links.to-server-error");
    expect(c.explanation).toMatch(/requested again|asked again|second time|re-check/i);
    expect(c.explanation).toMatch(/re-check|confirmed|not made/i);
    expect(c.explanation).not.toMatch(/\bEvery 5xx\b/);
  });

  // The 5xx rule reports FOUR outcomes of the end-of-crawl second request, and
  // one of them is "no second look was made". Copy naming only the confirmed
  // case would present a state the engine explicitly records as unknown.
  it("http.server-error says the second look has outcomes, one of them 'not run'", () => {
    const c = copy("http.server-error");
    expect(c.explanation).toMatch(/second (?:time|request|look)|requested a second/i);
    expect(c.explanation, "inconclusive").toMatch(/inconclusive/i);
    expect(c.explanation, "capped").toMatch(/capped|budget/i);
    expect(c.explanation, "not run").toMatch(/not run|no second look/i);
  });

  // The only rule in the ruleset whose subject is TWO observations. Copy
  // reporting only the second one would tell a client nothing happened.
  it("http.server-error-transient says the URL failed once and serves now", () => {
    const c = copy("http.server-error-transient");
    expect(c.explanation, "the failure").toMatch(/5xx/);
    expect(c.explanation, "and the recovery").toMatch(
      /normal response|answered normally|served|recovered/i,
    );
    expect(c.explanation, "the two are separated in time").toMatch(
      /again at the end|when requested again|second/i,
    );
    // Not permanently broken, and not nothing either.
    expect(c.explanation).toMatch(/intermittent|not permanently broken/i);
  });

  // `crawl.blocked` describes how the crawl was RECEIVED. Whether Googlebot
  // meets the same wall is a separate question, and copy that answered it would
  // be reporting our user agent's experience as the site's indexability.
  it("crawl.blocked reports the crawler's reception, not the site's indexability", () => {
    const c = copy("crawl.blocked");
    expect(c.explanation, "the statuses it fires on").toMatch(/401|403|429/);
    expect(c.explanation, "and the challenge page").toMatch(/challenge|bot/i);
    expect(c.explanation, "nothing could be checked").toMatch(/nothing.*could be checked|not audited/i);
    expect(c.explanation, "search engines are a separate question").toMatch(
      /separate question|whether search engine/i,
    );
  });

  // The orphan rule cannot see a link from a URL the crawl never fetched, and
  // the evidence carries that count for exactly this reason.
  it("links.orphan says an unfetched URL could have been the missing link", () => {
    const c = copy("links.orphan");
    expect(c.explanation, "the cohort").toMatch(/indexable/i);
    expect(c.explanation, "self-links").toMatch(/self-link/i);
    expect(c.explanation, "the sitemap is not a link").toMatch(/sitemap/i);
    expect(c.explanation, "the unfetched caveat").toMatch(
      /could not fetch|not fetched|unfetched/i,
    );
  });

  // The marker beside it: it reports the crawl's own limit, and reporting that
  // limit as orphans is the always-passes defect hard rule 1 is about.
  it("links.orphan-skipped reports the crawl's limit, not a site fault", () => {
    const c = copy("links.orphan-skipped");
    expect(c.explanation).toMatch(/page limit|did not reach|unfetched|not reach every URL/i);
    expect(c.explanation).toMatch(/left unrun|rather than report/i);
    expect(c.howToFix).toMatch(/re-run|resume|re-crawl/i);
  });
});

// ==========================================================================
// SITEMAPS AND ROBOTS
// ==========================================================================

describe("copy: sitemaps and robots", () => {
  // The engine never probes /sitemap.xml speculatively (a Phase 1 ruling), so
  // the only sitemaps it can see are the ones robots.txt declares. "This site
  // has no sitemap" is a claim the rule cannot support: a sitemap nobody
  // declares is exactly the site this fires on.
  it("sitemap.missing claims an absent declaration, not an absent file", () => {
    const c = copy("sitemap.missing");
    expect(c.title, "the title says where the declaration is missing from").toMatch(
      /robots\.txt/i,
    );
    expect(c.explanation, "and says a sitemap may still exist").toMatch(
      /may still have a sitemap|still have one|may exist/i,
    );
    const overclaim =
      /(?:site|there) (?:has|have|is|are) no sitemap|no sitemap (?:exists|at all|on (?:this|the) site)|does not have a sitemap/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });

  // `robotsUnreadable` lets `outcome === "absent"` through, so the rule also
  // fires on a site that serves no robots.txt at all. Copy speaking only of "a
  // robots.txt with no Sitemap: line" would describe a file that is not there,
  // and its fix would tell a client to edit it.
  it("sitemap.missing covers the site that serves no robots.txt either", () => {
    const c = copy("sitemap.missing");
    expect(`${c.explanation} ${c.howToFix}`).toMatch(
      /no robots\.txt|serves none|serves no robots/i,
    );
  });

  // The rule fires on every non-200, non-redirect status, and `blocked` (401,
  // 403, 429) is one of them. "Restore the page or remove the entry" is the
  // wrong instruction for a URL a WAF is defending, so the fix branches.
  it("sitemap.non-200 tells blocked apart from gone", () => {
    const fix = copy("sitemap.non-200").howToFix;
    expect(fix).toMatch(/\b410\b/);
    expect(fix).toMatch(/\b403\b/);
    expect(fix).toMatch(/\b429\b/);
    expect(fix).toMatch(/WAF|bot protection|bot-protection|allowlist/i);
  });

  // THREE causes, and the third is not a variant of the other two: the frontier
  // gates every candidate on `isSameOrigin`, so a listed URL outside the crawl's
  // origin was never attempted BY DESIGN. A page limit, a robots disallow and a
  // failed request are all untrue of it, so it is named, and it has a remedy of
  // its own rather than sharing "re-run with a higher page limit".
  it("sitemap.uncrawled names the off-origin cause and gives it its own remedy", () => {
    const c = copy("sitemap.uncrawled");
    expect(c.explanation, "the on-site limit").toMatch(/page or depth limit|page limit|robots\.txt/i);
    expect(c.explanation, "the off-origin cause is named").toMatch(
      /outside the crawl|another host|off-origin/i,
    );
    expect(c.explanation, "and named as deliberate, not as a limit").toMatch(
      /by design|not fetched by design|deliberate/i,
    );
    expect(c.explanation, "and the request that got no answer").toMatch(/no (?:usable )?response|never answered/i);
    expect(c.howToFix, "the remedy is addressed to the off-origin case").toMatch(/off-origin/i);
    expect(c.howToFix, "and it does not ask for a bigger crawl for it").toMatch(
      /need nothing|needs nothing|nothing is wrong/i,
    );
    // The other two causes keep their own remedies.
    expect(c.howToFix, "the limit case survives").toMatch(/higher page limit/i);
    expect(c.howToFix, "the failed-fetch case survives").toMatch(/request .*yourself/i);
  });

  // The rule fires on `outcome === "absent"`, which is the site ANSWERING with
  // a 4xx. A server that could not serve robots.txt is a different finding
  // (`robots.check-skipped`), and copy blurring the two would tell a client to
  // write a file they may already have.
  it("robots.missing does not treat a server failure as an absent file", () => {
    const c = copy("robots.missing");
    const blurred = /unreachable|could not be (?:fetched|reached|read)|timed out|server error/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(blurred);
    expect(c.explanation, "it names the answer it got").toMatch(/not[- ]found|404/i);
  });

  // …and the sibling that owns the unreachable case says which two shapes it
  // covers, one of which is a file too big to read in full.
  it("robots.check-skipped owns the unreadable case and names the read limit", () => {
    const c = copy("robots.check-skipped");
    expect(c.explanation).toMatch(/did not serve|could not be fetched|not available/i);
    expect(c.explanation, "the 500KB read").toMatch(/500\s?KB/i);
    expect(c.explanation, "the checks were left unrun").toMatch(/unrun|not run|left/i);
  });

  // A blocked sitemap URL is not a page we judged: it is a URL nobody may read.
  it("robots.blocks-sitemap-urls names the Disallow line it read", () => {
    const c = copy("robots.blocks-sitemap-urls");
    expect(c.explanation).toMatch(/Disallow/);
    expect(c.explanation).toMatch(/user agent|user-agent/i);
  });

  // Every sitemap-hygiene rule reports a URL the sitemap NAMES. The three
  // non-indexable variants must each say which state they cover, or a reader
  // meeting three findings for one URL cannot tell them apart.
  it("the three sitemap hygiene rules each name their own state", () => {
    expect(copy("sitemap.non-200").title).toMatch(/3xx|4xx|5xx|non-200/i);
    expect(copy("sitemap.non-indexable").title).toMatch(/noindex/i);
    expect(copy("sitemap.redirected").title).toMatch(/redirect/i);
    expect(copy("sitemap.non-indexable").explanation).toMatch(
      /robots meta|X-Robots-Tag|noindex/i,
    );
    expect(copy("sitemap.redirected").explanation).toMatch(/redirect/i);
  });

  // A sitemap that could not be parsed is a document, not a page, and the fix
  // has to say what a valid one looks like.
  it("sitemap.invalid names what made the document unreadable", () => {
    const c = copy("sitemap.invalid");
    expect(c.explanation).toMatch(/urlset|sitemapindex/i);
    expect(c.explanation).toMatch(/XML/);
    expect(c.howToFix).toMatch(/urlset|sitemapindex|XML/i);
  });

  // Not every absence from a sitemap is a defect — plenty of URLs are left out
  // on purpose — so the copy has to leave the judgement with the reader.
  it("pages.not-in-sitemap allows the deliberate omission", () => {
    const c = copy("pages.not-in-sitemap");
    expect(`${c.explanation} ${c.howToFix}`).toMatch(/deliberate|intentional|on purpose/i);
  });
});

// ==========================================================================
// CANONICALS, DIRECTIVES AND HREFLANG
// ==========================================================================

describe("copy: canonicals, directives and hreflang", () => {
  // A cross-host canonical is right for syndicated content and wrong for
  // everything else: the rule detects the shape, not the intent.
  it("canonical.cross-domain reports a shape and asks whether it was meant", () => {
    const c = copy("canonical.cross-domain");
    expect(c.explanation).toMatch(/different host|another host/i);
    expect(c.explanation, "the legitimate case").toMatch(/syndicat/i);
    expect(c.howToFix).toMatch(/confirm|intended/i);
  });

  // `indexability.noindex` is listed for review. Copy calling it an error would
  // report every thank-you page on the site as a fault.
  it("indexability.noindex is listed for review, not as an error", () => {
    const c = copy("indexability.noindex");
    expect(c.explanation).toMatch(/intentional|deliberate|for review|not as an error/i);
    expect(c.howToFix).toMatch(/No action|Nothing|if the exclusion is deliberate/i);
  });

  // §4 of the audit accuracy design. Return-link judges only an alternate the
  // crawl FETCHED; the alternates it did not fetch are a separate, reported
  // silence. Copy that left this out would read as a complete verdict on an
  // international setup half of which was never requested.
  it("the hreflang copy states which alternates were judged and which were not", () => {
    const returnLink = copy("hreflang.missing-return-link");
    expect(returnLink.explanation, "judged: the crawled alternates").toMatch(
      /which was crawled|that was crawled|crawled/i,
    );
    expect(returnLink.explanation, "not judged: reported separately").toMatch(
      /not crawled|separately|not checked/i,
    );
    expect(returnLink.explanation, "why reciprocity matters").toMatch(/reciprocal|both ways/i);

    const self = copy("hreflang.missing-self-reference");
    expect(self.explanation, "the page's own URL is the subject").toMatch(/own URL/i);
    expect(self.explanation, "and the whole set is discarded").toMatch(/discard/i);
    // The engine stores no language for a page, so no copy may say which
    // alternate stands in for it.
    expect(self.explanation).not.toMatch(/own language code|own-language/i);

    const marker = copy("hreflang.alternates-not-crawled");
    expect(marker.explanation, "what was not done").toMatch(/not crawled|not fetched|were not/i);
    expect(marker.explanation, "what could not be judged").toMatch(/nothing is known|could not be checked/i);
    expect(marker.explanation, "and that this is not a site fault").toMatch(
      /not crawled by design|not that anything is wrong/i,
    );
    expect(marker.howToFix).toMatch(/crawl/i);
  });

  // The rule is per SET: it fires once per distinct cluster of alternates, not
  // once for the crawl and not once per page.
  it("hreflang.missing-x-default speaks about a cluster, not a site or a page", () => {
    const c = copy("hreflang.missing-x-default");
    const wrongScope = /this (?:crawl|site|page)|the whole site|site-wide/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(wrongScope);
    expect(c.explanation).toMatch(/set|versions/i);
  });

  // The predicate is `fetchClass === "redirect" || (auditable && !isIndexable)`,
  // and for a fetched 200 the second arm is exactly noindex. Copy naming a 4xx
  // or a canonicalised target would describe a rule that does not ship.
  it("hreflang.non-indexable-target names the two states it fires on", () => {
    const c = copy("hreflang.non-indexable-target");
    expect(c.explanation).toMatch(/redirect/i);
    expect(c.explanation).toMatch(/noindex/i);
    expect(c.explanation, "the alternate was crawled").toMatch(/crawled/i);
  });

  it("hreflang.invalid-code points at the standard rather than guessing the value", () => {
    const c = copy("hreflang.invalid-code");
    expect(c.howToFix).toMatch(/ISO 639/);
    expect(c.howToFix).toMatch(/ISO 3166/);
    expect(c.howToFix).toMatch(/x-default/);
  });
});

// ==========================================================================
// ON-PAGE AND CONTENT
// ==========================================================================

describe("copy: on-page and content", () => {
  // The on-page thresholds are asserted against the rule constants themselves,
  // so copy and rule cannot drift apart: change TITLE_MIN and this fails until
  // the prose is changed with it.
  it("quotes the on-page thresholds the rules actually use", () => {
    expect(copy("title.too-short").explanation).toContain(`${TITLE_MIN} characters`);
    expect(copy("title.too-long").explanation).toContain(`${TITLE_MAX} characters`);
    expect(copy("meta-description.too-short").explanation).toContain(`${META_MIN} characters`);
    expect(copy("meta-description.too-long").explanation).toContain(`${META_MAX} characters`);
    expect(copy("content.thin").explanation).toContain(`${THIN_WORDS} words`);
  });

  it("quotes the meta description range, not just its ends, in the fixes", () => {
    expect(copy("meta-description.missing").howToFix).toContain(`${META_MIN} to ${META_MAX}`);
    expect(copy("meta-description.too-short").howToFix).toContain(`${META_MIN} to ${META_MAX}`);
  });

  // Same contract for the two technical numbers. Word-bounded: a bare
  // `toContain("5 links")` would also pass against "15 links". `SLOW_MS` is
  // quoted with the space a client reads ("1500 ms"), so the pin allows it.
  it("quotes the technical thresholds the rules actually use", () => {
    expect(copy("performance.slow-response").explanation).toMatch(
      new RegExp(`(?<![0-9])${SLOW_MS} ?ms\\b`),
    );
    expect(copy("performance.slow-response").explanation, "and that it is TTFB").toMatch(
      /start responding|first byte/i,
    );
    expect(copy("structure.deep-page").explanation).toMatch(
      new RegExp(`(?<![0-9])${DEEP_DEPTH} links\\b`),
    );
  });

  // The title and description rules cut by PIXEL width at the search engine's
  // end; the character count is a working guide. Copy stating it as a hard
  // limit would have a client trimming a title that was never truncated.
  it("the length rules call the character count a guide, not a limit", () => {
    for (const id of ["title.too-long", "meta-description.too-long"]) {
      expect(copy(id).explanation, id).toMatch(/pixel|working guide|guide rather than/i);
    }
  });

  // The guards below are negative on purpose. A positive `toContain` still
  // passes when someone APPENDS an overpromise to text that already says the
  // right thing, so the forbidden claim is what has to be asserted against.
  it("content.placeholder claims only the literal phrase it detects", () => {
    const c = copy("content.placeholder");
    // The analyzer matches /lorem ipsum/i in visible text and nothing else.
    expect(`${c.title} ${c.explanation}`.toLowerCase()).toContain("lorem ipsum");
    const widened =
      /\bTODO\b|\bTBC\b|dummy (?:text|copy|content|name)|placeholder (?:of any kind|text such as)|generic placeholder|any placeholder/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(widened);
  });

  // …and the reason the finding quotes the sentence it matched: the match is
  // frequently not in the body copy at all.
  it("content.placeholder says the match is quoted and often not in the body", () => {
    const c = copy("content.placeholder");
    expect(c.explanation).toMatch(/quotes up to 160 characters|quotes/i);
    expect(`${c.explanation} ${c.howToFix}`).toMatch(/excerpt|summary|description/i);
  });

  it("images.missing-dimensions claims the absent attribute, not proven CLS", () => {
    const c = copy("images.missing-dimensions");
    expect(c.explanation).toContain("attribute");
    // An empty attribute counts as present and CSS may already reserve the
    // space, so layout shift may not be happening at all.
    const certainty =
      /is shifting|causes layout shift|will shift|will cause layout shift|results in layout shift|creates layout shift/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(certainty);
    expect(c.explanation, "the CSS caveat").toMatch(/unless CSS|CSS reserves/i);
  });

  it("mobile.viewport-missing speaks only to the absent tag", () => {
    // The rule fires on `!hasViewport`. It knows nothing about the contents of
    // a viewport tag that does exist.
    const misconfigured =
      /misconfigured|incorrectly configured|incorrect viewport|wrong viewport|badly configured|invalid viewport/i;
    expect(whole("mobile.viewport-missing")).not.toMatch(misconfigured);
  });

  it("headings.h1-multiple does not claim a ranking penalty", () => {
    const c = copy("headings.h1-multiple");
    // Multiple H1s are valid HTML and are not a ranking problem; the finding is
    // about the outline and the likely templating accident.
    const overclaim =
      /dilut|penalt|hurts? (?:your )?rank|lower(?:s|ing)? (?:your )?rank|damages? (?:your )?rank/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
    expect(c.explanation, "it says the markup is valid").toMatch(/valid HTML|accident/i);
  });

  // Same contract as the on-page thresholds: the numbers in the content copy
  // are the rules' own constants, so changing one fails here until the prose
  // changes with it.
  it("quotes the content thresholds the rules actually use", () => {
    const soft = copy("content.soft-404");
    expect(soft.explanation).toMatch(new RegExp(`(?<![0-9])${SOFT_404_WORDS}\\b`));
    // And WHICH 300 words: the ceiling is applied to the RENDERABLE count, so a
    // short error message inside a full site shell is still short. Copy leaving
    // this out would describe a rule that fires far less often than it does on
    // exactly the sites where it matters most.
    expect(soft.explanation, "the renderable count").toMatch(/renderable/i);
    // The other half of the same rule, which either signal can fire on its own:
    // `TEMPLATE_HAMMING` bits against the site's own not-found body.
    expect(soft.explanation, "the fingerprint arm").toMatch(
      new RegExp(`${TEMPLATE_HAMMING} (?:bits )?of 64`, "i"),
    );

    const near = copy("content.near-duplicate");
    expect(near.explanation, "the distance").toMatch(
      new RegExp(`${NEAR_DUPLICATE_HAMMING} (?:bits )?of 64`, "i"),
    );
    // Phase 19 §2's floor. A reader who does not know that two thin pages are
    // never paired here will go looking for the pairs that are missing.
    expect(near.explanation, "the own-words floor").toMatch(
      new RegExp(`(?<![0-9])${NEAR_DUPLICATE_MIN_MAIN_WORDS} words\\b`),
    );
    // And the per-page COUNT cap. A count presented as exact when it is a floor
    // is hard rule 1's defect one level down: the copy says where counting
    // stops, and says the number the rule actually stops at.
    expect(near.explanation, "the count cap").toMatch(
      new RegExp(`exact(?:ly)?(?: up to)? ${NEAR_DUPLICATE_COUNT_CAP}\\b`, "i"),
    );
  });

  // §1 and §2 of the audit accuracy design: the fingerprint is over the MAIN
  // content, and a page that has already declared a canonical elsewhere has
  // done what the fix asks and is not reported.
  it("the content copy says what the duplicate rules now measure and skip", () => {
    const near = copy("content.near-duplicate");
    expect(near.explanation, "the fingerprint's subject").toMatch(/main content/i);
    expect(near.explanation, "what it excludes").toMatch(
      /header, navigation|navigation.*footer/i,
    );
    expect(copy("content.exact-duplicate").explanation).toMatch(/canonical/i);
    expect(`${near.explanation} ${near.howToFix}`).toMatch(/canonical/i);
  });

  // The near-duplicate rule measures a distance between two content
  // fingerprints. It knows nothing about who wrote what, and near-duplicate
  // pages carry no ranking penalty — the finding is about consolidation.
  it("content.near-duplicate claims similarity, not plagiarism or a penalty", () => {
    const c = copy("content.near-duplicate");
    const overclaim =
      /plagiaris|scraped|stolen|copied from|duplicate content penalt|penalis|penaliz|will be penal/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
    expect(c.howToFix, "the remedy is consolidation").toMatch(/merge|consolidat|canonicalise/i);
  });

  // The soft-404 rule fires on EITHER signal. Copy saying both are needed would
  // describe a rule half as sensitive as the one that ships, and copy claiming
  // the page was proved missing would overstate what a similarity measurement
  // and a word count can establish.
  it("content.soft-404 does not make either signal a requirement", () => {
    const c = copy("content.soft-404");
    expect(c.explanation).toContain("200");
    expect(c.explanation, "the two arms are alternatives").toMatch(/\bor\b/);
    const bothRequired =
      /both signals|only when both|and also matches|must (?:also )?match the|combination of both/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(bothRequired);
  });

  // The marker's own contract, which every member of the family carries: it
  // reports the limit of a crawl, and nothing in it may read as a fault found
  // on the site.
  it("content.near-duplicate-skipped reports a crawl, never a site fault", () => {
    const c = copy("content.near-duplicate-skipped");
    expect(c.explanation, "why the check could not run").toMatch(/fingerprint/i);
    expect(c.explanation, "and that an empty list is not a clean site").toMatch(
      /rather than reported clean|rather than reported as clean|not.*clean/i,
    );
    expect(c.howToFix).toMatch(/re-crawl/i);
    const verdict =
      /the site has|your pages are|these pages are duplicat|near-duplicate content was found|the site is (?:fine|clean|healthy)/i;
    expect(whole("content.near-duplicate-skipped")).not.toMatch(verdict);
  });

  // Its twin, for the thin-content floor: the same silence, and the reason it
  // could not be answered from the whole-document word count instead.
  it("content.thin-skipped says why the document word count was not a substitute", () => {
    const c = copy("content.thin-skipped");
    expect(c.explanation).toMatch(/own content|own words/i);
    expect(c.explanation, "the shared chrome argument").toMatch(/chrome|shared|whole-document/i);
    expect(c.explanation).toMatch(/rather than reported clean|rather than reported as clean/i);
    expect(c.howToFix).toMatch(/re-crawl/i);
  });

  // `content.thin` counts a page's OWN words — the main area, or what is left
  // once header, navigation, sidebar and footer are removed — and the finding
  // shows both numbers so a reader can see the template's share.
  it("content.thin says which words it counted and shows the document total beside them", () => {
    const c = copy("content.thin");
    expect(c.explanation).toMatch(/own content|own words|of their own/i);
    expect(c.explanation, "what own means").toMatch(/main|header, navigation|footer/i);
    expect(c.explanation, "the second number").toMatch(/whole-document|document word count/i);
  });

  // The three duplicate-group rules share one evidence shape — the duplicated
  // value, the exact size of the group, and a capped sample of its URLs — and a
  // reader who cannot tell the count from the list will read a twenty-URL
  // sample as the whole problem.
  it("the field-duplicate copy names the value, the count and the capped URL list", () => {
    const fields: Record<string, RegExp> = {
      "title.duplicate": /title/i,
      "meta-description.duplicate": /description/i,
      "h1.duplicate-text": /H1/,
    };
    for (const [id, value] of Object.entries(fields)) {
      const text = copy(id).explanation;
      expect(text, `${id}: the duplicated value`).toMatch(value);
      expect(text, `${id}: the count of the group`).toMatch(/number of (?:distinct )?pages/i);
      expect(text, `${id}: the capped list`).toMatch(
        new RegExp(`up to ${DUPLICATE_SAMPLE_URLS} of their URLs`, "i"),
      );
      // And the cohort, because a client checking the finding against their own
      // site will otherwise count noindexed and redirecting URLs too.
      expect(text, `${id}: the cohort`).toMatch(/indexable/i);
    }
    expect(DUPLICATE_SAMPLE_URLS).toBe(20);
  });

  // Exact equality after trimming is the whole claim. Copy implying the engine
  // spotted SIMILAR titles would describe a measurement it did not make, and
  // duplicate titles carry no penalty of their own — the cost is that the pages
  // stop distinguishing themselves.
  it("the field-duplicate copy claims exact repetition, not similarity or a penalty", () => {
    for (const id of ["title.duplicate", "meta-description.duplicate", "h1.duplicate-text"]) {
      expect(copy(id).explanation, id).toMatch(/identical|word for word/i);
      const overclaim =
        /\bsimilar|near-identical|almost the same|penalis|penaliz|will be penal|duplicate content penalt/i;
      expect(`${copy(id).explanation} ${copy(id).howToFix}`, id).not.toMatch(overclaim);
    }
    // And the heading rule says which heading it read: the column holds the
    // FIRST h1 only, so copy speaking of "the headings on these pages" would be
    // describing data the rule never sees.
    expect(copy("h1.duplicate-text").explanation).toMatch(/first H1/i);
  });

  // The skip's copy is about the CRAWL: a site with no duplicate headings and a
  // crawl that never read a heading share one silence, and only one of them is
  // good news.
  it("h1.duplicate-skipped explains the crawl and the remedy, and claims nothing", () => {
    const c = copy("h1.duplicate-skipped");
    expect(c.title, "the title says the check did not run").toMatch(
      /not checked|not run|could not be run/i,
    );
    expect(c.explanation, "what is missing").toMatch(/no H1 text|stored no H1|heading text/i);
    expect(c.explanation, "though the pages have H1s").toMatch(/carry H1|H1 elements/i);
    expect(c.explanation, "not reported clean").toMatch(
      /rather than reported clean|rather than reported as clean/i,
    );
    expect(c.howToFix).toMatch(/re-crawl/i);
  });
});

// ==========================================================================
// STRUCTURED DATA
// ==========================================================================

describe("copy: structured data", () => {
  // The breadcrumb copy names the size of site it is advice for, and that
  // number is the rule's own floor. The gate is
  // `indexablePages < BREADCRUMB_PAGE_FLOOR`, so the floor is INCLUSIVE and a
  // site of exactly five pages fires: "more than five" would describe a rule
  // one page less sensitive than the one that ships.
  it("quotes the breadcrumb page floor the rule actually uses, inclusively", () => {
    const c = copy("schema.breadcrumb-absent");
    expect(c.explanation).toMatch(
      new RegExp(`\\bat least ${BREADCRUMB_PAGE_FLOOR} indexable(?:, self-canonical)? pages\\b`),
    );
    expect(c.explanation).not.toMatch(new RegExp(`\\bmore than ${BREADCRUMB_PAGE_FLOOR}\\b`));
  });

  // The crawler reads JSON-LD and nothing else, so a site marked up in
  // microdata or RDFa is invisible to these rules. Copy saying a site has no
  // structured data, flatly, would be a claim about markup nobody looked at.
  it("the site-scoped schema copy claims JSON-LD, not every markup format", () => {
    for (const id of ["schema.none-on-site", "schema.breadcrumb-absent"]) {
      const c = copy(id);
      expect(`${c.title} ${c.explanation}`, id).toContain("JSON-LD");
      const overclaim =
        /(?:has|have|uses?|carr(?:y|ies)) no structured data(?! .{0,20}JSON-LD)|no structured data (?:at all|of any kind|anywhere on the site\.)|no markup of any kind/i;
      expect(`${c.explanation} ${c.howToFix}`, id).not.toMatch(overclaim);
    }
    // And the site-wide rule says so outright, since it is the one whose
    // silence a client would read as "we have no markup".
    expect(copy("schema.none-on-site").explanation).toMatch(/microdata|RDFa/i);
  });

  // The presence blob behind the Product finding is the union across the page's
  // Product blocks, so a field it names is missing from ALL of them. Copy about
  // "the Product block" would misdescribe a page carrying several.
  it("schema.product-incomplete speaks about the page's blocks, not one block", () => {
    const c = copy("schema.product-incomplete");
    expect(c.explanation).toMatch(/across all its Product blocks|all of the page's Product/i);
    const singular = /your Product block\b|the Product block on this page\b/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(singular);
    // The two field rulings a reader would otherwise dispute: an offers block
    // counts only with a price, and any GTIN length counts.
    expect(c.explanation, "the offers ruling").toMatch(/price|priceSpecification/);
    expect(c.explanation, "the gtin ruling").toMatch(/gtin/i);
  });

  // The self-serving finding is a statement about which snippets Google shows.
  // It is not an accusation that the reviews are fabricated, and there is no
  // penalty attached to publishing them.
  it("schema.self-serving-reviews claims a policy, not fake reviews or a penalty", () => {
    const c = copy("schema.self-serving-reviews");
    expect(`${c.title} ${c.explanation}`, "it names the policy").toMatch(
      /policy|self-serving/i,
    );
    expect(c.explanation, "and what actually happens").toMatch(/does not show|not shown|no stars/i);
    const overclaim =
      /fake|fraudulent|fabricat|manual action|penalt|penalis|penaliz|will be penal/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
    // The two types it reads, and only those two.
    expect(c.explanation).toMatch(/Organization/);
    expect(c.explanation).toMatch(/LocalBusiness/);
  });
});

// ==========================================================================
// IMAGES AND RESOURCES
// ==========================================================================

describe("copy: images and resources", () => {
  // The resource threshold, pinned against the rule's own constant the way the
  // on-page ones are. It is quoted with a thousands separator because that is
  // how a client reads a byte count, so the pin formats the constant rather
  // than matching its digits.
  it("quotes the image weight threshold the rules actually use", () => {
    const bytes = IMAGE_WEIGHT_WARN.toLocaleString("en-US");
    expect(bytes).toBe("100,000");
    expect(copy("images.oversized").title).toContain(bytes);
    expect(copy("images.oversized").explanation).toContain(`${bytes} bytes`);
    expect(copy("images.legacy-format").title).toContain(bytes);
    expect(copy("images.legacy-format").explanation).toContain(`${bytes} bytes`);
  });

  // The two SAMPLE CAPS the resource copy words, pinned against the rules' own
  // constants exactly as the threshold above is. A capped sample read as a
  // complete list is the misreading these numbers exist to prevent, so the copy
  // says how long the list is — and says the number the rule actually cuts at.
  //
  // THE CHECKLIST RIDES THESE PINS TOO. `skills/ariadne-audit/checklist.md`
  // quotes the same two numbers in CHECK-50 and CHECK-51, in prose an agent
  // reads and repeats to a client, and it is the living authority (hard rule
  // 10) rather than a copy of the copy — so it is asserted against the same
  // constants here. Change a cap and this test names every place that moves.
  it("quotes the sample caps the resource rules actually apply", async () => {
    expect(BROKEN_SAMPLE_RESOURCES).toBe(10);
    expect(UNCACHED_SAMPLE_RESOURCES).toBe(20);

    expect(copy("resources.broken").explanation, "the broken-file sample").toMatch(
      new RegExp(`up to ${BROKEN_SAMPLE_RESOURCES} files`, "i"),
    );
    expect(copy("resources.uncached").explanation, "the uncached sample").toMatch(
      new RegExp(`up to ${UNCACHED_SAMPLE_RESOURCES}\\b`, "i"),
    );

    // Whitespace-collapsed before matching: the checklist is prose wrapped at
    // 80 columns, and a sentence that moves across a line break is not a change
    // to what it says. The NUMBER is what this pins; the checklist spells it.
    const capWords: Record<number, string> = { 10: "ten", 20: "twenty" };
    const checklist = (
      await readFile(new URL("../../skills/ariadne-audit/checklist.md", import.meta.url), "utf8")
    ).replace(/\s+/g, " ");
    expect(checklist, "CHECK-51 quotes the broken-file sample").toContain(
      `names up to ${capWords[BROKEN_SAMPLE_RESOURCES]} of the files`,
    );
    expect(checklist, "CHECK-50 quotes the uncached sample").toContain(
      `up to ${capWords[UNCACHED_SAMPLE_RESOURCES]} of them named`,
    );
  });

  // THE BOUNDARY THE WHOLE FAMILY RESTS ON, in the client-facing text rather
  // than only in the rules' headers: these are the references in the HTML the
  // server sent, and a file the crawl never got an answer for is UNKNOWN rather
  // than clean or broken. A client reading "no oversized images" about a site
  // that injects its images with JavaScript would otherwise be reading a
  // sentence about our evidence as a sentence about their site.
  //
  // The copy says it in one of two ways and each rule must say it one way or
  // the other: the rules whose finding is a COUNT state the completeness
  // boundary ("only images referenced in the HTML and answered by the server
  // are weighed"), and the rules whose finding is a LIST state the unknown one
  // ("files that were not asked about are counted as unknown, not broken").
  const EVIDENCE_LIMIT =
    /referenced in the HTML|in the HTML response|answered by the server|as unknown|never asked|not asked about|not weighed|unweighed|floor/i;

  it("every resource rule states the limit of what it looked at", () => {
    for (const id of [
      "resources.broken",
      "images.oversized",
      "images.legacy-format",
      "resources.uncached",
      "page.weight",
    ]) {
      expect(copy(id).explanation, `${id}: the evidence limit`).toMatch(EVIDENCE_LIMIT);
    }
  });

  // …and the three whose number invites a completeness reading name the served
  // HTML outright, because "100,000 bytes of images" quoted from a site that
  // injects its images with JavaScript is our evidence read as their site.
  it("the counting rules name the served HTML their references come from", () => {
    for (const id of ["images.oversized", "images.legacy-format", "page.weight"]) {
      expect(copy(id).explanation, `${id}: the served-HTML boundary`).toMatch(
        /referenced in the HTML|in the HTML response|HTML the server sent/i,
      );
    }
  });

  // "Unknown" as a word is cheap; what a reader needs is which states it
  // covers, because they are decisions (ours, the site's robots, a cap) rather
  // than faults — and one shape in particular is not a healthy file: a 200 with
  // a refusal reason beside it is bot protection answering in place of it.
  it("resources.broken names the reasons a file goes uncounted rather than broken", () => {
    const c = copy("resources.broken");
    expect(c.explanation, "never asked").toMatch(/not asked about|never asked/i);
    expect(c.explanation, "refused or disallowed").toMatch(/refused|disallow/i);
    expect(c.explanation, "no response").toMatch(/no response|never completed/i);
    expect(c.explanation, "counted as unknown, not broken").toMatch(
      /unknown, not broken|as unknown/i,
    );
    expect(c.explanation, "the refused 200").toMatch(/200 with a refusal reason/i);
  });

  // The measurement is metadata: a status, a content type, a byte count. The
  // crawl never decodes an image, so no copy here may claim anything about its
  // dimensions, its compression quality, or its size relative to the box it is
  // displayed in.
  it("the image copy claims transferred bytes, never a decoded image", () => {
    for (const id of ["images.oversized", "images.legacy-format"]) {
      const text = copy(id).explanation;
      const overclaim =
        /(?:is|are) (?:badly|poorly|over)[- ]?compressed|larger than (?:its|the) (?:layout|container|display)|wrong dimensions|its dimensions are/i;
      expect(text, id).not.toMatch(overclaim);
    }
    // The positive half for the weight rule, whose number invites the
    // misreading: it says what it did NOT open.
    expect(copy("images.oversized").explanation).toMatch(
      /dimensions and compression (?:quality )?are not examined|nothing here opens the image/i,
    );
    // And the byte count's provenance, which is the difference between a claim
    // and a measurement: `bytes_source` is `header` or `counted`, and a reader
    // who cannot tell them apart will quote a server's claim as our number.
    expect(copy("images.oversized").explanation).toMatch(
      /server-declared or measured|declared size is the server's claim/i,
    );
  });

  // A format is a CHOICE. The rule is info and its copy has to leave room for
  // the right answer, because PNG is correct for a screenshot.
  it("images.legacy-format offers a candidate rather than declaring a defect", () => {
    const c = copy("images.legacy-format");
    expect(`${c.explanation} ${c.howToFix}`, "where PNG is right").toMatch(
      /sharp[- ]edged|screenshot|Leave PNG/i,
    );
    const asDefect =
      /must (?:be )?convert|should not use|wrong format|outdated format|is a defect|replace (?:all|every)/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(asDefect);
  });

  // The caching rule reads two headers and nothing else, so it cannot say a
  // browser re-downloads the file — a CDN or an ETag may be doing that work
  // where the response says nothing.
  it("resources.uncached claims the absent header, not a proven re-download", () => {
    const c = copy("resources.uncached");
    expect(c.explanation).toMatch(/Cache-Control/);
    expect(c.explanation).toMatch(/Expires/);
    expect(c.explanation, "what it cannot see").toMatch(/ETag|edge caching/i);
    const overclaim =
      /(?:is|are) (?:re-?)?downloaded (?:again )?(?:on )?every (?:visit|request|page load)|never cached|no caching (?:is )?happen/i;
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(overclaim);
  });

  // The four resource markers, and the job each has that its siblings do not.
  // All four share one contract — they report the CRAWL, not a fault on the
  // site, and their silence is not a clean bill of health.
  it("resources.not-recorded reports a crawl that recorded no references at all", () => {
    const c = copy("resources.not-recorded");
    expect(c.title, "the title says the checks did not run").toMatch(/not run|not checked/i);
    expect(c.explanation, "the census is empty").toMatch(
      /recorded no image|no image, stylesheet or script references/i,
    );
    expect(c.explanation, "though the pages carry images").toMatch(/carry images|counted at least one image/i);
    expect(c.explanation, "not reported clean").toMatch(
      /rather than reported clean|rather than reported as clean/i,
    );
    expect(c.howToFix).toMatch(/re-crawl/i);
  });

  it("resources.not-fetched says the files were recorded AND unasked, and names all three reasons", () => {
    const c = copy("resources.not-fetched");
    expect(c.title, "the title says listed but not requested").toMatch(
      /not requested|never asked|listed but/i,
    );
    expect(c.explanation, "the census is real").toMatch(
      /recorded every image, stylesheet and script/i,
    );
    expect(c.explanation, "and nothing was asked").toMatch(/requested none of them/i);
    expect(c.explanation, "the operator's switch").toMatch(/turned off|switched off/i);
    expect(c.explanation, "the interrupted crawl").toMatch(/interrupted/i);
    expect(c.explanation, "the budget").toMatch(/budget/i);
    expect(c.explanation, "what the silence is not").toMatch(
      /Nothing is known|rather than a clean bill/i,
    );
    expect(c.howToFix).toMatch(/re-run|resume/i);
    // NEVER the other marker's sentence: this crawl recorded plenty.
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(
      /recorded no (?:files|resources)|no resource records|found no files/i,
    );
  });

  it("resources.all-unknown says the crawl asked and got nothing usable, and names the four states", () => {
    const c = copy("resources.all-unknown");
    expect(c.explanation, "the crawl asked").toMatch(/asked about|came back|tried to reach|was refused|recorded was/i);
    expect(c.explanation, "nothing usable came back").toMatch(/no usable answer|nothing.*usable|answered usably|got no response/i);
    expect(c.explanation, "our own policy").toMatch(/our own policy|the crawler's own policy/i);
    expect(c.explanation, "robots disallow").toMatch(/disallowed by robots\.txt/i);
    expect(c.explanation, "unreachable robots").toMatch(/robots\.txt was unreachable|whose robots\.txt was unreachable|robots\.txt that could not be fetched/i);
    expect(c.explanation, "a request that never completed").toMatch(/never completed|got no response/i);
    // The consequence a reader would otherwise misread as a light site.
    expect(c.explanation, "page weight beside it").toMatch(/HTML only|HTML and nothing else/i);
    expect(c.howToFix).toMatch(/crawl again|re-run the crawl/i);
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(
      /recorded no (?:files|resources)|no resource records/i,
    );
  });

  it("resources.partial-unknown says the crawl reached only some files, and names the four states", () => {
    const c = copy("resources.partial-unknown");
    expect(c.explanation, "only some reached").toMatch(/only some of the files|about only some/i);
    expect(c.explanation, "nothing usable came back").toMatch(/no usable answer|nothing.*usable|answered usably|got no response/i);
    expect(c.explanation, "the four states").toMatch(/refused/i);
    expect(c.explanation, "the four states").toMatch(/disallow/i);
    expect(c.explanation, "the four states").toMatch(/unreachable robots|robots\.txt/i);
    expect(c.explanation, "the four states").toMatch(/no response|never completed/i);
    expect(c.explanation, "what the silence is not").toMatch(
      /nothing to judge|not a verdict on the site|rather than a clean bill/i,
    );
    expect(c.howToFix).toMatch(/re-run the crawl|resume/i);
    expect(`${c.explanation} ${c.howToFix}`).not.toMatch(
      /recorded no (?:files|resources)|no resource records/i,
    );
  });
});

// ==========================================================================
// RENDERING AND PAGINATION
// ==========================================================================

describe("copy: rendering and pagination", () => {
  // The render diff rules' thresholds, pinned against the rules' own constants
  // exactly as the on-page ones are. These matter more than most: all three
  // fire on a COMPARISON, and copy quoting a threshold the rule does not use
  // would describe a different — usually more sensitive — rule than the one
  // that produced the finding a client is reading.
  it("quotes the render diff thresholds the rules actually use", () => {
    const csr = copy("content.csr-dependent").explanation;
    expect(CSR_WORD_MULTIPLE).toBe(2);
    expect(csr, "the ratio arm").toMatch(/at least twice/i);
    expect(csr, "the floor arm").toMatch(
      new RegExp(`(?<![0-9])${CSR_MIN_ADDED_WORDS}\\b`),
    );

    const nav = copy("nav.js-only").explanation;
    expect(nav, "the raw ceiling").toMatch(new RegExp(`fewer than ${NAV_RAW_MAX} links\\b`));
    expect(nav, "the rendered floor").toMatch(new RegExp(`at least ${NAV_RENDERED_MIN}\\b`));
    expect(NAV_RENDERED_MULTIPLE).toBe(2);
    expect(nav, "the ratio").toMatch(/more than twice as many|at least twice as many/i);

    const filters = copy("filters.js-only").explanation;
    expect(filters, "the rendered floor").toMatch(
      new RegExp(`at least ${FILTER_RENDERED_MIN}\\b`),
    );
    // The predicate is half the finding: a reader who cannot tell what counted
    // as a filter link cannot check the claim against their own page.
    expect(filters, "the `?` arm").toMatch(/query[- ]string/i);
    expect(filters, "the regex arm").toMatch(/filter, facet or sort/i);
  });

  // Google renders, on a schedule and a budget nobody outside Google can
  // measure. What these rules establish is that the content is not in the first
  // response, which is a cost and a risk rather than an invisibility. Asserted
  // negatively, because prose that already says the right thing can have the
  // overclaim appended to it.
  it("the render diff copy does not claim search engines cannot see the page", () => {
    for (const id of ["content.csr-dependent", "nav.js-only", "filters.js-only", "redirect.js"]) {
      const overclaim =
        /(?:search engines|google|crawlers) (?:cannot|can't|will never|do not|don't) (?:see|index|read|find)|invisible to (?:search engines|google)|never indexed|will not be indexed/i;
      expect(whole(id), id).not.toMatch(overclaim);
    }
  });

  // rel=next/rel=prev stopped being a discovery or consolidation signal in
  // 2019. The findings are about what the markup documents and about the HTML
  // links that are missing beside it.
  it("the pagination copy does not claim rel=next still consolidates a series", () => {
    for (const id of [
      "pagination.next-target-uncrawled",
      "pagination.next-not-linked",
      "pagination.canonical-to-other",
    ]) {
      const overclaim =
        /rel=next (?:tells|lets|helps|allows|asks) (?:search engines|google|crawlers)|(?:search engines|google|crawlers) use rel=next|consolidat\w+ (?:the )?series (?:with|through|via) rel=next/i;
      expect(whole(id), id).not.toMatch(overclaim);
    }
    // The positive half, on the rule whose whole point is the missing anchor.
    expect(copy("pagination.next-not-linked").explanation).toMatch(/anchor/i);
    expect(copy("pagination.next-not-linked").explanation).toMatch(/2019|no longer|not used/i);
  });

  // A series running past the edge of a bounded crawl is the ordinary case, and
  // the copy has to say that nothing needs doing about it. A fix that told a
  // client to correct every rel=next would send them after their own crawl
  // settings.
  it("pagination.next-target-uncrawled allows the bounded crawl as the usual cause", () => {
    const c = copy("pagination.next-target-uncrawled");
    expect(c.explanation).toMatch(/past the edge of the crawl|runs past|no record of/i);
    expect(c.howToFix).toMatch(/Nothing if|No action/i);
  });

  // The paginated-canonical rule fires only on a page that declares rel=prev,
  // and the trade-off it reports has two legitimate ends.
  it("pagination.canonical-to-other names rel=prev and leaves the decision open", () => {
    const c = copy("pagination.canonical-to-other");
    expect(c.explanation).toMatch(/rel=prev/);
    expect(c.howToFix).toMatch(/If the items|If the series|if/i);
  });

  // A JavaScript redirect is a 200 that moves. The claim is about what the HTTP
  // response said, not about whether the visitor arrives.
  it("redirect.js says the HTTP response showed no redirect", () => {
    const c = copy("redirect.js");
    expect(c.explanation).toMatch(/2xx|200/);
    expect(c.explanation).toMatch(/no redirect|HTTP response/i);
    expect(c.howToFix).toMatch(/301|302/);
  });
});

// ==========================================================================
// METRIC TABLES
// ==========================================================================

describe("copy: metric tables", () => {
  // The metric-copy contract: a reader can say what the table measured from the
  // text alone, so every COLUMN of the value shape appears in it. p95 was the
  // one the first draft left out — the number was in the evidence and nowhere
  // in the prose. Asserted for all three distributions, which share a shape.
  it("the distribution copy names every column of the shape, p95 included", () => {
    for (const id of [
      "inlinks.distribution",
      "structure.depth-distribution",
      "structure.click-depth-distribution",
      "content.metrics-by-type",
      "page.weight",
    ]) {
      const text = copy(id).explanation;
      expect(text, `${id}: the count`).toMatch(/\bcount\b/i);
      expect(text, `${id}: min and max`).toMatch(/\bmin\b.*\bmax\b|smallest and largest/i);
      expect(text, `${id}: the mean`).toContain("mean");
      expect(text, `${id}: p25/median/p75`).toContain("quartiles");
      expect(text, `${id}: p95`).toContain("95th percentile");
    }
  });

  // The ninth column, and the reason the click-depth metric exists in the shape
  // it does. A count of unreachable pages a reader meets with no prose behind
  // it is a number they will read as "no data" — the exact misreading that let
  // a site with 437 unreachable pages pass CHECK-31.
  it("the click-depth copy explains the unreachable bucket rather than just having one", () => {
    const c = copy("structure.click-depth-distribution");
    expect(c.explanation, "the bucket").toMatch(/unreachable|no link path/i);
    expect(c.explanation, "internal links only").toMatch(/internal link/i);
    expect(c.explanation, "a redirect ends the path").toMatch(/redirect/i);
    expect(c.howToFix, "the fix starts with them").toMatch(/unreachable/i);
  });

  // The other half of the same move: the metric that KEPT its data had to lose
  // the words "click depth", because the number it holds is a property of the
  // CRAWL — a title saying "click depth" over a column that counts sitemap
  // entries as zero hops is the defect Phase 7 removed.
  it("the discovery-depth copy claims the crawl, never a click path", () => {
    const c = copy("structure.depth-distribution");
    expect(c.title, "the title names discovery depth").toMatch(/discovery depth/i);
    expect(c.title, "and never click depth").not.toMatch(/click/i);
    expect(c.explanation, "whose property the number is").toMatch(
      /measures the crawl|of the crawl, not/i,
    );
    // Why it is flat on a sitemapped site, which is what a reader would
    // otherwise quote as good news.
    expect(c.explanation, "the sitemap's effect").toMatch(/sitemap/i);
    expect(c.explanation, "points at the metric that answers the click question").toMatch(
      /click depth/i,
    );
  });

  it("content.metrics-by-type names all three measures and what renderable excludes", () => {
    const text = copy("content.metrics-by-type").explanation;
    expect(text, "word count").toMatch(/word count/i);
    expect(text, "renderable word count").toMatch(/renderable word count/i);
    expect(text, "text ratio").toMatch(/text ratio/i);
    // A column called "renderable" is meaningless without the sentence that
    // says what it leaves out.
    expect(text, "what renderable excludes").toMatch(/markup[- ]hidden|hidden by markup|minus/i);
    expect(text, "the untyped bucket").toMatch(/untyped/i);
  });

  it("content.template-similarity names its columns, its thresholds and its sample", () => {
    const c = copy("content.template-similarity");
    const text = c.explanation;
    expect(text, "the distance and its scale").toMatch(/mean.*distance|distance in bits/i);
    expect(text, "0 identical, 64 unrelated").toMatch(/0 identical|64 unrelated/i);
    expect(text, "quartiles").toContain("quartiles");
    // The two shares, pinned against the rule's own constants.
    expect(TEMPLATE_NEAR_BITS).toBe(3);
    expect(TEMPLATE_LOOSE_BITS).toBe(8);
    expect(text, "the near share").toMatch(new RegExp(`within ${TEMPLATE_NEAR_BITS}`, "i"));
    expect(text, "the loose share").toMatch(new RegExp(`within ${TEMPLATE_LOOSE_BITS} bits`, "i"));
    // The sampling rule is part of the shape: a reader who cannot see it would
    // read a sample as a census.
    expect(TEMPLATE_SAMPLE_PAGES).toBe(200);
    expect(text, "the sampling rule").toMatch(
      new RegExp(`up to ${TEMPLATE_SAMPLE_PAGES} fingerprinted pages`, "i"),
    );
    expect(text, "how many pages and pairs each row saw").toMatch(/sampled/i);
    expect(text, "and the pairs").toMatch(/pairs/i);
  });

  // The plan's naming ruling, asserted negatively because that is the only
  // direction that holds: prose already saying "template similarity" can have
  // the other word appended and still pass a positive check. The metric
  // measures how alike two pages are; which parts of a page are worth reading
  // is a judgement it has not made.
  it("content.template-similarity is labelled template similarity and never the other word", () => {
    expect(whole("content.template-similarity")).not.toMatch(/boilerplate/i);
    expect(
      `${copy("content.template-similarity").title} ${copy("content.template-similarity").explanation}`.toLowerCase(),
    ).toContain("template");
  });

  it("hreflang.coverage names its three columns and claims declaration, not correctness", () => {
    const text = copy("hreflang.coverage").explanation;
    expect(text, "pagesWithHreflang").toMatch(/declare at least one hreflang/i);
    expect(text, "indexablePages").toMatch(/how many were measured|indexable 200 pages/i);
    expect(text, "coveragePct").toMatch(/percentage/i);
    // A page counts once however many alternates it names — the property that
    // makes the percentage a page share rather than an annotation count.
    expect(text, "counted once per page").toMatch(/counts once|once regardless/i);
    // And the claim it must NOT make: coverage counts pages that declare
    // something, not pages whose declarations are correct.
    const overclaim = /(?:sets|declarations) are (?:complete|correct|valid)|correctly configured/i;
    expect(text).not.toMatch(overclaim);
  });

  it("the link metrics quote the list caps they actually apply", () => {
    expect(EXTREMES_LIST_CAP).toBe(20);
    expect(copy("inlinks.extremes").explanation).toMatch(
      new RegExp(`(?<![0-9])${EXTREMES_LIST_CAP}\\b`),
    );
    // The tie-break is what makes two runs over one crawl name the same URLs.
    expect(copy("inlinks.extremes").explanation).toMatch(/ties|tie-break|broken by URL/i);

    expect(SOURCE_TYPE_CAP).toBe(25);
    expect(copy("inlinks.sources-by-type").explanation).toMatch(
      new RegExp(`(?<![0-9])${SOURCE_TYPE_CAP}\\b`),
    );
    // The rollup bucket is a KEY a reader meets in the table, so the copy names
    // it — and names the parenthesised spelling, which is what keeps it apart
    // from a template a client really called `other`.
    expect(OTHER_SOURCES).toBe("(other)");
    expect(copy("inlinks.sources-by-type").explanation).toContain(OTHER_SOURCES);
  });

  it("inlinks.distribution says what one inlink is and how a page with none counts", () => {
    const text = copy("inlinks.distribution").explanation;
    expect(text, "unique per linking page").toMatch(/unique/i);
    expect(text, "self-links").toMatch(/self-link/i);
    expect(text, "the zero case").toMatch(/no inlinks count as 0|count as 0|zero/i);
  });

  it("url.param-volumes names every column of its shape and its cap", () => {
    const text = copy("url.param-volumes").explanation;
    expect(text, "totalParams").toMatch(/how many distinct parameter names/i);
    expect(text, "trackingParams").toMatch(/tracking parameters/i);
    expect(text, "which ones count as tracking").toMatch(/utm_source|gclid/i);
    expect(text, "topParams").toMatch(/on the most URLs/i);
    expect(text, "parameterisedPages").toMatch(/query string/i);
    expect(text, "parameterisedIndexablePages").toMatch(/indexable/i);
    expect(TOP_PARAMS_CAP).toBe(20);
    expect(text, "the cap").toMatch(new RegExp(`(?<![0-9])${TOP_PARAMS_CAP} parameters`, "i"));
  });

  it("redirect.volume names every column and counts each redirecting URL once", () => {
    const text = copy("redirect.volume").explanation;
    expect(text, "redirectPages").toMatch(/returned a redirect/i);
    expect(text, "totalPages").toMatch(/out of all fetched|fetched URLs/i);
    expect(text, "ratioPct").toMatch(/percentage/i);
    // `redirectInlinks` is a second count of the same fact and reads as a
    // restatement unless the copy says what it counts: one redirecting URL in a
    // footer is one page and one link per page of the site.
    expect(text, "redirectInlinks").toMatch(/internal links point/i);
    expect(text, "chains and loops").toMatch(/chains and loops|chains and how many/i);
    expect(text, "counted once").toMatch(/counts once|counted once/i);
  });

  it("sitemap.structure names every column of both its shapes", () => {
    const text = copy("sitemap.structure").explanation;
    expect(text, "docs").toMatch(/how many documents|number of documents/i);
    expect(text, "totalUrls").toMatch(/total entries|entries/i);
    expect(text, "oversizedDocsSkipped").toMatch(/dropped for size|too large/i);
    expect(text, "urlCapBreaches").toMatch(/over the 50,000|past 50,000/i);
    // `entryCapReached` changes what every other number means, so it is copy
    // rather than a footnote.
    expect(text, "entryCapReached").toMatch(/entry cap|stopped collection/i);
    // Both caps are the rule's own constants.
    expect(SITEMAP_URL_CAP).toBe(50_000);
    expect(text, "the protocol cap").toContain(SITEMAP_URL_CAP.toLocaleString("en-US"));
    expect(SITEMAP_DOC_ROWS_CAP).toBe(50);
    expect(text, "the listing cap").toMatch(
      new RegExp(`largest ${SITEMAP_DOC_ROWS_CAP} documents`, "i"),
    );
    expect(text, "an entry in several documents").toMatch(/counted once/i);
  });

  // The Phase 5 metric, whose shape is two-sided — what the selection decided,
  // and what the page rows now hold. The prose names both sides and the reason
  // they can disagree, because a reader who takes them for one set of numbers
  // reads a legitimate difference as an error.
  it("render.coverage names every column of its shape and both of its sides", () => {
    const text = copy("render.coverage").explanation;
    expect(text, "pagesCrawled").toMatch(/pages crawled|how many pages the crawl read/i);
    // The field that says whether the four numbers after it are a record or a
    // projection (docs/gates/phase-11.md §6.3): an unexplained "18 selected" on
    // a crawl nobody rendered is read as eighteen pages somebody chose.
    expect(text, "renderPassEvidence").toMatch(/whether a render run happened/i);
    // Phase 25: `failed`, and the column that says why, by its label.
    expect(text, "renderPassEvidence: failed").toMatch(/the last one could not start/i);
    expect(text, "renderLaunchError").toContain("Render Launch Error");
    expect(text, "the projection, said as one").toMatch(/would choose|a run would/i);
    expect(text, "selectionMode").toMatch(/selection mode/i);
    expect(text, "selectionBudget").toMatch(/budget/i);
    expect(text, "selectionSuspects").toMatch(/incomplete|suspect/i);
    expect(text, "selectionSampled").toMatch(/sampled/i);
    expect(text, "selectionSelected").toMatch(/selected/i);
    expect(text, "selectionTruncated").toMatch(/truncated/i);
    expect(text, "pagesRendered and renderFailures").toMatch(/rendered or failed|failures/i);
    // And what a reader must do with it before quoting any rendering finding.
    expect(copy("render.coverage").howToFix).toMatch(/before quoting|read this/i);
    expect(copy("render.coverage").howToFix, "the silence is not a clean site").toMatch(
      /silent|nothing was measured/i,
    );
    // A run that could not start: its selection is still waiting, an earlier
    // run's pages still count, and the rest is unmeasured — never "nothing".
    const fix = copy("render.coverage").howToFix;
    expect(fix, "could not start").toMatch(/if the last run could not start/i);
    expect(fix, "its selection waits").toMatch(/still waiting to be rendered/i);
    expect(fix, "an earlier run's pages stand").toMatch(/pages an earlier run rendered still count/i);
    expect(fix, "only the rest is unmeasured").toMatch(/everything else is unmeasured until a run succeeds/i);
  });

  // Phase 10's rollup, and the things its copy has to say that no other
  // metric's does.
  it("site.health names every column and the population they are over", () => {
    const text = copy("site.health").explanation;
    expect(text, "urlsTotal").toMatch(/pages the audit (?:could judge|judges)/i);
    expect(text, "the census definition").toMatch(/200, HTML|200 with HTML/i);
    expect(text, "urlsWithCritical").toMatch(/critical/i);
    expect(text, "urlsWithWarningOnly").toMatch(/warning and no critical/i);
    expect(text, "urlsWithInfoOnly").toMatch(/only informational/i);
    expect(text, "urlsClean").toMatch(/how many none|no finding|clean/i);
    expect(text, "cleanRatio").toMatch(/clean ratio/i);
    expect(text, "pagesNotAuditable").toMatch(/other (?:fetched|crawled) URLs|left out/i);
    // Counted once, at the worst severity — the property the whole table rests
    // on, and the one a reader would otherwise assume the other way round.
    expect(text, "counted once at the worst severity").toMatch(
      /counted once at its worst severity/i,
    );
    // A finding that names no page is about the site and belongs in no bucket.
    expect(text, "site-level findings").toMatch(/Site-wide findings appear in none/i);
    // The remainder is a SHAPE, not a catalogue: the predicate excludes a 200
    // that was not HTML too, and that page is counted by no other table.
    expect(text, "the remainder names the non-HTML case").toMatch(/non-HTML/i);
  });

  // THE CAP CAVEAT, and the ratio's precision. At 50,000 pages one clean page
  // rounds to 0.0000: rounding is right for the column, and what the copy has
  // to add is which number to trust.
  it("site.health says the counts are the authority, not the ratio", () => {
    const c = copy("site.health");
    expect(c.explanation, "a capped run's clean count is a floor").toMatch(
      /capped run|past the cap count as clean/i,
    );
    expect(c.howToFix, "work percentages from the counts").toMatch(
      /Work percentages out from the counts/i,
    );
    expect(c.howToFix, "and check the cap before quoting the ratio").toMatch(
      /capped before quoting|whether the run was capped/i,
    );
  });

  // Obligation 6, as a test: Ariadne emits the ingredients and the ratio; Talos
  // owns the gauge. A grade, a label or a threshold in this copy would be the
  // engine passing the judgement it exists to leave to its consumer — and copy
  // is where one would arrive first, since the row itself is just numbers.
  it("site.health grades nothing: no score, no label, no threshold", () => {
    const c = copy("site.health");
    // The copy says so where the reader meets the numbers…
    expect(c.howToFix).toMatch(/not as a score|no grade|shape of the work/i);
    // …and then does so.
    const judgement =
      /health score|site score|\bgrade\b|out of 100|score of|\bA\+|excellent|poor health|good health|healthy site|unhealthy|above \d+%|below \d+%|more than \d+% of pages|threshold/i;
    expect(`${c.title} ${c.explanation}`).not.toMatch(judgement);
  });

  // A metric states what was counted; it does not accuse the site of anything.
  // "Fix" language in a table's copy would turn a distribution into a fault
  // list, and the numbers at the bottom of a distribution are frequently fine.
  it("the metric copy describes a measurement rather than a defect", () => {
    for (const rule of RULES.filter((r) => r.kind === "metric")) {
      const asFault =
        /this (?:is a|indicates a) (?:problem|fault|error)|must be fixed|you must fix|is broken|penalis|penaliz/i;
      expect(whole(rule.id), rule.id).not.toMatch(asFault);
    }
  });
});

// ==========================================================================
// THE RUBRIC (spec §1)
// ==========================================================================

/**
 * THE CLIENT-FACING COPY RUBRIC.
 *
 * The owner's instruction behind the Phase 20 register: "Texts rewritten for an
 * SEO tool, not for a chat, concise, direct, easy to understand and not
 * ambiguous but also using the well known SEO language."
 * (docs/superpowers/specs/2026-09-10-reports-and-copy-design.md §1.)
 *
 * Four contracts, one describe or one `it` each:
 *
 *  1. NO ENGINE VOCABULARY. The banned list is not a style preference — each
 *     word was found IN this copy once and judged, and the reasoning is
 *     recorded beside it, including the words considered and kept.
 *  2. STRUCTURE. `Area: Condition`, the area from the spec's fixed list, at
 *     most 80 characters, no trailing full stop; a description of one to three
 *     sentences; a fix with at least one imperative.
 *  3. THRESHOLDS IN THE TITLE. "Page titles: Too long" makes a reader open the
 *     finding to learn the number; "Page titles: Over 60 characters" does not.
 *     The numbers come from the rules' own constants.
 *  4. MARKERS. The `marker` reason is the "Why:" line on a demo row and the
 *     `marker` field of the rules catalog: one plain sentence, the cause and
 *     what would answer the check.
 */

/**
 * Words banned from every client-facing string, whole-word and case-insensitive.
 *
 * Each entry says why. The list was built by grepping the copy that existed
 * before the first pass rather than by imagination — a banned word nothing ever
 * used is a guard for the future, a banned word the copy DID use is a rewrite
 * that happened.
 *
 * WORDS CONSIDERED AND KEPT, each for a reason that is not tone:
 *
 *  - "row" and "rows" — kept since Phase 20, where every finding became a TABLE
 *    served to the client (spec §2: standard columns plus the rule's declared
 *    columns, in the API, the CSV export and the demo). "The row shows the URL
 *    and the Disallow line" is now a sentence about what the reader is looking
 *    at, in their vocabulary. It used to be banned outside a metric's copy,
 *    when a finding rendered as a URL list and "row" could only mean ours.
 *  - "upstream" — kept since Phase 20, where the only use is the SITE'S own
 *    upstream ("restarts, deploys, exhausted connection pools and upstream
 *    timeouts"), which is what an operator calls the thing behind their proxy.
 *    Our two meanings — the lifted sources, and a proxy's origin — appear in no
 *    client-facing string.
 *  - "the engine" — a reader needs a name for the thing that did the crawling,
 *    and every alternative is a euphemism.
 *  - "rule" — in this copy it is always the SITE'S rule: a redirect rule, a
 *    Disallow rule, a bot-protection rule. Ours are never mentioned.
 *  - "pass" as a VERB — links pass equity, a page passes the Rich Results
 *    Test. Only the noun (our render/resource phase) is banned, below.
 *  - "fingerprint" — it is what the number IS, and the alternative is either
 *    "simhash" (ours) or a paragraph.
 */
const BANNED_WORDS: { word: string; why: string }[] = [
  // Engine parts a client has never heard of and cannot act on.
  { word: "marker", why: "our name for a rule that reports a check we could not answer" },
  { word: "markers", why: "as above" },
  { word: "census", why: "our name for the row counts behind a marker" },
  { word: "frontier", why: "the crawl queue, an internal structure" },
  { word: "tokenizer", why: "how the HTML is parsed; no reader acts on it" },
  { word: "simhash", why: "the algorithm behind the fingerprint; say fingerprint" },
  { word: "hamming", why: "the distance measure; say how many bits differ" },
  { word: "jsonb", why: "a Postgres column type" },
  { word: "cursor", why: "a pagination token in our API" },
  { word: "schema", why: "our database, which a reader will read as schema.org markup" },
  { word: "cohort", why: "our name for the set of pages a metric measured" },
  { word: "blob", why: "how evidence is stored" },
  { word: "dedupe", why: "jargon for consolidating duplicates" },
  { word: "auditable", why: "our predicate for a page we could judge; say what it means" },
  { word: "probe", why: "our name for the extra host requests" },
  { word: "probes", why: "as above" },
  { word: "probing", why: "as above" },
];

/** Banned phrases, for the same reason and with the same evidence behind them. */
const BANNED_PHRASES: { label: string; pattern: RegExp; why: string }[] = [
  {
    label: "not measured",
    pattern: /\bnot measured\b|\bNOT MEASURED\b/,
    why: "the engine's own label for an unanswered check; the demo says 'not checked' and 'Why:'",
  },
  { label: "fetch class", pattern: /\bfetch[ _]class\b/i, why: "the column name behind a status" },
  { label: "evidence blob", pattern: /\bevidence blob\b/i, why: "how a finding is stored" },
  {
    // "pass" as a VERB is ordinary English and stays: links pass equity, a page
    // passes Google's Rich Results Test. "pass" as a NOUN is one of this
    // engine's phases — the render pass, the resource pass — and names nothing
    // a reader can see, so the noun is what is banned rather than the word.
    label: "pass (the engine phase, as a noun)",
    pattern:
      /\b(?:a|an|the|this|that|each|one|its|earlier|another|no|every|second|first)\s+pass\b|\b(?:render|rendering|resource|resources|fetch|crawl|selection|partial)\s+pass(?:es)?\b/i,
    why: "an internal phase of a crawl; say what was or was not done instead",
  },
];

/**
 * The areas a title may open with (spec §1). A fixed list rather than "anything
 * before the colon": the area is what groups findings in a report, and a
 * twenty-fifth spelling of "Links" would split a section in two.
 */
const AREAS = [
  "Response codes",
  "Sitemaps",
  "Canonicals",
  "Directives",
  "Page titles",
  "Meta description",
  "H1",
  "Headings",
  "Content",
  "Images",
  "Links",
  "Hreflang",
  "Redirects",
  "URL",
  "Security",
  "Structured data",
  "Pagination",
  "Site",
  "Crawl",
  "Resources",
  "Mobile",
  "Performance",
  "Rendering",
  "Robots.txt",
];

/** `Area: Condition` — an area from the list above, then a condition. */
const TITLE_SHAPE = /^[A-Z][A-Za-z0-9 .()\-/]+: .+/;

/** Titles are headlines: this is the width one survives in a table header. */
const TITLE_MAX_CHARS = 80;

/**
 * Verbs an instruction may open with.
 *
 * The rubric asks for ONE imperative sentence, not for an imperative FIRST
 * sentence: plenty of good fixes open with the condition ("If the page should
 * rank, …") and give the instruction second, so every clause is examined and
 * one hit is enough. A leading conjunction is stepped over ("…, and send an
 * HSTS header").
 *
 * The list is the spec's, plus the verbs this copy actually uses: "301" because
 * practitioners use it as one ("301 the old URL"), "crawl" and "shorten" and
 * "send" because the entries that need them read worse any other way. A new
 * entry opening with a verb that is not here fails and is either a real
 * imperative worth adding or prose worth rewriting.
 */
const IMPERATIVES = [
  // The spec's list.
  "add", "remove", "replace", "point", "make", "set", "fix", "re-crawl", "re-run",
  "redirect", "give", "link", "merge", "restore", "trim", "expand", "choose", "pick",
  "decide", "confirm", "check", "read", "compare", "start", "strip", "split",
  "publish", "declare", "allowlist", "fill", "move", "render", "serve",
  "canonicalise", "generate", "request", "return", "use", "keep", "leave",
  "validate", "consolidate", "nothing",
  // …and the verbs the copy uses beside it.
  "301", "build", "correct", "crawl", "cut", "narrow", "re-export", "re-test",
  "send", "shorten", "submit", "swap", "test", "trace", "update", "verify", "work",
  "write",
];

/** Conjunctions a clause may open with before its verb. */
const CONJUNCTIONS = new Set(["and", "or", "then", "but"]);

/** The first word of a clause, lowercased and stripped of punctuation. */
const opener = (clause: string): string => {
  const words = clause
    .split(/[\s,—]+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 0);
  const first = words[0] ?? "";
  return CONJUNCTIONS.has(first) ? (words[1] ?? "") : first;
};

describe("client-facing copy rubric", () => {
  it("has a rule to judge (the registry built)", () => {
    expect(RULES.length).toBeGreaterThan(90);
  });

  it("uses no engine vocabulary in any title, explanation, how-to-fix or marker reason", () => {
    const offences: string[] = [];
    for (const rule of RULES) {
      const c = copyFor(rule.id);
      const fields: [string, string][] = [
        ["title", c.title],
        ["explanation", c.explanation],
        ["howToFix", c.howToFix],
      ];
      if (rule.marker !== undefined) fields.push(["marker", rule.marker]);
      for (const [field, text] of fields) {
        for (const banned of BANNED_WORDS) {
          if (new RegExp(`\\b${banned.word}\\b`, "i").test(text)) {
            offences.push(`${rule.id}.${field}: "${banned.word}" — ${banned.why}`);
          }
        }
        for (const banned of BANNED_PHRASES) {
          if (banned.pattern.test(text)) {
            offences.push(`${rule.id}.${field}: "${banned.label}" — ${banned.why}`);
          }
        }
      }
    }
    expect(offences, `engine vocabulary in client copy:\n  ${offences.join("\n  ")}`).toEqual([]);
  });

  it("titles every rule as `Area: Condition`, short and unpunctuated at the end", () => {
    for (const rule of RULES) {
      const title = copyFor(rule.id).title;
      expect(title, `${rule.id} title is padded`).toBe(title.trim());
      expect(title, `${rule.id} title is not "Area: Condition": ${title}`).toMatch(TITLE_SHAPE);
      expect(
        title.length,
        `${rule.id} title is ${title.length} chars, over ${TITLE_MAX_CHARS}: ${title}`,
      ).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title.endsWith("."), `${rule.id} title ends with a full stop: ${title}`).toBe(false);
      // A rule id — "content.near-duplicate" — in a title is this engine's
      // filing system on a client's screen. `robots.txt` is a file on their own
      // site and is allowed by name.
      const dotted = title
        .replace(/robots\.txt/gi, "")
        .match(/\b[a-z][a-z0-9]*\.[a-z][a-z0-9-]+\b/);
      expect(dotted, `${rule.id} title carries an engine id: ${String(dotted)}`).toBeNull();
    }
  });

  it("opens every title with an area from the fixed list", () => {
    const strays: string[] = [];
    for (const rule of RULES) {
      const title = copyFor(rule.id).title;
      const area = title.slice(0, title.indexOf(": "));
      if (!AREAS.includes(area)) strays.push(`${rule.id}: "${area}" (${title})`);
    }
    expect(strays, `titles outside the area list:\n  ${strays.join("\n  ")}`).toEqual([]);
  });

  it("describes every rule in one to three sentences", () => {
    const offences: string[] = [];
    for (const rule of RULES) {
      const c = copyFor(rule.id);
      expect(c.explanation, `${rule.id} explanation is padded`).toBe(c.explanation.trim());
      const said = sentences(c.explanation);
      if (said.length < 1 || said.length > 3) {
        offences.push(`${rule.id}: ${said.length} sentences — ${c.explanation}`);
      }
    }
    expect(
      offences,
      `descriptions outside the one-to-three sentence rule (spec §1):\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  it("instructs in at least one imperative sentence per fix", () => {
    const offences: string[] = [];
    for (const rule of RULES) {
      const c = copyFor(rule.id);
      expect(c.howToFix, `${rule.id} howToFix is padded`).toBe(c.howToFix.trim());
      expect(sentences(c.howToFix).length, `${rule.id} howToFix is empty`).toBeGreaterThanOrEqual(1);
      // Clauses, not sentences: "If the URL should exist, restore the page at
      // it" is an instruction, and demanding that the verb come first would
      // push every conditional fix into worse English than it has now.
      const clauses = c.howToFix
        .split(/(?<=[.!?])\s+|,\s+|;\s+|:\s+|—\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (!clauses.some((clause) => IMPERATIVES.includes(opener(clause)))) {
        offences.push(`${rule.id}: ${c.howToFix}`);
      }
    }
    expect(
      offences,
      `fixes with no imperative sentence (spec §1):\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });
});

/**
 * A rule that fires on a number has to put the number in the title.
 *
 * "Page titles: Too long" reads as an opinion and sends a reader into the
 * finding to learn what "too" is; "Page titles: Over 60 characters" is the
 * condition. The values come from the rules' own exported constants, so this
 * fails the day one of them changes without the copy.
 */
describe("copy rubric: a threshold belongs in the title", () => {
  /** id → the number the title must carry, as the title spells it. */
  const THRESHOLD_IN_TITLE: Record<string, string> = {
    "title.too-short": String(TITLE_MIN),
    "title.too-long": String(TITLE_MAX),
    "meta-description.too-short": String(META_MIN),
    "meta-description.too-long": String(META_MAX),
    "headings.h1-too-long": String(H1_MAX),
    "url.too-long": String(URL_MAX),
    "content.thin": String(THIN_WORDS),
    "performance.slow-response": String(SLOW_MS),
    "structure.deep-page": String(DEEP_DEPTH),
    "headings.level-skip": String(HEADING_MAX_STEP),
    "content.near-duplicate": String(NEAR_DUPLICATE_HAMMING),
    "images.oversized": IMAGE_WEIGHT_WARN.toLocaleString("en-US"),
    "images.legacy-format": IMAGE_WEIGHT_WARN.toLocaleString("en-US"),
    // Two rules whose ids do not advertise a threshold but whose predicates are
    // one. `content.soft-404` fires on `SOFT_404_WORDS` OR `TEMPLATE_HAMMING`;
    // the word count is the half a title can carry, and the four bits are
    // pinned in the explanation above.
    "content.soft-404": String(SOFT_404_WORDS),
    "redirect.chain": String(CHAIN_HOPS),
  };

  it("states the number in the title of every rule that fires on one", () => {
    for (const [id, value] of Object.entries(THRESHOLD_IN_TITLE)) {
      const title = copy(id).title;
      expect(title, `${id} title omits its threshold ${value}: ${title}`).toMatch(
        new RegExp(`(?<![0-9,])${value}(?![0-9])`),
      );
    }
  });

  // The guard on the map itself: a rule whose id promises a threshold and is
  // not listed above is a rule whose title nobody checked. Markers are outside
  // it (a check that could not be run states no threshold), and so are metrics
  // (a distribution has no firing line).
  //
  // AN ID IS NOT THE ONLY PROMISE. `content.soft-404` and `redirect.chain` name
  // no threshold and are both defined by one: 300 words or four bits, and two
  // hops. They are in the map and in this pattern, and the pattern is the
  // reminder that the next rule like them has to be added by hand — the id is
  // the cheap signal, not the authority.
  it("leaves no threshold rule out of the map", () => {
    const promises =
      /too-long|too-short|thin|slow|oversized|deep|level-skip|near-duplicate|soft-404|\.chain$/;
    const missing = RULES.filter(
      (r) =>
        r.marker === undefined &&
        r.kind !== "metric" &&
        promises.test(r.id) &&
        !(r.id in THRESHOLD_IN_TITLE),
    ).map((r) => r.id);
    expect(missing, `threshold rules with no pinned number: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * The marker reason strings.
 *
 * This is the "Why:" line under a rule in the demo's "Not checked on this
 * crawl" section, and the `marker` field of the rules catalog an agent reads.
 * It used to be a noun phrase written for us — "a crawl that recorded no
 * resources (P11-T3)" — which on a client's screen said nothing and cited a
 * task number. One sentence, the cause, and what would answer the check.
 */
describe("copy rubric: marker reasons", () => {
  const markers = RULES.filter((r) => r.marker !== undefined);

  it("has markers to judge", () => {
    expect(markers.length).toBeGreaterThan(5);
  });

  it("is one plain sentence naming the cause and the remedy", () => {
    for (const rule of markers) {
      const reason = rule.marker!;
      expect(reason, `${rule.id} marker is padded`).toBe(reason.trim());
      expect(reason.length, `${rule.id} marker is too short to say both halves`).toBeGreaterThan(40);
      expect(reason[0], `${rule.id} marker does not open with a capital`).toBe(
        reason[0]!.toUpperCase(),
      );
      expect(reason.endsWith("."), `${rule.id} marker is not a sentence: ${reason}`).toBe(true);
      expect(
        sentences(reason).length,
        `${rule.id} marker is more than one sentence: ${reason}`,
      ).toBe(1);
      // No task numbers, no phase ids: "(P11-T3)" reached a client screen.
      expect(reason, `${rule.id} marker cites a build task`).not.toMatch(/\bP\d+-T\d+\b/);
      // And the half that makes it useful: what would answer the check.
      expect(reason, `${rule.id} marker names no remedy: ${reason}`).toMatch(
        /\bre-?crawl|re-?run|crawl(?:ing)?\b|raise|enable|turn(?:ed)? on|allow|supply|resume|fix|add\b/i,
      );
    }
  });
});
