/**
 * The Phase 3 authored pages: fixtures for the rules that read the crawl's
 * TABLES rather than one page's markup.
 *
 * Phase 2's authored file exists because a page rule needs a page with one thing
 * wrong in its head. Every rule below needs something a single page cannot be:
 * a canonical whose TARGET the crawl found broken, an hreflang cluster whose
 * other half does not answer back, a paginated series, two spellings of one URL,
 * a page the sitemap forgot. So the unit here is often a CLUSTER — two or three
 * pages that only mean something together — and the comments say which page of a
 * cluster carries the finding and why, because "the rule fired" is not evidence
 * unless it fired on the right URL.
 *
 * Three properties carried over from the Phase 2 file, and one added:
 *
 *  1. **Every page starts from the control recipe** (`healthyBody`), so the only
 *     signals that differ from a clean page are the ones the fixture is named
 *     for. Prose is written fresh for each page rather than templated: pages
 *     built from one paragraph with a word changed are near-duplicates of each
 *     other, `content.near-duplicate` says so, and it would be right.
 *  2. **`expectedIssues` is complete, not a floor** (`exact: true`), and every
 *     list was verified by RUNNING the harness rather than by reading the rules.
 *  3. **Site-scoped findings land on no path**, so a rule this file provokes
 *     site-wide (`sitemap.uncrawled` and friends) appears in the harness's
 *     `siteFindings` map instead of in any list here.
 *  4. **A fixture may declare where it is reachable from.** `linkedFromHub` and
 *     `inSitemap` are how a page becomes an orphan, or the one page the sitemap
 *     does not list — link-graph facts a handler cannot express (see
 *     `Fixture`).
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

const CANONICAL = "canonical";
const CONTENT = "content";
const HREFLANG = "hreflang";
const PAGINATION = "pagination";
const SCHEMA = "structured-data";
const SITEMAP = "sitemap";
const URLS = "url";

/**
 * The control recipe, as in the Phase 2 file: a clean outline, a described
 * image, and comfortably more than `THIN_WORDS` words, so a page that fires
 * `content.thin` here would be a page that was written too short by accident.
 */
function healthyBody(opts: {
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  /** Appended after the article, for a fixture that needs its own markup. */
  extra?: string;
}): string {
  return `${article({
    h1: opts.h1,
    lede: opts.lede,
    sections: [
      { h2: "What this page does", body: opts.what },
      { h2: "Why it matters", body: opts.why },
      { h2: "How it gets fixed", body: opts.fix },
    ],
  })}${opts.extra === undefined ? "" : `\n${opts.extra}`}`;
}

/** One `<link rel=alternate>` line, absolute against this page's own URL. */
function alternate(code: string, path: string, self: string): string {
  return `<link rel="alternate" hreflang="${code}" href="${new URL(path, self).href}">`;
}

// ---------------------------------------------------------------------------
// Canonical targets — canonical.non-200-target, canonical.non-indexable-target
//
// Both rules judge the page a canonical POINTS AT, so each fixture is really a
// pair: the page below, and an absorbed page it names. The absorbed halves are
// `/status/not-found` (a 404) and `/index/noindex-meta` (a 200 that opts out of
// the index), both of which the crawl fetches for their own sake — which is
// what gives these two canonicals a target with a known outcome rather than an
// uncrawled URL the rules stay silent about.
//
// `canonical.points-elsewhere` rides along on both, and correctly: a canonical
// naming another URL is exactly what that page rule reports, and the target
// being broken does not stop it being true.
// ---------------------------------------------------------------------------

const canonicalTo404: Fixture = {
  path: "/authored3/canonical-to-404",
  category: CANONICAL,
  name: "Canonical points at a 404",
  // `sitemap.non-indexable` since Phase 22 §1: the page is listed in the
  // sitemap and canonicalises elsewhere, which is the new case that rule reports.
  expectedIssues: [
    "canonical.non-200-target",
    "canonical.points-elsewhere",
    "sitemap.non-indexable",
  ],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A canonical that names a dead URL",
      metaDescription:
        "The canonical on this page names a URL that returns 404, so the consolidation it asks for has nowhere to land.",
      canonical: new URL("/status/not-found", self).href,
      bodyHtml: healthyBody({
        h1: "This page hands its signals to a page that is gone",
        lede: "The canonical in the head names a URL the same crawl fetched and found missing.",
        what: "A canonical is an instruction about where a page's ranking signals should end up. This one names an address that answers 404. The instruction is still read, still followed as far as it can be, and then arrives at nothing.",
        why: "The usual cause is a deletion nobody traced. A product is retired, its URL starts returning 404, and every variant that canonicalised to it keeps pointing at the hole. Those variants stop being indexed in their own right because they asked not to be, and the page they deferred to no longer exists, so the whole group quietly leaves search results without a single error being logged anywhere.",
        fix: "Check the status of every canonical target during a crawl, not only the status of the pages themselves. A canonical is a link like any other and it can rot like any other. When the target is gone, either restore it, repoint the canonical at the page that replaced it, or let the variant stand on its own with a self-referential canonical.",
      }),
    })),
};

