/**
 * The Phase 26c fixtures: pages that give the hreflang-and-sitemaps wave's
 * rules something to fire on in the end-to-end harness. Every fixture is
 * `exact: true` and starts from the control recipe, so a page carries one
 * defect (the hreflang pair carries one between them, on the English page).
 *
 * `social.image-insecure` has no page here: it needs an `https:` page, and the
 * fixture site is plain HTTP on 127.0.0.1 (see its `SKIP_HARNESS_CLAIMS`
 * paragraph in test/fixtures/harness.test.ts). `sitemap.oversized` has none
 * either: a 50 MB sitemap is out of proportion (same file, same list).
 */
import type { Fixture } from "../fixture.js";
import { SHARED_IMAGE_PATH } from "../assets.js";
import { article, selfUrl, serve } from "../render.js";

/**
 * Characters of padding behind each over-long reference on
 * `/p26c/reference-too-long`. Comfortably past `INDEXED_URL_MAX` (2,500) once the
 * path and the origin are in front of it, and nowhere near a header or body cap.
 */
export const P26C_OVERLONG_PADDING = 2_600;

/**
 * `url.reference-too-long`: one internal link and one image whose addresses are
 * too long to index. The crawl counts them on the page row and stores neither,
 * so nothing else on the site ever sees them: the link is not a `links` row or a
 * frontier URL, and the image is not a `resources` row. The image keeps its alt
 * and dimensions, so the image rules have nothing to say about it.
 */
const referenceTooLong: Fixture = {
  path: "/p26c/reference-too-long",
  category: "url",
  name: "A link and an image with addresses too long to index",
  expectedIssues: ["url.reference-too-long"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Search results whose links carry the whole session",
      metaDescription:
        "A results template that writes the visitor's entire session state into every address, so one link and one thumbnail run to thousands of characters.",
      bodyHtml:
        article({
          h1: "Addresses that grew past what can be indexed",
          lede: "A faceted search page serialises its filters and its session into the query string, and two of the addresses on this page are now longer than any index will hold.",
          withImage: false,
          sections: [
            {
              h2: "How an address gets this long",
              body: "Each filter a visitor applies is appended to the query string, and the template never removes one. After a long session the address of a single result carries every choice the visitor has made since arriving.",
            },
            {
              h2: "What happens to such an address",
              body: "Browsers cope with it, but search engines and most proxies give up well before ten thousand characters, and a crawler storing the address in an index has to refuse it outright.",
            },
            {
              h2: "Keeping addresses short",
              body: "Keep the session in a cookie or on the server, and let the address carry only what identifies the content. A result that can be shared should be reachable at an address a person could read aloud.",
            },
          ],
        }) +
        `\n<p><a href="/p26c/archive?session=${"s".repeat(P26C_OVERLONG_PADDING)}">The rest of the results</a></p>` +
        `\n<img src="${SHARED_IMAGE_PATH}?filters=${"f".repeat(P26C_OVERLONG_PADDING)}" alt="A thumbnail of the first result" width="720" height="360">`,
    })),
};

/**
 * `links.aria-label-only` from the two hint sources that are not an
 * `aria-label`: an icon link named only by its `title` attribute, and one named
 * only by the `<title>` inside its `<svg>`. Neither has a word of anchor text.
 * The targets are other p26c fixtures, so no link leaves the site, and each is a
 * different URL (only the first anchor per target is stored).
 */
