/**
 * The Phase 29b fixtures: what a real browser sees go wrong on a page (gate
 * clause 1).
 *
 * Every page here is `exact` and built from the control recipe (`healthyBody`,
 * test/fixtures/pages/authored-p3.ts), with one defect added. Three families:
 *
 *  - **The console** (CHECK-51). `/p29b/js-exception` throws after load,
 *    `/p29b/console-error` logs an error, and `/p29b/failing-script` asks for a
 *    same-origin script the server does not have. Each fires its own
 *    `render.*` rule and no other render rule: an uncaught exception is not a
 *    console message (the renderer reads `Runtime.consoleAPICalled` only), and
 *    neither is a failed request.
 *  - **The images** (CHECK-49). Five pages, each carrying ONE raster image and
 *    no other (`imageBody`, which leaves the shared SVG out), so the page's
 *    image counts are exactly that image's: a 4× file, a 1× file, a `srcset`
 *    whose chosen rendition was never fetched, a 4× file on the CDN, and a 4×
 *    file lazily loaded below the fold. The first, third and fourth fire
 *    `images.larger-than-displayed`; the 1× and the lazy one do not, which is
 *    the half of the clause that proves the rule can stay quiet. Every one of
 *    them is a file the resource pass fetched (it is in the markup) and read a
 *    size from (a real PNG header), because the renderer stands in only images
 *    whose size is stored.
 *  - **Accessibility** (CHECK-89). One page per rule of `A11Y_RULES`, at
 *    `/p29b/a11y/<axe-id>`, generated from the table so a rule added to the
 *    subset without a page fails here at import rather than passing unseen.
 *    Each page carries exactly one violation of its rule. Where the violation
 *    is also a defect an existing rule reports, that rule is in the page's
 *    expectations with a one-line reason (`alsoFires`).
 *
 * WHY NONE OF THESE PAGES HAS AN ANCHOR THAT BECOMES A LINK. The render pass
 * renders suspects and a three-page sample per page type (src/crawl/render/
 * select.ts), and on this site the suspicion that fires is "this page links
 * nowhere". A page here that stored a link would be rendered only if it were
 * among the first three of its template in URL order, and its rule would then
 * fire or not by alphabet. So the one page whose violation IS a link,
 * `/p29b/a11y/link-name`, uses a `mailto:` address: still `a[href]` to axe, never
 * a `links` row to the crawler. The harness asserts every page here was
 * rendered, so a page that slipped out of the selection fails by name.
 */
import { A11Y_RULES } from "../../../src/crawl/render/a11y.js";
import type { Fixture } from "../fixture.js";
import {
  assetHostRaster,
  P29B_IMAGE_PATHS,
  SHARED_IMAGE_PATH,
} from "../assets.js";
import { article, escapeHtml, serve, type PageSpec } from "../render.js";
import { healthyBody } from "./authored-p3.js";

const CONSOLE = "render-console";
const IMAGES = "render-images";
const A11Y = "accessibility";

/** The path of the one same-origin script the server does not have. */
export const P29B_MISSING_SCRIPT = "/p29b/missing.js";

// ---------------------------------------------------------------------------
// The console: render.js-exception, render.console-error, render.failed-request
// ---------------------------------------------------------------------------

const jsException: Fixture = {
  path: "/p29b/js-exception",
  category: CONSOLE,
  name: "A script that throws after the page has loaded",
  expectedIssues: ["render.js-exception"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Delivery estimate widget that throws on load",
      metaDescription:
        "A shipping page whose estimate script throws an uncaught error once the page has loaded, so the estimate never appears.",
      bodyHtml: healthyBody({
        h1: "Delivery times for the coastal routes",
        lede: "The estimate box on this page is filled by a script, and the script stops with an error before it writes anything.",
        what: "When the load event fires, a small script reads the postcode field and asks for a delivery window. It throws instead. The rest of the page is ordinary server-rendered text, so a crawler that never runs scripts sees nothing wrong here at all.",
        why: "An uncaught exception ends the script that raised it. Whatever that script was going to do after the failing line, such as filling a price, opening a menu or recording a sale, simply does not happen, and a visitor is given no sign that anything was supposed to be there.",
        fix: "Open the page with the developer console showing, find the line the error names and reproduce it. Guard the value that was missing rather than wrapping the whole block in a catch that hides the failure, then confirm the estimate renders on a clean load.",
        extra:
          '<script>window.addEventListener("load", function () { throw new Error("fixture: the delivery estimate has no postcode to read"); });</script>',
      }),
    })),
};

const consoleError: Fixture = {
  path: "/p29b/console-error",
  category: CONSOLE,
  name: "A script that logs an error to the console",
  expectedIssues: ["render.console-error"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Stock level panel that reports its own failure",
      metaDescription:
        "A product page whose stock panel cannot read its feed and says so in the browser console, at the error level, on every visit.",
      bodyHtml: healthyBody({
        h1: "Galley stock levels for this week",
        lede: "The stock panel on this page logs an error to the console when its feed comes back empty, and carries on without it.",
        what: "A script asks for the week's stock figures, finds nothing to show and writes an error message to the console. Nothing throws, so the page keeps working, but the panel that should list quantities is left blank for every visitor who opens it.",
        why: "Teams log errors precisely because something went wrong that they wanted to hear about. A message that appears on every page view is a fault that has been reported to nobody, since the only person who can see it is a visitor who happened to open the developer tools.",
        fix: "Treat a logged error as a defect report. Find the code that writes it, decide whether the condition is real, and either fix the feed or stop logging a state the page handles correctly. An error log that is always full trains people to ignore it.",
        extra:
          '<script>console.error("fixture: the stock feed answered with no rows");</script>',
      }),
    })),
};

