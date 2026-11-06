/**
 * The BAD pages: broken-on-purpose fixtures absorbed from open-seo (MIT),
 * badseo/src/fixtures/ @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070 —
 * head-tags.ts, content.ts, indexability.ts, http-status.ts, redirects.ts,
 * performance.ts, structure.ts and kitchen-sink.ts.
 *
 * What was absorbed is the CONTENT: the HTML each fixture serves, its title and
 * meta description, its prose, and the intent recorded in its name. What was
 * not absorbed is upstream's plumbing — the TanStack/Workers app, the catalog
 * page, the sitemap wiring, the `Fixture` type and its `summary` / `lesson` /
 * `extraPaths` / `inSitemap` / `linkedFromCatalog` / `support` fields. Ariadne's
 * `Fixture` type, its handler shape and the harness are ours (build plan §2).
 *
 * Changes, each marked at its site below:
 *  - `expectedIssues` is remapped from upstream's audit-issue ids to Ariadne's
 *    rule ids. Phase 3's query rules claimed most of what Phase 2 left waiting —
 *    duplicates, orphans, broken internal links, redirect chains and loops all
 *    have their rule and their expectation now. What is still `expectedIssues:
 *    []` with a comment is either a page whose finding belongs to another URL
 *    (a chain's middle hop, the page holding a broken link) or a page waiting on
 *    a metric rule that does not exist yet (duplicate titles and meta
 *    descriptions, dead ends). The content is the point; deleting it would mean
 *    absorbing it twice.
 *  - Task 9 added the site's sitemap, and with it two link-graph facts a handler
 *    cannot express: `inSitemap` and `linkedFromHub` (see `Fixture`). Both are
 *    set here only where the arrangement is the fixture — the orphan, the deep
 *    chain, and the pages the sitemap deliberately does or does not list.
 *  - `/status/server-error` answers 503 rather than upstream's 500. The fixture
 *    app's contract calls for a 503 route, Ariadne classifies both as
 *    `server_error` (fetch-page: ≥ 500 with no bot-challenge markers in the
 *    body), and one route is honester than two that mean the same thing.
 *  - The deep click-path is `/deep/1` … `/deep/7` rather than upstream's
 *    `/structure/deep/{1..4}` + `/structure/deep/treasure`. Ariadne's
 *    `structure.deep-page` fires above depth 5 and the hub is depth 0, so the
 *    chain needs seven rungs for anything to be buried; `/deep/6` and `/deep/7`
 *    are the pages that are.
 *  - Upstream's trailing-slash trap was one fixture plus a Worker intercept.
 *    Here it is the two pages it always was: the non-slash form redirects, the
 *    slash form is the canonical 200.
 *  - Bodies are served through our `serve` / `renderDocument`, so upstream's
 *    nav, footer and "what this page tests" panel are absent (see render.ts).
 */
import type { Fixture } from "../fixture.js";
import { article, lorem, redirect, serve } from "../render.js";
import { DEEP_DEPTH } from "../../../src/rules/thresholds.js";

// ---------------------------------------------------------------------------
// Head tags & headings — badseo/src/fixtures/head-tags.ts
// ---------------------------------------------------------------------------

const HEAD = "head-tags";

const missingTitle: Fixture = {
  path: "/head/missing-title",
  category: HEAD,
  name: "Missing <title> tag",
  expectedIssues: ["title.missing"],
  handler: (req, res) =>
    serve(req, res, () => ({
      // title intentionally omitted
      metaDescription:
        "This page is fine except for one thing: it has no title tag for search results or browser tabs.",
      bodyHtml: article({
        h1: "A page with no title",
        lede: "The content and headings here are fine. There is just no title tag in the head.",
        sections: [
          {
            h2: "What the title does",
            body: "The title tag is how a page introduces itself to a search engine and to anyone scanning a list of results. It carries the main topic and it is the first thing people read. When it is missing, the search engine builds its own title from text on the page, and that is usually worse than one you would write yourself.",
          },
          {
            h2: "Why it goes missing",
            body: "A missing title almost always comes from a template. A content type never got a title field, or a component only renders the title when a value is passed in, or a migration dropped the head tags. The page looks fine to a person, so the problem is easy to miss until you check the head.",
          },
        ],
      }),
    })),
};

const LONG_TITLE =
  "The Complete And Fully Unabridged Guide To Writing Page Titles That Are Much Too Long To Fit In Search Results";

const titleTooLong: Fixture = {
  path: "/head/title-too-long",
  category: HEAD,
  name: "Title too long",
  expectedIssues: ["title.too-long"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: LONG_TITLE,
      metaDescription:
        "The title on this page runs well past the length a search result will show.",
      bodyHtml: article({
        h1: "A title that runs too long",
        lede: "There is a length past which a title stops helping and just gets cut off.",
        sections: [
          {
            h2: "Where the title gets cut",
            body: "Search engines show the title in a fixed width, which works out to roughly 60 characters for most English text. Anything past that is replaced with an ellipsis. If the useful, specific words are at the end, people never see them. They see a sentence that trails off and they move on to the next result.",
          },
          {
            h2: "How to shorten it",
            body: "Lead with the main topic. Drop filler like complete guide to and ultimate. Move the brand name to the end, where a cut hurts least. A tight title of about 50 characters usually does better than a long one, both for clicks and for how clearly a search engine can tell what the page is about.",
          },
        ],
      }),
    })),
};

const titleTooShort: Fixture = {
  path: "/head/title-too-short",
  category: HEAD,
  name: "Title too short",
  expectedIssues: ["title.too-short"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Hi",
      metaDescription:
        "The title on this page is a single short word, which tells a search engine almost nothing.",
      bodyHtml: article({
        h1: "A title that is too short",
        lede: "Short is good. This is too short to say anything.",
        sections: [
          {
            h2: "Titles need room to work",
            body: "The title is the most useful string of text you control on a page. A two-character title throws that away. It cannot hold the term people search for, it does not describe the page, and it gives nobody a reason to pick this result over the others next to it.",
          },
          {
            h2: "A good length",
            body: "Aim for about 30 to 60 characters. That is enough to name the topic, include the words people actually search for, and add a short hook. In practice that is one clear phrase, not a single word and not a full sentence that runs off the end.",
          },
        ],
      }),
    })),
};

