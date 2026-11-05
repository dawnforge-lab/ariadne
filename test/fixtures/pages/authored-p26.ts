/**
 * The Phase 26a fixtures: pages that give the new rules over existing data
 * (docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md, "26a")
 * something to fire on in the end-to-end harness.
 *
 * Every fixture here is `exact: true` and starts from the control recipe, so a
 * page carries one defect and the harness pins its issue list exactly. The
 * fixture site is plain HTTP on 127.0.0.1, so the HTTPS-only rules
 * (`security.*` headers, HTTP-URL and mixed content) cannot have a page here;
 * they are proven by DB tests and are listed in `SKIP_HARNESS_CLAIMS` with the
 * reason.
 *
 * `test/fixtures/assets.ts` holds the other half of the content-type fixture:
 * `/css/p26-wrong-type.css` answers 200 with `content-type: text/html`.
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

/** The path whose stylesheet the fixture site serves as text/html. */
export const P26_WRONG_TYPE_PATH = "/authored26/wrong-content-type";

/** The stylesheet the page links, served with the wrong type. */
export const P26_WRONG_TYPE_STYLESHEET = "/css/p26-wrong-type.css";

const wrongContentType: Fixture = {
  path: P26_WRONG_TYPE_PATH,
  category: "resources",
  name: "Page linking a stylesheet served as text/html",
  expectedIssues: ["resources.bad-content-type"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A stylesheet the server labels as a web page",
      metaDescription:
        "The markup of this page is correct; the stylesheet it links is answered with a content type that says it is HTML, which only the response reveals.",
      headExtra: `<link rel="stylesheet" href="${P26_WRONG_TYPE_STYLESHEET}">`,
      bodyHtml: article({
        h1: "A page whose stylesheet arrives mislabelled",
        lede: "Everything in this document is well formed. The stylesheet in its head is a real file that the server hands back as if it were a web page.",
        withImage: false,
        sections: [
          {
            h2: "What this page does",
            body: "The head of this page links one stylesheet with a rel and an href, exactly as it should. The server answers the request for that file with a success status and a content type of text/html, which no amount of reading the page itself would have told you.",
          },
          {
            h2: "Why it matters",
            body: "A browser refuses to apply a stylesheet that is not sent as text/css, so the page loses its styling even though the request for the file succeeded. It is the commonest result of a server rule that maps every unknown extension to a default type, or of a CDN that wraps the file.",
          },
          {
            h2: "How it gets fixed",
            body: "Configure the server or the CDN to send text/css for stylesheets, and check that the address does not return an error or login page that happens to answer with a success status.",
          },
        ],
      }),
    })),
};

/**
 * The three robots-directive fixtures. Each is the control recipe with one
 * robots meta added, so the one directive is the page's only defect.
 */
const nofollow: Fixture = {
  path: "/authored26/nofollow",
  category: "directives",
  name: "Indexable page whose robots meta says nofollow",
  expectedIssues: ["indexability.nofollow"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that tells search engines to ignore its links",
      metaDescription:
        "The page may be indexed and ranked, but its robots meta carries nofollow, so none of the links it contains are followed or credited by a search engine.",
      robotsMeta: "index, nofollow",
      bodyHtml: article({
        h1: "A page whose links are closed to crawlers",
        lede: "This document is open to the index. Its robots meta also carries a directive that tells engines to disregard every link it contains.",
        withImage: false,
        sections: [
          {
            h2: "What the directive does",
            body: "The nofollow value applies to the whole page and not to a single link. A search engine that reads it will neither follow the page's outgoing links to discover new addresses nor pass any credit through them, however deliberately the page was written to point elsewhere.",
          },
          {
            h2: "When it is a mistake",
            body: "Login pages and pages of user submitted content are sensible places for it. On an ordinary article it usually arrives from a template shared with such a page, and it quietly starves the pages that article links to of the internal links they depend on.",
          },
          {
            h2: "How it gets fixed",
            body: "Remove the nofollow value from the robots meta tag and from any matching header, leaving index and follow, and let the next crawl confirm the links are being followed again.",
          },
        ],
      }),
    })),
};

const nosnippet: Fixture = {
  path: "/authored26/nosnippet",
  category: "directives",
  name: "Indexable page whose robots meta says nosnippet",
  expectedIssues: ["directives.restrictive"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that forbids a text excerpt in search results",
      metaDescription:
        "This page is indexed normally, yet its robots meta carries nosnippet, so a search result shows a title and an address and never any text from the page.",
      robotsMeta: "index, follow, nosnippet",
      bodyHtml: article({
        h1: "A page that hides its own excerpt",
        lede: "Search engines may list this page, but a directive in its head asks them to show no text from it beneath the title.",
        withImage: false,
        sections: [
          {
            h2: "What nosnippet takes away",
            body: "With the directive present a result for this page carries no description line at all. Visitors choose between listings by reading those lines, so a page that suppresses its own is asking to be passed over for a neighbour that offers one.",
          },
          {
            h2: "Where it comes from",
            body: "Sites reach for it to stop an excerpt being quoted or reused by an answer feature. It is easily left behind when a template moves from one section to another, and nobody looks at a result listing once the launch is done.",
          },
          {
            h2: "How it gets fixed",
            body: "Delete the nosnippet value if the restriction was never meant. To cap the excerpt instead of forbidding it, replace the value with a limit on its length.",
          },
        ],
      }),
    })),
};

const unavailableAfter: Fixture = {
  path: "/authored26/unavailable-after",
  category: "directives",
  name: "Indexable page whose robots meta names an expiry date long past",
  expectedIssues: ["directives.unavailable-after"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that asked to leave the index years ago",
      metaDescription:
        "This page carries an unavailable_after directive whose date fell in 2010, so a search engine reading it today is told the page has long since expired.",
      robotsMeta: "index, follow, unavailable_after: 25 Jun 2010 15:00:00 PST",
      bodyHtml: article({
        h1: "A page with an expiry date in the past",
        lede: "A directive in the head of this document names a date after which it should no longer be listed, and that date is more than a decade gone.",
        withImage: false,
        sections: [
          {
            h2: "What the date means",
            body: "The unavailable_after directive schedules a page's removal from search results. Once the date passes, a search engine is entitled to drop the page on its next visit, which is exactly what a page promoting an event or an offer wants and exactly what an evergreen page does not.",
          },
          {
            h2: "Why one lingers",
            body: "A campaign page is published with an end date and then repurposed. Nobody edits the head, the date slides into the past, and the page loses its place in results with no deploy, no error and no alert to explain it.",
          },
          {
            h2: "How it gets fixed",
            body: "If the page should stay listed, remove the directive or move the date far into the future. If it was meant to expire, redirect it or take it down on purpose.",
          },
        ],
      }),
    })),
};

export const authoredP26Fixtures: Fixture[] = [
  wrongContentType,
  nofollow,
  nosnippet,
  unavailableAfter,
];
