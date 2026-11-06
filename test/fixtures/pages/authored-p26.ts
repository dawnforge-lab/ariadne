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
import {
  HIGH_EXTERNAL_OUTLINKS,
  META_PX_MAX,
  META_PX_MIN,
  TITLE_PX_MAX,
  TITLE_PX_MIN,
} from "../../../src/rules/thresholds.js";
import { serpWidth } from "../../../src/rules/serp-width.js";
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

// ---------------------------------------------------------------------------
// Hreflang integrity. Every page here declares an x-default and names itself,
// so `hreflang.missing-x-default` and `hreflang.missing-self-reference` stay
// where Phases 2 and 19 put them. Each cluster breaks one thing.
// ---------------------------------------------------------------------------

const CODE_A = "/authored26/hreflang-code-a";
const CODE_B = "/authored26/hreflang-code-b";
const DUP_A = "/authored26/hreflang-dup-a";
const DUP_B = "/authored26/hreflang-dup-b";
const SELF_ONLY = "/authored26/hreflang-self-only";
const LINK_A = "/authored26/hreflang-link-a";
const LINK_B = "/authored26/hreflang-link-b";

function alternate(code: string, path: string, self: string): string {
  return `<link rel="alternate" hreflang="${code}" href="${new URL(path, self).href}">`;
}

interface HreflangCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  body: [string, string][];
}

function hreflangPage(
  path: string,
  block: Array<[code: string, path: string]>,
  copy: HreflangCopy,
  rest: Pick<Fixture, "expectedIssues" | "linkedFromHub" | "name">,
): Fixture {
  return {
    path,
    category: "hreflang",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, (self) => ({
        title: copy.title,
        metaDescription: copy.description,
        headExtra: block.map(([code, target]) => alternate(code, target, self)).join("\n"),
        bodyHtml: article({
          h1: copy.h1,
          lede: copy.lede,
          withImage: false,
          sections: copy.body.map(([h2, body]) => ({ h2, body })),
        }),
      })),
  };
}

/**
 * A wrong return code: A calls itself `en`, and B, its French twin, calls A
 * `en-gb`. B names itself `fr` and A names B `fr`, so B is consistent and only
 * A fires.
 */
const codeA = hreflangPage(
  CODE_A,
  [
    ["en", CODE_A],
    ["fr", CODE_B],
    ["x-default", CODE_A],
  ],
  {
    title: "Shipping times for orders sent inside the country",
    description:
      "The English version of a shipping page. Its twin calls this page British English in its own annotations, while this page calls itself plain English.",
    h1: "How long a domestic order takes to arrive",
    lede: "This page calls itself English. The French version of it describes this page with a different code, so the two pages disagree about what language this one is.",
    body: [
      [
        "What the two pages say",
        "This page lists itself under en and its French twin under fr. The twin lists this page under en-gb and itself under fr, so each side has the other's address and the codes for this page do not match.",
      ],
      [
        "Why the disagreement matters",
        "A set of annotations is meant to be one statement made by every page in it. When two members give different answers about the same page, a search engine has to choose one or set the whole cluster aside, and nothing on either page says which it will do.",
      ],
      [
        "Who notices first",
        "Nobody sees this in a browser. It shows up when someone compares the two annotation blocks side by side, or when traffic from one country keeps landing on the wrong version and no setting in the analytics explains why.",
      ],
      [
        "How it gets fixed",
        "Choose the code this page should carry and write that same code on every page that names it, ideally by generating all the blocks from one table of pages and codes.",
      ],
    ],
  },
  {
    name: "hreflang cluster where the return link calls this page another code",
    expectedIssues: ["hreflang.inconsistent-return-code"],
  },
);

const codeB = hreflangPage(
  CODE_B,
  [
    ["en-gb", CODE_A],
    ["fr", CODE_B],
    ["x-default", CODE_A],
  ],
  {
    title: "Délais de livraison pour les commandes nationales",
    description:
      "The French version of the shipping page. It names the English page with a regional code that the English page does not use for itself.",
    h1: "Combien de jours pour recevoir une commande",
    lede: "The French counterpart of the previous page, written for a different audience, and the one whose annotations name the English version with a code of its own choosing.",
    body: [
      [
        "Where the code comes from",
        "This page was annotated by a template that adds a region to every English entry, while the English page was annotated by another that does not. Neither is wrong on its own and together they describe two different languages.",
      ],
      [
        "What stays consistent",
        "This page calls itself fr and the English page calls it fr, so nothing is reported against it. The inconsistency belongs to the page whose own code does not match the return link.",
      ],
      [
        "A check worth keeping",
        "After any change to either template, compare what each page calls the other. A short script over the crawl's annotation export can list every pair of pages whose two codes for one address differ, which is cheaper than reading blocks by eye.",
      ],
      [
        "How it gets fixed",
        "Nothing on this page needs to change if the English page is brought into line, because the English code is the one that has to follow the return link or the other way round.",
      ],
    ],
  },
  {
    name: "hreflang cluster, the side that is consistent with its twin",
    expectedIssues: [],
  },
);

/** Duplicate `en`: each page lists two different URLs as English, and both name each other. */
const dupA = hreflangPage(
  DUP_A,
  [
    ["en", DUP_A],
    ["en", DUP_B],
    ["x-default", DUP_A],
  ],
  {
    title: "Gift wrapping options for the spring collection",
    description:
      "A page whose annotations give the English code to two different addresses, so a search engine cannot tell which of them the code means.",
    h1: "Wrapping a gift in three styles",
    lede: "This page lists itself as English and then lists a second page as English too, so the one code now points at two addresses.",
    body: [
      [
        "What the block says",
        "Three annotations sit in the head: this page as en, a second page as en, and this page again as the fallback. The second line was probably meant to carry another language or region and the code was never changed.",
      ],
      [
        "Why a code needs one address",
        "A language code is a lookup key. Two addresses under one key leave the engine to pick, and engines are told to ignore an annotation that contradicts itself, so both lines can be lost together.",
      ],
      [
        "How the second line gets there",
        "Usually somebody copies the first line to add a market, changes the address and forgets the code. The page keeps rendering and no error is raised, so the copy-paste survives until a crawl reads every block.",
      ],
      [
        "How it gets fixed",
        "Decide which address is the English version and give the other the code it really represents, or remove it if it is not an alternate at all.",
      ],
    ],
  },
  {
    name: "hreflang page listing one code for two URLs (first)",
    expectedIssues: ["hreflang.multiple-entries"],
  },
);