const missingMeta: Fixture = {
  path: "/head/missing-meta-description",
  category: HEAD,
  name: "Missing meta description",
  expectedIssues: ["meta-description.missing"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with no meta description",
      // metaDescription intentionally omitted
      bodyHtml: article({
        h1: "No meta description",
        lede: "This page has a title and clean headings. It has no meta description.",
        sections: [
          {
            h2: "What the description does",
            body: "The meta description is the line of text under the title in search results. It does not affect ranking directly, but a good one lifts the click rate. Leave it out and the search engine writes one for you from text on the page, which may or may not read well.",
          },
          {
            h2: "How to write one",
            body: "Treat it as a short ad. In about 70 to 160 characters, say what the page gives you and give a reason to click. Write a different one for each page so results never show the same snippet twice, and do not stuff it with keywords, which search engines tend to ignore.",
          },
        ],
      }),
    })),
};

const LONG_META =
  "This meta description keeps going well past the point where a search engine would ever show the whole thing, adding clause after clause after clause, so most of it ends up cut off with an ellipsis that no one reads.";

const metaTooLong: Fixture = {
  path: "/head/meta-description-too-long",
  category: HEAD,
  name: "Meta description too long",
  expectedIssues: ["meta-description.too-long"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with a very long meta description",
      metaDescription: LONG_META,
      bodyHtml: article({
        h1: "A meta description that runs too long",
        lede: "You can write too much here, and this page proves it.",
        sections: [
          {
            h2: "Where the snippet gets cut",
            body: "The description is shown in a fixed width and cut off with an ellipsis, usually somewhere around 150 to 160 characters. Everything past that point does not appear in the result. If your reason to click is at the end of a long description, it will not be seen.",
          },
          {
            h2: "Keep it to one line",
            body: "Put the most important point first, keep the whole thing to a single sentence, and stop before the cutoff. If you find yourself joining three ideas together with semicolons, that is two descriptions competing for one slot.",
          },
        ],
      }),
    })),
};

const SHORT_META = "A short, unique snippet for this one fixture.";

const metaTooShort: Fixture = {
  path: "/head/meta-description-too-short",
  category: HEAD,
  name: "Meta description too short",
  expectedIssues: ["meta-description.too-short"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with a very short meta description",
      metaDescription: SHORT_META,
      bodyHtml: article({
        h1: "A meta description that is too short",
        lede: "The page has a description, but it is too short to do much work.",
        sections: [
          {
            h2: "Why short snippets underperform",
            body: "The meta description is the short sales pitch under the title in a search result. A tiny description leaves most of that space blank, so the page says less than the results around it. Search engines may also decide the tag is not useful and pull text from the page instead, which can produce a choppy or irrelevant snippet.",
          },
          {
            h2: "What enough detail looks like",
            body: "A useful description names the page, explains what someone will get, and gives a reason to click. It does not need to be long, but it needs enough room to be specific. Around 70 to 160 characters is usually enough to summarize the page without drifting into a paragraph.",
          },
        ],
      }),
    })),
};

const missingH1: Fixture = {
  path: "/head/missing-h1",
  category: HEAD,
  name: "Missing H1",
  expectedIssues: ["headings.h1-missing"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with no H1 on the fixture site",
      metaDescription:
        "Every heading on this page is an H2 or lower. The top-level H1 that should state the topic is missing.",
      // Hand-authored body: starts at H2 on purpose, no H1.
      bodyHtml: `<h2>Where the headline should be</h2>
<p class="lede">This article has plenty to say, but it never states its topic in an H1.</p>
<p>A well-structured page opens with a single H1 that names what the page is about, then uses H2s and H3s for the sections under it. When the H1 is missing, both a screen reader and a search crawler lose the anchor that tells them the main subject, and the page reads like a chapter with no chapter title.</p>
<h2>Why it happens</h2>
<p>Usually a design system styles the real headline as a plain div for exact control, or a template marks the site logo as the only H1 and leaves the article headline as an H2. Either way the fix is the same: make the real headline a proper H1 so the markup matches what the eye already sees.</p>
<h3>A quick check</h3>
<p>Open the page and confirm there is exactly one H1, and that a stranger could read it and know what the page is about before scrolling.</p>`,
    })),
};

/**
 * Upstream expected its `missing-h1` issue here. Ariadne's `headings.h1-missing`
 * counts h1 elements and this page has one, so nothing fires: no rule reads the
 * *text* of a heading yet. The page is kept because it is the honest test of
 * that gap — a rule that treats an empty h1 as missing would claim it.
 */
const emptyH1: Fixture = {
  path: "/head/empty-h1",
  category: HEAD,
  name: "Empty H1",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with an empty H1 on the fixture site",
      metaDescription:
        "The only H1 on this page is empty, so the markup has a top-level heading tag but no actual heading text.",
      bodyHtml: `<h1></h1>
<p class="lede">The headline tag is present, but it does not contain a headline.</p>
<p>${lorem(90)}</p>
<h2>Why an empty heading fails</h2>
<p>An H1 is useful because it says what the page is about. A blank tag gives screen readers a heading stop with no label and gives search engines no phrase to connect to the topic. It can happen when a template renders the heading wrapper even when the CMS field is blank, or when styling hides all text from the tag.</p>
<h3>What to fix</h3>
<p>Put the real page headline inside the H1, then use H2 and H3 for the sections below it. If the page does not have a clear headline yet, write one before publishing instead of leaving an empty element in the document outline.</p>`,
    })),
};

const multipleH1: Fixture = {
  path: "/head/multiple-h1",
  category: HEAD,
  name: "Multiple H1s",
  expectedIssues: ["headings.h1-multiple"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with three H1s on the fixture site",
      metaDescription:
        "This page marks three separate lines as an H1, so a crawler gets three competing claims about the topic.",
      bodyHtml: `<h1>This line is an H1</h1>
<h1>So is this one</h1>
<p class="lede">Three H1s on one page. A crawler cannot tell which one is the actual topic.</p>
<p>An H1 is meant to be the single most important label on a page, the headline. When a template makes the logo, the headline, and a sidebar title all H1s, a crawler gets three claims about what the page is about and has to guess. The topic signal you meant to send gets split three ways.</p>
<h1>And this is the third H1</h1>
<p>The usual cause is a shared heading component with a fixed level, dropped into places that should have been H2 or H3. Pick the one real headline, keep it as the H1, and lower the rest. Something like a logo should not be a heading at all; a styled span or div is the right tag for that.</p>`,
    })),
};

