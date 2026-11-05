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

// ---------------------------------------------------------------------------
// Canonicals (Task 5)
// ---------------------------------------------------------------------------

/**
 * A self-referential canonical written as a path. It resolves to the page's own
 * URL, so `canonical.points-elsewhere` stays silent and the one defect is that
 * the value has no scheme or host.
 */
const canonicalRelative: Fixture = {
  path: "/authored26/canonical-relative",
  category: "canonical",
  name: "Page whose canonical is a relative path",
  expectedIssues: ["canonical.relative"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that names itself with only a path",
      metaDescription:
        "The canonical link on this page is a bare path with no scheme or host, so it is resolved against whichever address happened to serve the page.",
      canonical: "/authored26/canonical-relative",
      bodyHtml: article({
        h1: "A canonical written as a bare path",
        lede: "The head of this document declares itself canonical, but only as a path, leaving the scheme and the host for the reader to supply.",
        withImage: false,
        sections: [
          {
            h2: "What the path leaves open",
            body: "A relative canonical works only while the page is fetched from the address it was written for. Served from a staging host, a mirror or a cached copy, the same markup names that copy as the original, which is the opposite of what a canonical is for.",
          },
          {
            h2: "Why templates produce it",
            body: "A template that prints the request path is the shortest thing to write, and on the production host it looks right in every test a developer runs. Nobody sees the other hosts until a crawler or a search engine does.",
          },
          {
            h2: "How it gets fixed",
            body: "Print the preferred scheme and host in front of the path, from configuration and not from the request, so every copy of the page agrees on one address.",
          },
        ],
      }),
    })),
};

/**
 * A canonical that is the page's own address plus a `#fragment`. The fragment is
 * stripped when the URL is normalised, so the canonical still resolves to the
 * page itself and only the fragment rule fires.
 */
const canonicalFragment: Fixture = {
  path: "/authored26/canonical-fragment",
  category: "canonical",
  name: "Page whose canonical carries a fragment",
  expectedIssues: ["canonical.fragment"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A page whose canonical ends in a fragment",
      metaDescription:
        "The canonical link on this page is the page's own address followed by a hash fragment, which no search engine treats as part of the URL it indexes.",
      canonical: `${new URL("/authored26/canonical-fragment", self).href}#main`,
      bodyHtml: article({
        h1: "A canonical that ends in a hash",
        lede: "This page declares its own absolute address as canonical and then appends a fragment to it, naming a place inside the page rather than the page.",
        withImage: false,
        sections: [
          {
            h2: "What the fragment does to a canonical",
            body: "A fragment points at a spot inside a document and is never sent to the server, so every address that differs only by one is the same page. A canonical that carries one names an address that does not exist as written, and an engine is free to ignore the hint.",
          },
          {
            h2: "Where it comes from",
            body: "Single page layouts and tabbed templates often build the canonical from the browser location, hash included. The server never sees the hash, so the bug appears only where scripts or a copied link supply it.",
          },
          {
            h2: "How it gets fixed",
            body: "Build the canonical from the path and the preferred host alone, and leave anything after a hash out of it.",
          },
        ],
      }),
    })),
};

/**
 * Chain a -> b -> c. Only `a` is linked from the hub, and neither `b` nor `c` is
 * linked from anywhere, so every link into the chain is the hub's link to `a`.
 * `c` is self-canonical. Each page canonicalises with an absolute URL, so the
 * defects are the ones the chain itself produces and nothing about the value.
 */
const CHAIN_A = "/authored26/chain-a";
const CHAIN_B = "/authored26/chain-b";
const CHAIN_C = "/authored26/chain-c";

function chainPage(
  path: string,
  canonicalPath: string,
  copy: { title: string; description: string; h1: string; lede: string; body: [string, string][] },
  rest: Pick<Fixture, "expectedIssues" | "linkedFromHub" | "inSitemap" | "name">,
): Fixture {
  return {
    path,
    category: "canonical",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, (self) => ({
        title: copy.title,
        metaDescription: copy.description,
        canonical: new URL(canonicalPath, self).href,
        bodyHtml: article({
          h1: copy.h1,
          lede: copy.lede,
          withImage: false,
          sections: copy.body.map(([h2, body]) => ({ h2, body })),
        }),
      })),
  };
}