const failingScript: Fixture = {
  path: "/p29b/failing-script",
  category: CONSOLE,
  name: "A same-origin script the server does not have",
  // The script is in the markup, so the resource pass asked for it too and got
  // the same 404 the browser did: `resources.broken` is the crawl's view of
  // the defect the render rule reports from the browser's.
  expectedIssues: ["render.failed-request", "resources.broken"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Booking form whose script file has gone missing",
      metaDescription:
        "A booking page that loads its form script from an address the server no longer serves, so the browser's request for it fails.",
      bodyHtml: healthyBody({
        h1: "Mooring bookings for the summer season",
        lede: "This page loads its booking script from its own server, and the server answers that request with a missing file.",
        what: "The page names a script on the same site in a script tag. The browser asks for it, the server has nothing at that address, and the booking form the script would have built never arrives. The text of the page is unaffected, which is why the gap is easy to miss.",
        why: "A deploy that renames bundled files without updating every template is the usual cause. Old pages keep pointing at the previous file name, a cache serves the new markup with the old references, and the feature quietly disappears from the pages nobody tested after the release.",
        fix: "Request the script address directly and confirm the status code. Point the tag at the file that exists, or publish the file it expects. Then add the page to whatever checks run after a deploy, so that a missing asset is noticed by a test and not by a customer.",
        extra: `<script src="${P29B_MISSING_SCRIPT}"></script>`,
      }),
    })),
};

// ---------------------------------------------------------------------------
// The images: images.larger-than-displayed
// ---------------------------------------------------------------------------

/**
 * The control recipe for an image page: the healthy outline and prose, WITHOUT
 * the shared SVG `article` adds (an SVG has no stored pixel size, so it would
 * be counted as `noDimensions` on the page and blur what the page's own image
 * measured), and with `image` at the end of the body.
 */
function imageBody(opts: {
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  image: string;
}): string {
  return `${article({
    h1: opts.h1,
    lede: opts.lede,
    withImage: false,
    sections: [
      { h2: "What this page does", body: opts.what },
      { h2: "Why it matters", body: opts.why },
      { h2: "How it gets fixed", body: opts.fix },
    ],
  })}\n${opts.image}`;
}

const imageFourX: Fixture = {
  path: "/p29b/image-4x",
  category: IMAGES,
  name: "An image four times wider than its box",
  expectedIssues: ["images.larger-than-displayed"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A harbour photo sent at four times its size",
      metaDescription:
        "A page that sends a 1600-pixel photograph to fill a 400-pixel space, so most of what the visitor downloads is never shown.",
      bodyHtml: imageBody({
        h1: "The harbour wall at low water",
        lede: "The photograph on this page is 1600 pixels wide, and the page shows it in a box 400 pixels wide.",
        what: "The image tag sets a display width of 400 pixels and the file behind it is four times that. The browser downloads every pixel of the original, then scales it down to fit, so three quarters of its width is thrown away on arrival.",
        why: "Oversized images are the commonest waste on a content page. They cost transfer on every visit, they slow the moment the largest element finishes painting, and on a phone connection they turn a quick article into a slow one, all for detail no screen at this size can show.",
        fix: "Export the photograph at the width it is shown at, doubled for dense screens if that matters, or publish several widths and let the browser choose through srcset and sizes. The original can stay in the media library for the pages that genuinely need it large.",
        image: `<img src="${P29B_IMAGE_PATHS.fourX}" alt="The harbour wall at low water, with weed on the lower stones" width="400" height="300">`,
      }),
    })),
};

const imageOneX: Fixture = {
  path: "/p29b/image-1x",
  category: IMAGES,
  name: "An image exactly the width of its box (control)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A slipway photo sent at the size it is shown",
      metaDescription:
        "A page whose 400-pixel photograph fills a 400-pixel box exactly, which is the case the oversized image check must leave alone.",
      bodyHtml: imageBody({
        h1: "The slipway beside the sailing club",
        lede: "The photograph on this page is 400 pixels wide and the page shows it 400 pixels wide, so nothing is wasted.",
        what: "This is the control for the oversized image pages beside it. The file was exported at the width of the box it fills, and the box keeps the proportions of the file, so the browser draws every pixel it receives and scales nothing up or down.",
        why: "A check that measures images against their boxes is only useful if it is quiet when the two agree. Without a page like this one, a rule that reported every image on the site would look exactly like a rule that worked, and nobody would know which they had.",
        fix: "Nothing needs fixing here. The page is kept so that the measurement can prove it reads a correctly sized image as correct, which is the half of the claim a fixture set made only of broken pages could never support on its own.",
        image: `<img src="${P29B_IMAGE_PATHS.oneX}" alt="The slipway beside the sailing club at half tide" width="400" height="300">`,
      }),
    })),
};