const headingSkip: Fixture = {
  path: "/head/heading-order-skip",
  category: HEAD,
  name: "Heading levels skip",
  expectedIssues: ["headings.level-skip"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that skips heading levels",
      metaDescription:
        "The headings on this page jump from H1 to H4, leaving a gap that confuses screen readers and parsers.",
      bodyHtml: `<h1>Headings that skip a level</h1>
<p class="lede">This page goes from an H1 straight to an H4, as if H2 and H3 did not exist.</p>
<h4>The first section, which should have been an H2</h4>
<p>Headings are not just larger and smaller text. They form a nested outline that screen readers announce and that search engines use to understand structure. When the page jumps from H1 to H4, a screen reader user hears that they have gone three levels deep with nothing in between, which is confusing and makes the page harder to move through by headings.</p>
<h4>Another skipped-level section</h4>
<p>The fix is about the tag, not the size. If you want smaller text, use CSS, but keep the heading one level below its parent. A clean outline goes H1, then H2, then H3, then H4, so anyone reading the structure can follow it without a missing rung.</p>`,
    })),
};

// ---------------------------------------------------------------------------
// Content quality — badseo/src/fixtures/content.ts
// ---------------------------------------------------------------------------

const CONTENT = "content";

const thinContent: Fixture = {
  path: "/content/thin-content",
  category: CONTENT,
  name: "Thin content",
  expectedIssues: ["content.thin"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Thin content example on the fixture site",
      metaDescription:
        "A sparse page with almost no visible text, built to show how thin content reads to a crawler.",
      bodyHtml: `<h1>Nothing here yet</h1>
<p>This is the whole page. There is not enough here for a search engine to work with.</p>`,
    })),
};

const imagesMissingAlt: Fixture = {
  path: "/content/images-missing-alt",
  category: CONTENT,
  name: "Images missing alt text",
  expectedIssues: ["images.missing-alt"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with an image that has no alt text",
      metaDescription:
        "This page has an image with no alt attribute, so a screen reader and a search engine cannot tell what it shows.",
      bodyHtml: `<h1>An image with no alt text</h1>
<p class="lede">The image below has no alt text, so a screen reader skips over it as if it were not there.</p>
<img src="/img/placeholder.svg" width="720" height="360">
<h2>Why alt text matters</h2>
<p>An image with no alt attribute is a blank spot for anyone using a screen reader and a mystery to a crawler trying to read the page. Alt text is the caption the software reads. An image that carries meaning needs a short, specific description of what it shows. An image that is only decoration should carry an empty alt so the software knows to skip it on purpose.</p>
<h2>Getting it right</h2>
<p>Describe what the image shows and does, not that it is an image. Keep it short and do not stuff it with keywords. Never leave the attribute off entirely. A missing alt and an empty alt look almost the same in the markup but mean the opposite thing to the software that reads them.</p>`,
    })),
};

/**
 * The duplicate family — same page at two URLs, two pages sharing a title, two
 * pages sharing a meta description. Ariadne answers all three with cross-page
 * SQL (`contentHash` / `simhash` / grouped field values), and as of Phase 7 all
 * three have their rule: `content.exact-duplicate` (CHECK-39) landed in Phase 3,
 * and `title.duplicate` (CHECK-35) and `meta-description.duplicate` (CHECK-36)
 * in P7-T2 — the numbers the first real audit had to report as unmeasured.
 *
 * These pages were written for those rules and waited three phases for them, so
 * what changes here is the expectations and nothing else. The identical pair
 * below carries all four findings, because two byte-identical pages share their
 * title and their description as well as their body.
 */
/**
 * The five values the duplicate rules group on, exported so the harness asserts
 * the strings this site actually serves rather than restating them.
 *
 * A copy of a value in two files is a copy that can drift: an edit here would
 * leave the harness pinning a title no page carries any more, and the assertion
 * would fail for the wrong reason — or, worse, keep passing against a group it
 * no longer describes.
 */
export const DUP_TITLE = "Pumpkin Spice Latte Recipe";
export const DUP_H1 = "The same latte recipe, twice";
export const DUP_META =
  "The same latte recipe, published word for word at two different URLs, so a search engine has to pick one and drop the other.";
const DUP_BODY = article({
  h1: DUP_H1,
  lede: "This page is identical, byte for byte, to another URL on this site.",
  sections: [
    {
      h2: "Two URLs, one page",
      body: "Duplicate content is the same text living at more than one address: a trailing-slash variant, an http and an https copy, a print version, or, as here, the same article pasted at two paths. A search engine does not want to show the same thing twice, so it picks one URL to keep and drops the rest, and the ranking signals get split across copies that now compete with each other.",
    },
    {
      h2: "How to fix it",
      body: "Pick one URL to be the real one and point the duplicates at it with a rel=canonical tag, or send a 301 redirect so people and crawlers both land on the single page. On templated sites, watch for URL parameters and slashes creating identical pages you did not mean to make, each one taking a little strength from the page that should rank.",
    },
  ],
});

function duplicateBody(path: string, expectedIssues: string[] = []): Fixture {
  return {
    path,
    category: CONTENT,
    name: "Duplicate content (same page, two URLs)",
    // Every duplicate rule reports the GROUP once, on its lexically first
    // member, so all four expectations belong to `/content/duplicate-a` alone —
    // the `-b` copy is named in each finding's evidence rather than carrying one
    // of its own. The four are `content.exact-duplicate` (the body),
    // `title.duplicate`, `meta-description.duplicate` and `h1.duplicate-text`:
    // two identical pages are identical in every one of those columns, which is
    // exactly why the h1 rule needed a pair of its own that is NOT identical
    // (test/fixtures/pages/authored-p7.ts).
    expectedIssues,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: DUP_TITLE,
        metaDescription: DUP_META,
        bodyHtml: DUP_BODY,
      })),
  };
}

export const SHARED_TITLE = "Blue Running Shoes | Sole Mates";

const dupTitleA: Fixture = {
  path: "/content/duplicate-title-a",
  category: CONTENT,
  name: "Duplicate title (product A)",
  // The group is reported on its lexically first member, which is this page;
  // `-b` is named in the evidence. The two descriptions differ, deliberately —
  // this pair is the title rule's fixture and must not also be the description
  // rule's, or neither finding would prove which column was grouped.
  expectedIssues: ["title.duplicate"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: SHARED_TITLE,
      metaDescription:
        "The Marathon model in cobalt blue, a cushioned daily trainer built for long, flat road miles.",
      bodyHtml: article({
        h1: "Marathon Trainer, Cobalt Blue",
        lede: "A cushioned road shoe for runners who put in serious weekly mileage.",
        sections: [
          {
            h2: "Built for distance",
            body: "The Marathon is a long-run shoe: a soft, high-stack midsole that stays comfortable deep into a twenty-miler, a breathable knit upper, and a durable outsole rated for hundreds of road miles. It is a different product from the Sprint, but both pages ship with the same title above, so a search engine cannot tell them apart at a glance.",
          },
          {
            h2: "Why the title matters here",
            body: "When every product in a catalogue inherits the same title, the pages compete for the same searches and none of them stands out. The fix is to put the differences, the model name and the colour and the use case, into the title template so Marathon and Sprint read as the separate products they are.",
          },
        ],
      }),
    })),
};

