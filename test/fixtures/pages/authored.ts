/**
 * The authored pages: fixtures written here, for the rules the absorbed
 * collection left unclaimed.
 *
 * Task 8 landed the badseo absorb and the control page, and ten registered
 * rules had no page to fire on — canonical.missing, canonical.multiple,
 * canonical.cross-domain, directive.canonical-noindex-conflict,
 * indexability.meta-header-conflict, content.placeholder,
 * mobile.viewport-missing, images.missing-dimensions, hreflang.invalid-code and
 * hreflang.missing-x-default. One page each is what this file is.
 *
 * Two things separate these from the absorbed pages:
 *
 *  1. **Every one starts from the control recipe.** `healthyBody` is the
 *     control page's shape — one h1, headings that step down a level at a time,
 *     an image that names itself and carries its dimensions, and comfortably
 *     more than `THIN_WORDS` words of prose — and each fixture breaks exactly
 *     the signals its name promises. Nothing here is broken by accident.
 *
 *  2. **`expectedIssues` is complete, not a floor.** Each fixture sets
 *     `exact: true`, so the harness asserts set equality: the list names EVERY
 *     rule the page fires, including the ones that come along for the ride
 *     (a canonical pointing at another URL fires `canonical.points-elsewhere`
 *     as well as whatever the page was written for, and saying so is the point).
 *     Every list below was verified by running the harness, not by reading the
 *     rules and guessing.
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

/**
 * Categories match the rule families these pages provoke rather than lumping
 * every authored page under one label: a harness failure names the category, and
 * "canonical" says more about where to look than "authored" does.
 */
const CONTENT = "content";
const CANONICAL = "canonical";
const INDEX = "indexability";
const HREFLANG = "hreflang";
const MOBILE = "mobile";
const IMAGES = "images";

/**
 * The control recipe as a function. `article` already gives the clean outline
 * and the well-described image; the extra section is here for word count —
 * `content.thin` fires below 150 words, and a fixture that tripped it by
 * accident would have to carry `content.thin` in `expectedIssues`, at which
 * point the list stops meaning "this page breaks exactly what it says it does".
 */
function healthyBody(opts: {
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  /** Render the well-described image. Default true. */
  withImage?: boolean;
}): string {
  return article({
    h1: opts.h1,
    lede: opts.lede,
    withImage: opts.withImage,
    sections: [
      { h2: "What this page does", body: opts.what },
      { h2: "Why it matters", body: opts.why },
      { h2: "How it gets fixed", body: opts.fix },
    ],
  });
}

// ---------------------------------------------------------------------------
// Content — content.placeholder
// ---------------------------------------------------------------------------

/**
 * `hasLoremIpsum` is a case-insensitive "lorem ipsum" match over the page's
 * VISIBLE text, so the placeholder has to be in the body copy rather than in a
 * comment or an attribute. The rest of the page is healthy: a real title, a
 * real description, and enough words that `content.thin` has nothing to say.
 */