const hintOnlyLinks: Fixture = {
  path: "/p26c/hint-only-links",
  category: "links",
  name: "Icon links named only by a title attribute and an svg title",
  expectedIssues: ["links.aria-label-only"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Toolbar icons that only a tooltip can name",
      metaDescription:
        "Two toolbar icons on this page carry no visible words: one is named by a tooltip attribute, the other by a title tucked inside its drawing.",
      bodyHtml:
        article({
          h1: "A toolbar with nothing written on it",
          lede: "The two icons below each lead to another page of the site, and the only names they have are a tooltip and a label inside the picture itself.",
          withImage: false,
          sections: [
            {
              h2: "Where an icon's name can hide",
              body: "Designers name icons in the places a mouse user sees them: a tooltip that appears on hover, or a title written into the vector drawing so an editor can tell the shapes apart.",
            },
            {
              h2: "Who reads those names",
              body: "Some screen readers announce a tooltip or a drawing's title when nothing better is offered. Search engines document neither as anchor text, so the link reaches its target carrying no words at all.",
            },
            {
              h2: "Giving the icon real words",
              body: "Put a short visible label beside the icon, or at least a visually hidden span inside the link, so every reader of the page gets the same name for where the link leads. The tooltip can stay; it simply stops being the only name the link has, and the drawing's title can go back to being a note for the designer.",
            },
          ],
        }) +
        `\n<p><a href="/p26c/reference-too-long" title="Session addresses example">` +
        `<svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16H0z"></path></svg></a> ` +
        `<a href="/p26c/sitemap-twice">` +
        `<svg width="16" height="16"><title>Listed twice example</title><path d="M0 0h16v16H0z"></path></svg></a></p>`,
    })),
};

/**
 * `sitemap.url-in-multiple`: a page `/sitemap.xml` lists as it lists every
 * fixture, and `/sitemap-extra.xml` lists twice. Two documents, so one finding,
 * with a count of two: the repeat inside the second document is one membership,
 * not a third listing (review focus 2).
 */
const sitemapTwice: Fixture = {
  path: "/p26c/sitemap-twice",
  category: "sitemap",
  name: "A page listed in two sitemaps, twice in the second",
  expectedIssues: ["sitemap.url-in-multiple"],
  exact: true,
  extraSitemapListings: 2,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "One product page that two sitemap plugins both list",
      metaDescription:
        "Two sitemap generators run on this site, and both of them publish this page: one in the main sitemap, and one twice over in a sitemap of its own.",
      bodyHtml: article({
        h1: "The page two generators both claim",
        lede: "A shop added a second sitemap plugin for its new catalogue without retiring the first, and the pages they have in common are now published twice.",
        withImage: false,
        sections: [
          {
            h2: "How the overlap happens",
            body: "The first plugin lists every published page. The second lists every catalogue page, and writes some of them once per category they belong to, so one address can appear several times in one file.",
          },
          {
            h2: "What it costs",
            body: "Search engines tolerate the repetition, but the two documents now disagree about which file owns which page, and a change of date or priority made in one of them is contradicted by the other.",
          },
          {
            h2: "Choosing one owner",
            body: "Give every address exactly one sitemap: split the files by section and have each generator write only its own section, or retire one of the plugins entirely. Then submit the remaining files again, so the search console stops reporting the old overlap as current.",
          },
        ],
      }),
    })),
};

/**
 * `hreflang.source-conflict`, a two-page cluster annotated three ways. Both
 * pages declare `en`, `de` and an `x-default` in their HTML, and
 * `/sitemap.xml`'s entries for them carry the same alternates as `xhtml:link`
 * (`Fixture.sitemapAlternates`): the HTML and the sitemap agree. The English
 * page ALSO sends a `Link` header that agrees on `en` and `de` and sends
 * `x-default` to the German page. One code, two targets, in two sources: the
 * conflict, on the English page only (the German page has one source that
 * disagrees with nothing).
 *
 * The conflict is on `x-default`, and both of its targets are healthy members
 * of the cluster that return each other, so the union a search engine reads
 * has no missing return link, no uncrawled target and no second code for
 * either page's own language. The source conflict is the one defect.
 */
const HEADER_EN = "/p26c/header-en";
const HEADER_DE = "/p26c/header-de";

const PAIR_ALTERNATES = [
  { hreflang: "en", path: HEADER_EN },
  { hreflang: "de", path: HEADER_DE },
  { hreflang: "x-default", path: HEADER_EN },
] as const;