const dupB = hreflangPage(
  DUP_B,
  [
    ["en", DUP_A],
    ["en", DUP_B],
    ["x-default", DUP_A],
  ],
  {
    title: "Presentes embrulhados para a coleção de primavera",
    description:
      "The second page of the pair carries the same block as the first, so it also gives the English code to two different addresses.",
    h1: "Embrulhar um presente de três maneiras",
    lede: "A sibling of the previous page written for another audience, whose head repeats the same two English entries because both pages share one template.",
    body: [
      [
        "A shared template",
        "The block is the same on both pages because it comes from one include. That is why the fault appears on every page of the cluster at once and why one correction in the include removes all of them.",
      ],
      [
        "What is reported",
        "One finding per page and code, naming the addresses listed. Here that is two findings in total, one on each page, each with the same two addresses.",
      ],
      [
        "What a reader would see",
        "Nothing at all. The two pages read like ordinary gift guides in different languages, and the fault is confined to the head, which is why it is the sort of mistake that is found by crawling and almost never by browsing.",
      ],
      [
        "How it gets fixed",
        "Correct the include so each code appears once with one address, then check that every page of the cluster renders the corrected block.",
      ],
    ],
  },
  {
    name: "hreflang page listing one code for two URLs (second)",
    expectedIssues: ["hreflang.multiple-entries"],
  },
);

/** A page whose block names nobody but itself. */
const selfOnly = hreflangPage(
  SELF_ONLY,
  [
    ["en", SELF_ONLY],
    ["x-default", SELF_ONLY],
  ],
  {
    title: "Opening a trade account with the wholesale team",
    description:
      "A page whose annotations list only itself, once as English and once as the fallback, so the block names no other version of the page.",
    h1: "Starting a wholesale account step by step",
    lede: "The head of this page carries an annotations block, and every line in it points back at this very page.",
    body: [
      [
        "A block with no alternates",
        "The block declares this page as English and as the default, which is valid and tells a search engine nothing new. Pages like this usually come from a template that is switched on before the translations exist.",
      ],
      [
        "Why it is reported",
        "It is the commonest sign of an unfinished rollout: the markup exists on every page, and none of the pages is connected to a version in another language.",
      ],
      [
        "What it costs",
        "Very little in itself, because a page that names only itself does no harm. The cost is the missed benefit: visitors in other markets are never steered to a version written for them while the block sits there looking finished.",
      ],
      [
        "How it gets fixed",
        "Add the other language versions to the block once they exist, or remove the block until then so the markup says only what is true.",
      ],
    ],
  },
  {
    name: "hreflang page that names only itself",
    expectedIssues: ["hreflang.self-only"],
  },
);

/**
 * An alternate nothing links to. `link-a` is linked from the hub, `link-b` is
 * not, so the only things that name `link-b` are the sitemap and the two
 * annotation blocks. Both pages declare the same complete set.
 */
const linkBlock: Array<[string, string]> = [
  ["en", LINK_A],
  ["fr", LINK_B],
  ["x-default", LINK_A],
];

const linkA = hreflangPage(
  LINK_A,
  linkBlock,
  {
    title: "Returning an item bought in one of our shops",
    description:
      "The linked half of a pair of pages. It names its French counterpart in its annotations, but nothing in its body links to that page.",
    h1: "Sending back something you bought from a shop",
    lede: "This page is reachable from the home page and annotates a French version of itself that no page on the site links to.",
    body: [
      [
        "What the head says",
        "Three annotations list this page as English, the French page as French and this page again as the fallback. The body has no link to the French page, and nor does any other page.",
      ],
      [
        "Why the French page is hard to find",
        "An annotation tells an engine two pages are versions of one another. It does not give a visitor, or a crawler that follows links, a way to reach the second page, which is why a page named only by annotations is easy to miss.",
      ],
      [
        "What a switcher gives you",
        "A visible link from this page to its French version lets people choose a language, gives crawlers an ordinary path to follow, and carries the usual signals of a link, so the second page stops depending on a hint alone to be found.",
      ],
      [
        "How it gets fixed",
        "Add a language switcher or a link to the French version, so the page is part of the site and not only of a list in the head.",
      ],
    ],
  },
  {
    name: "hreflang pair, the half the hub links",
    expectedIssues: [],
  },
);

const linkB = hreflangPage(
  LINK_B,
  linkBlock,
  {
    title: "Retourner un article acheté dans l'un de nos magasins",
    description:
      "The French half of the pair: no page links to it, so the crawl reaches it only through the sitemap and the annotations on its English twin.",
    h1: "Renvoyer un achat fait en magasin",
    lede: "No page on this site links here. The English twin names this page in its annotations, and the sitemap lists it, and that is all that points at it.",
    body: [
      [
        "An alternate with no way in",
        "Visitors can reach this page only by typing the address or finding it in a search engine. The site itself offers no path to it, so the French version exists without being part of the French or the English navigation.",
      ],
      [
        "What is reported",
        "The alternate is reported once, with the pages that name it and how many there are, and the page is also an orphan because nothing links to it.",
      ],
      [
        "Why the sitemap does not help",
        "A sitemap lists the address, so a crawler can find it, but it says nothing about how the page relates to the rest of the site. A page that only the sitemap and a head annotation know about is treated as a loose end rather than as part of a section.",
      ],
      [
        "How it gets fixed",
        "Link this page from the language switcher of the English page and from the French section, so it is reachable by following links.",
      ],
    ],
  },
  {
    name: "hreflang pair, the alternate no page links to",
    linkedFromHub: false,
    expectedIssues: ["links.orphan", "hreflang.unlinked-target"],
  },
);

// ---------------------------------------------------------------------------
// Pagination integrity. Three clusters, each breaking one thing, and the hub
// links each page (the default) so `pagination.next-not-linked` and `links.orphan`
// stay where Phase 3 put them. The Phase 3 series (`/authored3/paged-*`) is
// untouched: it is wired correctly in both directions, so it proves
// `pagination.sequence-error` does not fire on a series whose prevs are right.
//
//  - the loop (`loop-1` -> `loop-2` -> `loop-3` -> `loop-1`): every page names
//    its neighbours both ways, so the only defect is that the series has no end.
//    Each of the three fires `pagination.loop`.
//  - the dead next page (`next-gone`): its `rel=next` names `/status/not-found`,
//    a page the crawl fetched and which answered 404.
//  - the one-way pair (`sequence-a` -> `sequence-b`): the second page's
//    `rel=prev` names the home page instead of the first, so the first fires
//    `pagination.sequence-error`.
// ---------------------------------------------------------------------------

