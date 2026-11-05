/**
 * The Phase 25 fixture (gate clause 2): a response header longer than the
 * 2,048-character cap `pages.response_headers` keeps per value.
 *
 * `/authored25/long-csp.txt` is a plain-text document served with a
 * `content-security-policy` of {@link LONG_CSP_LENGTH} characters — the shape a
 * server-wide `add_header` produces, which sends the site's whole policy on
 * every response, documents included. The crawl must store the value cut to
 * `RESPONSE_HEADER_VALUE_CAP` and name the header in `truncated`, so a reader
 * can never mistake the cut value for the whole policy.
 *
 * WHY A TEXT DOCUMENT AND NOT AN HTML PAGE. What is under test is the fetch
 * layer's header capture, which is the same for every class that saw a
 * response. An HTML page would join the judged cohort, the render selection,
 * the sitemap and the click-depth walk and move every census the harness pins;
 * a `non_html` row joins only the whole-crawl counts (`pagesCrawled`, the
 * render budget's denominator, `redirect.volume`'s `totalPages`, the health
 * rollup's row total). It also keeps the policy out of the render pass, where
 * a browser would enforce it.
 *
 * It fires nothing: a 200 that is not HTML is judged by no rule. Off the
 * sitemap, because a sitemap lists pages and this is not one.
 */
import type { Fixture } from "../fixture.js";

/** Source hosts for the policy's directives: enough of them to pass the cap. */
const SOURCES = Array.from({ length: 60 }, (_, i) => `https://cdn${i + 1}.static.example.com`);

/**
 * The policy this document is served with. Deterministic, so the harness can
 * compute the cut it expects from this constant rather than from the row.
 */
export const LONG_CSP = [
  "default-src 'self'",
  `script-src 'self' ${SOURCES.join(" ")}`,
  `style-src 'self' ${SOURCES.slice(0, 20).join(" ")}`,
  `img-src 'self' data: ${SOURCES.slice(20, 40).join(" ")}`,
  "frame-ancestors 'none'",
  "report-uri /csp-report",
].join("; ");

export const LONG_CSP_LENGTH = LONG_CSP.length;

export const P25_LONG_HEADER_PATH = "/authored25/long-csp.txt";

const longCsp: Fixture = {
  path: P25_LONG_HEADER_PATH,
  category: "response headers",
  name: "Document whose content-security-policy is longer than the stored cap",
  expectedIssues: [],
  exact: true,
  inSitemap: false,
  handler: (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": LONG_CSP,
    });
    res.end("A plain-text document. Its policy header is the fixture; this body is not.\n");
  },
};

export const authoredP25Fixtures: Fixture[] = [longCsp];
