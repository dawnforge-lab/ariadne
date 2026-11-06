/**
 * The Phase 26b fixtures: pages that give the parser-wave rules something to
 * fire on in the end-to-end harness. Added task by task; every fixture is
 * `exact: true` and starts from the control recipe (a complete, consistent
 * social set is `renderDocument`'s default), so a page carries one defect.
 */
import type { Fixture } from "../fixture.js";
import { SHARED_IMAGE_PATH } from "../assets.js";
import { article, serve } from "../render.js";

/**
 * Task 6: the social rules. Each page breaks one tag of the default set and
 * keeps the rest, so the one social rule it is for is the only finding.
 */
const ogIncomplete: Fixture = {
  path: "/p26b/og-incomplete",
  category: "social",
  name: "Open Graph set with no og:image",
  expectedIssues: ["social.og-incomplete"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A shared link that arrives without its picture",
      metaDescription:
        "This page writes its Open Graph title, type and address but leaves out the share image, so a platform has to guess which picture to show beside the link.",
      social: { image: undefined },
      bodyHtml: article({
        h1: "Sharing a page whose preview has no image",
        lede: "Open Graph tags decide how a link looks when someone posts it. This document declares three of the four that a complete preview needs and stops there.",
        withImage: false,
        sections: [
          {
            h2: "Which tag is absent",
            body: "The head carries a title, a type and a canonical address for sharing, and no image tag. Facebook, LinkedIn and most messaging apps then pick an image from the page by their own rules, or show none at all, which is rarely the picture an editor would choose.",
          },
          {
            h2: "Why a complete set matters",
            body: "A shared link with a strong image is clicked far more often than a bare line of text. Writing all four tags in the template, filled from each page's own content, keeps every shared address looking deliberate rather than accidental.",
          },
          {
            h2: "Putting it right",
            body: "Add the missing image tag to the page template with an absolute address, and fill it per page from the article's lead picture or a sensible section default.",
          },
        ],
      }),
    })),
};

const ogMultiple: Fixture = {
  path: "/p26b/og-multiple",
  category: "social",
  name: "Two og:title tags with different values",
  expectedIssues: ["social.og-multiple"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A page that names its share title twice",
      metaDescription:
        "Two plugins on this page each write an Open Graph title, and the two disagree, so every platform decides on its own which headline a shared link carries.",
      headExtra: '<meta property="og:title" content="A second, contradicting share headline">',
      bodyHtml: article({
        h1: "When two tools write one tag",
        lede: "Themes and plugins often both emit Open Graph markup. Here the second copy of the title says something the first one does not.",
        withImage: false,
        sections: [
          {
            h2: "The contradiction in the head",
            body: "The first og:title matches the document title. A later one, added by another component, carries different words. Nothing in the specification says which wins, so different networks resolve it differently and the preview varies by where the link is posted.",
          },
          {
            h2: "How it usually happens",
            body: "A content management system gains a social plugin while its theme already writes the same tags. Each produces a complete, valid block of markup on its own, and only reading the two of them side by side in the rendered source of a live page shows the conflict that a preview tool or a crawler reports.",
          },
          {
            h2: "Resolving it",
            body: "Turn off one of the two sources so that each Open Graph tag is written exactly once, and confirm the remaining title is the one editors expect to see when they paste the address into a post or a chat window.",
          },
        ],
      }),
    })),
};

