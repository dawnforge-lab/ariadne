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

export const authoredP26Fixtures: Fixture[] = [wrongContentType];