const imageSrcset: Fixture = {
  path: "/p29b/srcset",
  category: IMAGES,
  name: "A srcset whose chosen rendition is far wider than its box",
  expectedIssues: ["images.larger-than-displayed"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "Responsive image with a sizes value that misleads",
      metaDescription:
        "A page whose srcset tells the browser the image fills the viewport while CSS shows it 300 pixels wide, so the largest file is chosen.",
      bodyHtml: imageBody({
        h1: "Buoys stacked in the boatyard for winter",
        lede: "The image here offers two widths through srcset, and a sizes value that says it spans the whole screen.",
        what: "The srcset lists a 400-pixel and a 1600-pixel rendition, and sizes claims the image is as wide as the viewport. On a wide desktop window the browser believes that and picks the 1600-pixel file, then lays it out in a box only 300 pixels across.",
        why: "Responsive images only save bandwidth when sizes tells the truth about the layout. A template that copies a full-width sizes value onto a thumbnail makes every visitor on a large screen download the biggest rendition, which is the opposite of what the markup was written to achieve.",
        fix: "Set sizes to the width the image is actually shown at, at each breakpoint the layout has. Checking the rendition the browser chose, in the network panel or by reading currentSrc, is the quickest way to see whether the hint and the stylesheet still agree.",
        image:
          `<img src="${P29B_IMAGE_PATHS.srcset400}" ` +
          `srcset="${P29B_IMAGE_PATHS.srcset400} 400w, ${P29B_IMAGE_PATHS.srcset1600} 1600w" sizes="100vw" ` +
          `alt="Red and white buoys stacked against the boatyard fence" width="300" height="225">`,
      }),
    })),
};

const imageCdn: Fixture = {
  path: "/p29b/cdn-image",
  category: IMAGES,
  name: "A CDN image four times wider than its box",
  expectedIssues: ["images.larger-than-displayed"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A lighthouse photo from the CDN at four times size",
      metaDescription:
        "A page that loads a 1600-pixel photograph from a separate image host to fill a 400-pixel box, which the render measures all the same.",
      bodyHtml: imageBody({
        h1: "The lighthouse on the outer breakwater",
        lede: "This page takes its photograph from an image host on another domain, and the file is four times the width it is shown at.",
        what: "The image tag points at a content delivery network rather than at this site. The file there is 1600 pixels wide and the page displays it at 400. Serving it from a faster host does not change how many of those pixels the visitor actually needed.",
        why: "Moving images to a CDN is often treated as the whole of image performance. It shortens the distance the bytes travel and leaves their number unchanged, so a page can be fast to start and still slow to finish because each photograph is far larger than its slot.",
        fix: "Most image hosts resize on request: ask for the width the layout shows, through a query parameter or a named transformation, and list a few widths in srcset. If the host cannot resize, export smaller copies before uploading, exactly as for files served from the site itself.",
        image: `<img src="${escapeHtml(assetHostRaster())}" alt="The lighthouse on the outer breakwater in morning light" width="400" height="300">`,
      }),
    })),
};

const imageLazy: Fixture = {
  path: "/p29b/lazy",
  category: IMAGES,
  name: "A lazy image far below the fold (not measured, not fired)",
  expectedIssues: [],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A long page with one lazy photograph at the end",
      metaDescription:
        "A page whose only image loads lazily, five thousand pixels down, so a renderer that does not scroll never asks for it.",
      bodyHtml: imageBody({
        h1: "Notes from the estuary survey walk",
        lede: "The single photograph on this page is marked to load lazily and sits a long way below the first screen.",
        what: "The image is oversized for its box, like the photographs on the pages beside this one, but it is set to load only when a visitor scrolls near it, and it starts five thousand pixels down. The render opens the page at one fixed window and never scrolls.",
        why: "An image the browser never asked for has no size to compare, so nothing can be said about whether it is too large. Counting it as unmeasured, rather than as fine, is what keeps the share of measured images an honest statement about how much of the page was actually judged.",
        fix: "Nothing on this page is reported, and that is the intended reading: the photograph was not judged at all. Check lazily loaded images by scrolling to them in a browser, or by reading the file widths from the image host, before calling a long page clean.",
        image: `<img src="${P29B_IMAGE_PATHS.lazy}" alt="Mud flats and a channel marker at the end of the survey walk" width="400" height="300" loading="lazy" style="display:block;margin-top:5000px">`,
      }),
    })),
};

/** The five image pages, exported so the harness can sum their measurement. */
export const P29B_IMAGE_PAGE_PATHS = [
  imageFourX.path,
  imageOneX.path,
  imageSrcset.path,
  imageCdn.path,
  imageLazy.path,
] as const;

// ---------------------------------------------------------------------------
// Accessibility: one page per rule of A11Y_RULES
// ---------------------------------------------------------------------------

/** A small inline icon, hidden from assistive technology as icons should be. */
const ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 2h12v12H2z"></path></svg>';

interface A11yPage {
  title?: string;
  metaDescription: string;
  h1: string;
  lede: string;
  what: string;
  why: string;
  fix: string;
  /** The one violation, appended after the article. */
  violation?: string;
  /** Head-level overrides for the violations that live in the head or on `<html>`. */
  spec?: Partial<Pick<PageSpec, "htmlLang" | "viewport" | "headExtra" | "social">>;
  /** Existing rules the violation necessarily trips, each with its reason beside it. */
  alsoFires?: string[];
}