const canonicalToNoindex: Fixture = {
  path: "/authored3/canonical-to-noindex",
  category: CANONICAL,
  name: "Canonical points at a noindexed page",
  // `sitemap.non-indexable` for `canonical-to-404`'s reason (Phase 22 §1).
  expectedIssues: [
    "canonical.non-indexable-target",
    "canonical.points-elsewhere",
    "sitemap.non-indexable",
  ],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A canonical that names a page kept out of the index",
      metaDescription:
        "The canonical here names a page that answers 200 and carries a noindex, so the URL this page defers to can never be shown.",
      canonical: new URL("/index/noindex-meta", self).href,
      bodyHtml: healthyBody({
        h1: "Deferring to a page that asked to be left out",
        lede: "The target of this canonical serves a perfectly good page, and that page tells search engines to keep it out of results.",
        what: "Two directives, one on each end of the same relationship. This page says the other URL is the version worth indexing. The other URL says it does not want to be indexed. Neither statement is wrong on its own, and together they mean nothing on this side of the pair can appear in search.",
        why: "This shows up most often after a section is retired halfway. Somebody noindexes a category listing to stop it competing with the products, and forgets that a dozen filter URLs canonicalise into it. The filters were fine before; now they defer to a page that has opted out, and the whole cluster drops. Because both halves look deliberate, nobody investigates until traffic to the section is already gone.",
        fix: "Treat a canonical target's indexability as part of the canonical's correctness. If the target should stay out of the index, the pages pointing at it need their own canonicals and their own place in search. If the pages really are duplicates of it, the noindex is the tag that has to go.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// Soft 404 — content.soft-404
//
// The rule has two signal paths and this fixture exercises exactly one of them.
// The template path compares a page against the body the site served for a URL
// that cannot exist, and the fixture app answers a real 404 for those, so this
// crawl records no template to compare against (`templateSimhash` returns null)
// and the path is unavailable — by design, since a fixture app that answered 200
// for every unknown path would change what a dozen other fixtures see.
//
// What is left is the phrase path, and it needs BOTH halves: not-found wording
// in the visible text AND fewer than `SOFT_404_WORDS` (300) words. So this body
// is deliberately short of that and deliberately clear of `THIN_WORDS` (150) —
// a page in neither band would fire nothing, and one under 150 would fire
// `content.thin` as well and stop being a single-signal fixture.
// ---------------------------------------------------------------------------

const soft404: Fixture = {
  path: "/authored3/soft-404",
  category: CONTENT,
  name: "Soft 404 (200 OK, page cannot be found)",
  expectedIssues: ["content.soft-404"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Sorry, this page cannot be found",
      metaDescription:
        "A page that answers 200 OK while telling every visitor that what they were looking for is not here.",
      bodyHtml: article({
        h1: "Sorry, this page cannot be found",
        lede: "The address you followed no longer points at anything on this site.",
        withImage: false,
        sections: [
          {
            h2: "What you can do",
            body: "Try the search box, or start again from the home page. If you arrived here from a link on another site, that link is out of date and there is nothing at this address to give you. Most of what used to live under this part of the site was moved rather than removed, so a search for the title you were expecting will usually turn it up in one attempt.",
          },
          {
            h2: "Why a server should say so properly",
            body: "The response you are reading arrived with a 200 status, which is the code a server uses to say here is the page you asked for. Search engines take that at face value: the URL is recorded as a real page, it is crawled again later, and it can be indexed and shown to somebody as a result. Every one of those is a request spent on an address with nothing behind it. A missing page should answer with a 404 or a 410, and then a crawler can drop the URL and spend the visit on a page that exists instead.",
          },
        ],
      }),
    })),
};

// ---------------------------------------------------------------------------
// Pagination — the three pagination rules, as one series
//
// A paginated set is the smallest thing that can provoke any of them, so the
// three pages below are one fixture in three parts:
//
//  - `paged-1` is the healthy head of the series: a `rel=next` at a page the
//    hub links and the crawl fetched. It fires NOTHING, which is what makes the
//    other two mean something.
//  - `paged-2` carries all three of the things page two of a series can get
//    wrong at once: it canonicalises to page one (`pagination.canonical-to-other`,
//    plus `canonical.points-elsewhere` for the same tag), and its `rel=next`
//    names a page nothing links to (`pagination.next-not-linked`).
//  - `paged-3` is that unlinked page. It reaches the crawl through the sitemap
//    alone, which is precisely `links.orphan`'s finding, and its own `rel=next`
//    names a fourth page that does not exist anywhere — no link, no sitemap
//    entry — so the crawl never fetches it and `pagination.next-target-uncrawled`
//    reports the series running past the crawl's reach.
//
// `paged-3` links to ITSELF, the way a real pagination control renders the
// current page as an anchor. That self-link is the interesting half: an orphan
// that links to itself would satisfy its own inbound-link test under a naive
// anti-join, and the rule excludes `source_page_id = target` precisely so it
// does not. The unit test pins the SQL; this page proves it end to end.
// ---------------------------------------------------------------------------

const PAGED_1 = "/authored3/paged-1";
const PAGED_2 = "/authored3/paged-2";
const PAGED_3 = "/authored3/paged-3";
/** Page four of the series. No fixture serves it and nothing lists it. */
const PAGED_4 = "/authored3/paged-4";

const paged1: Fixture = {
  path: PAGED_1,
  category: PAGINATION,
  name: "Paginated series, page 1 (healthy head)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Field notes, page 1 of 3",
      metaDescription:
        "The first page of a three-page archive. It declares the next page and canonicalises to itself, which is the arrangement nothing should be reported about.",
      headExtra: `<link rel="next" href="${new URL(PAGED_2, self).href}">`,
      bodyHtml: healthyBody({
        h1: "Field notes from the estuary, page one",
        lede: "The first of three pages of notes, wired the way a paginated archive should be.",
        what: "This page declares the page after it with a rel=next link and names itself as its own canonical. Nothing further: page one of a series is an ordinary page that happens to have something after it.",
        why: "Search engines stopped using rel=next and rel=prev for discovery years ago, so the annotation is a hint about ordering rather than a route. What actually carries a crawler from one page of an archive to the next is the numbered links in the pagination control, which is why the arrangement here has both and why the audit has nothing to say about it.",
        fix: "Nothing to fix. This page is here as the control for its two siblings: if a pagination rule ever fires on a healthy series head, the rule has grown too eager and the finding it wrote is a false one.",
        extra: `<nav class="pagination"><a href="${PAGED_2}">Page 2</a></nav>`,
      }),
    })),
};