const placeholderCopy: Fixture = {
  path: "/authored/lorem",
  category: CONTENT,
  name: "Placeholder copy left in the body",
  expectedIssues: ["content.placeholder"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Placeholder copy that shipped",
      metaDescription:
        "This page went live with a block of lorem ipsum still sitting where the real product copy was supposed to be.",
      bodyHtml: healthyBody({
        h1: "A page that shipped with its placeholder still in it",
        lede: "The head tags on this page are fine. The second paragraph is the one the writer never replaced.",
        what: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.",
        why: "Placeholder text on a live page is a small embarrassment and a real ranking problem at the same time. A search engine reads it as the page's content, so the page ends up described by a Latin passage that has nothing to do with what is being sold. Anyone who lands on it learns immediately that nobody checked the page before it went out, and they leave.",
        fix: "The fix is not a template change, it is a publishing check. Placeholder copy gets in when a page is built from a design mock and shipped before the words arrive, so the thing to catch it is a crawl that looks at body text on every page after every release, rather than a person remembering to reread each page one at a time.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

/**
 * `canonical: null` renders no `<link rel=canonical>` at all, and no `Link`
 * header goes with it, so the page declares no canonical from either source.
 * `canonical.missing` is gated on `isIndexable`, so the page also has to stay
 * plainly indexable: no robots meta, no `X-Robots-Tag`.
 */
const canonicalNone: Fixture = {
  path: "/authored/canonical-none",
  category: CANONICAL,
  name: "No canonical declared anywhere",
  expectedIssues: ["canonical.missing"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with no canonical link",
      metaDescription:
        "An indexable page that declares no canonical URL at all, in the head or in the response headers, so nothing names the original.",
      canonical: null,
      bodyHtml: healthyBody({
        h1: "This page never says which URL it is",
        lede: "There is no canonical link in the head and no canonical in the response headers either.",
        what: "A canonical link is how a page names the address it wants to be indexed under. This one does not have one, in either place a search engine looks. The page is otherwise healthy and plainly indexable, which is exactly the situation where the missing tag costs something rather than being harmless.",
        why: "Without a canonical, the search engine picks the URL itself. Most of the time it picks the one it crawled, which is fine until the same page becomes reachable with a tracking parameter, with and without a trailing slash, or through a category path as well as a flat one. Then the choice is made for you, the signals split across the variants, and the version that ranks is not necessarily the one you would have chosen.",
        fix: "Emit a self-referential absolute canonical on every indexable page, from the template rather than by hand, so a page that gains a parameter tomorrow still names itself today. It costs one line in the head and it removes an entire class of duplicate-content surprise before it can start.",
      }),
    })),
};

/**
 * Two `<link rel=canonical>` tags. `renderDocument` writes the self-referential
 * one first and `headExtra` second, which matters: `canonicalHtml` is the FIRST
 * declaration, so the audited value is this page's own URL and
 * `canonical.points-elsewhere` correctly stays quiet. Only the count is wrong,
 * which is what `canonical.multiple` reports.
 */
const canonicalMultiple: Fixture = {
  path: "/authored/canonical-multiple",
  category: CANONICAL,
  name: "Two canonical links in one head",
  expectedIssues: ["canonical.multiple"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Two canonical links in one head",
      metaDescription:
        "This page ships two rel=canonical link tags, so a search engine gets two different answers to a question that has one.",
      headExtra: '<link rel="canonical" href="/control">',
      bodyHtml: healthyBody({
        h1: "Two canonicals, one page",
        lede: "The head of this page declares a canonical twice, and the two tags do not name the same URL.",
        what: "The first canonical names this page. The second, further down the head, names a different one. Both are valid tags on their own and a browser will happily render the page, so nothing about it looks wrong until somebody reads the source or crawls it.",
        why: "A search engine that finds several canonical links on one page cannot tell which one the site meant, and the documented behaviour is to ignore all of them and choose a canonical on its own. So the tag you were relying on to consolidate duplicates quietly stops working, and it stops working without an error anywhere.",
        fix: "Find the second source. Almost always it is two things emitting the tag: a layout that always writes a self-referential canonical plus a plugin, a template partial, or an editor field that writes another one. Pick the single place that owns the canonical and stop the other from rendering.",
      }),
    })),
};

/**
 * A canonical on a host this site does not own. Two rules fire and both are
 * correct: the URL is not this page (`canonical.points-elsewhere`) and its host
 * is not this host (`canonical.cross-domain`). Naming only the second would be
 * an incomplete claim about what the engine does.
 */
