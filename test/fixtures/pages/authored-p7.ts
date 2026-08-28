/**
 * The Phase 7 fixture: one page shaped like the defect that provoked the phase.
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
import { serve } from "../render.js";

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

/** The Phase 7 fixtures. One page, and it is the phase's whole shape. */
export const authoredP7Fixtures: Fixture[] = [hiddenChrome];