const paged2: Fixture = {
  path: PAGED_2,
  category: PAGINATION,
  name: "Paginated series, page 2 (canonicalised to page 1, next page unlinked)",
  expectedIssues: [
    "canonical.points-elsewhere",
    "pagination.canonical-to-other",
    "pagination.next-not-linked",
    // PHASE 22 §1: page two is listed in the sitemap and canonicalises to page
    // one, which `sitemap.non-indexable` now reports. It is the same canonical
    // the two pagination findings are about, read from the sitemap's side.
    "sitemap.non-indexable",
  ],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Field notes, page 2 of 3",
      metaDescription:
        "The second page of the archive: it folds itself into page one with a canonical and points a rel=next at a page nothing links to.",
      canonical: new URL(PAGED_1, self).href,
      headExtra: [
        `<link rel="prev" href="${new URL(PAGED_1, self).href}">`,
        `<link rel="next" href="${new URL(PAGED_3, self).href}">`,
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Field notes from the estuary, page two",
        lede: "This page declares itself part of a series and then hands its content to the first page of it.",
        what: "A rel=prev names page one, a rel=next names page three, and the canonical also names page one. The pagination annotations say this is the middle of a series; the canonical says the middle of the series is not a page in its own right.",
        why: "Consolidating a series onto its first page is a real strategy, and so is letting every page stand alone. The one thing an audit can usefully do is say which was chosen, because the choice was often nobody's: a template writes the canonical from a category identifier and quietly drops the page number. The content on pages two and beyond then has no indexable home, and long archives lose everything below the fold of the first page.",
        fix: "Decide deliberately. If the deeper pages carry content worth finding, canonicalise each to itself. If they are only a route to the items, keeping the canonical on page one is defensible, as long as the items themselves are linked from somewhere that is indexed.",
        extra: `<nav class="pagination"><a href="${PAGED_1}">Page 1</a></nav>`,
      }),
    })),
};