const canonicalCrossDomain: Fixture = {
  path: "/authored/canonical-crossdomain",
  category: CANONICAL,
  name: "Canonical points at another domain",
  expectedIssues: ["canonical.cross-domain", "canonical.points-elsewhere"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A canonical on another domain",
      metaDescription:
        "The canonical on this page names a URL on a completely different host, handing the page's ranking signals off the site.",
      canonical: "https://other.example/x",
      bodyHtml: healthyBody({
        h1: "This page points its canonical off the site",
        lede: "The canonical here names a URL on a host this site does not own.",
        what: "A cross-domain canonical tells a search engine that the real version of this page lives on another site entirely, and that any credit this page earns should go there instead. It is a legitimate tool for syndicated articles, where the original really is somewhere else, and it is a disaster when it happens by accident.",
        why: "The accidental version usually comes from a staging or agency domain baked into a template, or from a migration where the canonical kept naming the old host. Every page on the site then tells search engines to index somewhere else, the pages drop out of results, and nothing on the site reports an error, because as far as the server is concerned every page is fine.",
        fix: "Check the host in the canonical against the host being crawled on every page, and treat any mismatch as something a person has to confirm on purpose. Syndication is real, so this is a fact worth stating rather than a fault worth failing, but it should never be discovered months later.",
      }),
    })),
};

/**
 * The contradiction: keep this page out of the index AND fold its signals into
 * another URL. Three rules fire — the conflict itself, the noindex that half of
 * it consists of, and the canonical that is the other half — and all three are
 * true statements about the page.
 */
