/**
 * The Phase 7 fixtures: the page shaped like the defect that provoked the phase
 * (T1), and the pair at the bottom of this file that share an H1 and nothing
 * else (T2).
 *
 * `audits/lavishalice.com/render-diagnosis.md` measured a real product page at
 * 1,413 raw words against 335 rendered ones and attributed every missing word
 * to two things a tokenizer had been counting and no visitor could read: 482
 * words inside a `<template>`, and ~740 words of per-page chrome the markup or
 * the stylesheet hides. This page reproduces that shape at a size a person can
 * check by hand — a template block, a hidden mega-menu drawer, an inline
 * `display:none` country picker, and a closed `<details>` accordion, around
 * copy a reader actually sees.
 *
 * WHY THE NUMBERS ARE STATED HERE. The two counts below are the page's
 * arithmetic, not the analyzer's output: each block's word count is written
 * beside the block and the totals are their sums. The analyzer unit test
 * (test/crawl/analyzer-extensions.test.ts) asserts `analyzePage` reproduces
 * them from this exact HTML, and the harness asserts the `pages` row the real
 * crawl wrote carries the same two numbers — so the claim runs from the markup
 * through the tokenizer, the writer and the database, and a change to any of
 * the three fails against a number that was derived rather than observed.
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

/** Exactly 44 characters — inside TITLE_MIN..TITLE_MAX. */
const TITLE = "A page that hides most of the words it ships";

/** Exactly 145 characters — inside META_MIN..META_MAX. */
const META =
  "A page whose markup carries a template, a hidden drawer, an inline display none block and a closed accordion, none of which a visitor ever reads.";

/** The `<h1>`: 9 words. */
const H1 = "A page whose markup hides most of its words";

/** The lede paragraph: 60 words. */
const LEDE =
  "Everything below this sentence is copy a reader can see, and the four blocks after it are copy nobody can. They are here because a crawler that counts them reports a page four times the size of the page a visitor is shown, and every rule with a word count in it then reads a number that is mostly furniture.";

/** The second visible paragraph: 63 words. */
const BODY_TWO =
  "The interesting part is that none of the hidden blocks are unusual. A mega menu that only opens on a narrow viewport, a currency picker that waits for a click, a size guide folded into an accordion and a card template a script will clone later are all ordinary parts of an ordinary shop, and every one of them ships on every page.";

/** The `<h2>` section heading: 6 words. */
const H2 = "What the hidden blocks look like";

/** The third visible paragraph: 47 words. */
const BODY_THREE =
  "So the honest measurement is not the number of words the server sent. It is the number of words the markup does not already say are hidden, which is what this page exists to pin, one block at a time, in a shape small enough to count.";

/** The `<summary>` of the closed accordion, which a browser still renders: 2 words. */
const SUMMARY = "Size guide";

/** Inside the `<template>`: 24 words, plus a one-word `<h3>`. In no document. */
const TEMPLATE_TEXT =
  "Product card template cloned by the script for every result in the grid, with a placeholder name, a placeholder price and a placeholder promise.";

/** Inside the `hidden` drawer: 34 words. */
const DRAWER_TEXT =
  "Shop all new arrivals dresses tops skirts knitwear denim shoes bags accessories sale gift cards stores our story sustainability careers press contact delivery returns size guide student discount klarna help and frequently asked questions.";

/** Inside the inline `display:none` picker: 20 words. */
const PICKER_TEXT =
  "United Kingdom pounds Ireland euro Germany euro France euro Spain euro Italy euro Australia dollar United States dollar Canada dollar";

/** Inside the closed `<details>`, beside its summary: 28 words. */
const DETAILS_TEXT =
  "Our sizes run true to the measurements in the table below, so take the size you usually wear unless the fabric has no stretch at all in it.";

/**
 * `pages.word_count` for this page: every visible word plus every markup-hidden
 * one, with the template's 25 excluded because template content is in no
 * document (the Phase 7 correction).
 *
 *   9 (h1) + 60 (lede) + 63 (body two) + 6 (h2) + 47 (body three)
 *     + 34 (drawer) + 20 (picker) + 2 (summary) + 28 (details body) = 269
 */
export const P7_WORD_COUNT = 269;

/**
 * `pages.renderable_word_count`: the same page minus the four blocks whose own
 * markup says they are not displayed. The summary survives — a closed
 * `<details>` still renders it — and the template was already gone above.
 *
 *   9 + 60 + 63 + 6 + 47 + 2 (summary) = 187
 */
export const P7_RENDERABLE_WORD_COUNT = 187;

/** The path, exported so the harness and the analyzer test name the same page. */
export const P7_HIDDEN_CHROME_PATH = "/authored7/hidden-chrome";

/**
 * The body markup, exported so the analyzer unit test measures the same bytes
 * the fixture app serves. `serve` wraps it in `<main>` inside `<body>`, which
 * adds elements and no words.
 */
export const P7_HIDDEN_CHROME_BODY = `<h1>${H1}</h1>
<p>${LEDE}</p>
<p>${BODY_TWO}</p>
<h2>${H2}</h2>
<p>${BODY_THREE}</p>
<template id="product-card"><article><h3>Placeholder</h3><p>${TEMPLATE_TEXT}</p></article></template>
<div hidden id="sidebar-menu"><nav><p>${DRAWER_TEXT}</p></nav></div>
<div style="display:none" id="country-picker"><p>${PICKER_TEXT}</p></div>
<details><summary>${SUMMARY}</summary><p>${DETAILS_TEXT}</p></details>`;