const A11Y_PAGES: Record<string, A11yPage> = {
  "image-alt": {
    title: "A chart of tide heights with no text alternative",
    metaDescription:
      "A page whose tide chart image carries no alt attribute at all, so a screen reader announces the file name or nothing.",
    h1: "Tide heights through a spring cycle",
    lede: "The chart at the foot of this page is an image element with no alt attribute, which leaves it unnamed.",
    what: "Every other image on the page describes itself. The tide chart was added later, by a template that writes the source, the width and the height and never the alt attribute, so assistive technology has nothing to announce when it reaches the chart.",
    why: "A missing alt attribute is not the same as an empty one. Empty says the image is decoration and may be skipped. Missing says nothing, so many screen readers fall back to reading the file name aloud, which is noise at best and a meaningless string of digits at worst.",
    fix: "Write alt text that says what the chart shows, in a sentence, such as the range of heights over the cycle. If an image really is decorative, give it an empty alt attribute on purpose, so that the choice is visible in the markup and not left to chance.",
    violation: `<img src="${SHARED_IMAGE_PATH}" width="720" height="360">`,
    // An img with no alt attribute is the crawl's own missing-alt finding too.
    alsoFires: ["images.missing-alt"],
  },
  "input-image-alt": {
    title: "An image submit button that has no name",
    metaDescription:
      "A search form whose submit control is an image input with no alt text, so its purpose is never announced to anyone.",
    h1: "Search the chandlery catalogue",
    lede: "The search box on this page is submitted by an image button, and that button carries no text alternative.",
    what: "The form uses an input of type image as its submit control, showing a small magnifying glass. The input has a source and a size and no alt attribute, so the control is focusable and works with a mouse, but it has no name to announce.",
    why: "An image input is a button, and a button needs a name. Without one, a keyboard user hears only that a button exists, and voice control software has no word to listen for, so the commonest action on a catalogue page is the hardest one to reach.",
    fix: "Give the image input an alt attribute naming the action, such as Search, not describing the picture. If the design allows, use a real button element containing the icon and a visually hidden label, which is easier to style and to keep accessible.",
    violation: `<input type="image" src="${SHARED_IMAGE_PATH}" width="48" height="24">`,
  },
  "role-img-alt": {
    title: "A rating graphic built from a div with no name",
    metaDescription:
      "A product page whose star rating is drawn by CSS on an element with role img and no label, so the rating is invisible to screen readers.",
    h1: "Customer rating for the folding galley stove",
    lede: "The rating on this page is a styled element declared as an image, and nothing gives that image a name.",
    what: "A designer drew the stars with a background on an empty span and added role img so the graphic would be treated as one picture. The span has no aria-label, no labelled-by reference and no title, so the picture it declares has no description at all.",
    why: "Declaring an element as an image makes assistive technology treat it as one and stop looking inside it. If the image then has no name, the information it carries, here the rating out of five, simply disappears for anyone who is not looking at the screen.",
    fix: "Add an aria-label stating what the graphic shows, such as Rated four out of five. If the same figure already appears as text next to the graphic, mark the graphic as presentational instead, so it is skipped and the visible text does the work.",
    violation:
      '<span role="img" style="display:inline-block;width:80px;height:16px;background:#336"></span>',
  },
  "area-alt": {
    title: "A clickable harbour map whose hotspots are unnamed",
    metaDescription:
      "A page with an image map of the harbour whose area links have no alt text, so each hotspot is an unnamed link to a keyboard user.",
    h1: "Pontoon map for visiting yachts",
    lede: "The harbour map on this page is an image map, and its clickable area carries no text alternative.",
    what: "The map image itself is described, but the region drawn over the visitor pontoon is an area element with a link and no alt attribute. A mouse user sees the pontoon and clicks it; a keyboard user tabs to a link that has no name to read out.",
    why: "Image maps are old markup that still turns up in harbour plans, campus maps and floor plans. Each area is a link in its own right, and a link without a name gives a screen reader user a list of identical, meaningless stops with no way to tell them apart.",
    fix: "Give every area element an alt attribute naming its destination, such as Visitor pontoon. Better still, replace the image map with a described image and a plain list of links, which works at every screen size and needs no coordinates kept in step with the picture.",
    violation:
      `<img src="${SHARED_IMAGE_PATH}" alt="A plan of the harbour with the visitor pontoon on the east side" width="720" height="360" usemap="#harbour">` +
      '<map name="harbour"><area shape="rect" coords="360,0,720,360" href="/control"></map>',
  },
  "object-alt": {
    title: "An embedded route diagram with no text alternative",
    metaDescription:
      "A page that embeds a passage diagram through an object element and gives it no label, so the embedded content is unnamed.",
    h1: "Passage plan from the river mouth",
    lede: "The diagram on this page is embedded with an object element, and the object has neither a label nor fallback text.",
    what: "An object element loads a vector drawing of the passage. It has a data address and a type, and no aria-label, no title and no content between its tags, so there is nothing for assistive technology to announce when the embedded drawing is reached.",
    why: "Embedded content is opaque to the page around it. Unless the object itself carries a name, a screen reader user learns only that something is embedded, not that it is the route they came to read about, and the plan the page exists to publish is lost to them.",
    fix: "Add an aria-label or a title to the object describing the drawing, and consider writing the passage out as a short list of waypoints beside it. If the drawing is an image in all but name, an image element with alt text is simpler and better supported.",
    violation: `<object data="${SHARED_IMAGE_PATH}" type="image/svg+xml" width="720" height="360"></object>`,
  },
  "link-name": {
    title: "An email link drawn as an icon with no name",
    metaDescription:
      "A contact page whose email link contains only a hidden icon, so the link has no accessible name for screen readers or voice control.",
    h1: "Contacting the harbour office",
    lede: "The email link at the foot of this page shows an envelope icon and contains no text, label or title.",
    what: "The link opens a new message to the harbour office. Its only content is a small icon marked as hidden from assistive technology, which is correct for the icon, but nothing else names the link, so it is announced as a bare link with no purpose.",
    why: "Icon-only links are everywhere in headers and footers, and they are one of the commonest accessibility defects found in audits. A visitor relying on speech hears a link and nothing more, and a voice control user cannot say the name of a link that does not have one.",
    fix: "Give the link an aria-label such as Email the harbour office, or add visually hidden text inside it. Keep the icon hidden from assistive technology, as it is here, so that the name is read once and the decoration is not described on top of it.",
    violation: `<p><a href="mailto:office@harbour-fixture.example">${ICON}</a></p>`,
  },
  "button-name": {
    title: "A close button drawn as an icon with no name",
    metaDescription:
      "A page whose notice panel has a close button containing only a hidden icon, so the button has no accessible name to announce.",
    h1: "Weekend berthing notice for visitors",
    lede: "The notice on this page can be dismissed with a button, and that button contains an icon and nothing else.",
    what: "The button that closes the notice holds a small cross drawn in SVG and hidden from assistive technology. It has no text, no aria-label and no title, so the control works for a mouse and is announced to everyone else as a button with no name.",
    why: "A button without a name is a control whose purpose has to be guessed. On a page with several of them, such as close, next and play, a keyboard user hears the same empty announcement for each and has to try them one by one to find out what they do.",
    fix: "Add an aria-label naming the action, such as Close notice, or put visually hidden text inside the button. Keep the icon hidden from assistive technology so the name is not read twice, and check the result with a screen reader before shipping the component.",
    violation: `<p><button type="button">${ICON}</button></p>`,
  },
  "input-button-name": {
    title: "A styled input button that carries no label",
    metaDescription:
      "A page with an input of type button whose value is empty, drawn by CSS, so the control has no name for assistive technology.",
    h1: "Printable tide tables for the month",
    lede: "The print control on this page is an input of type button with an empty value and an icon drawn by the stylesheet.",
    what: "The control is an input element of type button. Its value attribute, which is where an input button takes its visible label from, is empty, and the printer icon is painted by CSS as a background, so the button has nothing that names it.",
    why: "Input buttons get their name from their value. A designer who prefers an icon empties the value and paints the icon instead, which looks right and leaves the control silent to screen readers and invisible to voice control, which listens for a spoken label.",
    fix: "Put the action in the value, such as Print tide tables, and style the text if needed, or add an aria-label. A button element with an icon and hidden text gives more freedom for styling and is the better choice for new markup.",
    violation:
      '<p><input type="button" value="" style="width:32px;height:32px;background:#ddd;border:1px solid #888"></p>',
  },
  "select-name": {
    title: "A size chooser that no label describes",
    metaDescription:
      "A product page whose size select menu has no label element, aria-label or title, so its purpose is never announced.",
    h1: "Choosing a size for the sailing smock",
    lede: "The size menu on this page is a select element with options and no label of any kind attached to it.",
    what: "The select offers four sizes. A heading above the form says Size, but it is not a label element and is not connected to the select, so assistive technology reaches a menu of letters with nothing explaining what the letters choose.",
    why: "Form controls are named by their labels. Text that merely sits near a control is a visual hint and nothing more, so a screen reader user moving through the form hears a combo box with a current value of S and has to guess from the options what is being chosen.",
    fix: "Wrap the text in a label element whose for attribute names the select, or give the select an aria-label. A visible label is better than a hidden one, because it also gives everyone a larger area to click and helps people using magnification.",
    violation:
      '<p><select name="size"><option>S</option><option>M</option><option>L</option><option>XL</option></select></p>',
  },
  label: {
    title: "A postcode field that nothing labels",
    metaDescription:
      "A delivery page whose postcode field is a text input with no label, aria-label, title or placeholder, so it is announced unnamed.",
    h1: "Checking delivery to your postcode",
    lede: "The postcode field on this page is a bare text input, and nothing in the markup tells anyone what to type into it.",
    what: "A text input waits for a postcode under a paragraph that explains delivery. The paragraph is not a label and is not linked to the field, and the field has no aria-label, no title and no placeholder, so it is announced simply as an edit box.",
    why: "An unlabelled field is a guessing game for anyone who cannot see the layout around it. It also breaks autofill heuristics and voice control, and it means a click on the explanatory text does nothing, which makes the field a smaller target than it should be.",
    fix: "Add a visible label element connected to the input through its for and id attributes, and give the input a name and an autocomplete value of postal-code. A placeholder alone is not a label, since it disappears as soon as anybody starts typing.",
    violation: '<p><input type="text" name="postcode"></p>',
  },
  "frame-title": {
    title: "An embedded opening hours frame with no title",
    metaDescription:
      "A page that embeds its opening hours in an inline frame with no title attribute, so the frame is announced without a purpose.",
    h1: "Opening hours at the fuel berth",
    lede: "The hours on this page are shown inside an inline frame, and the frame carries no title saying what it holds.",
    what: "An iframe holds a small document with the fuel berth's opening hours, written inline through srcdoc so it needs no request of its own. The frame has no title attribute and no label, so a screen reader announces a frame and leaves the visitor to explore it blind.",
    why: "Frames are separate documents, and assistive technology lists them so people can jump between them. A list of frames without titles is a list of identical entries, and on a page with a map, a video and a booking widget, the visitor cannot tell which frame is which.",
    fix: "Give every iframe a short title describing its content, such as Fuel berth opening hours. If the embedded content is simple text, as it is here, consider putting it in the page itself, where it is easier to style, translate and index.",
    violation:
      '<p><iframe srcdoc="&lt;p&gt;Fuel berth: 07:00 to 19:00 daily&lt;/p&gt;" width="320" height="60"></iframe></p>',
  },
  "document-title": {
    metaDescription:
      "A page served with no title element, so the browser tab, the history list and screen readers all have no name to show for it.",
    h1: "Winter storage rates for dinghies",
    lede: "This page has everything a page needs except a title element in its head, which is where its name comes from.",
    what: "The head carries a description, a canonical and the sharing tags, which still name the page, and no title. Browsers fall back to the address in the tab, and a screen reader opening the page announces no name before it starts reading the content.",
    why: "The title is the first thing announced when a page loads and the label used in tabs, bookmarks and the history list. Without it, someone switching between several open pages has no way to tell which one is which, short of reading each of them again.",
    fix: "Write a title for every page that names its subject, unique across the site, with the most specific words first. Check the template that serves this kind of page, because a missing title is almost always a template that never received a value.",
    // No title element is the crawl's own missing-title finding as well. The
    // sharing tags keep a title of their own, so no social rule joins in.
    alsoFires: ["title.missing"],
    spec: { social: { title: "Winter storage rates for dinghies at the yard" } },
  },
  "html-has-lang": {
    title: "A page that does not say what language it is in",
    metaDescription:
      "A page whose html element carries an empty lang attribute, so screen readers must guess which language to read it in.",
    h1: "Notes on reading the almanac",
    lede: "The html element of this page has a lang attribute with nothing in it, which is the same as not declaring a language.",
    what: "The page is written in English, and its root element has an empty language attribute where the code should be. Nothing else on the page declares a language either, so software reading it aloud has to rely on its own default, which may not be English at all.",
    why: "Screen readers choose a voice and pronunciation rules from the page language. A visitor whose reader defaults to another language hears English words spoken with the wrong sounds, which is hard to follow. Translation tools and spelling checkers make the same guess.",
    fix: "Set the lang attribute on the html element to the language of the content, here en, or a regional form such as en-GB. Fix it in the base template so every page inherits the value, and mark passages in other languages with their own lang attributes.",
    spec: { htmlLang: "" },
  },
  "html-lang-valid": {
    title: "A page whose language code is not a language",
    metaDescription:
      "A page whose html lang attribute holds the word english rather than a language code, so the declaration is ignored as invalid.",
    h1: "Reading a tidal stream atlas",
    lede: "The html element of this page declares a language, but the value it uses is a word and not a valid language code.",
    what: "A template author wrote the language out in full as english instead of the code en. The attribute is present, so a quick check passes, but the value matches no language tag, and software that reads it has to discard it and guess.",
    why: "Language tags follow a standard so that every tool reads them alike. A value outside it is treated as missing, with the same result: the wrong voice in a screen reader, the wrong hyphenation and quotation rules, and translation offered for a page already in the reader's language.",
    fix: "Use the code from the standard, en for English or en-GB for British English. Check any setting in the content system that feeds the attribute, because an invalid value usually comes from a free text field that someone filled in with the language's name.",
    spec: { htmlLang: "english" },
  },
  "valid-lang": {
    title: "A quotation marked with a language that does not exist",
    metaDescription:
      "A page with a quoted motto whose lang attribute holds a made-up code, so the passage cannot be read in the intended language.",
    h1: "The yacht club motto and where it comes from",
    lede: "The motto quoted on this page is marked with a lang attribute, and the code in it does not name a real language.",
    what: "The page is correctly declared as English. The Latin motto inside it carries a lang attribute meant to switch languages for that one line, but the value is latin, written out, rather than the code la, so the switch does not happen.",
    why: "Marking a passage in another language lets a screen reader change voice for it, so a quotation is pronounced as the language it is written in. With an invalid code the reader stays in English and the motto comes out as a string of oddly pronounced syllables.",
    fix: "Use the standard code for the passage, la for Latin, on the element that wraps it. When a content editor offers a language picker for quotations, make it write codes from a fixed list rather than whatever a person types in.",
    violation: '<p><q lang="latin">Fluctuat nec mergitur</q>, as the club has it.</p>',
  },
  "meta-viewport": {
    title: "A mobile page that forbids zooming in",
    metaDescription:
      "A page whose viewport meta tag caps the zoom at its starting scale, so visitors on phones cannot enlarge text they cannot read.",
    h1: "Fuel and water prices on the quay",
    lede: "This page sets a maximum scale of one in its viewport tag, which stops visitors on phones from zooming in.",
    what: "The viewport tag sets the page width to the device width, which is right, and then adds a maximum scale equal to the starting scale. On most phones that disables pinch to zoom entirely, so the text stays at whatever size the stylesheet chose.",
    why: "People with low vision rely on zoom to read pages on small screens. Blocking it was once used to stop layouts jumping on double tap, a problem browsers solved long ago, so the restriction now costs readers a basic tool and buys nothing in return.",
    fix: "Remove the maximum scale and any user scalable setting from the viewport tag, leaving the width and the initial scale. Then check the layout at two and four times zoom, and fix any part of it that breaks, instead of preventing anyone from zooming in.",
    spec: {
      viewport: false,
      headExtra: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    },
  },
  "meta-refresh": {
    title: "A results page that reloads itself every ten minutes",
    metaDescription:
      "A page with a timed meta refresh that reloads it every ten minutes, interrupting anyone still reading or filling in a form.",
    h1: "Race results from the evening series",
    lede: "This page reloads itself on a timer set in a meta refresh tag, with no way for a visitor to stop it.",
    what: "A meta refresh in the head reloads the page after six hundred seconds, so the results stay current while the racing is on. It names no other address, so it is a reload and not a redirect, and it runs whether or not the visitor has finished reading.",
    why: "A page that reloads on its own moves a screen reader back to the top, loses a visitor's place in a long table and can wipe a half-completed form. People who read slowly, or who use assistive technology, are the ones most likely to still be reading when it fires.",
    fix: "Update the results with a script that changes only the table and announces new rows politely, or offer a button that refreshes on request. If the page must reload, let visitors turn the timer off, and give them generous warning before it happens.",
    // A reload timer, not a redirect: `redirect.meta-refresh` reports a refresh
    // that sends the browser elsewhere and is silent on one with no address.
    spec: { headExtra: '<meta http-equiv="refresh" content="600">' },
  },
  "aria-hidden-focus": {
    title: "A hidden panel that keeps a focusable button",
    metaDescription:
      "A page with a panel hidden from assistive technology that still contains a button the keyboard can reach, so focus lands on nothing.",
    h1: "Tide alerts for the outer moorings",
    lede: "The alert panel on this page is hidden from assistive technology, and the button inside it can still be reached with the keyboard.",
    what: "The panel was closed by setting aria-hidden to true on its container, which hides it from screen readers. The button inside it was left as it was, so pressing tab moves focus onto a control that assistive technology says does not exist.",
    why: "A keyboard user who tabs onto a hidden control hears nothing, or hears a stale label, and cannot tell where focus has gone. It is a common side effect of dialogs and menus that hide themselves with aria-hidden and never take their own controls out of the tab order.",
    fix: "Hide closed panels with the hidden attribute or display none, which removes their content from both the accessibility tree and the tab order. If the panel must stay rendered, mark it inert as well, so its controls cannot take focus while it is closed.",
    violation:
      '<div aria-hidden="true"><p>High water warning in effect.</p><button type="button">Dismiss the tide alert</button></div>',
  },
  "aria-required-attr": {
    title: "A custom checkbox that never states if it is checked",
    metaDescription:
      "A page with a div given the checkbox role and no aria-checked attribute, so assistive technology cannot report its state.",
    h1: "Signing up for the tide table mailing",
    lede: "The opt-in on this page is a custom checkbox built from a div, and it never says whether it is ticked or not.",
    what: "A div carries the checkbox role and is focusable, so it is announced as a checkbox. The aria-checked attribute, which every checkbox must carry, is missing, so the control has a role and a name but no state for anyone relying on the announcement.",
    why: "A role is a promise about behaviour. Calling something a checkbox tells assistive technology to expect a checked state and report it, and when the state is absent the visitor cannot find out whether they have agreed to receive the mailing or not.",
    fix: "Use a real input of type checkbox with a label, which carries its state for free. If the custom control must stay, set aria-checked to true or false and update it in the same script that changes its appearance, so the two can never drift apart.",
    violation:
      '<p><span role="checkbox" tabindex="0">Send me the monthly tide tables</span></p>',
  },
  "aria-valid-attr": {
    title: "A search button with a misspelt ARIA attribute",
    metaDescription:
      "A page whose search button carries aria-lable, a misspelling that no browser recognises, so the intended label is ignored.",
    h1: "Searching the club's race archive",
    lede: "The search button on this page carries an attribute that looks like ARIA and is spelt in a way ARIA does not define.",
    what: "Someone meant to add aria-label to the search button and typed aria-lable instead. The browser keeps the attribute but gives it no meaning, so the button is named only by its own text and the label the author wanted is silently dropped.",
    why: "ARIA attributes are matched by exact name, and a typo turns one into dead weight that no validator in the browser complains about. Here the visible text happens to cover the gap, but the same slip on an icon button would leave a control with no name at all.",
    fix: "Correct the spelling to aria-label, and run an accessibility check as part of the build so misspelt attributes are caught before release. Prefer visible text over ARIA where it will do, because visible text cannot be misspelt invisibly.",
    violation: '<p><button type="button" aria-lable="Search the race archive">Search</button></p>',
  },
  "aria-valid-attr-value": {
    title: "A menu button whose expanded state is not a value",
    metaDescription:
      "A page whose menu button sets aria-expanded to open, a value ARIA does not allow, so its state cannot be reported to anyone.",
    h1: "The club calendar menu",
    lede: "The menu button on this page sets its aria-expanded attribute to a word that is not one of the values that attribute accepts.",
    what: "A script toggles the button between open and closed by writing those words into aria-expanded. The attribute accepts only true or false, so assistive technology cannot read the state, and the menu's position is never announced to anyone using it.",
    why: "State attributes exist so that a visitor who cannot see a menu can still learn whether it is showing. An invalid value is treated as if the attribute were missing, which means the control looks finished in the markup and tells a screen reader nothing at all.",
    fix: "Write true when the menu is shown and false when it is hidden, from the same code that shows and hides it. Keep a short list of the values each ARIA attribute accepts near the component library, since the wrong word is an easy and invisible mistake.",
    violation: '<p><button type="button" aria-expanded="open">Calendar</button></p>',
  },
  list: {
    title: "A kit list that contains something other than items",
    metaDescription:
      "A page whose unordered list holds a paragraph beside its list items, so the list structure is broken for assistive technology.",
    h1: "What to bring on the first sailing lesson",
    lede: "The kit list on this page is an unordered list, and one of its children is a paragraph instead of a list item.",
    what: "The list begins with proper list items for a waterproof jacket and soft shoes. A note about sun cream was pasted in as a paragraph directly inside the list, which a list may not contain, so the structure that assistive technology relies on is broken.",
    why: "Screen readers announce a list with its number of items and let visitors move through it item by item. Content that is not an item breaks the count and can be skipped or read out of place, and it often signals a content editor fighting the template.",
    fix: "Put the note inside a list item of its own, or move it out of the list and place it before or after it. Content editors that allow arbitrary blocks inside lists should restrict list children to items, so that this cannot happen by accident.",
    violation:
      '<ul><li>A waterproof jacket</li><li>Soft-soled shoes</li><p>Sun cream, even when it is cloudy.</p></ul>',
  },
  listitem: {
    title: "A list item that belongs to no list at all",
    metaDescription:
      "A page with a list item placed directly inside a div, outside any list, so it is not announced as part of one.",
    h1: "Safety briefing before launching",
    lede: "The safety point at the end of this page is marked up as a list item, but it sits outside any list.",
    what: "A safety reminder was written as a list item and placed straight inside a div, perhaps after the list around it was removed in an edit. A list item only means something inside a list, so this one is announced as nothing in particular.",
    why: "Structure is what lets a screen reader user skim. A list item outside a list gives no count and no grouping, and the markup reads as tidy to whoever wrote it, so nobody notices until an audit or a complaint from a visitor who relies on that structure.",
    fix: "Wrap the item in an unordered or ordered list, or turn it into a paragraph if it was never meant to be part of one. Checking rendered structure with an accessibility tool after content edits catches orphaned items before they are published.",
    violation: '<div><li>Check that the bung is in before you launch the dinghy.</li></div>',
  },
  "color-contrast": {
    title: "Fine print set in a grey that is too light to read",
    metaDescription:
      "A page whose terms paragraph is light grey on white, well below the contrast ratio normal body text needs to stay legible.",
    h1: "Terms for hiring a club dinghy",
    lede: "The terms on this page are printed in a very light grey on a white background, below the contrast text needs.",
    what: "The hire terms use a pale grey, chosen to make them look less prominent than the main text. The contrast between that grey and the white page is under two to one, a long way below the four and a half to one that normal sized text requires.",
    why: "Low contrast text is hard to read for people with low vision, for older readers and for everyone on a phone outdoors. Making fine print faint does not make it less binding, it only makes it harder for the people who agree to it to read what they agreed to.",
    fix: "Darken the text until it reaches at least four and a half to one against its background, which a contrast checker confirms in seconds. Use size and position, not a faint colour, to show that a passage matters less than the text around it.",
    violation:
      '<p style="color:#c8c8c8">Boats are hired for the session booked and must be returned to the pontoon by the time shown on the hire slip.</p>',
  },
};

