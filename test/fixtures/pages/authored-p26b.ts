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

/**
 * Task 7: headings, title and description. Each page is the control recipe
 * with one thing broken. Every h2 here is unique to its page except the pair
 * that shares one on purpose.
 */
const h2Missing: Fixture = {
  path: "/p26b/h2-missing",
  category: "on-page",
  name: "Article with an H1 and no H2 at all",
  expectedIssues: ["h2.missing"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Caring for a cast iron skillet through the years",
      metaDescription:
        "How to season, clean and store a cast iron skillet so the coating builds up with use and the pan lasts long enough to be handed down.",
      bodyHtml: [
        article({
          h1: "Caring for a cast iron skillet",
          lede: "A well kept skillet gets better with every meal. The coating that makes it nonstick is baked-on oil, and looking after it is mostly a matter of not undoing that work.",
          withImage: false,
          sections: [],
        }),
        "<p>After cooking, rinse the pan under hot water and scrub off any stuck food with a stiff brush or a little coarse salt. A drop of mild soap does no harm to a pan that has been seasoned properly, but long soaking does, because standing water lifts the coating and starts rust at the edges.</p>",
        "<p>Dry the skillet at once on a low burner until no moisture is left, then wipe a very thin film of neutral oil over the whole surface, inside and out. Too much oil turns tacky instead of hard, so rub it back until the pan looks barely damp, then let it cool before it goes away.</p>",
        "<p>Store it somewhere dry with a paper towel under the lid or between stacked pans, so air can move and nothing traps moisture against the iron. Acidic sauces and long simmers wear the coating thinner, and a pan that has started to look dull or grey simply wants another round of oil and heat in a hot oven.</p>",
      ].join("\n"),
    })),
};

const h2TooLong: Fixture = {
  path: "/p26b/h2-too-long",
  category: "on-page",
  name: "First H2 is a whole sentence of body copy",
  expectedIssues: ["h2.too-long"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Repotting a houseplant without shocking its roots",
      metaDescription:
        "When a houseplant has outgrown its pot, how to choose the next size, loosen the root ball and settle the plant back in without setting it back.",
      bodyHtml: article({
        h1: "Repotting a houseplant",
        lede: "Roots that circle the inside of a pot or push out of the drainage holes are asking for room. Spring, when growth is starting, is the kindest time to give it.",
        withImage: false,
        sections: [
          {
            h2: "When the roots have filled the pot completely and water runs straight through without soaking in at all",
            body: "Slide the plant out and look at the root ball. A tight mat of white roots wound round the edge means it is ready for a pot one size up, no more, since a pot that is far too big holds wet compost around roots that cannot yet use it.",
          },
          {
            h2: "Loosening the root ball",
            body: "Tease the outer roots apart with your fingers and trim any that are black or mushy. Set the plant at the same depth as before, fill round it with fresh compost and press down gently so there are no large air pockets left beneath the stem.",
          },
          {
            h2: "Settling it back in",
            body: "Water thoroughly once and let the pot drain, then keep it out of strong direct sun for a week. A little wilting is normal while the roots find the new compost, and feeding should wait until you see fresh growth.",
          },
        ],
      }),
    })),
};

/** The one first H2 the two duplicate pages share. */
const SHARED_H2 = "What to check before you begin";

const h2DuplicateA: Fixture = {
  path: "/p26b/h2-duplicate-a",
  category: "on-page",
  name: "First H2 shared with another page (the group's first URL)",
  // The group lands on its lexically first member; its twin fires nothing.
  expectedIssues: ["h2.duplicate"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Bleeding a hydronic radiator that stays cold at the top",
      metaDescription:
        "Why a radiator is warm at the bottom and cold at the top, and how to release the trapped air with a key so hot water fills the whole panel again.",
      bodyHtml: article({
        h1: "Bleeding a radiator",
        lede: "Air collects at the top of a radiator and keeps hot water from filling it. Letting it out takes a few minutes and a small brass key.",
        withImage: false,
        sections: [
          {
            h2: SHARED_H2,
            body: "Switch the heating on and wait until the pipes are hot, then find the radiators that stay cold near the top. Turn the heating off again before you open anything, because a running pump can pull more air in through the valve.",
          },
          {
            h2: "Releasing the air",
            body: "Hold a cloth under the valve, turn the key a quarter turn anticlockwise and listen for the hiss. When water starts to spit, close the valve firmly; do not force it past the point where it stops turning.",
          },
          {
            h2: "Topping up the pressure",
            body: "Bleeding lets pressure drop on a sealed system, so look at the boiler gauge afterwards and refill through the filling loop until it sits in the green band the manufacturer shows beside the dial.",
          },
        ],
      }),
    })),
};