const chainA = chainPage(
  CHAIN_A,
  CHAIN_B,
  {
    title: "The first page of a three step canonical chain",
    description:
      "This page canonicalises to a second page, and that second page canonicalises to a third, so the first signal has to pass through a page that hands it on.",
    h1: "The head of a canonical chain",
    lede: "This is the only page of the three that the home page links to, and its canonical names a page that itself points somewhere else.",
    body: [
      [
        "Where the signal goes",
        "The canonical of this page names the second page in the chain. That page declares a canonical of its own, so the consolidation this page asked for never lands on the page it named and depends on a search engine following one more step.",
      ],
      [
        "Why a chain is a risk",
        "Engines read a canonical as a hint and may stop after one hop, so a chain leaves it to chance which of the three addresses is kept. Redesigns and migrations leave them behind when one address is retired and its old canonical is pointed at the new one.",
      ],
      [
        "How it gets fixed",
        "Point this page straight at the last address in the chain, the one that names itself, so a single hop settles the question.",
      ],
    ],
  },
  {
    name: "Canonical chain, first page (a -> b -> c)",
    // Canonicalised pages stay out of the sitemap: listing one is
    // `sitemap.non-indexable`, which is not what this fixture is about.
    inSitemap: false,
    expectedIssues: ["canonical.points-elsewhere", "canonical.chain", "canonical.unlinked"],
  },
);

const chainB = chainPage(
  CHAIN_B,
  CHAIN_C,
  {
    title: "The middle page of a three step canonical chain",
    description:
      "This page is the target of the first page's canonical and carries a canonical of its own that names the third page, which is what makes the first a chain.",
    h1: "The middle of a canonical chain",
    lede: "No page on the site links to this one. It is reached only because the first page of the chain names it, and it names the third.",
    body: [
      [
        "A target that defers",
        "A canonical target is supposed to be the page that keeps the signals. This one passes them on, which is why the page before it is reported as a chain, while this page is reported only for pointing elsewhere.",
      ],
      [
        "Why nobody links it",
        "Pages like this are often old addresses that were replaced and left behind. Every link on the site was updated to the new address, so only a canonical still names the page.",
      ],
      [
        "How it gets fixed",
        "Update whichever page names this one so it points at the final address, and retire this page or redirect it.",
      ],
    ],
  },
  {
    name: "Canonical chain, middle page (a -> b -> c)",
    // Linked from nowhere, so the only way the crawl reaches it is the
    // sitemap, which makes it a listed page that canonicalises elsewhere:
    // `sitemap.non-indexable` is an arithmetic consequence of being reachable.
    linkedFromHub: false,
    expectedIssues: [
      "canonical.points-elsewhere",
      "canonical.unlinked",
      "sitemap.non-indexable",
    ],
  },
);

const chainC = chainPage(
  CHAIN_C,
  CHAIN_C,
  {
    title: "The final page of a three step canonical chain",
    description:
      "This page is where the chain ends, because it canonicalises to itself, and it is linked from no other page on the site, only named by a canonical.",
    h1: "The end of a canonical chain",
    lede: "This page names itself as canonical, so it is where the signals of the other two pages are meant to land, and no page links to it.",
    body: [
      [
        "The page that keeps the signals",
        "A self-referencing canonical on an indexable page is the healthy end of any chain. Everything above it is asking for the signals to be consolidated here, so this is the address a search engine is meant to keep, to rank and to show to the people who search, and the page above it in the chain exists only to hand its signals on to this one.",
      ],
      [
        "Why it needs a link",
        "A canonical is a hint, and an address that nothing links to gives an engine little reason to prefer it over a page it can reach. A page that others point at is easier to keep, because the links are the evidence an engine weighs when it decides between two addresses that claim to be the same content, and this page has none of that evidence.",
      ],
      [
        "How it gets fixed",
        "Link to this page from the places a reader would expect to find it, such as a menu, a related list or the body of the page above it in the chain, and point the first two pages of the chain straight at it.",
      ],
    ],
  },
  {
    name: "Canonical chain, final page (a -> b -> c, orphaned)",
    linkedFromHub: false,
    expectedIssues: ["links.orphan"],
  },
);

export const authoredP26Fixtures: Fixture[] = [
  wrongContentType,
  nofollow,
  nosnippet,
  unavailableAfter,
  canonicalRelative,
  canonicalFragment,
  chainA,
  chainB,
  chainC,
];
