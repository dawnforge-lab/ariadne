/**
 * The Phase 23 fixtures (study D2): three fetch outcomes that were classified
 * rows and judged by no rule before ruleset 0.18.0.
 *
 * None of these pages has markup worth reading — that is the point. Each one is
 * a URL the crawler could not read as a page, and each must now speak:
 *
 *  - `/authored23/no-response` resets the connection on every request: three
 *    loop attempts, then the recheck, all `network_error` — `http.no-response`
 *    with `recheck: "confirmed"`. STATELESS, on `/status/server-error`'s
 *    precedent: the answered-on-re-check half (`http.no-response-transient`)
 *    needs a route whose answer depends on how many times it was asked, which
 *    this shared app rules out (see the harness's `SKIP_HARNESS_CLAIMS` entry);
 *    it is proved in test/crawl/recheck.test.ts and test/rules/status.test.ts.
 *  - `/authored23/too-large` serves 2.5 MiB of HTML, over the 2 MiB cap —
 *    `page.html-too-large`.
 *  - `/authored23/brotli` answers 200 with `content-encoding: br`, which the
 *    crawler never asks for (it sends `accept-encoding: gzip`) and cannot
 *    decode — the `crawl.unreadable-encoding` marker.
 *
 * All three are off the sitemap: a sitemap entry that does not answer is
 * `sitemap.non-200`'s subject, already proved by `/status/not-found`, and
 * listing these would put that finding on pages whose subject is the fetch.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Fixture } from "../fixture.js";

const FETCH = "fetch outcomes";

/** Drop the connection without a response: a `network_error` to the crawler. */
function reset(req: IncomingMessage): void {
  req.socket.destroy();
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

const noResponse: Fixture = {
  path: "/authored23/no-response",
  category: FETCH,
  name: "URL that never responds (connection reset)",
  expectedIssues: ["http.no-response"],
  exact: true,
  inSitemap: false,
  handler: (req) => reset(req),
};

/** 2.5 MiB: over the 2 MiB `MAX_BODY`. */
const TOO_LARGE_BYTES = 2.5 * 1024 * 1024;

const tooLarge: Fixture = {
  path: "/authored23/too-large",
  category: FETCH,
  name: "HTML page over the 2 MiB body cap",
  expectedIssues: ["page.html-too-large"],
  exact: true,
  inSitemap: false,
  handler: (_req, res) => {
    const shell = "<!doctype html><html><head><title>Huge</title></head><body><p>";
    const tail = "</p></body></html>";
    html(res, shell + "x".repeat(TOO_LARGE_BYTES - shell.length - tail.length) + tail);
  },
};

const brotli: Fixture = {
  path: "/authored23/brotli",
  category: FETCH,
  name: "Page sent in a compression format the crawler did not request",
  expectedIssues: ["crawl.unreadable-encoding"],
  exact: true,
  inSitemap: false,
  handler: (_req, res) => {
    // The bytes are irrelevant: the crawler refuses the coding before reading
    // them, and says which coding it was.
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
    res.end("not really brotli");
  },
};

export const authoredP23Fixtures: Fixture[] = [noResponse, tooLarge, brotli];