const ogUrlMismatch: Fixture = {
  path: "/p26b/og-url-mismatch",
  category: "social",
  name: "og:url naming another address than the canonical",
  expectedIssues: ["social.og-url-mismatch"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, (self) => ({
      title: "A share address that points somewhere else",
      metaDescription:
        "The canonical tag on this page names the page itself, while its Open Graph address names a different URL, so shares are counted against the wrong page.",
      social: { url: `${new URL(self).origin}/p26b/og-url-elsewhere` },
      bodyHtml: article({
        h1: "Counting shares against the wrong address",
        lede: "Platforms aggregate likes and shares by the og:url a page declares. This one declares an address that is not its own canonical.",
        withImage: false,
        sections: [
          {
            h2: "Two addresses for one page",
            body: "Search engines are told, through the canonical link, that this URL is the page. Social networks are told, through og:url, that a different URL is. Engagement then accrues to an address nobody indexes, and the page itself looks unshared.",
          },
          {
            h2: "Where the mismatch comes from",
            body: "It is often a template that writes the site root, a staging hostname or an old slug into the share address while the canonical was corrected long ago.",
          },
          {
            h2: "Aligning them",
            body: "Write og:url from the same value as the canonical tag, so the address search engines index and the address social platforms count are always one.",
          },
          {
            h2: "Checking the result",
            body: "Paste the page into each network's sharing debugger after the change. The debugger shows which address it resolved, and a cached preview can be refreshed there so old counts and stale titles stop following the link around for weeks.",
          },
        ],
      }),
    })),
};

const xIncomplete: Fixture = {
  path: "/p26b/x-incomplete",
  category: "social",
  name: "twitter:card given as property= rather than name=",
  expectedIssues: ["social.x-incomplete"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "An X card tag written the Open Graph way",
      metaDescription:
        "The card type on this page is declared with a property attribute, which X does not read, so a link posted there falls back to a plain preview.",
      social: { xCard: undefined },
      headExtra: '<meta property="twitter:card" content="summary_large_image">',
      bodyHtml: article({
        h1: "A card declaration X cannot see",
        lede: "Open Graph uses property attributes and X uses name attributes. Copying the Open Graph pattern for the card type makes it invisible to the platform it was written for.",
        withImage: false,
        sections: [
          {
            h2: "The attribute that matters",
            body: "X looks for meta elements whose name begins with twitter. A tag carrying the same words in a property attribute is skipped, so the large image card this page asks for is never applied when someone shares it.",
          },
          {
            h2: "A common copy and paste slip",
            body: "Developers adding card markup next to an existing Open Graph block tend to repeat its attribute name. The markup looks consistent, validates as HTML, and quietly does nothing.",
          },
          {
            h2: "The correction",
            body: "Write every twitter tag with a name attribute, starting with the card type, and keep the property form for the Open Graph tags alone.",
          },
          {
            h2: "What a reader notices",
            body: "Without the card, a post carrying this link shows a small text snippet instead of the wide image the editor picked. Readers scrolling a busy timeline pass over it, and the page loses most of the visits a well formed card would have earned.",
          },
        ],
      }),
    })),
};

/** The one share title the two duplicate pages carry under different titles. */
const SHARED_OG_TITLE = "One share headline used by two different pages";

const ogDuplicateA: Fixture = {
  path: "/p26b/og-duplicate-a",
  category: "social",
  name: "og:title shared with another page (the group's first URL)",
  // The group lands on its lexically first member; its twin fires nothing.
  expectedIssues: ["social.og-duplicate"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Planning a spring vegetable garden from scratch",
      metaDescription:
        "How to choose a sunny plot, prepare the soil and pick early crops that tolerate the last cold nights of the season in a first vegetable garden.",
      social: { title: SHARED_OG_TITLE },
      bodyHtml: article({
        h1: "Planning a spring vegetable garden",
        lede: "A first vegetable bed succeeds or fails on site and soil long before any seed goes in. Start with light, drainage and a plan you can actually water.",
        withImage: false,
        sections: [
          {
            h2: "Choosing the plot",
            body: "Most vegetables want six hours of direct sun. Watch the garden through a full day, note where shadows from fences and trees fall, and mark the brightest strip that drains well after heavy rain.",
          },
          {
            h2: "Preparing the soil",
            body: "Clear turf and perennial weeds, loosen the ground to a spade's depth and work in well rotted compost. A soil that crumbles in the hand holds moisture without staying waterlogged.",
          },
          {
            h2: "Early crops",
            body: "Peas, radishes, lettuce and spinach tolerate cool nights and reward a beginner quickly. Sow little and often so the harvest arrives in a steady stream rather than all at once.",
          },
          {
            h2: "Watering and mulching",
            body: "Water deeply twice a week rather than lightly every evening, so roots grow down instead of along the surface. A layer of straw or shredded leaves keeps moisture in, smothers seedling weeds and feeds the soil as it breaks down over summer.",
          },
        ],
      }),
    })),
};