const paged3: Fixture = {
  path: PAGED_3,
  category: PAGINATION,
  name: "Paginated series, page 3 (orphan, next page never crawled)",
  // In the sitemap and linked from nowhere: the only route to this page is the
  // sitemap, which is what `links.orphan` reports (`inSitemap: true` in its
  // evidence) and what leaves page two's rel=next target unlinked.
  linkedFromHub: false,
  expectedIssues: ["links.orphan", "pagination.next-target-uncrawled"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Field notes, page 3 of 3",
      metaDescription:
        "The last page of the archive, reachable only through the sitemap, declaring a fourth page the crawl never sees.",
      headExtra: [
        `<link rel="prev" href="${new URL(PAGED_2, self).href}">`,
        `<link rel="next" href="${new URL(PAGED_4, self).href}">`,
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Field notes from the estuary, page three",
        lede: "No page of this site links here. The sitemap is the only reason this page was crawled at all.",
        what: "The pagination control below renders the current page as a link to itself, which is what most pagination components do and what makes an orphan hard to spot: the page has an inbound link in the raw data, and it is its own.",
        why: "A page nothing links to collects no strength from the rest of the site and is visited rarely, whatever the sitemap says. Sitemaps help a crawler find URLs; they do not tell it which ones matter, and internal links are how a site says that. An archive whose later pages fell out of the pagination control is the ordinary way this happens, and the items only reachable from those pages go with them.",
        fix: "Link the page from wherever the series is rendered, and check the pagination control emits every page rather than a fixed window. A URL listed in the sitemap and linked from nowhere is a page the site has published and hidden at the same time.",
        extra: `<nav class="pagination"><a href="${PAGED_2}">Page 2</a> <a href="${PAGED_3}">Page 3</a></nav>`,
      }),
    })),
};

// ---------------------------------------------------------------------------
// Hreflang clusters — hreflang.missing-return-link, hreflang.non-indexable-target
//
// Both rules judge a page's declarations against the pages they NAME, so each
// needs at least two pages and the interesting one is always the pair, not the
// page. Three clusters:
//
//  - the happy pair (`hreflang-a` / `hreflang-b`): each names both members and an
//    x-default, so every annotation is reciprocated and both fire nothing. This
//    is the control for the two below.
//  - the one-way pair (`hreflang-one-way` -> `hreflang-mute`): the target is a
//    perfectly healthy page that declares no hreflang at all, so the annotation
//    is never returned. One finding, on the page that declared it, carrying
//    `targetHasHreflang: false`.
//  - the noindexed target (`hreflang-noindex` -> `/index/noindex-meta`): an
//    alternate naming a page search engines are told to keep out of the index.
//    That page declares nothing back either, so this fixture fires BOTH rules —
//    two true statements about one annotation, with two different fixes.
//
// Every page here declares an x-default, so `hreflang.missing-x-default` stays
// where Phase 2 put it: on `/authored/hreflang-no-xdefault`, which is the only
// fixture that means it.
// ---------------------------------------------------------------------------

const HREFLANG_A = "/authored3/hreflang-a";
const HREFLANG_B = "/authored3/hreflang-b";
const HREFLANG_MUTE = "/authored3/hreflang-mute";

const hreflangA: Fixture = {
  path: HREFLANG_A,
  category: HREFLANG,
  name: "Reciprocated hreflang pair (English half)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      // THE SAME TITLE AS ITS FRENCH HALF, and deliberately (Phase 22 §2): an
      // untranslated `<title>` is what a bilingual site really ships, and it is
      // what used to be reported as a duplicate. The two pages declare each
      // other reciprocally under different language codes, so they are ONE
      // member of any duplicate group — and the `expectedIssues: []` with
      // `exact: true` on both halves is the end-to-end proof that
      // `title.duplicate` says nothing about them.
      title: "Opening hours",
      metaDescription:
        "The English half of a two-language pair. It names both versions and an x-default, and its French half names the same two back.",
      headExtra: [
        alternate("en", HREFLANG_A, self),
        alternate("fr", HREFLANG_B, self),
        alternate("x-default", HREFLANG_A, self),
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Opening hours and how to reach us",
        lede: "The English version of a page that also exists in French, annotated the way the pair should be.",
        what: "Three link tags in the head: this page as the English version, the other as the French one, and this page again as the fallback for anyone the first two do not describe. The French page carries the identical three tags.",
        why: "An hreflang annotation is only honoured when the page it names names it back. Search engines treat the reciprocal pair as a claim both sides agree to, which is what stops one site from annotating pages it does not own. A cluster where every member lists every member, including itself, is the shape that survives that check.",
        fix: "Nothing to fix here. This pair is the control: if a return-link finding ever appears on either half, the rule has started reporting healthy clusters and its output cannot be trusted on the broken ones.",
      }),
    })),
};