function headerPair(
  path: string,
  htmlLang: string,
  copy: {
    title: string;
    description: string;
    h1: string;
    lede: string;
    sections: Array<{ h2: string; body: string }>;
  },
  expectedIssues: string[],
  name: string,
  linkHeader: boolean,
): Fixture {
  return {
    path,
    category: "hreflang",
    name,
    expectedIssues,
    exact: true,
    sitemapAlternates: PAIR_ALTERNATES,
    handler: (req, res) => {
      const self = selfUrl(req);
      const abs = (target: string): string => new URL(target, self).href;
      const header = linkHeader
        ? [
            ["en", HEADER_EN],
            ["de", HEADER_DE],
            // The conflict: the HTML and the sitemap send x-default to the
            // English page.
            ["x-default", HEADER_DE],
          ]
            .map(([code, target]) => `<${abs(target!)}>; rel="alternate"; hreflang="${code}"`)
            .join(", ")
        : undefined;
      serve(
        req,
        res,
        () => ({
          title: copy.title,
          metaDescription: copy.description,
          htmlLang,
          headExtra: PAIR_ALTERNATES.map(
            (a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${abs(a.path)}">`,
          ).join("\n"),
          bodyHtml: article({
            h1: copy.h1,
            lede: copy.lede,
            withImage: false,
            sections: copy.sections,
          }),
        }),
        header === undefined ? {} : { headers: { link: header } },
      );
    },
  };
}

const headerEn = headerPair(
  HEADER_EN,
  "en",
  {
    title: "Planning a cycling holiday along the river",
    description:
      "The English page of a pair whose HTML and sitemap agree on every language, while its Link header sends the x-default visitor somewhere else.",
    h1: "Cycling the river path in a week",
    lede: "The river path runs for four hundred kilometres with barely a hill, and a week is enough to ride it end to end at an easy pace.",
    sections: [
      {
        h2: "Choosing a direction",
        body: "Ride downstream with the prevailing wind behind you. The path is signposted in both directions, but the morning sun is kinder when it is at your back for the long eastern stretches.",
      },
      {
        h2: "Where to stay overnight",
        body: "Guest houses along the route take bicycles in for the night, and most will dry wet clothes. Book the riverside towns ahead in summer, when the path is busiest.",
      },
      {
        h2: "What to carry",
        body: "A puncture kit, a light rain jacket and a paper map are enough. Cafes and water taps appear every few kilometres, so there is no need to carry more than a day's food.",
      },
      {
        h2: "Getting back to the start",
        body: "Regional trains run beside most of the river and carry bicycles for a small supplement, so the return journey takes an afternoon rather than another week in the saddle.",
      },
    ],
  },
  ["hreflang.source-conflict"],
  "Hreflang pair, English page whose Link header sends x-default elsewhere",
  true,
);

const headerDe = headerPair(
  HEADER_DE,
  "de",
  {
    title: "Eine Radreise entlang des Flusses planen",
    description:
      "Die deutsche Seite des Paares. Ihr HTML und die Sitemap nennen dieselben Sprachversionen, und sie sendet keinen Link-Header mit Alternativen.",
    h1: "Den Flussradweg in einer Woche fahren",
    lede: "Der Flussradweg ist vierhundert Kilometer lang und fast eben, und eine Woche genügt, um ihn gemütlich von Anfang bis Ende zu fahren.",
    sections: [
      {
        h2: "Die Richtung wählen",
        body: "Fahren Sie flussabwärts, mit dem vorherrschenden Wind im Rücken. Der Weg ist in beide Richtungen ausgeschildert, doch die Morgensonne ist auf den langen östlichen Abschnitten angenehmer im Rücken.",
      },
      {
        h2: "Wo man übernachtet",
        body: "Die Gasthäuser entlang der Strecke stellen Fahrräder über Nacht unter, und die meisten trocknen nasse Kleidung. Im Sommer sollte man die Orte am Fluss im Voraus buchen.",
      },
      {
        h2: "Was man mitnimmt",
        body: "Flickzeug, eine leichte Regenjacke und eine Papierkarte reichen aus. Cafés und Wasserhähne gibt es alle paar Kilometer, also braucht man nicht mehr als den Proviant für einen Tag.",
      },
      {
        h2: "Zurück zum Ausgangspunkt",
        body: "Regionalzüge fahren fast überall am Fluss entlang und nehmen Fahrräder gegen einen kleinen Aufpreis mit, sodass die Rückreise einen Nachmittag dauert und nicht noch eine Woche im Sattel.",
      },
    ],
  },
  [],
  "Hreflang pair, German page with HTML and sitemap alternates only",
  false,
);

export const authoredP26cFixtures: Fixture[] = [
  referenceTooLong,
  hintOnlyLinks,
  sitemapTwice,
  headerEn,
  headerDe,
];