const LOOP_1 = "/authored26/loop-1";
const LOOP_2 = "/authored26/loop-2";
const LOOP_3 = "/authored26/loop-3";
const NEXT_GONE = "/authored26/next-gone";
const SEQ_A = "/authored26/sequence-a";
const SEQ_B = "/authored26/sequence-b";

interface PaginationCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  body: [string, string][];
}

function paginationPage(
  path: string,
  links: { next?: string; prev?: string },
  copy: PaginationCopy,
  rest: Pick<Fixture, "expectedIssues" | "name">,
): Fixture {
  return {
    path,
    category: "pagination",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, (self) => ({
        title: copy.title,
        metaDescription: copy.description,
        headExtra: [
          links.prev === undefined
            ? null
            : `<link rel="prev" href="${new URL(links.prev, self).href}">`,
          links.next === undefined
            ? null
            : `<link rel="next" href="${new URL(links.next, self).href}">`,
        ]
          .filter((l): l is string => l !== null)
          .join("\n"),
        bodyHtml: article({
          h1: copy.h1,
          lede: copy.lede,
          withImage: false,
          sections: copy.body.map(([h2, body]) => ({ h2, body })),
        }),
      })),
  };
}

const LOOP_BODY = (n: string): [string, string][] => [
  [
    "Where this page sits",
    `This is page ${n} of a three page archive. Its rel=next names the page after it and its rel=prev names the page before it, so each page is wired correctly to its neighbours on its own.`,
  ],
  [
    "What is wrong with the series",
    "The third page names the first as its next page, so following the series never reaches an end. A crawler that follows rel=next walks around the three pages until it gives up, and a reader of the annotations cannot tell which page is last.",
  ],
  [
    "How a loop gets made",
    "Archive templates usually wrap the page number around when it passes the last page, so that the final page links back to the start. That is a reasonable thing for a visible carousel to do and a wrong thing for an annotation that says what comes next.",
  ],
  [
    "How it gets fixed",
    "Leave rel=next off the last page of the series, and make sure no template computes the page after the last as the first.",
  ],
];

const loop1 = paginationPage(
  LOOP_1,
  { next: LOOP_2, prev: LOOP_3 },
  {
    title: "Archive page one of a three page loop",
    description:
      "The first page of an archive whose last page names it as the next one, so the series of next links has no end and runs in a circle.",
    h1: "Archive page one in a loop of three",
    lede: "Page one of three, linked to the second page ahead of it and to the third page behind it, which closes the circle.",
    body: LOOP_BODY("one"),
  },
  { name: "Pagination loop, page 1 of 3", expectedIssues: ["pagination.loop"] },
);

const loop2 = paginationPage(
  LOOP_2,
  { next: LOOP_3, prev: LOOP_1 },
  {
    title: "Archive page two of a three page loop",
    description:
      "The middle page of an archive whose last page names the first as its next page, which makes the whole series of next links a circle.",
    h1: "Archive page two in a loop of three",
    lede: "Page two of three, linked to the third page ahead of it and to the first page behind it, with nothing wrong that shows on this page alone.",
    body: LOOP_BODY("two"),
  },
  { name: "Pagination loop, page 2 of 3", expectedIssues: ["pagination.loop"] },
);

const loop3 = paginationPage(
  LOOP_3,
  { next: LOOP_1, prev: LOOP_2 },
  {
    title: "Archive page three of a three page loop",
    description:
      "The last page of an archive that names the first page as its next page, so the series never ends and a crawler following it goes round again.",
    h1: "Archive page three in a loop of three",
    lede: "Page three of three, whose next link wraps round to page one instead of being left out, which is the single fault in the series.",
    body: LOOP_BODY("three"),
  },
  { name: "Pagination loop, page 3 of 3", expectedIssues: ["pagination.loop"] },
);

const nextGone = paginationPage(
  NEXT_GONE,
  { next: "/status/not-found" },
  {
    title: "A series whose next page answers not found",
    description:
      "This page declares a next page that the crawl fetched and that answered 404, so the series points at an address that no longer serves anything.",
    h1: "A next page that no longer exists",
    lede: "The only page of a short series that is still live, whose rel=next names an address on the same site that returns a not found response.",
    body: [
      [
        "What the annotation says",
        "The head of this page declares a next page. The crawl requested that address because the rest of the site links to it, and the server answered that nothing is there.",
      ],
      [
        "Why it matters",
        "A series that points at an error page tells a search engine that the next step is broken. The page itself is fine, so the fault shows only in the annotation and in no report that looks at the page alone.",
      ],
      [
        "How it comes about",
        "Archives lose their later pages when posts are deleted or a category is merged, and the template that writes rel=next keeps naming a page number that used to exist. Nothing in a browser shows it, because the visible pagination control is generated separately.",
      ],
      [
        "How it gets fixed",
        "Make the template drop rel=next when the next page does not exist, or point it at the page that now holds the following items.",
      ],
    ],
  },
  { name: "Pagination, next page answers 404", expectedIssues: ["pagination.non-indexable-target"] },
);

const seqA = paginationPage(
  SEQ_A,
  { next: SEQ_B },
  {
    title: "The first page of a pair that disagree on order",
    description:
      "This page names the second page as its next page, and the second page names a different page as its previous one, so the two disagree.",
    h1: "Page one of a pair that disagree",
    lede: "The first page of a two page series, whose next link is returned by no link back to it from the page it names.",
    body: [
      [
        "What this page declares",
        "The head of this page names the second page as the next one. That page is live and was crawled, so the declaration is a statement about two pages that the crawl can read side by side.",
      ],
      [
        "What the second page says back",
        "The second page declares a previous page of its own, and it is not this one. Two pages that describe the same step differently leave a search engine to decide which description to trust, or to ignore both.",
      ],
      [
        "Why it happens",
        "The previous link is often built from a different variable than the next link, and the two drift apart when a page is renamed or a series is reordered. Neither template looks wrong by itself.",
      ],
      [
        "How it gets fixed",
        "Generate the previous link of every page from the same list that generates the next link of the page before it, so the two always agree.",
      ],
    ],
  },
  {
    name: "Pagination sequence, first page of a disagreeing pair",
    expectedIssues: ["pagination.sequence-error"],
  },
);