const hreflangB: Fixture = {
  path: HREFLANG_B,
  category: HREFLANG,
  name: "Reciprocated hreflang pair (French half)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      // The English half's title, verbatim — see the note there. The DESCRIPTION
      // still differs, so `meta-description.duplicate` is not being asserted
      // about at the same time and the title is the only collapsed column.
      title: "Opening hours",
      metaDescription:
        "The French half of the pair, carrying the same three annotations as its English counterpart so the cluster is complete from both sides.",
      headExtra: [
        alternate("en", HREFLANG_A, self),
        alternate("fr", HREFLANG_B, self),
        alternate("x-default", HREFLANG_A, self),
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Nos horaires, written in English for the fixture",
        lede: "The French counterpart of the previous page. Its prose is deliberately different, so the two are a translation pair rather than a duplicate one.",
        what: "The page a French visitor should land on, annotated identically to its English twin. Only the words differ, which in a real cluster is the whole point and in this fixture keeps the two clear of the duplicate-content rules.",
        why: "Translation pairs are where duplicate detection and internationalisation meet awkwardly. Two versions of one page that share a layout and differ only in a handful of strings look like near-duplicates to a fingerprint, and a site that machine-translates thinly enough really does publish duplicates. Genuine translations, written for the audience rather than substituted word for word, do not run into it.",
        fix: "Nothing to fix. Between them these two pages state what a complete cluster looks like, so the broken clusters below are measured against something rather than asserted in the abstract.",
      }),
    })),
};

const hreflangOneWay: Fixture = {
  path: "/authored3/hreflang-one-way",
  category: HREFLANG,
  name: "hreflang alternate that never answers back",
  expectedIssues: ["hreflang.missing-return-link"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Delivery information, English",
      metaDescription:
        "This page names a German alternate. The page it names carries no hreflang at all, so the annotation is discarded.",
      headExtra: [
        alternate("en", "/authored3/hreflang-one-way", self),
        alternate("de", HREFLANG_MUTE, self),
        alternate("x-default", "/authored3/hreflang-one-way", self),
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Delivery information, and a translation that never confirmed it",
        lede: "The German alternate this page declares is a real page on this site. It has never heard of this one.",
        what: "The annotation runs one way. This page names the German version; the German version's head carries no alternates whatsoever, so nothing on that end agrees that the two belong together.",
        why: "Unreciprocated annotations are dropped, which means a translation project can be finished, deployed and completely ineffective. The commonest cause is a rollout by section: the English templates get the cluster first, the translated templates are scheduled for later, and later never comes. From the outside the site looks internationalised, and every visitor still lands on whichever version the engine guessed.",
        fix: "Emit the cluster from shared data rather than per template, so a page cannot carry half of it. Then check reciprocity in a crawl: every alternate a page names should name it back, and a crawl is the only place that can be seen, because each page on its own looks correct.",
      }),
    })),
};

const hreflangMute: Fixture = {
  path: HREFLANG_MUTE,
  category: HREFLANG,
  name: "The alternate that declares nothing",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Versandinformationen, the silent half",
      metaDescription:
        "A healthy page that another page claims as its German alternate, and which carries no hreflang annotations of its own.",
      bodyHtml: healthyBody({
        h1: "A page somebody else claims as a translation",
        lede: "Nothing is wrong with this page in isolation, which is exactly why the missing annotation is easy to ship.",
        what: "There are no alternate link tags in this head. The page is otherwise ordinary: a title, a description, a self-referential canonical, and a body long enough to be worth indexing.",
        why: "The finding for this arrangement belongs on the page that made the claim, not on this one, and that is a deliberate choice about where a fix goes. Nobody would look at this page and see a fault, because there is no fault visible here — the missing half only exists in relation to a page that names it.",
        fix: "When this page gains the matching annotations, the finding on its counterpart disappears without anything being changed there. Reciprocity is a property of the pair, and a report that attributed it to one page alone would send somebody to the wrong file.",
      }),
    })),
};