const ogDuplicateB: Fixture = {
  path: "/p26b/og-duplicate-b",
  category: "social",
  name: "og:title shared with another page (second member)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Servicing a road bicycle before the summer season",
      metaDescription:
        "A practical checklist for cleaning the drivetrain, checking brake pads and setting tyre pressure on a road bicycle after a winter in the shed.",
      social: { title: SHARED_OG_TITLE },
      bodyHtml: article({
        h1: "Servicing a road bicycle for summer",
        lede: "A bicycle left through the winter needs an hour of attention before long rides. Most of the work needs only a few tools and a clean rag.",
        withImage: false,
        sections: [
          {
            h2: "Cleaning the drivetrain",
            body: "Degrease the chain, cassette and chainrings, then dry them thoroughly. A worn chain stretches and wears the sprockets with it, so measure it with a gauge and replace it before it costs a cassette too.",
          },
          {
            h2: "Brakes and cables",
            body: "Look at the pad compound for glazing and for embedded grit, and check that cables move freely without fraying at the clamp bolts. Adjust the barrel so the lever bites well before reaching the bar.",
          },
          {
            h2: "Tyres and pressure",
            body: "Inspect the tread for cuts and the sidewalls for cracking. Pump to the pressure printed on the casing, adjusted for your weight, and check it again before every ride for the first week.",
          },
          {
            h2: "Bearings and bolts",
            body: "Spin each wheel and listen for grinding from the hubs, then rock the cranks sideways to feel for play in the bottom bracket. Finish by checking the stem, seat post and bottle cage bolts against the torque figures stamped beside them.",
          },
        ],
      }),
    })),
};

const ogImageRelative: Fixture = {
  path: "/p26b/og-image-relative",
  category: "social",
  name: "og:image given as a relative path",
  expectedIssues: ["social.image-broken"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A share image written as a relative path",
      metaDescription:
        "The image tag on this page points at a file by a path relative to the site, which platforms fetching the preview from elsewhere cannot resolve reliably.",
      social: { image: SHARED_IMAGE_PATH },
      bodyHtml: article({
        h1: "A preview image without a full address",
        lede: "A browser resolves a relative path against the page it is on. A social platform reading the tag is not on the page, and the specification asks for an absolute URL.",
        withImage: false,
        sections: [
          {
            h2: "What the tag says",
            body: "The og:image content here starts with a slash and names no scheme or host. Some crawlers resolve it against the shared address, others discard it, and the result depends on which network the link is posted to.",
          },
          {
            h2: "How it slips in",
            body: "Templates that build image paths for the page body reuse the same helper for the share image, and that helper returns a site-relative path because the browser never needed more.",
          },
          {
            h2: "Making it absolute",
            body: "Prefix the share image with the site's https origin in the template, so every platform receives one complete address it can fetch directly.",
          },
          {
            h2: "Testing a preview",
            body: "After the change, share the page privately or run it through a preview debugger. A full address that answers quickly with an image type is what each platform needs, and the debugger confirms the picture it will show before the link goes out.",
          },
        ],
      }),
    })),
};

export const authoredP26bFixtures: Fixture[] = [
  ogIncomplete,
  ogMultiple,
  ogUrlMismatch,
  xIncomplete,
  ogDuplicateA,
  ogDuplicateB,
  ogImageRelative,
];