const hiddenChrome: Fixture = {
  path: P7_HIDDEN_CHROME_PATH,
  category: "content",
  name: "A page whose markup hides most of its words",
  // Nothing. The page is a healthy page carrying ordinary hidden chrome: 187
  // renderable words clear `content.thin` (150), the head is the control
  // page's, and no rule has anything to say about a template or a closed
  // accordion. That is the assertion — the correction changed what is counted
  // and did not make a clean page start speaking.
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: TITLE,
      metaDescription: META,
      bodyHtml: P7_HIDDEN_CHROME_BODY,
    })),
};

// ---------------------------------------------------------------------------
// T2: the duplicate H1, on two pages that share nothing else
// ---------------------------------------------------------------------------

/**
 * The heading both pages below open with, and the ONLY thing they have in
 * common.
 *
 * The fixture site already carried duplicate titles and duplicate meta
 * descriptions, authored in Phase 2 and left with `expectedIssues: []` and a
 * comment saying a later phase would claim them — this is that phase, and those
 * pages need no change beyond their expectations. Duplicate H1 TEXT had no such
 * pair: the only pages on the site sharing a heading were `/content/duplicate-a`
 * and `-b`, which are byte-identical copies and therefore share their title,
 * their description and their content hash as well.
 *
 * That is why these two exist. A rule that had quietly grouped by content hash,
 * or by title, would fire on the identical pair and look correct; it fires on
 * NOTHING here, because these two pages differ in every column but the heading.
 * The pair is what makes the harness's h1 assertion an assertion about h1s.
 */
export const P7_SHARED_H1 = "How the returns process works";

/** The pair's paths, exported so the harness names the same two pages. */
export const P7_SHARED_H1_PATHS = ["/authored7/shared-h1-a", "/authored7/shared-h1-b"] as const;

/** The two pages' word counts clear THIN_WORDS (150) with room to spare. */
function guideBody(opts: { lede: string; sections: Array<{ h2: string; body: string }> }): string {
  return article({ h1: P7_SHARED_H1, lede: opts.lede, sections: opts.sections });
}

const sharedH1A: Fixture = {
  path: P7_SHARED_H1_PATHS[0],
  category: "content",
  name: "Duplicate H1 (the first of the pair)",
  // `h1.duplicate-text` reports the GROUP once, on its lexically first member,
  // so the expectation belongs to this page alone and `-b` is named in the
  // evidence. Nothing else fires: the title, the description and the prose are
  // this page's own, which is the arrangement the pair exists to provide.
  expectedIssues: ["h1.duplicate-text"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Returns, refunds and the timings",
      metaDescription:
        "How long a refund takes, what condition we can accept an item back in, and who pays for the postage when something arrives damaged.",
      bodyHtml: guideBody({
        lede: "This page is about money going back to a card, and it shares its headline with a page about something else entirely.",
        sections: [
          {
            h2: "What happens after the parcel reaches us",
            body: "A returned parcel is booked in on the day it arrives, checked against the order it belongs to, and then refunded to the card that paid for it. The bank takes a few working days of its own after that, which is the part nobody controls and the part every customer asks about, so it is written here rather than left to a support ticket. Nothing about this section is true of the other page carrying the same heading, and that is the point of the pair.",
          },
          {
            h2: "Why a heading has to say what the page is",
            body: "A headline that could sit on any page in a section is a headline that names none of them. Two pages built from the same template with the same words at the top are two pages making the same claim about themselves, and a search engine choosing between them has nothing in the strongest signal on either page to tell them apart. The fix is a template change rather than a rewrite: build the heading from the field that already differs.",
          },
        ],
      }),
    })),
};

const sharedH1B: Fixture = {
  path: P7_SHARED_H1_PATHS[1],
  category: "content",
  name: "Duplicate H1 (the second of the pair)",
  // The group is reported on `-a` above. This page carries no finding of its
  // own, which is what an exact set is for: a rule reporting per PAGE rather
  // than per group would fail here rather than pass quietly.
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Exchanges and how to arrange one",
      metaDescription:
        "Swapping an item for another size or colour, why we treat it as a return plus a fresh order, and what that means for how quickly it ships.",
      bodyHtml: guideBody({
        lede: "This page is about swapping one item for another, and it shares its headline with a page about refunds.",
        sections: [
          {
            h2: "An exchange is two transactions",
            body: "The replacement is placed as a new order the moment the request comes in, so it ships from stock immediately instead of waiting for the original to travel back across the country. The original then follows the ordinary returns route and is refunded when it lands. Handling it as one transaction would mean holding the customer's replacement hostage to a courier, which is a worse experience for the sake of a tidier ledger.",
          },
          {
            h2: "Where the sizes are listed",
            body: "Every product page carries the measurements for its own range, taken the same way across the catalogue so two ranges can be compared without converting anything. If the size chart and the product description ever disagree, the chart is the one that was measured and the description is the one that was written, so trust the chart and tell us about the description.",
          },
        ],
      }),
    })),
};

/**
 * The Phase 7 fixtures: the page whose markup hides most of its own words
 * (T1), and the pair that share a heading and nothing else (T2).
 */
export const authoredP7Fixtures: Fixture[] = [hiddenChrome, sharedH1A, sharedH1B];