const hreflangNoindexTarget: Fixture = {
  path: "/authored3/hreflang-noindex",
  category: HREFLANG,
  name: "hreflang alternate pointing at a noindexed page",
  // Two findings, both true of the same annotation: the target is excluded from
  // the index, AND it declares nothing back. Different fixes, so two rules.
  expectedIssues: ["hreflang.missing-return-link", "hreflang.non-indexable-target"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "Returns policy, English",
      metaDescription:
        "The German alternate named here answers 200 and carries a noindex, so the version this page points travellers at can never be shown.",
      headExtra: [
        alternate("en", "/authored3/hreflang-noindex", self),
        alternate("de", "/index/noindex-meta", self),
        alternate("x-default", "/authored3/hreflang-noindex", self),
      ].join("\n"),
      bodyHtml: healthyBody({
        h1: "Pointing German readers at a page kept out of search",
        lede: "The alternate named in this head is a live page that has asked not to appear in results.",
        what: "The annotation resolves, the target answers, and the target carries a robots noindex. So the cluster names a version a search engine has been told it may not serve, which is a different fault from an alternate that 404s and a different one again from an alternate that does not answer back.",
        why: "It usually means two teams changed the same section a month apart. One noindexes a page to keep it out of results; the other keeps naming it as the German version because it is still the right page for a German reader. Both changes are defensible and the combination is not: German searchers get whatever the engine falls back to, which is generally the English page they cannot read.",
        fix: "Either the target belongs in search, in which case the noindex goes, or it does not, in which case the annotation should name the page that does serve that language. An alternate is a promise that a version exists and can be shown, and a noindexed page cannot keep the second half of it.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// URL hygiene — url.normalisation-variants, url.tracking-params-internal,
// url.parameter-pages-indexable, pages.not-in-sitemap
// ---------------------------------------------------------------------------

/**
 * Two spellings of one path, differing only in case, BOTH answering 200. That is
 * the whole condition: the absorbed trailing-slash pair is the other shape, where
 * one spelling redirects to the other, and the rule stays quiet about it because
 * that configuration is the fix rather than the fault.
 *
 * The group is reported ONCE, on its first URL, and which of these two that is
 * comes from Postgres: the rule's `order by s2.url` sorts under the database's
 * collation, and the dev and CI cluster is the documented `postgres:16` container
 * (en_US.UTF-8), where a lowercase letter sorts before its uppercase twin. So
 * the finding lands on the lowercase fixture below and this one carries nothing.
 * On a cluster created with the C collation the byte values decide instead, the
 * uppercase spelling sorts first, and these two expectations swap — which is a
 * loud failure with this paragraph next to it rather than a silent difference.
 *
 * The two bodies are written differently on purpose: identical text at two URLs
 * is a duplicate-content finding as well, which would be true but would make
 * this a fixture about two things.
 */
const caseVariantUpper: Fixture = {
  path: "/authored3/Case",
  category: URLS,
  name: "Case variant (upper), served 200",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The same page under a capitalised path",
      metaDescription:
        "This URL and its lowercase twin both answer 200, so a search engine has two addresses for one page and no instruction about which is the real one.",
      bodyHtml: healthyBody({
        h1: "One page, two addresses, no redirect between them",
        lede: "A capital letter in a path is enough to make a second URL, and this server answers both.",
        what: "Paths are case-sensitive on most servers, so this address and the all-lowercase spelling of it are two resources as far as HTTP is concerned. Both return a page, neither redirects to the other, and each names itself as its own canonical.",
        why: "Split addresses split everything that accumulates against an address: links from elsewhere, the record of which one people click, whatever internal weight the site passes along. Case variants usually enter through hand-written links or an old campaign, and they are invisible from inside the site, because every page in the template links to the spelling the template uses.",
        fix: "Pick one spelling, redirect the others to it with a 301, and lower-case incoming paths at the edge so a mistyped link fixes itself. Where a redirect is not possible, a canonical naming the chosen spelling at least tells search engines which of the two to keep.",
      }),
    })),
};

const caseVariantLower: Fixture = {
  path: "/authored3/case",
  category: URLS,
  name: "Case variant (lower), served 200",
  // The half the finding lands on, under the collation named above; its twin is
  // in the evidence beside it rather than carrying a finding of its own.
  expectedIssues: ["url.normalisation-variants"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The lowercase spelling of the same path",
      metaDescription:
        "The second half of the case-variant pair, written differently so the two are one page at two addresses rather than one duplicated body.",
      bodyHtml: healthyBody({
        h1: "The spelling most of this site actually links",
        lede: "Everything about this address is ordinary. Its twin is what makes it a problem.",
        what: "A page reached at an all-lowercase path, with a self-referential canonical and no redirect anywhere. On its own it is exactly what a page should be.",
        why: "That is what makes normalisation variants slow to find. Neither URL looks wrong, no request fails, and no template is broken. The fault only exists in the set: two addresses served the same content, and nothing anywhere saying which one counts. It takes a crawl comparing URLs against each other to notice, which no single page test can do.",
        fix: "The repair is on the pair, not on either half: one canonical spelling, a redirect from the other, and a check in the crawl that no two fetched URLs normalise to the same key while both answering 200.",
      }),
    })),
};

/**
 * A URL that is a query string: an indexable 200 at `?utm_source=…` that names
 * ITSELF as canonical, linked internally with the tag still on the href.
 *
 * One page, two findings, and they are about different halves of it:
 *  - `url.tracking-params-internal` is about the LINK — an internal href
 *    carrying a campaign tag, which sends anyone following it into analytics as
 *    a campaign visit and gives the tagged URL its own life in search.
 *  - `url.parameter-pages-indexable` is about the PAGE — a parameter variant
 *    declaring itself the canonical version, which is how a small catalogue
 *    becomes a large index.
 *
 * The fixture's `path` carries the query, so the app serves it at that exact
 * target and the hub links it with the tag attached (see `Fixture.path`).
 */