const h2DuplicateB: Fixture = {
  path: "/p26b/h2-duplicate-b",
  category: "on-page",
  name: "First H2 shared with another page (second member)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Replacing a worn bicycle saddle with a better fitting one",
      metaDescription:
        "How to tell when a saddle is the cause of discomfort on long rides, measure your sit bones and fit and adjust a replacement at the right height.",
      bodyHtml: article({
        h1: "Replacing a bicycle saddle",
        lede: "Numbness and soreness on a long ride often come from a saddle that is the wrong width or tilt. A new one costs little and changes the whole ride.",
        withImage: false,
        sections: [
          {
            h2: SHARED_H2,
            body: "Measure the distance between your sit bones on a piece of corrugated card, because saddles come in widths that match it. Note your current height and tilt with a mark on the seat post before you loosen a single bolt.",
          },
          {
            h2: "Fitting the new saddle",
            body: "Clamp the rails at the same position as the old one and set the top flat with a spirit level. Tighten the bolts in small steps, alternating between them, to the torque stamped on the clamp.",
          },
          {
            h2: "Riding it in",
            body: "Give the saddle a few short rides before judging it, nudging the tilt a degree at a time. If pressure moves forward, tilt the nose up a touch; if you slide forward, tilt it down.",
          },
        ],
      }),
    })),
};

const titleMultiple: Fixture = {
  path: "/p26b/title-multiple",
  category: "on-page",
  name: "Two title elements in the head",
  expectedIssues: ["title.multiple"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Choosing a ladder for work at height around the house",
      metaDescription:
        "Which ladder type suits which job around a house, how to read the duty rating, and how to set one up safely on uneven ground before climbing.",
      headExtra: "<title>Ladders for work at height</title>",
      bodyHtml: article({
        h1: "Choosing a ladder",
        lede: "A ladder is the tool most often borrowed and least often checked. Picking the right one is mostly a matter of height, load and what it will stand on.",
        withImage: false,
        sections: [
          {
            h2: "Matching the type to the job",
            body: "A stepladder suits indoor work where you can stand and lean on the frame. An extension ladder reaches gutters and eaves, and needs to stand at a quarter of its working height out from the wall.",
          },
          {
            h2: "Reading the duty rating",
            body: "Look for the load figure printed on the stile and add the weight of your tools to your own. Trade grade ladders carry more and flex less, which matters most when you spend hours on one.",
          },
          {
            h2: "Setting it up on uneven ground",
            body: "Never pack a foot with bricks. Use a levelling foot or choose another way to reach the work, and tie the top to a fixed point where the ladder rests against the building.",
          },
        ],
      }),
    })),
};

const metaDescriptionMultiple: Fixture = {
  path: "/p26b/meta-description-multiple",
  category: "on-page",
  name: "Two meta description elements in the head",
  expectedIssues: ["meta-description.multiple"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Insulating a loft to cut heating bills this winter",
      metaDescription:
        "How much insulation a loft needs, which materials suit which roof, and how to lay it without blocking the ventilation that keeps the timbers dry.",
      headExtra:
        '<meta name="description" content="A second description written by a plugin that nobody turned off after the theme began writing its own.">',
      bodyHtml: article({
        h1: "Insulating a loft",
        lede: "A quarter of the heat in an uninsulated house escapes through the roof. Laying mineral wool between and across the joists is one of the cheapest fixes there is.",
        withImage: false,
        sections: [
          {
            h2: "How much is enough",
            body: "Aim for about 270 millimetres in total, laid in two layers. The first goes between the joists and the second across them, which covers the timber that would otherwise carry heat straight through.",
          },
          {
            h2: "Keeping the roof ventilated",
            body: "Leave a gap at the eaves so air can move up under the felt, and fit vents or baffles where the insulation meets the roof edge. A loft sealed tight grows damp and the rafters start to rot.",
          },
          {
            h2: "Pipes, wiring and the hatch",
            body: "Insulate above pipes but not under them, so the warmth from the house keeps them clear of frost. Lift cables clear of the wool to stop them overheating, and fit a seal and a layer of insulation to the hatch.",
          },
        ],
      }),
    })),
};

const titleSameAsH1: Fixture = {
  path: "/p26b/title-same-as-h1",
  category: "on-page",
  name: "Title repeats the H1 apart from case and spacing",
  expectedIssues: ["title.same-as-h1"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Choosing   A Lawn Mower For A Small Garden ",
      metaDescription:
        "What to weigh when buying a lawn mower for a small lawn: cutting width, power source, collection box and storage, with a note on what each costs.",
      bodyHtml: article({
        h1: "choosing a lawn mower for a small garden",
        lede: "A small lawn does not need a big machine. Weight, noise and where it lives in the shed matter more than horsepower.",
        withImage: false,
        sections: [
          {
            h2: "Cutting width and lawn size",
            body: "Under about a hundred square metres, a cutting width of thirty centimetres is plenty. A wider deck saves few passes and costs more in weight and storage space, and it struggles to turn at the edge of a border.",
          },
          {
            h2: "Power source",
            body: "Battery mowers start without fuss and are quiet enough for an early start. Corded ones never run flat but need care with the cable, and petrol suits large or rough lawns more than a courtyard.",
          },
          {
            h2: "Collection and storage",
            body: "A rear collection box gives a neat finish but must be emptied often. Look for a handle that folds flat and a body that stands upright on its end, so the machine fits behind a door.",
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
  h2Missing,
  h2TooLong,
  h2DuplicateA,
  h2DuplicateB,
  titleMultiple,
  metaDescriptionMultiple,
  titleSameAsH1,
];
