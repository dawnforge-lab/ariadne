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
  codeA,
  codeB,
  dupA,
  dupB,
  selfOnly,
  linkA,
  linkB,
];