const trackedParameterPage: Fixture = {
  path: "/authored3/tracked?utm_source=newsletter",
  category: URLS,
  name: "Internally linked campaign URL, indexable in its own right",
  expectedIssues: ["url.parameter-pages-indexable", "url.tracking-params-internal"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A campaign URL that is also a page",
      metaDescription:
        "An internal link points here with a utm_source still attached, and the page that answers names the tagged address as its own canonical.",
      bodyHtml: healthyBody({
        h1: "The campaign tag that stayed on the internal link",
        lede: "This address exists because somebody pasted a newsletter link into the site's own navigation.",
        what: "The URL carries a campaign parameter, the page answers 200, and its canonical names the URL including the parameter. So the tagged address is a page in its own right rather than a variant that folds back into a clean one.",
        why: "Two things go wrong at once. Analytics stops describing where people came from, because visitors already on the site are recorded as arriving from a newsletter they never opened. And search engines get a second address for a page that already had one, self-declared as canonical, so both can be indexed and neither is clearly the original.",
        fix: "Strip campaign parameters from internal hrefs — they only ever describe traffic arriving from outside — and canonicalise parameter variants to the clean URL. Where a parameter genuinely produces a different page, say so deliberately; where it only tags a visit, it has no business being part of an address that gets indexed.",
      }),
    })),
};

/**
 * The page whose sitemap entry is spelled differently from its own URL.
 *
 * `/sitemap.xml` publishes `?sort=asc&ref=sitemap#top` for a page the crawl
 * fetches at `?ref=sitemap&sort=asc`: a fragment on the end and the parameters
 * in the order a template appended them rather than sorted. `normalizeUrl`
 * strips the one and sorts the other, so the two are one URL — and the entry
 * must join the page the crawl created FROM IT.
 *
 * Before the normalized join columns existed it did not: the entry read as a
 * URL the crawl never reached (`sitemap.uncrawled`) and the page as one the
 * sitemap never listed (`pages.not-in-sitemap`), two findings about a site that
 * had done nothing wrong. That both are absent from this fixture's exact set —
 * and that `/sitemap.xml` still publishes the divergent spelling, which the
 * harness reads out of `sitemap_urls` — is what proves the seam closed.
 *
 * The query string is not decoration: sorting only means something with two
 * parameters to sort. It costs one finding, and the fixture declares it —
 * `url.parameter-pages-indexable` is what an indexable parameter page naming
 * itself canonical fires, and this page is exactly that.
 */
const sitemapLocVariant: Fixture = {
  path: "/authored3/loc-variant?ref=sitemap&sort=asc",
  sitemapLoc: "/authored3/loc-variant?sort=asc&ref=sitemap#top",
  category: SITEMAP,
  name: "Page whose <loc> carries a fragment and unsorted parameters",
  expectedIssues: ["url.parameter-pages-indexable"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The sitemap entry that spells this address its own way",
      metaDescription:
        "The sitemap publishes this page with a fragment on the end and its parameters in another order. It is the same URL, and the crawl fetched it.",
      bodyHtml: healthyBody({
        h1: "One page, two spellings, one of them written by the sitemap",
        lede: "Nothing about this address is wrong. The file that lists it simply writes it differently.",
        what: "The page answers at a URL carrying two query parameters. The sitemap names it with those parameters in the opposite order and a fragment appended, which is what a template that builds URLs by concatenation tends to emit.",
        why: "A fragment is never sent to a server and parameter order never changes which page answers, so both spellings address one resource. An audit that compared the published text against the fetched key character by character would announce that the sitemap lists a page nobody crawled and that a crawled page is missing from the sitemap — two faults invented out of punctuation, on a site with neither.",
        fix: "Compare sitemap entries against crawled URLs on the normalised form of both, and keep the published spelling for the report, because the line somebody edits is the line the file actually contains.",
      }),
    })),
};

/**
 * The one indexable page `/sitemap.xml` does not list.
 *
 * `pages.not-in-sitemap` is data-gated on the crawl holding at least one sitemap
 * entry, so this fixture only says anything because the site now publishes a
 * sitemap; before Task 9 it would have been one of forty silent pages. The deep
 * click-path is the other omission, and for a different reason (see
 * `Fixture.inSitemap`).
 */
const notInSitemap: Fixture = {
  path: "/authored3/unlisted",
  category: SITEMAP,
  name: "Indexable page the sitemap does not list",
  inSitemap: false,
  expectedIssues: ["pages.not-in-sitemap"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page the sitemap forgot",
      metaDescription:
        "This page is linked, indexable and perfectly ordinary. The site's sitemap does not mention it.",
      bodyHtml: healthyBody({
        h1: "Published, linked, and missing from the sitemap",
        lede: "Everything about this page works. The one list that is supposed to enumerate the site leaves it out.",
        what: "The sitemap this site publishes names every other indexable page and not this one. Nothing else about the page is unusual: it is linked from the hub, it answers 200, and it asks to be indexed.",
        why: "A sitemap is a statement about what a site considers its pages. A page missing from it is not hidden — links are what a crawler mostly follows — but it is excluded from the one place a site gets to say this URL exists and here is when it changed. On large sites the omission is rarely one page: it is a content type the generator was never taught about, and it stays invisible until somebody compares the crawl against the file.",
        fix: "Generate the sitemap from the same source the routes come from, so a new content type cannot be published without appearing in it, and compare a crawl against the sitemap regularly in both directions: URLs listed and not reachable, and URLs reachable and not listed.",
      }),
    })),
};