const dupTitleB: Fixture = {
  path: "/content/duplicate-title-b",
  category: CONTENT,
  name: "Duplicate title (product B)",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: SHARED_TITLE,
      metaDescription:
        "The Sprint model in electric blue, a firm, low-drop racing flat for 5K and 10K races.",
      bodyHtml: article({
        h1: "Sprint Racer, Electric Blue",
        lede: "A light racing flat for short, fast efforts on the track and road.",
        sections: [
          {
            h2: "Built for speed",
            body: "The Sprint is the opposite of a long-run shoe: a firm, responsive plate, a low drop that pushes a snappy forefoot strike, and almost no weight to carry around a fast 5K. No one would confuse it with the Marathon in person, but on a results page the two look the same because they carry the same title.",
          },
          {
            h2: "One title, two products",
            body: "This is the common store version of a duplicate title: a catalogue template that outputs a generic colour-and-category title for every item. A search engine groups the pages, the click rate drops, and the store competes with itself. Making the titles different is a small template change that helps across the whole catalogue.",
          },
        ],
      }),
    })),
};

export const SHARED_META =
  "Fresh, seasonal, and made locally every morning, then delivered to your door. Order today.";

const dupMetaA: Fixture = {
  path: "/content/duplicate-meta-a",
  category: CONTENT,
  name: "Duplicate meta description (bakery)",
  // Reported on the group's first member, like the title pair above, and with
  // the same discipline in the other direction: the two titles differ, so this
  // pair proves the description column and only that one.
  expectedIssues: ["meta-description.duplicate"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Early Riser Bakery, sourdough and pastries",
      metaDescription: SHARED_META,
      bodyHtml: article({
        h1: "Early Riser Bakery",
        lede: "Slow-fermented sourdough and pastries, baked before dawn.",
        sections: [
          {
            h2: "What we bake",
            body: "Every loaf takes two days: a long, cold fermentation for flavour, a hot oven for the crust, and an open crumb inside. Alongside the bread we make croissants, morning buns, and a rotating set of seasonal tarts. This is clearly a bakery, but its meta description is the same generic sentence used on our florist site.",
          },
          {
            h2: "The snippet problem",
            body: "Because the description is shared, someone searching finds two of our pages with the same snippet and no way to tell the bakery from the flower shop. Reusing one sentence across every page feels efficient, but it gives up the chance to sell each page in the one place people actually read before clicking.",
          },
        ],
      }),
    })),
};

const dupMetaB: Fixture = {
  path: "/content/duplicate-meta-b",
  category: CONTENT,
  name: "Duplicate meta description (florist)",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Petal & Stem, seasonal flower delivery",
      metaDescription: SHARED_META,
      bodyHtml: article({
        h1: "Petal & Stem Florist",
        lede: "Hand-tied seasonal bouquets, cut fresh and delivered the same day.",
        sections: [
          {
            h2: "What we arrange",
            body: "Our bouquets follow the seasons: tulips and ranunculus in spring, dahlias in late summer, amaryllis and evergreens through winter. Each is hand-tied to order and delivered in water so it lasts. This is very clearly a flower shop, not a bakery, but the two sites were built from one template and share the same meta description.",
          },
          {
            h2: "One sentence, two businesses",
            body: "When the same description is used on unrelated pages, the search results show the same snippet twice with nothing to tell them apart, and the click rate drops on both. The fix is to write a specific, honest description for each page that says what that page offers.",
          },
        ],
      }),
    })),
};

// ---------------------------------------------------------------------------
// Indexability & canonical — badseo/src/fixtures/indexability.ts
// ---------------------------------------------------------------------------

const INDEX = "indexability";

/**
 * The site's one noindexed sitemap entry (Task 9), which is why
 * `sitemap.non-indexable` lands here: a URL a sitemap asks a search engine to
 * crawl, answering 200 with a directive telling it not to keep the result.
 *
 * It is also the target of two Phase 3 fixtures — `/authored3/canonical-to-noindex`
 * and `/authored3/hreflang-noindex` — for the same property. Nothing about this
 * page changes for them; it is named by them.
 */
const noindexMeta: Fixture = {
  path: "/index/noindex-meta",
  category: INDEX,
  name: "Noindex (robots meta)",
  expectedIssues: ["indexability.noindex", "sitemap.non-indexable"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page set to noindex on the fixture site",
      metaDescription:
        "This page can be crawled, but a robots noindex tag tells search engines to keep it out of results.",
      robotsMeta: "noindex, follow",
      bodyHtml: article({
        h1: "This page asks not to be indexed",
        lede: "Nothing is wrong with this page. It just does not want to be in Google.",
        sections: [
          {
            h2: "When noindex is right",
            body: "Some pages should not show up in search: internal search results, filter combinations, thank-you pages, staging content. A robots noindex tag is the correct way to keep them out while still letting crawlers follow their links. It is a feature, most of the time.",
          },
          {
            h2: "When it is a problem",
            body: "The same tag becomes a problem when it ends up on pages that were meant to rank. A noindex left over from a staging setup, or a template that applies it too widely, can drop a whole section of a site from search. That is why an audit reports every noindex it finds, so a person can confirm each one is on purpose.",
          },
        ],
      }),
    })),
};

const noindexHeader: Fixture = {
  path: "/index/noindex-header",
  category: INDEX,
  name: "Noindex (X-Robots-Tag header)",
  expectedIssues: ["indexability.noindex"],
  // Off the sitemap: `/index/noindex-meta` above is the listed noindexed entry,
  // and one is what the rule needs.
  inSitemap: false,
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "Noindex set in a response header",
        metaDescription:
          "The HTML on this page looks indexable, but an X-Robots-Tag header tells search engines to skip it.",
        bodyHtml: article({
          h1: "A noindex you cannot see in the HTML",
          lede: "View the source all you want. This page's noindex is in the HTTP headers.",
          sections: [
            {
              h2: "Headers can control indexing too",
              body: "The X-Robots-Tag response header does what a robots meta tag does, but from the HTTP layer instead of the page. It is handy for files like PDFs and for setting rules at the server or CDN level. The catch is that it is invisible if you only look at the rendered HTML, which is how it can hide for months.",
            },
            {
              h2: "Why a tool has to check both",
              body: "A crawler that reads only the HTML will report this page as indexable, because nothing in the markup says otherwise. Catching a header-level rule means reading the response headers on every request. This page exists to check that an audit does that, instead of trusting the HTML.",
            },
          ],
        }),
      }),
      { headers: { "x-robots-tag": "noindex" } },
    ),
};