const seqB = paginationPage(
  SEQ_B,
  { prev: "/" },
  {
    title: "The second page of a pair that disagree on order",
    description:
      "This page names the home page as its previous page, while the first page of the series names this page as its next one, which is a mismatch.",
    h1: "Page two of a pair that disagree",
    lede: "The second page of a two page series, whose previous link goes to the home page of the site instead of to the page that names it.",
    body: [
      [
        "What this page declares",
        "The head of this page names the home page as its previous page. The first page of the series names this page as its next one, so the two ends of the step do not match.",
      ],
      [
        "Where the finding goes",
        "The report is filed against the first page, because that is the page whose declaration is not returned. This page is reported for nothing: the home page it names is an ordinary page that returns a success status and can be indexed.",
      ],
      [
        "A common cause",
        "A template that falls back to the site root when it cannot work out the previous address will write exactly this, and it does so on every page whose previous page is missing from its data.",
      ],
      [
        "How it gets fixed",
        "Point the previous link at the first page of the series, or leave it out on every page of the series if the site does not use rel=prev.",
      ],
    ],
  },
  { name: "Pagination sequence, second page of a disagreeing pair", expectedIssues: [] },
);

// ---------------------------------------------------------------------------
// Link hygiene (Task 8). Each page is the control recipe plus one link, so the
// link is its only defect:
//
//  - `internal-nofollow`: one rel=nofollow link back to the home page.
//  - `generic-anchor`: one internal link whose whole anchor is "click here".
//  - `private-host-link`: one external link to a private address.
//  - `noindex-hub` and `only-from-noindex`: a noindexed page (off the sitemap, as
//    every noindex fixture is) that links a page nothing else links to. The hub
//    links the noindex page but not its target, and the target is reached by the
//    sitemap and by the noindex page alone, so it is linked only from a page that
//    is out of the index.
//
//  - `high-outlinks`: `HIGH_EXTERNAL_OUTLINKS + 1` generated links to distinct
//    external addresses, so the fixture follows the constant. They are external
//    on purpose: the crawler follows internal links, and a page of more than
//    `HIGH_INTERNAL_OUTLINKS` internal ones would grow the crawl by that many
//    pages, so the internal limit is proven by the DB test alone.
// ---------------------------------------------------------------------------

interface LinkPageCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  /** The one link this page adds, as raw HTML. */
  linkHtml: string;
  robotsMeta?: string;
}

function linkPage(
  path: string,
  copy: LinkPageCopy,
  rest: Pick<Fixture, "expectedIssues" | "linkedFromHub" | "inSitemap" | "name">,
): Fixture {
  return {
    path,
    category: "links",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: copy.title,
        metaDescription: copy.description,
        ...(copy.robotsMeta === undefined ? {} : { robotsMeta: copy.robotsMeta }),
        bodyHtml:
          article({
            h1: copy.h1,
            lede: copy.lede,
            withImage: false,
            sections: [
              { h2: "What this page does", body: copy.what },
              { h2: "Why it matters", body: copy.why },
              { h2: "How it gets fixed", body: copy.fix },
            ],
          }) + `\n<p>${copy.linkHtml}</p>`,
      })),
  };
}

const internalNofollow = linkPage(
  "/authored26/internal-nofollow",
  {
    title: "A page that marks a link to its own site nofollow",
    description:
      "This page links back to the home page of its own site with rel=nofollow, which asks search engines not to follow it or to count it as an endorsement.",
    h1: "A link to the home page that search engines are told to ignore",
    lede: "Everything on this page is in order except one internal link, which carries a rel attribute that tells crawlers to disregard it.",
    what: "The link at the foot of the page points at the home page of the same site. Its rel attribute says nofollow, so a search engine may neither follow it nor credit the home page for it, although the page it names belongs to the same site as this one.",
    why: "Internal links are how a site tells search engines which of its own pages matter and passes credit between them. A nofollow on one of them withholds that credit from a page the site itself has chosen to link, which is almost never what the people who run the site want, and it tends to be copied from a template meant for another kind of link.",
    fix: "Remove nofollow from links between the pages of your own site, and keep it for links to addresses you do not want to vouch for, such as ones left in comments by visitors.",
    linkHtml: '<a href="/" rel="nofollow">Back to the home page</a>',
  },
  { name: "Page with an internal nofollow link", expectedIssues: ["links.internal-nofollow"] },
);

const genericAnchor = linkPage(
  "/authored26/generic-anchor",
  {
    title: "A page whose only link says click here",
    description:
      "This page links to its own home page with the words click here, an anchor that says nothing about the page it leads to or why a visitor would go there.",
    h1: "A link that tells the reader nothing about where it goes",
    lede: "The page is well formed, and its single internal link uses an anchor that would read the same on any page of any site.",
    what: "The link at the foot of the page points at the home page and its whole anchor text is click here. A visitor skimming the links on the page, and a search engine reading the anchor for a clue to the target, learn nothing from it.",
    why: "Anchor text is one of the few places where a link describes its own destination in words. A page full of links that say click here or read more gives a visitor using a screen reader a list of identical entries to choose between, and it gives a search engine no description of the pages those links lead to.",
    fix: "Write the anchor so it describes the page it points at, for example the name of the site or the question the target answers, and keep generic phrases out of it.",
    linkHtml: '<a href="/">click here</a>',
  },
  { name: "Page with a generic internal anchor", expectedIssues: ["links.non-descriptive-anchor"] },
);

const privateHostLink = linkPage(
  "/authored26/private-host-link",
  {
    title: "A page that links to a private network address",
    description:
      "This page carries a link to an address on a private network, which opens nothing for any visitor outside the network of whoever wrote the link.",
    h1: "A link that only works on the author's own network",
    lede: "The page is complete and its only external link points at a private address left over from a staging or development setup.",
    what: "The link at the foot of the page points at a ten dot address, which is reserved for private networks. It opens a page for the author and for no one else, and a crawler that follows it reaches nothing.",
    why: "A link to a private address is a sign that a page was written or copied on a development setup and published without anyone clicking through it. Visitors get a dead end or a connection error, and some browsers and security tools treat a public page that reaches into a private network as a risk worth flagging.",
    fix: "Replace the link with the public address of the page it was meant to reach, or remove it, and search the templates for other addresses of the same kind.",
    linkHtml: '<a href="http://10.1.2.3/admin">Open the admin panel</a>',
  },
  { name: "Page linking a private network address", expectedIssues: ["links.localhost"] },
);