const canonicalNoindex: Fixture = {
  path: "/authored/canonical-noindex",
  category: CANONICAL,
  name: "Canonical elsewhere plus noindex",
  expectedIssues: [
    "canonical.points-elsewhere",
    "directive.canonical-noindex-conflict",
    "indexability.noindex",
  ],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Canonical and noindex together",
      metaDescription:
        "This page asks to be dropped from the index and, in the same head, asks for its signals to be folded into another URL.",
      canonical: new URL("/control", self).href,
      robotsMeta: "noindex, follow",
      bodyHtml: healthyBody({
        h1: "Two instructions that cancel each other out",
        lede: "The robots meta says do not index this page. The canonical says credit a different page for it.",
        what: "Taken separately both tags are ordinary. A noindex keeps a page out of search results while letting crawlers follow its links. A canonical pointing at another URL consolidates duplicate versions onto one address. Put them on the same page and they ask for opposite things at the same time.",
        why: "A canonical asks the search engine to treat two URLs as one page and to pass this page's signals to the other. A noindex asks it to drop this page. If the engine honours the canonical, the noindex risks travelling with it to the target; if it honours the noindex, the consolidation never happens. Which one wins is not something you get to decide, and the outcome is often the target page disappearing too.",
        fix: "Decide what the page is for. If it is a duplicate, canonicalise it and let it stay indexable so the signals can flow. If it should not be in search at all, noindex it and drop the cross-URL canonical. Never ship both on one page.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// Indexability
// ---------------------------------------------------------------------------

/**
 * The two robots sources disagree: the markup invites indexing, the header
 * forbids it. `indexability.noindex` fires as well as the conflict rule, and it
 * should — the header alone is enough to keep the page out, so "this page is
 * noindex" is a true and separately useful statement.
 */
const noindexConflict: Fixture = {
  path: "/authored/noindex-conflict",
  category: INDEX,
  name: "Robots meta and X-Robots-Tag disagree",
  expectedIssues: ["indexability.meta-header-conflict", "indexability.noindex"],
  exact: true,
  handler: (req, res) =>
    serve(
      req,
      res,
      () => ({
        title: "Robots meta against the header",
        metaDescription:
          "The robots meta tag on this page says index, follow, while the X-Robots-Tag response header says noindex. Both cannot win.",
        robotsMeta: "index, follow",
        bodyHtml: healthyBody({
          h1: "The markup says index, the header says no",
          lede: "Two robots directives ship with this page and they say opposite things.",
          what: "The HTML carries a robots meta tag asking to be indexed and followed. The HTTP response carries an X-Robots-Tag header asking for the opposite. Anyone reading the page source sees only the first one, which is what makes this particular contradiction so long-lived.",
          why: "Search engines resolve conflicting robots directives by taking the most restrictive of them, so a page in this state is almost certainly out of the index however clearly the markup asks to be in it. The page looks correct in the browser, correct in the source, and correct to anyone who checks it the obvious way, and it still does not rank.",
          fix: "Work out which layer is adding the header. A CDN rule, a reverse proxy, or a leftover staging configuration are the usual sources, and none of them are visible from the page itself. Remove the one that is wrong so a single source of truth is left, and check headers as well as markup whenever a page mysteriously will not index.",
        }),
      }),
      { headers: { "x-robots-tag": "noindex" } },
    ),
};

// ---------------------------------------------------------------------------
// Hreflang
//
// Both pages below declare language alternates and neither declares an
// x-default, which is what makes `hreflang.missing-x-default` fire. That rule
// is SITE-SCOPED: it writes one finding with a null page id, because a missing
// fallback is a property of the crawl's whole annotation set rather than of any
// one URL. It therefore appears in NEITHER page's `expectedIssues` — the
// harness maps only page-attached findings to paths — and is asserted from the
// harness's `siteFindings` map instead, together with the three declarations
// these two pages contribute between them.
// ---------------------------------------------------------------------------

/**
 * One declaration whose code is not a language code. `hreflang.invalid-code`
 * writes one finding per bad declaration, attached to the page that declared it.
 */
const hreflangBadCode: Fixture = {
  path: "/authored/hreflang-bad-code",
  category: HREFLANG,
  name: "hreflang with an invalid language code",
  expectedIssues: ["hreflang.invalid-code"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "An hreflang code that is not one",
      metaDescription:
        "This page declares a language alternate with the value english-uk, which is not a language code any search engine parses.",
      headExtra: `<link rel="alternate" hreflang="english-uk" href="${self}">`,
      bodyHtml: healthyBody({
        h1: "A language alternate nobody can read",
        lede: "The alternate in the head of this page spells its language out in English instead of writing it as a code.",
        what: "An hreflang value has to be a language code, optionally with a region: en, en-gb, pt-br, es-419. This page declares english-uk, which is neither, so the annotation names a language no parser recognises and is dropped on the floor.",
        why: "An invalid code does not fail loudly. The link tag is well-formed, the page renders, and the search engine simply ignores the annotation it cannot parse. The cluster of translated pages this alternate was supposed to join stays broken, visitors keep landing on the wrong language version, and the site looks like it has hreflang implemented when effectively it does not.",
        fix: "Validate the codes at build time against the same small grammar the engines use: two or three letters for the language, and an optional region that is either two letters or three digits. Anything else is a typo, and a typo caught in the template is one that never reaches production.",
      }),
    })),
};

/**
 * A valid pair with no x-default. The page itself is clean — both codes parse,
 * so nothing page-attached fires here — and its job is to make the site-scoped
 * rule's subject a real cluster rather than one malformed tag.
 *
 * That job is only worth doing if a test can tell the page apart from nothing,
 * and the rule alone cannot: `hreflang.missing-x-default` fires on ANY
 * declaration with no x-default anywhere, so the bad-code page above would
 * produce it single-handed. The harness therefore asserts the declarations
 * themselves — these two codes, on this path, and the total of three the
 * finding counted — which is what stops this page from being a fixture that
 * exists without being evidence.
 */
const hreflangNoXDefault: Fixture = {
  path: "/authored/hreflang-no-xdefault",
  category: HREFLANG,
  name: "Language alternates with no x-default",
  // Intentionally empty: the only rule this page provokes is site-scoped, and
  // site-scoped findings attach to no URL. What this page IS pinned by is the
  // harness's hreflang-declarations assertion. See the block comment above.
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Language alternates with no fallback",
      metaDescription:
        "This page declares an English and a German alternate but never names an x-default, so unmatched visitors get no fallback.",
      headExtra: [
        `<link rel="alternate" hreflang="en" href="${self}">`,
        '<link rel="alternate" hreflang="de" href="https://de.example/willkommen">',
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Two languages and no default",
        lede: "This page names an English version and a German one. It names nothing for anyone who is neither.",
        what: "An hreflang cluster tells a search engine which version of a page to show to which audience. This one covers English and German correctly, and stops there. There is no x-default entry, which is the value that says what to serve when none of the declared languages match the person searching.",
        why: "Without an x-default, a visitor whose language is not in the cluster gets whichever version the engine guesses at, and the guess is usually the first or the most linked one rather than the one you would pick. On a site with a real language selector or a global English page, that is a choice worth making explicitly rather than leaving to a heuristic.",
        fix: "Add one x-default entry per cluster, pointing at the page you would want an unmatched visitor to land on: the language selector, or the international English version. It is a single extra link tag and it turns an implicit guess into a stated intention.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// Mobile & images
// ---------------------------------------------------------------------------

/**
 * The one page on the site with no `<meta name=viewport>`. The rule fires on
 * the tag's absence and nothing else; the page is otherwise the control.
 */
const noViewport: Fixture = {
  path: "/authored/no-viewport",
  category: MOBILE,
  name: "No viewport meta tag",
  expectedIssues: ["mobile.viewport-missing"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page with no viewport meta",
      metaDescription:
        "Everything about this page is healthy except the missing viewport meta tag, so phones render it at desktop width.",
      viewport: false,
      bodyHtml: healthyBody({
        h1: "A page that forgot it would be read on a phone",
        lede: "There is no viewport meta tag in the head of this page, and that one omission changes how every phone renders it.",
        what: "The viewport meta tag tells a mobile browser to lay the page out at the width of the device. Without it, the browser assumes a desktop-width canvas, renders the page at that width, and then zooms the whole thing out to fit the screen. Nothing is broken, exactly. Everything is just tiny.",
        why: "A page that has to be pinched and dragged to read is a page most people leave, and mobile usability is something search engines measure directly. The omission is easy to miss in review because it looks perfect on the desktop the page was built on, and the tag is one line that a stripped-down layout or a landing-page template can quietly drop.",
        fix: "Put the viewport tag in the base layout so no template can ship without it, and check for it on every page rather than on the handful somebody thought to test. Its absence is a fact a crawl can state with certainty, which makes it exactly the sort of thing to check automatically.",
      }),
    })),
};

/**
 * An image with alt text and no dimensions — the complement of the absorbed
 * `/content/images-missing-alt` page, which has dimensions and no alt. The
 * article helper's own image is suppressed (`withImage: false`) so this page
 * carries exactly one image and the count in the finding is unambiguous.
 */
const imageNoDimensions: Fixture = {
  path: "/authored/img-no-dimensions",
  category: IMAGES,
  name: "Image with alt text but no dimensions",
  expectedIssues: ["images.missing-dimensions"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "An image with no width or height",
      metaDescription:
        "The image on this page has good alt text but no width or height attributes, so the layout shifts as it finally loads.",
      bodyHtml: `${healthyBody({
        h1: "An image that does not reserve its own space",
        lede: "The image below is described properly. It just never says how big it is.",
        withImage: false,
        what: "The image on this page carries alt text, so a screen reader and an image search both know what it shows. What it does not carry is a width and a height, so the browser has no idea how much room to leave for it until the file itself has arrived.",
        why: "Until the image loads, the browser lays the page out as if it were not there. When it arrives, everything below it jumps down by the height of the image. That is a layout shift, it is measured as one, and it is the reason people tap the wrong link on a page that moved under their thumb a fraction of a second earlier.",
        fix: "Set width and height on every image element, or reserve the space in CSS with an aspect ratio. The attributes do not fight responsive layouts; modern browsers use them purely to work out the ratio and hold the space, and the rendered size still comes from the stylesheet.",
      })}
<img src="/img/authored-no-dimensions.svg" alt="An illustration of a paragraph jumping down as an image loads above it">`,
    })),
};

export const authoredFixtures: Fixture[] = [
  placeholderCopy,
  canonicalNone,
  canonicalMultiple,
  canonicalCrossDomain,
  canonicalNoindex,
  noindexConflict,
  hreflangBadCode,
  hreflangNoXDefault,
  noViewport,
  imageNoDimensions,
];