const canonicalized: Fixture = {
  path: "/index/canonicalized",
  category: INDEX,
  name: "Canonicalized to another URL",
  expectedIssues: ["canonical.points-elsewhere"],
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A page whose canonical points elsewhere",
      metaDescription:
        "This page's rel=canonical points at the homepage, telling search engines to credit that URL instead of this one.",
      canonical: new URL("/", self).href,
      bodyHtml: article({
        h1: "This is not the canonical page",
        lede: "This page exists, but it tells search engines to index a different URL in its place.",
        sections: [
          {
            h2: "What a cross-URL canonical does",
            body: "A rel=canonical pointing at a different address is an instruction: treat that other URL as the real one and fold the ranking signals into it. It is the right tool for syndicated copies, parameter variants, and print versions. Used on purpose, it prevents duplicate-content problems before they start.",
          },
          {
            h2: "When it goes wrong",
            body: "It becomes a real problem when a template hardcodes the homepage, or a staging domain, as the canonical for every page. Now the whole site tells search engines that none of its pages should rank on their own, and they should all defer to one URL. The pages drop out of results with no error anywhere, which is why an audit reports every canonical that points away from its own page.",
          },
        ],
      }),
    })),
};

const canonicalConflict: Fixture = {
  path: "/index/canonical-conflict",
  category: INDEX,
  name: "Conflicting canonical signals",
  expectedIssues: ["canonical.html-header-conflict", "canonical.points-elsewhere"],
  handler: (req, res) =>
    serve(
      req,
      res,
      (self) => ({
        title: "A page with two different canonicals",
        metaDescription:
          "This page ships two canonical URLs that disagree: one in the HTML head and a different one in the HTTP Link header.",
        canonical: `${self}?via=html`,
        bodyHtml: article({
          h1: "Two canonicals that disagree",
          lede: "The head names one canonical URL. The HTTP header names another. Both lose.",
          sections: [
            {
              h2: "Mixed signals",
              body: "You can set a canonical URL in the HTML head with a link tag, or in the HTTP response with a Link header. Search engines read both. When the two disagree, as they do here, the search engine cannot trust either one, so it drops them and picks a canonical on its own, which is rarely the one you wanted.",
            },
            {
              h2: "Pick one place",
              body: "Set the canonical in one place and keep it consistent. Most sites use the HTML head tag and never touch the header. If a CDN or framework is adding a Link-header canonical you did not ask for, that is usually the cause. Line it up with the head tag, or remove it, so there is one clear answer.",
            },
          ],
        }),
      }),
      {
        // Relative on purpose: a `Link` canonical is resolved against the page
        // URL, and the port is not known when this module is evaluated.
        headers: { link: `</index/canonical-conflict?via=header>; rel="canonical"` },
      },
    ),
};

// ---------------------------------------------------------------------------
// HTTP status & links — badseo/src/fixtures/http-status.ts
// ---------------------------------------------------------------------------

const STATUS = "status";

/**
 * Upstream reached this URL through the sitemap, and since Task 9 so do we: it
 * is the site's one deliberately dead sitemap entry, as well as being linked
 * from the hub. Ariadne reports a 404 as a `client_error` page row and says so
 * in the crawl summary.
 *
 * Two rules land here and each is about a different publisher of the dead URL:
 * `links.broken-internal` is target-centric — one finding for the URL, counting
 * the pages that link to it — so it lands HERE rather than on
 * `/links/broken-internal-link` below, which is the page holding the link. And
 * `sitemap.non-200` is the same URL's other appearance: a line of XML telling
 * search engines to go and fetch it.
 */
const notFound: Fixture = {
  path: "/status/not-found",
  category: STATUS,
  name: "Page returns 404",
  expectedIssues: ["links.broken-internal", "sitemap.non-200"],
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "404, this page does not exist on the fixture site",
        metaDescription: "A URL that is listed in the sitemap but returns 404.",
        bodyHtml: article({
          h1: "404, but the sitemap still lists it",
          lede: "The sitemap says this page exists. The server returns 404.",
          sections: [
            {
              h2: "Why a 404 in the sitemap is a problem",
              body: "A sitemap is a list of pages you are telling search engines to go crawl. When one of those URLs returns 404, you spend crawl budget fetching nothing and keep pointing the crawler at a page that is not there. On a large site, thousands of these add up.",
            },
            {
              h2: "The fix",
              body: "If the page should exist, restore it. If it is gone for good, take it out of the sitemap and out of any internal links, and if something replaced it, add a 301 to that page. What you do not want is to leave it in the sitemap, telling crawlers to keep visiting a URL that no longer works.",
            },
          ],
        }),
      }),
      { status: 404 },
    ),
};

/**
 * 503 rather than upstream's 500 (see the header). The prose deliberately
 * carries none of fetch-page's bot-challenge markers, so the response is
 * classified `server_error` and not `blocked`.
 */
const serverError: Fixture = {
  path: "/status/server-error",
  category: STATUS,
  name: "Server error (503)",
  expectedIssues: ["http.server-error"],
  // Off the sitemap: one dead entry (`/status/not-found`) is what
  // `sitemap.non-200` needs, and listing this one too would put a second copy of
  // that finding on a page whose subject is the 5xx itself.
  inSitemap: false,
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "503, the server errored on the fixture site",
        metaDescription: "A URL that returns a server error to every crawler.",
        bodyHtml: article({
          h1: "A server error",
          lede: "This URL does not return 404. It returns a server error every time.",
          sections: [
            {
              h2: "5xx is worse than 4xx",
              body: "A 404 says the page is not here. A 5xx says the server itself failed while trying to answer. Search engines treat repeated server errors as a sign the site is unhealthy and respond by slowing their crawl. Do it often enough and pages start dropping out of the index.",
            },
            {
              h2: "Return the right code",
              body: "If content is gone, return a 404 or 410 so the search engine can update its records. Keep server errors for actual, unexpected failures, and then read the logs and fix them. A route that fails every time is not an error page, it is a bug.",
            },
          ],
        }),
      }),
      { status: 503 },
    ),
};