const highOutlinks = linkPage(
  "/authored26/high-outlinks",
  {
    title: "A page with a very long list of outgoing links",
    description:
      "This page carries a very long list of links to other sites, more than the limit this audit allows, which shares the page's link value too thinly.",
    h1: "A page with a very long list of links to other sites",
    lede: "Everything on this page is in order except the length of its list of outgoing links, which is longer than any reader will scan.",
    what: "The list at the foot of the page links to one more distinct external address than the limit allows. Each link is to a different address, so the count is of places the page sends a visitor and not of repeated links to one place.",
    why: "Every link on a page takes a share of the value the page can pass on, so a very long list dilutes each of them, and a crawler that reads only the start of a long document may never reach the end of the list. Pages like this are usually directories or link dumps that nobody curates.",
    fix: "Cut the list to the links a visitor needs, and move the rest to pages of their own, each with a manageable number, or drop the ones that no longer earn a place.",
    linkHtml: Array.from(
      { length: HIGH_EXTERNAL_OUTLINKS + 1 },
      (_, i) => `<a href="https://example.com/outlink/${i + 1}">Reference number ${i + 1}</a>`,
    ).join(" "),
  },
  { name: "Page with more external links than the limit", expectedIssues: ["links.high-outlinks"] },
);

const NOINDEX_TARGET = "/authored26/only-from-noindex";

const noindexHub = linkPage(
  "/authored26/noindex-hub",
  {
    title: "A noindexed page that links to a page nothing else links to",
    description:
      "This page asks to stay out of the index and links to a second page that no indexable page links to, so the second page is reachable only through this one.",
    h1: "A page out of the index that is another page's only link",
    lede: "The robots meta of this page says noindex while still allowing its links to be followed, and one of those links is the only way in to another page.",
    what: "The link at the foot of the page names a page that the site's other pages do not link to. Search engines may give links from a page they are asked not to index little or no weight, so the page it names is left with no usable internal link.",
    why: "Internal links from a page that is kept out of the index may carry little or no weight, because the engine does not retain the page that holds them. A site that routes its only link to a page through a page of this kind has linked it in the markup and left it unlinked in the way that counts for search.",
    fix: "Link the target page from at least one page that is indexed, such as a category or a related content list, and leave the noindexed page as it is.",
    linkHtml: `<a href="${NOINDEX_TARGET}">Read the page that only this page links to</a>`,
    robotsMeta: "noindex, follow",
  },
  {
    name: "Noindexed page that is another page's only inlink",
    expectedIssues: ["indexability.noindex"],
    // Off the sitemap, for the reason every noindex fixture is: a listed
    // noindexed page is `sitemap.non-indexable`, which `/index/noindex-meta`
    // claims.
    inSitemap: false,
  },
);

const onlyFromNoindex = linkPage(
  NOINDEX_TARGET,
  {
    title: "An indexable page linked only from a noindexed page",
    description:
      "This page may be indexed, and the one page on the site that links to it asks to stay out of the index, which leaves it without a usable internal link.",
    h1: "A page whose only inlink comes from a page out of the index",
    lede: "Nothing is wrong with this page itself. The fault is in where its links come from, and it shows only when the whole site is read together.",
    what: "The sitemap lists this page and one other page links to it, and that page carries a noindex directive. Links from a page that is out of the index may be given little or no weight, so this page is close to having no internal links at all.",
    why: "A page with a single inlink, and that inlink from a page kept out of the index, is the closest thing to an orphan that still shows up as linked in a crawl. It is found by the sitemap if the sitemap lists it and by nothing else, which is a weak footing for a page that is meant to rank.",
    fix: "Add a link to this page from an indexable page that has a reason to mention it, such as the section it belongs to.",
    linkHtml: '<a href="/authored26/noindex-hub">See the page that links here</a>',
  },
  {
    name: "Indexable page linked only from a noindexed page",
    expectedIssues: ["links.only-from-non-indexable"],
    linkedFromHub: false,
  },
);

/**
 * The seven URL-shape fixtures (Task 9). The page is the control recipe and the
 * defect is its ADDRESS, so each one is `exact` with the one rule its path
 * trips. Paths are written as the crawler stores them (`normalizeUrl` keeps
 * case, underscores and `//`, and the encoded forms are already encoded).
 */
interface ShapePageCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
}

function shapePage(
  path: string,
  copy: ShapePageCopy,
  rest: Pick<Fixture, "expectedIssues" | "name">,
): Fixture {
  return {
    path,
    category: "url",
    ...rest,
    exact: true,
    handler: (req, res) =>
      serve(req, res, () => ({
        title: copy.title,
        metaDescription: copy.description,
        bodyHtml: article({
          h1: copy.h1,
          lede: copy.lede,
          withImage: false,
          sections: [
            { h2: "What this page does", body: copy.what },
            { h2: "Why it matters", body: copy.why },
            { h2: "How it gets fixed", body: copy.fix },
          ],
        }),
      })),
  };
}

const upperCase = shapePage(
  "/authored26/Upper-Case",
  {
    title: "A page served at an address with a capital letter",
    description:
      "This page is in order, and its address spells one folder with capital letters, which a server that reads paths exactly treats as another address.",
    h1: "An address that is spelled with capitals",
    lede: "Nothing on the page is wrong. The fault is in the path it is served at, where the last segment starts with capital letters.",
    what: "The path ends in Upper-Case, with a capital U and a capital C. On most servers a path is read exactly as written, so the same page may also answer at the lower-case spelling, and each of the two is a separate address to a search engine.",
    why: "People type, copy and link addresses in whatever case they remember. Where the server answers every case, each spelling is a copy of the page that splits the links and signals between them, and where it answers only one, the others are dead ends that a visitor reaches by a small slip.",
    fix: "Serve the page at a lower-case path, redirect the capitalised spelling to it with a permanent redirect, and make every link and the sitemap use the lower-case form.",
  },
  { name: "Page whose path has capital letters", expectedIssues: ["url.uppercase"] },
);