/** One accessibility page, from its rule's row and its copy. */
function a11yFixture(axeId: string, page: A11yPage): Fixture {
  return {
    path: `/p29b/a11y/${axeId}`,
    category: A11Y,
    name: `Accessibility: one violation of ${axeId}`,
    expectedIssues: [`a11y.${axeId}`, ...(page.alsoFires ?? [])],
    exact: true,
    handler: (req, res) =>
      serve(req, res, () => ({
        ...(page.title === undefined ? {} : { title: page.title }),
        metaDescription: page.metaDescription,
        ...page.spec,
        bodyHtml: healthyBody({
          h1: page.h1,
          lede: page.lede,
          what: page.what,
          why: page.why,
          fix: page.fix,
          ...(page.violation === undefined ? {} : { extra: page.violation }),
        }),
      })),
  };
}

/**
 * One page per row of `A11Y_RULES`, in the table's order. A row with no page
 * here throws at import (hard rule 7): a rule added to the subset without a
 * fixture would otherwise be a rule nobody has seen speak.
 */
const a11yFixtures: Fixture[] = A11Y_RULES.map((rule) => {
  const page = A11Y_PAGES[rule.axeId];
  if (page === undefined) {
    throw new Error(
      `authored-p29b: A11Y_RULES has ${rule.axeId} and no page here violates it — add one`,
    );
  }
  return a11yFixture(rule.axeId, page);
});
{
  const unused = Object.keys(A11Y_PAGES).filter((id) => !A11Y_RULES.some((r) => r.axeId === id));
  if (unused.length > 0) {
    throw new Error(`authored-p29b: pages for rules outside A11Y_RULES: ${unused.join(", ")}`);
  }
}

export const authoredP29bFixtures: Fixture[] = [
  jsException,
  consoleError,
  failingScript,
  imageFourX,
  imageOneX,
  imageSrcset,
  imageCdn,
  imageLazy,
  ...a11yFixtures,
];