const blocked: Fixture = {
  path: "/status/blocked",
  category: STATUS,
  name: "Crawler blocked (403)",
  expectedIssues: ["crawl.blocked"],
  // Off the sitemap, for the same reason as the 503 above.
  inSitemap: false,
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "403, the crawler was blocked on the fixture site",
        metaDescription: "A page that returns 403 Forbidden to crawlers.",
        bodyHtml: article({
          h1: "403, access denied to the crawler",
          lede: "Aggressive bot protection can block the good crawlers along with the bad ones.",
          sections: [
            {
              h2: "Blocked is not the same as broken",
              body: "When a page answers a crawler with 403, 429, or a challenge screen, the honest conclusion is not that the page is broken. It is that the crawler was not allowed to see it. A good audit says exactly that. Reporting a blocked page as a content problem would send you looking for a bug that is not there, when the real issue is access.",
            },
            {
              h2: "When your own protection backfires",
              body: "Strict WAF rules and bot-fight modes often catch real crawlers in the same net as scrapers. If search engines or your own audit keep getting blocked, allowlist their user agents so they can read the site. A page nobody can crawl is a page that cannot rank, however good the content behind the wall is.",
            },
          ],
        }),
      }),
      { status: 403 },
    ),
};

const brokenInternalLink: Fixture = {
  path: "/links/broken-internal-link",
  category: STATUS,
  name: "Broken internal link",
  // The finding for this page's dead link is written against the TARGET, so it
  // is `/status/not-found` that expects `links.broken-internal`, not this page.
  // This page is the inlink the finding counts.
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with a broken internal link",
      metaDescription:
        "This page is otherwise fine, but it links to one of its own URLs that returns a 404.",
      bodyHtml: `<h1>The link below goes nowhere</h1>
<p class="lede">This page is fine, except that it links to a page that no longer exists.</p>
<p>Broken internal links are one of the most common and most avoidable technical SEO problems. A person clicks, hits a 404, and leaves. A crawler follows the link, wastes a request, and learns nothing. Any link strength that should have gone to a real page goes into a dead end instead. Unlike a broken external link, this one is entirely yours to fix.</p>
<p>Here is the link, pointing at a URL on this site that returns a 404: <a href="/status/not-found">read our full guide</a>. Click it and you land on a Not Found page, which is what the audit reports when it crawls this link and sees the target return 404.</p>
<h2>How to catch these</h2>
<p>Crawl your own site regularly and check the status of every internal link target. The moment a linked page starts returning 4xx or 5xx, repoint the link to the correct URL or remove it. Do not rely on a redirect to cover it forever; link straight to the page that works.</p>`,
    })),
};

// ---------------------------------------------------------------------------
// Redirects — badseo/src/fixtures/redirects.ts
// ---------------------------------------------------------------------------

const REDIRECT = "redirect";

/**
 * The chain and the loop. Ariadne records every hop as its own `redirect` page
 * row, and the redirect query rules walk that graph: `redirect.chain` is
 * reported once, at the chain's HEAD (the redirect nothing else points at), so
 * `/redirect/chain-1` carries it and the middle hop carries nothing.
 *
 * The loop is the headless case the walk's second pass exists for: nothing
 * outside `/redirect/loop` redirects to it, so it is no chain's head and only a
 * walk seeded from the page itself finds the cycle.
 *
 * The chain's head is also the site's one redirecting sitemap entry (Task 9), so
 * it carries `sitemap.redirected` as well: a sitemap should list destinations,
 * and this one lists a URL that moves twice before it lands.
 */
const redirectChain: Fixture = {
  path: "/redirect/chain-1",
  category: REDIRECT,
  name: "Redirect chain (3 hops)",
  expectedIssues: ["redirect.chain", "sitemap.redirected"],
  handler: (_req, res) => redirect(res, "/redirect/chain-2", 301),
};

const redirectChainMid: Fixture = {
  path: "/redirect/chain-2",
  category: REDIRECT,
  name: "Redirect chain (middle hop)",
  // The chain is reported at its head, above; a middle hop is not a second
  // chain. Off the sitemap: the head is the listed entry, and a second listed
  // hop would be a second `sitemap.redirected` finding for one chain.
  expectedIssues: [],
  inSitemap: false,
  handler: (_req, res) => redirect(res, "/", 301),
};

const redirectLoop: Fixture = {
  path: "/redirect/loop",
  category: REDIRECT,
  name: "Redirect loop",
  expectedIssues: ["redirect.loop"],
  inSitemap: false,
  handler: (_req, res) => redirect(res, "/redirect/loop", 302),
};

/**
 * The trailing-slash trap (upstream's PR #61 regression): the slash form is the
 * canonical 200 and the non-slash form 301s to it, exactly as WordPress does. A
 * crawler that normalised the slash away would follow its own redirect forever.
 * `normalizeUrl` preserves trailing slashes precisely so this terminates, so
 * the expectation here is that nothing at all is reported.
 */
const TRAILING_SLASH_CANONICAL = "/redirect/trailing-slash/";

const trailingSlashRedirect: Fixture = {
  path: "/redirect/trailing-slash",
  category: REDIRECT,
  name: "Trailing-slash redirect (non-slash form)",
  expectedIssues: [],
  // A sitemap should list the destination, and this site's does: the slash form
  // below is listed and this one is not.
  inSitemap: false,
  handler: (_req, res) => redirect(res, TRAILING_SLASH_CANONICAL, 301),
};

const trailingSlashCanonical: Fixture = {
  path: TRAILING_SLASH_CANONICAL,
  category: REDIRECT,
  name: "Trailing-slash canonical (redirect-cycle trap)",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Trailing-slash canonical page on the fixture site",
      metaDescription:
        "The canonical version of this page ends in a trailing slash, and the non-slash form redirects to it, which trips up crawlers that strip slashes.",
      bodyHtml: article({
        h1: "This is the canonical, trailing-slash version",
        lede: "You reached this via a 301 from the non-slash URL. That is normal, and a crawler must handle it without looping.",
        sections: [
          {
            h2: "Why the trailing slash matters",
            body: "Most content management systems treat the trailing-slash form of a URL as canonical and 301-redirect the non-slash form to it. So /services and /services/ are not two pages; one is a permanent redirect to the other. This is correct behaviour, and every crawler has to deal with it.",
          },
          {
            h2: "Where crawlers go wrong",
            body: "A crawler that quietly strips trailing slashes to deduplicate URLs turns the canonical /services/ back into /services, fetches it, gets a 301 to /services/, strips the slash again, and queues /services once more. That cycle repeats until a loop detector gives up with a 508. The fix is to preserve the trailing slash, or to follow the redirect to the canonical form and mark it visited, so the page is crawled once and never re-queued.",
          },
        ],
      }),
    })),
};