const underScore = shapePage(
  "/authored26/under_score",
  {
    title: "A page served at an address joined with an underscore",
    description:
      "This page is fine, and its address joins two words with an underscore, which search engines read as one longer word rather than as two separate ones.",
    h1: "An address that joins its words with an underscore",
    lede: "The page itself is correct, and the path it lives at runs two words together with an underscore instead of a hyphen.",
    what: "The last segment of the path is under_score. A hyphen between words is read by search engines as a space, and an underscore is read as a character inside a word, so the two words are taken as a single term that nobody searches for.",
    why: "The words in an address are a small hint about what the page covers, and an underscore hides that hint. It is also easy to lose in a link that is underlined, because the underscore disappears behind the line and a reader sees a space where there is none.",
    fix: "Use hyphens between the words of the path, redirect the old address to the new one with a permanent redirect, and update the internal links and the sitemap to the new address.",
  },
  { name: "Page whose path has an underscore", expectedIssues: ["url.underscores"] },
);

const nonAscii = shapePage(
  "/authored26/caf%C3%A9",
  {
    title: "A page served at an address with an accented letter",
    description:
      "This page is correct, and its address ends with an accented letter that is sent as percent-encoded bytes, a form that is hard to read, copy or type.",
    h1: "An address that carries a letter outside plain ASCII",
    lede: "The page has no fault of its own. Its path ends with an e with an acute accent, which travels in an address as three characters beginning with a percent sign.",
    what: "The last segment of the path is caf followed by the encoded bytes of an accented e. A browser shows the accented letter, and anything that copies the address as text, such as an email or a spreadsheet, shows the encoded form.",
    why: "Search engines understand these addresses, but people who share them often get the encoded form, and some systems that rewrite links decode or encode them twice and break them. A path in plain letters avoids that and is easier to type from memory.",
    fix: "Use plain ASCII letters in the path, for example cafe, redirect the old address with a permanent redirect, and keep the accented spelling in the title and the text of the page.",
  },
  { name: "Page whose path has a non-ASCII character", expectedIssues: ["url.non-ascii"] },
);

const withSpace = shapePage(
  "/authored26/with%20space",
  {
    title: "A page served at an address that contains a space",
    description:
      "The page is in order, and its address holds a space, written as a percent sign and two digits, which breaks when the link is copied or wrapped in text.",
    h1: "An address with a space in the middle of it",
    lede: "There is nothing wrong with the content. The path carries a space, which is written in an address as a percent sign followed by two digits.",
    what: "The last segment of the path is the word with, a space and the word space. Anywhere an address is pasted into a line of text, the space can end the link early, so the visitor lands on a page that does not exist.",
    why: "A space is the one character that email programs, chat tools and word processors treat as the end of a link. A visitor who is sent this address may reach only the first half of it, and search engines may see a second address wherever the space is spelled another way.",
    fix: "Replace the space with a hyphen, redirect the old address to the new one with a permanent redirect, and change the links and the sitemap to the hyphenated address.",
  },
  { name: "Page whose path has a space", expectedIssues: ["url.spaces"] },
);

const doubleSlash = shapePage(
  "/authored26//double",
  {
    title: "A page served at an address with two slashes in a row",
    description:
      "This page is correct, and its address has two slashes in a row after the first folder, which usually means a link was built by joining two paths badly.",
    h1: "An address with a doubled slash inside it",
    lede: "The page is complete. The fault is in the address, where an empty folder sits between the first folder and the last segment.",
    what: "The path runs from the first folder straight into a second slash before the word double. Many servers read the doubled slash as a single one and answer with the same page, so the page exists at two addresses that differ by one character.",
    why: "The doubled slash nearly always comes from a template that adds a slash to a path that already ends with one. Search engines count the two addresses separately, and the mistake tends to repeat on every link the same template builds.",
    fix: "Find the template or the rule that joins the two parts of the path and make it add one slash only, then redirect the doubled address to the single one with a permanent redirect.",
  },
  { name: "Page whose path has a double slash", expectedIssues: ["url.multiple-slashes"] },
);

const repetitivePath = shapePage(
  "/authored26/shop/shop/x",
  {
    title: "A page served at an address that repeats a folder",
    description:
      "The page is in order, and its address names the same folder twice in a row, which is how a relative link that adds a folder begins to build endless paths.",
    h1: "An address that says the same folder twice",
    lede: "Nothing is wrong with the page. Its path repeats a folder straight after itself, and that is the signature of a link built from the wrong base.",
    what: "The path has the folder shop twice before the last segment. When a relative link is written without its leading slash, each page that carries it adds one more copy of the folder, and a crawler follows the result without end.",
    why: "A repeating folder is rarely a page somebody wanted. It is usually the first address of a run that a crawler can follow for as long as it is willing to, filling an index and a crawl budget with copies of one page under a path that grows by one folder at a time.",
    fix: "Find the relative link or the rewrite rule that adds the folder and correct it so it builds the address from the root, then redirect the repeating address to the right one.",
  },
  { name: "Page whose path repeats a folder", expectedIssues: ["url.repetitive-path"] },
);

const searchResults = shapePage(
  "/search?q=x",
  {
    title: "The results page of the site's own search box",
    description:
      "This page lists what the site search found for one phrase, and it is open to indexing, so every phrase a visitor types can become an indexed page.",
    h1: "What the site search found for one phrase",
    lede: "The page is complete and a search engine may index it. It is the output of the site's own search, requested here with the parameter q.",
    what: "The address is the search path with q set to one letter. The site answers with a results page and puts no noindex on it, so a crawler that finds a link to it treats it as a page of the site like any other.",
    why: "A site search can produce a different page for every phrase anyone has ever typed, and almost all of them are thin lists of links to pages the index already holds. Left open, they dilute the site's crawl and compete with the pages they list.",
    fix: "Add noindex to the results pages or block the search path in robots.txt, keep them out of the sitemap and the internal links, and give any search page that is meant to rank an address and content of its own.",
  },
  {
    name: "Indexable site search results page",
    expectedIssues: ["url.internal-search", "url.parameter-pages-indexable"],
  },
);

/**
 * The three sitemap-entry fixtures (Task 10). Each page is the control recipe
 * and the fault is in the line of `/sitemap.xml` that names it.
 *
 * `P26_LONG_LOC` is a fragment: it is stripped by `normalizeUrl`, so the
 * published `<loc>` is over 2,048 characters and still names the page the crawl
 * fetched, which keeps the entry joinable to its page.
 */
