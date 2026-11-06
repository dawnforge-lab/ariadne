/**
 * The Phase 11 fixtures: two pages whose MARKUP is the control recipe and whose
 * RESOURCES are the thing under test.
 *
 * Every fixture before these breaks something a parser can see in the HTML. The
 * resource rules judge files the crawler had to go and ask a server about, so
 * these two pages are healthy documents pointing at unhealthy files: one at an
 * image the site does not serve, one at an image that is 120,000 bytes of PNG.
 * The defect is a round trip away from the markup, which is exactly the shape
 * the phase added, and it is why `exact: true` matters more here than usual —
 * a page whose HTML is the control's must fire nothing except the resource
 * findings, or the rules have started reading the page rather than the file.
 *
 * `test/fixtures/assets.ts` holds the other half of both: `/img/p11-missing.png`
 * is deliberately absent from the served set (the app answers 404), and
 * `/img/p11-heavy-hero.png` declares exactly `HEAVY_IMAGE_BYTES`, so the size
 * the harness asserts on the finding is the size this site declared rather than
 * a number anybody rounded.
 */
import type { Fixture } from "../fixture.js";
import { article, serve } from "../render.js";

const RESOURCES = "resources";

/** The path whose image the fixture site deliberately does not serve. */
export const P11_BROKEN_PATH = "/authored11/broken-resource";

/** The path carrying the heavy PNG. */
export const P11_HEAVY_PATH = "/authored11/heavy-image";

/** The URL the broken page points at — no asset is registered for it. */
export const P11_MISSING_IMAGE = "/img/p11-missing.png";

/** The URL of the 120,000-byte PNG. */
export const P11_HEAVY_IMAGE = "/img/p11-heavy-hero.png";

/**
 * The control recipe, minus the article helper's own image, since both pages
 * below carry an image of their own and a second one would put the finding on
 * a file nobody was asking about.
 */
function healthyBody(opts: { h1: string; lede: string; what: string; why: string; fix: string }): string {
  return article({
    h1: opts.h1,
    lede: opts.lede,
    withImage: false,
    sections: [
      { h2: "What this page does", body: opts.what },
      { h2: "Why it matters", body: opts.why },
      { h2: "How it gets fixed", body: opts.fix },
    ],
  });
}

/**
 * An image element that is correct in every way a page rule can check — alt
 * text, both dimensions — so the only thing wrong with either page below is the
 * file at the other end of the src.
 */
function describedImage(src: string, alt: string): string {
  return `<img src="${src}" alt="${alt}" width="720" height="360">`;
}

const brokenResource: Fixture = {
  path: P11_BROKEN_PATH,
  category: RESOURCES,
  name: "Page referencing an image the site does not serve",
  expectedIssues: ["h2.duplicate", "resources.broken"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "An image reference that leads nowhere",
      metaDescription:
        "The markup of this page is correct in every respect; the image it points at is a 404, which nothing in the HTML could ever reveal.",
      bodyHtml: `${healthyBody({
        h1: "A page pointing at a file that is not there",
        lede: "Everything in this document is well formed. The image below has alt text and dimensions, and the file it names does not exist.",
        what: "The image element on this page is written exactly as it should be: it describes itself for a screen reader, and it reserves its own space so nothing jumps as the page loads. The server answers the request for the file with a 404, which no amount of reading the HTML would have told you.",
        why: "A reader gets a gap where the picture should be, and on a template rather than a single page that gap appears everywhere the template renders. It is also the commonest way an asset move goes wrong: the file is renamed, the markup is not, and nothing in the build fails because the markup is still valid.",
        fix: "Restore the file at the path the markup names, or point the markup at where the file went. Where a template is generating the path from a field, the field is what to fix, since one wrong value there is one broken image per page.",
      })}
${describedImage(P11_MISSING_IMAGE, "An illustration that never arrives, because the file behind it is missing")}`,
    })),
};

const heavyImage: Fixture = {
  path: P11_HEAVY_PATH,
  category: RESOURCES,
  name: "Page carrying a 120,000-byte PNG",
  // Both, and by construction: the legacy-format rule reports the heavy images
  // a server sent as PNG or JPEG, so its population is a subset of the
  // oversized one and this file is in both.
  expectedIssues: ["images.oversized", "images.legacy-format"],
  exact: true,
  handler: (req, res) =>
    serve(req, res, () => ({
      title: "A hero image far heavier than it needs to be",
      metaDescription:
        "The one image on this page transfers 120,000 bytes and arrives as a PNG, which is a great deal of weight for a picture on a page of prose.",
      bodyHtml: `${healthyBody({
        h1: "A page whose picture costs more than its words",
        lede: "The document below is a few kilobytes of HTML. The image at the bottom of it is a hundred and twenty.",
        what: "The image element is correct — described, dimensioned, and pointing at a file the server happily returns. What the server returns is a PNG of 120,000 bytes, which is what every visitor on an empty cache downloads before they see the picture.",
        why: "Weight is the part of a page a reader on a slow connection feels first, and an image is usually most of it. The format matters as well as the size: the same picture in a modern format is routinely a fraction of the bytes, and the browser will take whichever the server offers it.",
        fix: "Export the image at the size it is actually displayed at, compress it, and offer a modern format alongside the original so the browser can pick. Where the heavy file is deliberate, keep it out of the page and link to it instead.",
      })}
${describedImage(P11_HEAVY_IMAGE, "A deliberately heavy illustration, served as a PNG")}`,
    })),
};

export const authoredP11Fixtures: Fixture[] = [brokenResource, heavyImage];