// ---------------------------------------------------------------------------
// Performance — badseo/src/fixtures/performance.ts
// ---------------------------------------------------------------------------

/**
 * Upstream's 1.7s stall, kept as it was: comfortably over Ariadne's 1500ms
 * `SLOW_MS` threshold (and over the fixture app's 1600ms floor), and nowhere
 * near the crawl loop's 20s fetch deadline.
 */
const SLOW_DELAY_MS = 1_700;

const slowResponse: Fixture = {
  path: "/perf/slow-response",
  category: "performance",
  name: "Slow server response",
  expectedIssues: ["performance.slow-response"],
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "A page with a slow server response",
        metaDescription:
          "This page waits about 1.7 seconds before it responds, past the point where a slow time to first byte starts to hurt.",
        bodyHtml: article({
          h1: "A slow response",
          lede: "The pause before this page loaded was on purpose, and it was too long.",
          sections: [
            {
              h2: "Why time to first byte matters",
              body: "Time to first byte is how long the server takes before it sends anything at all. It sets the floor under every other speed metric. The browser cannot start rendering, and the crawler cannot start reading, until that first byte arrives. A slow time to first byte makes a fast front end feel slow, and at scale it means search engines crawl fewer of your pages per visit.",
            },
            {
              h2: "Common causes and fixes",
              body: "Most slow responses come from doing real work on every request: uncached database queries, slow upstream APIs, or rendering that could have been done ahead of time. The usual fix is to stop building the same HTML over and over. Cache it, generate it in advance, or serve it from the edge, so the server can answer in milliseconds.",
            },
          ],
        }),
      }),
      { delayMs: SLOW_DELAY_MS },
    ),
};

// ---------------------------------------------------------------------------
// Site structure — badseo/src/fixtures/structure.ts
// ---------------------------------------------------------------------------

const STRUCTURE = "structure";

/**
 * Upstream kept this page out of its catalog and in its sitemap, so nothing
 * linked to it. Task 9 restored exactly that arrangement: the site now publishes
 * a sitemap, this page is listed in it, and the hub does not link it — so the
 * only route to it is the sitemap, and `links.orphan` says so with
 * `inSitemap: true` in its evidence.
 *
 * A floor rather than an exact set, like the rest of the absorbed collection:
 * the prose is upstream's and was written to demonstrate one thing, not to be
 * silent about the rest.
 */
const orphan: Fixture = {
  path: "/structure/orphan",
  category: STRUCTURE,
  name: "Orphan page",
  linkedFromHub: false,
  expectedIssues: ["links.orphan"],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "An orphan page on the fixture site",
      metaDescription:
        "A normal page that no other page on the site links to. It is only reachable because it is listed in the sitemap.",
      bodyHtml: article({
        h1: "A page nothing links to",
        lede: "This page is fine. No other page on the site links to it.",
        sections: [
          {
            h2: "What makes a page an orphan",
            body: "An orphan page has no internal links pointing at it. You can still reach it if you know the URL, and it may be in the sitemap, but there is no path to it by clicking around the site. Search engines lean on internal links to find pages and to pass strength between them, so an orphan gets crawled rarely and ranks weakly, however good it is.",
          },
          {
            h2: "How pages get orphaned",
            body: "It usually happens by accident. A page is removed from a menu but the URL stays live, a campaign landing page loses its links when the campaign ends, or a bulk import creates pages that were never added to navigation. The fix is to link to the page from somewhere relevant, like a hub page, a related article, or the main navigation, so both crawlers and people can find it.",
          },
        ],
      }),
    })),
};

/**
 * Still unclaimed after Phase 3: "this page links nowhere" is a dead-end metric
 * over the link graph, and no rule in the registry asks the question yet (the
 * link-graph rules Phase 3 shipped are `links.orphan` and its skip twin, which
 * are about INBOUND links). The page genuinely has no anchors, which is what
 * that metric will need when it lands.
 */
const noOutgoingLinks: Fixture = {
  path: "/structure/no-outgoing-links",
  category: STRUCTURE,
  name: "No outgoing links",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Page with no outgoing links on the fixture site",
      metaDescription:
        "This healthy page deliberately renders no anchor tags, so crawlers and users reach a dead end.",
      bodyHtml: article({
        h1: "A page with no outgoing links",
        lede: "Everything on this page is healthy except the complete lack of links.",
        sections: [
          {
            h2: "Why dead ends are a problem",
            body: "Search crawlers move through a site by following links. When a page has no outgoing links, any link strength that reaches it stops there, and a crawler has no next page to discover from this point. People hit the same problem when they finish reading and have nowhere useful to go except the browser back button.",
          },
          {
            h2: "What a healthy page should do",
            body: "Most pages should point somewhere sensible after the main content: a related article, a parent category, the homepage, or the next step in a flow. The exact destination depends on the page, but the pattern is the same. A useful page should help visitors continue, and it should help crawlers understand how this URL fits into the wider site instead of treating the page as an isolated endpoint.",
          },
        ],
      }),
    })),
};

/**
 * The click-chain. `/deep/1` is the only rung the hub links; every other rung is
 * reachable only from the one above it, so a page's depth is its number. With
 * the hub at depth 0 and `structure.deep-page` firing above `DEEP_DEPTH` (5),
 * `/deep/6` and `/deep/7` are the buried pages.
 *
 * NO RUNG IS IN THE SITEMAP, and that is load-bearing rather than tidy: the
 * crawl loop enqueues every sitemap entry at depth 0 before the first fetch, so
 * a listed page is a depth-0 page whatever links to it. Listing the chain would
 * flatten it, `structure.deep-page` would fire nowhere, and the fixture would
 * quietly stop being about depth at all. The price is that each rung is an
 * indexable 200 the sitemap omits, so each also fires `pages.not-in-sitemap` —
 * which is true of them, and is stated in the exact set on the last rung.
 */
const DEEP_CHAIN_LENGTH = 7;
/** The threshold itself, read from the rule's constant so the chain follows it. */
const DEEP_DEPTH_THRESHOLD = DEEP_DEPTH;