const P26_LONG_LOC = `/authored26/long-loc#${"segment-".repeat(270)}`;

const badLastmod: Fixture = {
  path: "/authored26/bad-lastmod",
  sitemapLastmod: "2026-13-01",
  category: "sitemap",
  name: "Page whose sitemap entry carries an impossible lastmod",
  expectedIssues: ["h2.duplicate", "sitemap.lastmod-invalid"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The page whose sitemap entry has a month thirteen",
      metaDescription:
        "The page itself is sound. The sitemap entry that lists it carries a last modified date with a month that does not exist, so a search engine cannot read it.",
      bodyHtml: article({
        h1: "A page listed with a date no calendar contains",
        lede: "Nothing on this page is wrong. The file that lists it gives a modification date that no engine can parse.",
        withImage: false,
        sections: [
          { h2: "What the sitemap does", body: "The sitemap entry for this page has a lastmod of 2026-13-01. The month is thirteen, so the value is not a date in the W3C format the protocol asks for, and a crawler reading the file has to discard it." },
          { h2: "Why it matters", body: "A modification date is a promise about when to come back and look again. One that cannot be read is worse than none, because it teaches the engine that the site's dates are unreliable and it begins to ignore the good ones as well." },
          { h2: "How it gets fixed", body: "Output the date in the W3C format, a year, a date or a date and time with a zone, from the real last change of the page content, and check the generator against a month and a day that exist." },
          {
            h2: "What a check of the file looks like",
            body: "Open the sitemap, read the entry for this page and compare it with the address the page really answers on. Every entry is one line of text written by a generator, so a fault in one line is nearly always a fault in all the lines the same template writes, and one correction usually repairs the whole file at once.",
          },
        ],
      }),
    })),
};

const longLoc: Fixture = {
  path: "/authored26/long-loc",
  sitemapLoc: P26_LONG_LOC,
  category: "sitemap",
  name: "Page whose sitemap entry is longer than 2,048 characters",
  expectedIssues: ["sitemap.url-too-long"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The page whose sitemap entry is a very long address",
      metaDescription:
        "The page is ordinary. The sitemap lists it with an address more than two thousand characters long, which is past what a search engine accepts in an entry.",
      bodyHtml: article({
        h1: "A page listed under an address that never ends",
        lede: "Nothing on this page is wrong. The entry that lists it is over the length a sitemap may carry.",
        withImage: false,
        sections: [
          { h2: "What the sitemap does", body: "The sitemap writes this page's address with a very long tail after a fragment marker. The fragment is never sent to the server, so the address resolves to the same page, but the entry itself is far past 2,048 characters." },
          { h2: "Why it matters", body: "Search engines may drop or truncate an entry that long, so the page can silently stay out of the file that exists to announce it. A tail like this usually comes from a session or filter value that should never have been written into a sitemap." },
          { h2: "How it gets fixed", body: "Write the plain address of the page and leave any tail out. Check the generator for a value that is appended to every entry." },
          {
            h2: "What a check of the file looks like",
            body: "Open the sitemap, read the entry for this page and compare it with the address the page really answers on. Every entry is one line of text written by a generator, so a fault in one line is nearly always a fault in all the lines the same template writes, and one correction usually repairs the whole file at once.",
          },
        ],
      }),
    })),
};

const crossHostLoc: Fixture = {
  path: "/authored26/cross-host-loc",
  sitemapLoc: "{legacy}/authored26/cross-host-loc",
  category: "sitemap",
  name: "Page whose sitemap entry names it on another host",
  expectedIssues: ["pages.not-in-sitemap"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "The page the sitemap lists under the wrong host name",
      metaDescription:
        "The page answers on its own host. The sitemap lists it under another host name for the same server, outside the host of the file itself.",
      bodyHtml: article({
        h1: "A page listed on a host the sitemap does not belong to",
        lede: "Nothing on this page is wrong. The sitemap lists it under the old host name of the site.",
        withImage: false,
        sections: [
          { h2: "What the sitemap does", body: "The entry in the sitemap for this page names the old host of the site, which still answers. The sitemap protocol only allows a file to list addresses on its own host, so the entry is outside what the file may speak for, and the page counts as not listed." },
          { h2: "Why it matters", body: "A search engine may ignore entries on another host. The page it was meant to announce is then discovered only through links, and the old host keeps being treated as part of the site." },
          { h2: "How it gets fixed", body: "Rewrite the entry with the host and scheme of the sitemap, and fix the generator that still builds addresses from the old host name." },
          {
            h2: "What a check of the file looks like",
            body: "Open the sitemap, read the entry for this page and compare it with the address the page really answers on. Every entry is one line of text written by a generator, so a fault in one line is nearly always a fault in all the lines the same template writes, and one correction usually repairs the whole file at once.",
          },
        ],
      }),
    })),
};

/**
 * The four pixel-width fixtures (Task 12). The page is the control recipe and
 * the defect is the WIDTH of one head string, so each is `exact`.
 *
 * Each string is chosen to be inside the character rules' range and outside the
 * pixel bound where that is possible, so the page trips the pixel rule alone:
 *
 * - the long title is 54 upper-case characters (under `TITLE_MAX`'s 60) and
 *   wider than `TITLE_PX_MAX`; the long description is 148 characters (under
 *   `META_MAX`'s 155) and wider than `META_PX_MAX`;
 * - the short description is 72 characters (over `META_MIN`'s 70) and narrower
 *   than `META_PX_MIN`;
 * - the short title is the exception: 32 characters (over `TITLE_MIN`'s 30) in
 *   the narrowest letters English has, and it is the nearest a real title gets.
 *   It is narrower than `TITLE_PX_MIN` and not shorter than 30 characters, so
 *   `title.too-short` stays silent here too.
 *
 * The widths are asserted when the module loads, against the same `serpWidth`
 * the rule calls, so a regenerated glyph table that moves one of them throws
 * here instead of turning the fixture into a page the rule does not flag.
 */
const PX_LONG_TITLE = "WHY WE MEASURE WIDTH: A MIDWEEK GUIDE TO SEARCH TITLES";
const PX_SHORT_TITLE = "Flit, flit: it fills little jars";
const PX_LONG_META =
  "WE MEASURE WIDTH: A MIDWEEK GUIDE TO WIDE MEMBERS, MOMENTS AND MEETINGS IN WELLINGTON, WARSAW AND MADRID, MADE FOR WEEKLY WORKSHOPS WITH MORE WOMEN.";