// ---------------------------------------------------------------------------
// Structured data — schema.product-incomplete, schema.self-serving-reviews
//
// These two pages are the reason `schema.none-on-site` can never fire on this
// fixture site again: its condition is "no structured data anywhere on the
// crawl", and publishing any JSON-LD at all destroys it. That trade was made
// deliberately (see the harness's SKIP_HARNESS_CLAIMS entry). Neither page
// carries a `BreadcrumbList`, and nothing else on the site does either, so
// `schema.breadcrumb-absent` still fires site-wide and remains the fixture
// collection's proof of that rule.
// ---------------------------------------------------------------------------

/** A JSON-LD block, as a `<script>` for `headExtra`. */
function jsonLd(node: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    ...node,
  })}</script>`;
}

const productIncomplete: Fixture = {
  path: "/authored3/product-incomplete",
  category: SCHEMA,
  name: "Product markup missing its image",
  expectedIssues: ["schema.product-incomplete"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Enamel camp mug, 350ml",
      metaDescription:
        "A product page whose JSON-LD names the product and a priced offer, and never names an image.",
      // Name and a priced offer are present; `image` is not. The derivation
      // records that absence and the rule names the field.
      headExtra: jsonLd({
        "@type": "Product",
        name: "Enamel camp mug, 350ml",
        description: "A speckled enamel mug that survives a campfire and a dishwasher.",
        sku: "MUG-350-SPK",
        offers: {
          "@type": "Offer",
          price: "14.00",
          priceCurrency: "GBP",
          availability: "https://schema.org/InStock",
        },
      }),
      bodyHtml: healthyBody({
        h1: "Enamel camp mug, 350 millilitres",
        lede: "The markup on this page describes a real product and forgets the one field a rich result cannot be built without.",
        what: "The JSON-LD names the product, gives it a description and a stock keeping unit, and carries an offer with a price and a currency. There is no image field anywhere in the block.",
        why: "A product result in search is mostly a picture. Without an image field the markup is still valid and still parsed, and the enhanced result it was written for simply never appears, so the work of adding structured data returns nothing. It is a quiet failure: no error is reported to anybody, and the page looks fully marked up to a person reading the source.",
        fix: "Feed the markup from the same product record the page renders from, so a field cannot be present in the layout and absent in the data. Then validate what a crawl actually finds against the fields the result requires, rather than against what the template was supposed to emit.",
      }),
    })),
};

const selfServingReviews: Fixture = {
  path: "/authored3/reviews",
  category: SCHEMA,
  name: "Organization rating itself",
  expectedIssues: ["schema.self-serving-reviews"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "About Estuary Supplies",
      metaDescription:
        "An about page whose Organization markup carries an aggregate rating of the organisation itself.",
      headExtra: jsonLd({
        "@type": "Organization",
        name: "Estuary Supplies",
        url: "https://estuary-supplies.example/",
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.9",
          reviewCount: "218",
        },
      }),
      bodyHtml: healthyBody({
        h1: "About Estuary Supplies",
        lede: "The markup in this head gives the company a rating, and the company is the one publishing it.",
        what: "An Organization block naming the business and carrying an aggregate rating with a review count. Nothing in the markup is malformed; the block parses and describes exactly what it says it does.",
        why: "Ratings a business publishes about itself are the case Google's review-snippet policy names outright: they are ignored for rich results, whatever the numbers say. The markup usually arrives with a plugin that offers a star rating widget and writes it into whatever schema type the page already has, so nobody chose this arrangement on purpose.",
        fix: "Mark up reviews of the things being sold, where the rating belongs to a product rather than to the seller, and keep the organisation block to what it is for: name, contact details, logo, and the profiles that identify the business elsewhere.",
      }),
    })),
};

export const authoredP3Fixtures: Fixture[] = [
  canonicalTo404,
  canonicalToNoindex,
  soft404,
  paged1,
  paged2,
  paged3,
  hreflangA,
  hreflangB,
  hreflangOneWay,
  hreflangMute,
  hreflangNoindexTarget,
  caseVariantUpper,
  caseVariantLower,
  trackedParameterPage,
  sitemapLocVariant,
  notInSitemap,
  productIncomplete,
  selfServingReviews,
];