function deepRung(level: number): Fixture {
  const next = level < DEEP_CHAIN_LENGTH ? `/deep/${level + 1}` : null;
  return {
    path: `/deep/${level}`,
    category: STRUCTURE,
    name: `Deep click-path, level ${level}`,
    // Every rung is under THIN_WORDS, so every rung fires `content.thin` as
    // well. That is not an accident to be padded away: the chain exists to be
    // long, not to be read, and the two hundred words each rung would need to
    // clear the threshold would be filler on seven pages nobody looks at. The
    // honest thing is to say so — and until the exact pin below went on, nobody
    // had, because a containment assertion never asks what else fired.
    // Rung 2 carries a third: the rungs are one template with a number
    // substituted, so several of them are near-duplicates of each other — 2
    // pairs with 4, 5 and 6 inside the three-bit band, and each pair is
    // reported once, on the lexically first of the two, which is why rung 2 is
    // the only one carrying the finding. Also not an accident to be papered
    // over — it is exactly what CHECK-39 is about, and the pin in
    // harness.test.ts quotes every pair and its distance.
    // Every rung, the first included, also fires `pages.not-in-sitemap`: the
    // chain is deliberately unlisted (see the header above) and the rungs are
    // indexable 200s, so the sitemap rule is right about all of them. It is
    // spelled out here rather than only on the exact rung so the list reads as
    // the complete account it is.
    expectedIssues: [
      "content.thin",
      "pages.not-in-sitemap",
      ...(level > DEEP_DEPTH_THRESHOLD ? ["structure.deep-page"] : []),
      ...(level === 2 ? ["content.near-duplicate"] : []),
    ],
    // The last rung is pinned exactly rather than as a floor: unlike the rest
    // of the absorbed collection its body is ours (the chain was rebuilt for
    // Ariadne's depth threshold), so its complete finding set is something we
    // engineered and can therefore assert. Depth and length are the two things
    // true of it; a third finding appearing there would mean these pages had
    // stopped being what they were built to be.
    exact: level === DEEP_CHAIN_LENGTH,
    // Only the first rung is linked from the hub: every other one is reachable
    // solely from the rung above, which is what gives these pages their depth.
    linkedFromHub: level === 1,
    inSitemap: false,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: `Deep click-path, level ${level} of a deliberately deep chain`,
        metaDescription: `Level ${level} of a deliberately deep click-path. The only way on is the single link at the bottom of the page.`,
        bodyHtml: `${article({
          h1: `You are ${level} click${level === 1 ? "" : "s"} deep`,
          lede: "The buried page is further down than it should be. Keep going.",
          sections: [
            {
              h2: "Why click-depth matters",
              body: "Search engines spend more crawl budget on pages close to the homepage and less on pages behind many clicks. Depth is a rough measure of importance. If it takes six clicks to reach a page, the site's own structure is saying the page barely matters. Content you care about should not be that far down.",
            },
            {
              h2: "How to fix a buried page",
              body: "The fix is not to delete the pages in between. It is to add shortcuts. Link to important deep pages straight from hubs, category pages, or the main navigation, so they sit two or three clicks from home instead of six. A flatter structure tells search engines the page matters and gives it a real chance to rank.",
            },
          ],
        })}
${next === null ? "<p class=\"end\">This is the end of the chain.</p>" : `<p class="next"><a href="${next}">Go to the next level down</a></p>`}`,
      })),
  };
}

// ---------------------------------------------------------------------------
// Kitchen sink — badseo/src/fixtures/kitchen-sink.ts
// ---------------------------------------------------------------------------

const KITCHEN_SINK_TITLE =
  "The Kitchen Sink Page That Breaks Six SEO Rules At Once And Has A Title That Is Far Too Long";

/** Six defects on one URL: the audit must report all of them, not the first. */
const kitchenSink: Fixture = {
  path: "/kitchen-sink",
  category: "kitchen-sink",
  name: "Kitchen sink (everything at once)",
  expectedIssues: [
    "title.too-long",
    "meta-description.missing",
    "headings.h1-multiple",
    "headings.level-skip",
    "images.missing-alt",
    "performance.slow-response",
  ],
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: KITCHEN_SINK_TITLE,
        // meta description intentionally omitted
        bodyHtml: `<h1>The kitchen sink page</h1>
<h1>Yes, that was two H1s</h1>
<p class="lede">This page is broken on purpose, in more than one way, so an audit has plenty to find.</p>
<img src="/img/placeholder.svg" width="720" height="360">
<h4>This section skips straight to an H4</h4>
<p>Everything on this page is wrong on purpose, and it is wrong in more than one way at the same time. That is how broken pages usually show up. Nobody ships a page with a single, tidy problem. They ship a template that is a little off in a few places, and each small problem chips away at how the page does in search.</p>
<p>Here they are. The title runs well past 60 characters, so search results cut it off. There is no meta description, so the search engine writes a snippet from whatever text it finds. Two lines are marked as H1, so the page makes two claims about its own topic. The outline then jumps from H1 to H4, skipping two levels.</p>
<h4>And a few more</h4>
<p>The image a few paragraphs up has no alt attribute, so it is invisible to a screen reader and to image search. And the whole response is slow, waiting well over a second and a half before the first byte. Any one of these is worth fixing on its own. Together they are a checklist of the most common on-page problems, put on one URL so you can watch an audit find all of them instead of stopping after the first.</p>
<p>If an audit reports all six problems for this page, it is working. If it only finds one or two, it is giving people false confidence, which is worse than no audit at all, because real problems hide behind a clean-looking report.</p>`,
      }),
      { delayMs: SLOW_DELAY_MS },
    ),
};

export const absorbedFixtures: Fixture[] = [
  missingTitle,
  titleTooLong,
  titleTooShort,
  missingMeta,
  metaTooLong,
  metaTooShort,
  missingH1,
  emptyH1,
  multipleH1,
  headingSkip,
  thinContent,
  imagesMissingAlt,
  duplicateBody("/content/duplicate-a", [
    "content.exact-duplicate",
    "title.duplicate",
    "meta-description.duplicate",
    "h1.duplicate-text",
  ]),
  duplicateBody("/content/duplicate-b"),
  dupTitleA,
  dupTitleB,
  dupMetaA,
  dupMetaB,
  noindexMeta,
  noindexHeader,
  canonicalized,
  canonicalConflict,
  notFound,
  serverError,
  blocked,
  brokenInternalLink,
  redirectChain,
  redirectChainMid,
  redirectLoop,
  trailingSlashRedirect,
  trailingSlashCanonical,
  slowResponse,
  orphan,
  noOutgoingLinks,
  ...Array.from({ length: DEEP_CHAIN_LENGTH }, (_, i) => deepRung(i + 1)),
  kitchenSink,
];