const PX_SHORT_META = "Fill in a little more of the line here, still brief but not tiny at all.";

function assertWidth(
  text: string,
  kind: "title" | "description",
  test: (w: number) => boolean,
  what: string,
): void {
  const w = serpWidth(text, kind);
  if (w === null || !test(w)) {
    throw new Error(`authored-p26 pixel fixture drifted: ${what} measures ${w} px`);
  }
}
assertWidth(PX_LONG_TITLE, "title", (w) => w > TITLE_PX_MAX, "the long title");
assertWidth(PX_SHORT_TITLE, "title", (w) => w < TITLE_PX_MIN, "the short title");
assertWidth(PX_LONG_META, "description", (w) => w > META_PX_MAX, "the long description");
assertWidth(PX_SHORT_META, "description", (w) => w < META_PX_MIN, "the short description");

function pixelPage(
  path: string,
  copy: ShapePageCopy,
  rest: Pick<Fixture, "expectedIssues" | "name">,
): Fixture {
  return { ...shapePage(path, copy, rest), category: "head-tags" };
}

const pixelTitleLong = pixelPage(
  "/authored26/pixel-title-long",
  {
    title: PX_LONG_TITLE,
    description:
      "The title of this page is under sixty characters and still too wide for a search result, because it is set in capitals, the widest letters there are.",
    h1: "A title that is wide although it is not long",
    lede: "The text of the page is in order. Its title is short in characters, and set in capital letters it needs more room than a result gives it.",
    what: "The title runs to fifty-four characters, which passes any count of letters. A search result draws it in a fixed font and cuts it where the line ends, and capitals are about a third wider than lower-case letters, so the last words of this title are the ones that go.",
    why: "A title that is cut loses its ending, and the ending is often where the brand or the qualifier sits. Counting characters does not catch it, because the same number of capitals takes far more room than the same number of ordinary letters. The fault appears most often in headings that were set in capitals for emphasis and then reused as the title of the page without anyone measuring them again.",
    fix: "Write the title in ordinary capitalisation, or shorten it until it fits in the width a result offers, and keep the words that matter most at the front.",
  },
  {
    name: "Title that is too wide in pixels but within the character limit",
    expectedIssues: ["title.pixel-too-long"],
  },
);

const pixelTitleShort = pixelPage(
  "/authored26/pixel-title-short",
  {
    title: PX_SHORT_TITLE,
    description:
      "The title of this page has more than thirty characters and still fills only a small part of a result line, because it is made of the narrowest letters.",
    h1: "A title that is long enough and still narrow",
    lede: "The page is complete. Its title passes a count of characters and leaves most of the line in a search result unused.",
    what: "The title is thirty-two characters of thin letters, such as i, l and t, and of spaces and punctuation. A result gives a title about five hundred and sixty pixels, and this one takes a third of that, so most of the line is left empty.",
    why: "A title is the largest piece of text a result shows. One that fills a third of its line carries less than a third of what it could, and gives a searcher fewer reasons to choose it than the titles on either side. The words it leaves out are the ones that would have told the searcher what the page is for, which is why a title that looks complete to its author can still look thin in a list of results.",
    fix: "Add the words people search for, such as the product, the place or the benefit, until the title fills more of the line.",
  },
  {
    name: "Title that is too narrow in pixels but above the character minimum",
    expectedIssues: ["title.pixel-too-short"],
  },
);

const pixelMetaLong = pixelPage(
  "/authored26/pixel-meta-long",
  {
    title: "A description that is wide although it is not long",
    description: PX_LONG_META,
    h1: "A description that needs more room than it gets",
    lede: "The page is correct. Its meta description is under the character limit and wider than a search result will draw.",
    what: "The description is a hundred and forty-eight characters, which passes any count. It is written in capitals, which are about a third wider than ordinary letters, so a result cuts it well before the end and the closing words are lost.",
    why: "A description that is cut leaves the searcher with half a sentence. The reason to click is usually in the second half, which is the half that goes, and a count of characters does not tell you that it will. The same text in ordinary capitalisation would fit with room to spare, which is why the fault is easy to miss when the copy is read on a screen where it looks like a normal sentence of normal length.",
    fix: "Write the description in ordinary capitalisation or trim it until it fits in the width of a result, with the reason to click in the first sentence.",
  },
  {
    name: "Meta description too wide in pixels but within the character limit",
    expectedIssues: ["meta-description.pixel-too-long"],
  },
);

const pixelMetaShort = pixelPage(
  "/authored26/pixel-meta-short",
  {
    title: "A description that is long enough and still narrow",
    description: PX_SHORT_META,
    h1: "A description that leaves most of its space unused",
    lede: "The page is complete. Its meta description passes the count of characters and fills less of a result than it could.",
    what: "The description is seventy-two characters of short words, which is just over the character minimum. A result gives a description about nine hundred pixels, and this one takes less than half of that, so most of the space is left empty.",
    why: "A description is the one place a result lets you argue for the click. One that fills less than half of its space leaves that argument unmade, and the search engine may write a longer one of its own from the text of the page. A snippet written by an engine from the page text reads as an excerpt rather than as an invitation, and it changes from one search to the next, so the owner of the page no longer controls what a searcher sees.",
    fix: "Expand the description with what the page offers and a reason to click, until it fills more of the result.",
  },
  {
    name: "Meta description too narrow in pixels but above the character minimum",
    expectedIssues: ["meta-description.pixel-too-short"],
  },
);

export const authoredP26Fixtures: Fixture[] = [
  pixelTitleLong,
  pixelTitleShort,
  pixelMetaLong,
  pixelMetaShort,
  upperCase,
  underScore,
  nonAscii,
  withSpace,
  doubleSlash,
  repetitivePath,
  searchResults,
  wrongContentType,
  nofollow,
  nosnippet,
  unavailableAfter,
  canonicalRelative,
  canonicalFragment,
  chainA,
  chainB,
  chainC,
  codeA,
  codeB,
  dupA,
  dupB,
  selfOnly,
  linkA,
  linkB,
  loop1,
  loop2,
  loop3,
  nextGone,
  seqA,
  seqB,
  internalNofollow,
  genericAnchor,
  privateHostLink,
  noindexHub,
  onlyFromNoindex,
  highOutlinks,
  badLastmod,
  longLoc,
  crossHostLoc,
];
