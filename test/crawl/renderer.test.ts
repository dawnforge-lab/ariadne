/**
 * The render pass, driven by a real Chromium against a real HTTP server.
 *
 * NOTHING HERE IS MOCKED. The browser is the browser, the site is a
 * `node:http` server on 127.0.0.1, the database is the dev Postgres, and the
 * third-party origin is a *second* server whose request log is the evidence
 * that a blocked request never left the machine. A stubbed browser would
 * assert that our stub calls our code; the whole point of this pass is what a
 * real engine does with a real page's JavaScript.
 *
 * The fixture site here is deliberately NOT the shared fixture app
 * (test/fixtures/app.ts): that site belongs to the end-to-end harness, whose
 * render pages arrive in T6. These pages exist to make one renderer behaviour
 * observable each, with every count hand-derived from the markup below.
 *
 * Timing: the renderer's real settle is 3s and its real navigation timeout is
 * 15s. Both are configuration. The SETTLE is driven down (500ms) everywhere,
 * because every page here finishes its script in single-digit milliseconds and
 * a settle only ever ends by expiring. The NAVIGATION TIMEOUT is not: it is
 * left at the production 15s for every test but the one that renders `/hang`,
 * which gets its own renderer at 1s. A shortened navigation timeout is a
 * DEADLINE ON A REAL PAGE ANSWERING, and applying it to tests that are not
 * about deadlines is how a loaded machine fails a test that has nothing wrong
 * with it — the hazard the final review named, alongside the settle margin
 * below that a loaded machine actually did lose. The DEFAULTS themselves are
 * pinned as constants, once, rather than paid for in every test.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, frontier, pages } from "../../src/db/schema.js";
import { throttleRecordOf, type HostSpacingEntry } from "../../src/crawl/politeness.js";
import {
  completeUrls,
  enqueueUrls,
  frontierCounts,
  leaseBatch,
  leaseRenderUrls,
} from "../../src/crawl/frontier.js";
import { selectRenderSet } from "../../src/crawl/render/select.js";
import { RENDER_PASS_EVIDENCE, renderMetrics } from "../../src/rules/metric/render-metrics.js";
import {
  PageRenderer,
  RENDERER_DEFAULTS,
  browserNetworkSwitches,
  originVariants,
  freshLifetimeMs,
  renderedHtmlFilename,
  writeRenderResult,
  type RenderResult,
} from "../../src/crawl/render/renderer.js";
import type { RenderConsole } from "../../src/crawl/render/console-capture.js";
import { analyzeHtml } from "../../src/crawl/parse/page-analyzer.js";
import { isSameOrigin } from "../../src/crawl/parse/url-utils.js";
import { UrlPolicyError } from "../../src/crawl/url-policy.js";
import {
  RENDER_PASS_DEFAULTS,
  RenderPassRefusal,
  renderLeaseSeconds,
  runRenderPass,
} from "../../src/crawl/render/run-render.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

/**
 * Test settle: long enough for an injected script, short enough to be free.
 *
 * THE MARGIN ARITHMETIC, because this number lost a race once. The slowest
 * script on this fixture site is the redirect timer, armed for
 * `REDIRECT_DELAY_MS` (5ms) — so the settle must outlast a 5ms timer under
 * whatever load the suite is running against. 500ms is a **100× margin**. The
 * previous pairing was 20ms against a 150ms settle (7.5×), and run B of the
 * final review lost it: the settle expired before the browser's timer fired,
 * and the redirect assertions failed on a machine, not on a bug.
 */
const SETTLE_MS = 500;
/**
 * Navigation timeout for the ONE test that renders `/hang` — the page that
 * answers headers and then nothing. That test can only end by waiting this out,
 * so it is 1s rather than the production 15s, and it is applied by that test's
 * own renderer. Nothing else in this file shortens the navigation timeout: see
 * the module header.
 */
const NAV_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// The fixture site. Every count asserted below is derived from this markup.
// ---------------------------------------------------------------------------

/**
 * `/csr`: raw HTML carries a two-word body; a script writes the rest. The raw
 * document has 2 words ("Loading now") and 0 anchors; the rendered DOM has 6
 * anchors — 2 in <nav>, 2 in <footer>, 2 loose — of which 3 look like filters
 * (`?sort=`, `?page=2`, `/facet/blue`) and 3 do not.
 *
 * THE WORD COUNT, DERIVED: 12 words in the injected paragraph, plus 3 for the
 * anchors. Three, not six, and the reason is `innerText` rather than a
 * tokenizer — two adjacent inline anchors with no whitespace between them
 * render as ONE text run, so `<a>a</a><a>b</a>` is the single word "ab". That
 * is what a reader sees on the page, which is what this column is for.
 *
 * THE HEAD AND THE HEADING, REWRITTEN (P23-T6). The raw document has no robots
 * meta, no description and no `<h1>`; the script adds a robots meta and a
 * description to the head and writes the twelve words INTO an `<h1>` rather
 * than into the div's text. The word counts do not move — the same twelve
 * words, still the only text in `#app` — and the rendered DOM now carries the
 * three values the render pass persists beside `rendered_title`.
 */
const CSR_TEXT_WORDS = 12;
const CSR_ROBOTS = "noindex, follow";
const CSR_DESCRIPTION = "Written by the script after the page loaded";
const CSR_H1 = "one two three four five six seven eight nine ten eleven twelve";
const CSR_ANCHOR_WORDS = 3;
const CSR_RENDERED_WORDS = CSR_TEXT_WORDS + CSR_ANCHOR_WORDS;
function csrHtml(): string {
  return `<!doctype html><html lang="en"><head><title>CSR</title></head>
<body><div id="app">Loading now</div>
<script>
document.getElementById('app').innerHTML = '<h1>${CSR_H1}</h1>';
document.head.insertAdjacentHTML('beforeend',
  '<meta name="robots" content="${CSR_ROBOTS}">' +
  '<meta name="description" content="${CSR_DESCRIPTION}">');
document.body.insertAdjacentHTML('beforeend',
  '<nav><a href="/a">a</a><a href="/b?sort=asc">b</a></nav>' +
  '<footer><a href="/c">c</a><a href="/d?page=2">d</a></footer>' +
  '<a href="/e">e</a><a href="/facet/blue">f</a>');
</script>
</body></html>`;
}

/**
 * How long after parsing the redirect pages wait before sending themselves on.
 *
 * Near-immediate rather than zero, and the reason is the renderer's contract:
 * the pass waits for `domcontentloaded` and THEN settles, so a navigation that
 * started before the first of those would abort the very `page.goto` being
 * awaited — a different failure from the one these fixtures are for. A timer
 * cannot preempt the parser's own task, so any delay at all is enough for
 * ordering; 5ms is the smallest that is also obviously enough. Against
 * `SETTLE_MS` (500ms) that is a 100× margin — see `SETTLE_MS`.
 */
const REDIRECT_DELAY_MS = 5;

/** `/js-redirect`: a page that sends itself somewhere else after paint. */
function jsRedirectHtml(target: string): string {
  return `<!doctype html><html lang="en"><head><title>Off we go</title></head>
<body><p>Redirecting</p><script>setTimeout(function(){location.replace(${JSON.stringify(
    target,
  )});}, ${REDIRECT_DELAY_MS});</script></body></html>`;
}

/**
 * `/third-party`: four subresources, one of each combination that matters —
 * another origin's script and image (both aborted as third-party), this site's
 * own image (aborted as paint-only) and this site's own script (allowed, and it
 * appends a word, which is how the test proves it ran).
 */
function thirdPartyHtml(otherOrigin: string): string {
  return `<!doctype html><html lang="en"><head><title>Third party</title>
<script src="${otherOrigin}/tracker.js"></script>
<script src="/own.js" defer></script></head>
<body><p>one two three</p><img src="${otherOrigin}/pixel.png" alt="pixel" width="1" height="1">
<img src="/own.png" alt="ours" width="1" height="1"></body></html>`;
}

/**
 * `/chrome`: the two kinds of hiding, side by side, so the divergence between
 * the two measurement families is a pinned number rather than a claim.
 *
 * Five visible words, five hidden by the `hidden` ATTRIBUTE (which the analyzer
 * reads) and five hidden by a CSS CLASS (which it cannot — it does not
 * cascade). So over the serialised DOM:
 *
 *   analyzerWordCount   = 5 + 5 + 5 = 15   every word the markup carries
 *   renderableWordCount = 5     + 5 = 10   minus what the MARKUP hides
 *   wordCount (innerText) = 5              what a reader actually sees
 *
 * The five-word gap between the last two is the whole of Phase 7's 425-word
 * finding in miniature, and the reason `content.csr-dependent` compares the
 * middle number against its raw twin rather than the bottom one.
 */
function chromeHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Chrome</title>
<style>.folded { display: none }</style></head>
<body><p>five visible words here now</p>
<div hidden><p>five words the markup hides</p></div>
<div class="folded"><p>five words a class hides</p></div>
</body></html>`;
}

/**
 * `/malformed`: an `<a href>` left open across a `<nav>` boundary — the one
 * divergence the raw tokenizer has against a real tree builder.
 *
 * A browser's adoption agency algorithm reconstructs the open anchor INSIDE the
 * `<nav>`, so the DOM holds an anchor the byte stream never contained and the
 * streaming analyzer counts one fewer than `querySelectorAll('nav a[href]')`.
 * The test below uses this page to show that the divergence is a property of
 * the BYTES, not of the analyzer: run the same analyzer over the browser's own
 * serialisation and it agrees with the browser exactly.
 */
function malformedHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Malformed</title></head>
<body><a href="/outside">before<nav><a href="/one">one</a></nav>
<p>tail text here</p></body></html>`;
}

/** `/static/{n}`: three same-host pages, for the politeness spacing test. */
function staticHtml(n: string): string {
  return `<!doctype html><html lang="en"><head><title>Static ${n}</title></head>
<body><p>page ${n} body text</p><a href="/a">a</a></body></html>`;
}

/**
 * `/paced`: six same-origin, render-blocking, UNCACHEABLE scripts in the head
 * (Phase 24a). The browser's preload scanner asks for all six at once; the
 * pacing is what turns that burst into six requests a spacing apart, and the
 * server's arrival log is the evidence. `no-store`, so no cache can answer one
 * and every one of them is a real request at the site.
 */
const PACED_SCRIPTS = 6;
function pacedHtml(): string {
  const scripts = Array.from(
    { length: PACED_SCRIPTS },
    (_, i) => `<script src="/paced/${i + 1}.js"></script>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><title>Paced</title>${scripts}</head>
<body><p>six scripts above</p></body></html>`;
}

/**
 * `/iso/set` and `/iso/read`: the isolation pair (Review Focus 4). Both load
 * `/shared.js`, which is CACHEABLE (`max-age=3600`), so the second render can
 * only avoid asking for it if the HTTP cache survived the first. `/iso/set`
 * writes a cookie from script, gets one from the server (`Set-Cookie`), and
 * writes `localStorage.x`; its title reads them straight back, which proves
 * they were set at all. `/iso/read`'s title reports what IT can see.
 */
function isoHtml(write: boolean): string {
  const writes = write
    ? "document.cookie = 'js=1; max-age=3600; path=/'; localStorage.setItem('x', '1');"
    : "";
  return `<!doctype html><html lang="en"><head><title>pending</title>
<script src="/shared.js"></script></head>
<body><p>isolation</p><script>${writes}
document.title = 'cookie=[' + document.cookie + '] ls=[' + localStorage.getItem('x') + ']';
</script></body></html>`;
}

/** `/limited`: a page whose one script the server refuses with a 429. */
function limitedHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Limited</title>
<script src="/limited.js"></script></head><body><p>rate limited asset</p></body></html>`;
}

/**
 * `/mispredict/prime`: the cacheable `/volatile.js` as a script only, so the
 * ledger learns it. `/mispredict/fetch/{n}`: only
 * `fetch('/volatile.js', {cache: "no-store"})`, which the browser sends to the
 * network although nothing in the paused request says so. The ledger predicts
 * the first such fetch a hit exactly once; after that, never again.
 */
function mispredictHtml(prime: boolean): string {
  const script = prime ? `<script src="/volatile.js"></script>` : "";
  const fetcher = prime ? "" : `<script>fetch('/volatile.js', { cache: 'no-store' });</script>`;
  return `<!doctype html><html lang="en"><head><title>Mispredict</title>${script}</head><body><p>volatile</p>${fetcher}</body></html>`;
}

/**
 * `/iso/unload`: state written where a clear-then-close teardown would let it
 * through — every 5 ms on a timer, and in `pagehide` (a cookie too).
 */
function isoUnloadHtml(): string {
  return `<!doctype html><html lang="en"><head><title>unload</title></head>
<body><p>writes on the way out</p><script>
setInterval(function () { localStorage.setItem('x', 'interval'); }, 5);
addEventListener('pagehide', function () {
  localStorage.setItem('x', 'pagehide');
  document.cookie = 'late=1; max-age=3600; path=/';
});
</script></body></html>`;
}

/**
 * `/teardown`: a page that asks for more on its way out — a beacon, a
 * keepalive fetch and an ordinary fetch in `pagehide` — and keeps asking on a
 * timer. Nothing it asks for once the render has ended may reach the server.
 */
function teardownHtml(): string {
  return `<!doctype html><html lang="en"><head><title>teardown</title></head>
<body><p>teardown</p><script>
setInterval(function () { fetch('/teardown-tick'); }, 20);
addEventListener('pagehide', function () {
  navigator.sendBeacon('/teardown-beacon', 'x');
  fetch('/teardown-keepalive', { keepalive: true });
  fetch('/teardown-fetch');
});
</script></body></html>`;
}

/**
 * `/escape`: the requests a page-session interception cannot see — a
 * WebSocket to the origin and to another origin, a shared worker that would
 * fetch, and speculation rules that prefetch and prerender.
 */
function escapeHtml(otherOrigin: string): string {
  const otherWs = otherOrigin.replace(/^http/, "ws");
  const rules = JSON.stringify({
    prefetch: [{ source: "list", urls: ["/spec-pf", `${otherOrigin}/spec-x`], eagerness: "immediate" }],
    prerender: [{ source: "list", urls: ["/spec-pre"], eagerness: "immediate" }],
  });
  return `<!doctype html><html lang="en"><head><title>escape</title>
<script type="speculationrules">${rules}</script></head>
<body><p>escape</p><script>
try { new WebSocket('ws://' + location.host + '/socket'); } catch (e) {}
try { new WebSocket('${otherWs}/socket'); } catch (e) {}
try { new SharedWorker('/shared-worker.js'); } catch (e) {}
</script></body></html>`;
}

/** `/many-scripts`: `MANY_SCRIPTS` uncacheable same-origin scripts, all before `domcontentloaded`. */
const MANY_SCRIPTS = 32;
function manyScriptsHtml(): string {
  const scripts = Array.from(
    { length: MANY_SCRIPTS },
    (_, i) => `<script src="/many/${i + 1}.js"></script>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><head><title>Many</title>
${scripts}</head><body><p>many scripts</p></body></html>`;
}

/** How long `/late-429.json` holds its answer: past the render's settle. */
const LATE_ANSWER_MS = SETTLE_MS + 700;

/** `/late-429`: a fetch released during the render, answered 429 after it ended. */
function late429Html(): string {
  return `<!doctype html><html lang="en"><head><title>Late</title></head>
<body><p>late answer</p><script>fetch('/late-429.json').catch(function () {});</script></body></html>`;
}

/** `/one-script`: one uncacheable same-origin script, for the seeded-gate test. */
function oneScriptHtml(): string {
  return `<!doctype html><html lang="en"><head><title>One</title>
<script src="/one.js"></script></head><body><p>one script</p></body></html>`;
}

/** The function `/widget.js` on the other origin defines — never, because it is blocked. */
const WIDGET_FN = "widgetInit";

/**
 * `/console-errors` (Phase 25): everything the render evidence records, once each.
 *
 *  - a third-party script (`/widget.js` on the other origin) the renderer aborts,
 *    and an inline call to the function it would have defined: the
 *    `widgetInit is not defined` that OUR blocking caused, which must be recorded
 *    as the page's exception while the abort stays a count, never a failure;
 *  - a same-origin SCRIPT that 404s (`/missing.js`): an image or font would be
 *    aborted as paint-only before it was sent, so only a script is a request the
 *    site can fail;
 *  - a `console.error`, a `console.warn` and a `console.log` (not recorded: the
 *    levels kept are error and warning);
 *  - an uncaught `throw`.
 */
function consoleErrorsHtml(otherOrigin: string): string {
  return `<!doctype html><html lang="en"><head><title>Console errors</title>
<script src="${otherOrigin}/widget.js"></script>
<script src="/missing.js"></script></head>
<body><p>console errors</p>
<script>console.error("site says no"); console.warn("site warns"); console.log("site chats");</script>
<script>${WIDGET_FN}();</script>
<script>throw new Error("site threw on purpose");</script>
</body></html>`;
}

/** `/console-clean`: a page with script and nothing wrong. `console.log` is not a level kept. */
function consoleCleanHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Clean</title>
<script src="/one.js"></script></head>
<body><p>clean page</p><script>console.log("all is well");</script></body></html>`;
}

/**
 * `/console-hostile`: console text and an exception carrying a NUL and a lone
 * surrogate, both of which Postgres `jsonb` rejects. The escapes are the
 * page's JavaScript's, so the browser itself builds the hostile strings.
 */
function consoleHostileHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Hostile</title></head>
<body><p>hostile console</p>
<script>console.error("nul:\\u0000 lone:\\uD800 end");</script>
<script>throw new Error("thrown nul:\\u0000 lone:\\uDC00");</script>
</body></html>`;
}

/**
 * `/console-assert`: a failed `console.assert`, which the protocol reports as
 * its own type (`assert`), not as `error` — and a passing one, which logs nothing.
 */
function consoleAssertHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Assert</title></head>
<body><p>assert console</p>
<script>console.assert(1 === 2, "site asserts"); console.assert(true, "never logged");</script>
</body></html>`;
}

/**
 * `/gone-with-script`: a 404 DOCUMENT that still loads a script the site does
 * not have. The script's 404 is a failed request; the document's is the page
 * row's own status and must never be recorded beside it.
 */
function goneWithScriptHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Gone</title>
<script src="/missing.js"></script></head>
<body><p>this page is gone</p></body></html>`;
}

/**
 * `/reset-script`: a same-origin script whose connection the server destroys
 * before any response, so the browser fails it at the network level
 * (`Network.loadingFailed` with a net error) rather than with a status.
 */
function resetScriptHtml(): string {
  return `<!doctype html><html lang="en"><head><title>Reset</title>
<script src="/reset.js"></script></head>
<body><p>reset script</p></body></html>`;
}

interface Site {
  base: string;
  /** Arrival time (ms) of every request, in order, and the cookie it carried. */
  hits: Array<{ path: string; at: number; cookie?: string }>;
  close(): Promise<void>;
}

async function startSite(otherOrigin: () => string): Promise<Site> {
  const hits: Array<{ path: string; at: number; cookie?: string }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({
      path,
      at: Date.now(),
      ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
    });
    const html = (body: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (path === "/csr") return html(csrHtml());
    if (path === "/chrome") return html(chromeHtml());
    if (path === "/malformed") return html(malformedHtml());
    if (path === "/js-redirect") return html(jsRedirectHtml(`${siteBase(server)}/csr`));
    if (path === "/offsite-redirect") return html(jsRedirectHtml(`${otherOrigin()}/elsewhere`));
    if (path === "/js-redirect-missing") {
      return html(jsRedirectHtml(`${siteBase(server)}/no-such-page`));
    }
    if (path === "/third-party") return html(thirdPartyHtml(otherOrigin()));
    if (path === "/console-errors") return html(consoleErrorsHtml(otherOrigin()));
    if (path === "/console-clean") return html(consoleCleanHtml());
    if (path === "/console-hostile") return html(consoleHostileHtml());
    if (path === "/console-assert") return html(consoleAssertHtml());
    if (path === "/gone-with-script") {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(goneWithScriptHtml());
      return;
    }
    if (path === "/reset-script") return html(resetScriptHtml());
    if (path === "/reset.js") {
      // No response at all: the socket goes before a status line is written.
      req.socket.destroy();
      return;
    }
    if (path === "/console-hang") {
      // A console error, then silence: the error is logged while the document
      // is still arriving, and the navigation never reaches domcontentloaded.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write(
        "<!doctype html><html><head><title>Console hang</title>" +
          '<script>console.error("logged before the hang");</script>',
      );
      return;
    }
    if (path.startsWith("/static/")) return html(staticHtml(path.slice("/static/".length)));
    if (path === "/paced") return html(pacedHtml());
    if (path === "/limited") return html(limitedHtml());
    if (path === "/one-script") return html(oneScriptHtml());
    if (path === "/many-scripts") return html(manyScriptsHtml());
    if (path === "/late-429") return html(late429Html());
    if (path === "/late-429.json") {
      setTimeout(() => {
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
        res.end("slow down");
      }, LATE_ANSWER_MS);
      return;
    }
    if (path.startsWith("/mispredict/")) return html(mispredictHtml(path === "/mispredict/prime"));
    if (path === "/iso/unload") return html(isoUnloadHtml());
    if (path === "/teardown") return html(teardownHtml());
    if (path === "/escape") return html(escapeHtml(otherOrigin()));
    if (path === "/spec-pre") {
      return html(`<!doctype html><title>pre</title><script src="/spec-pre.js"></script>`);
    }
    if (path === "/shared-worker.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("fetch('/from-shared-worker');");
      return;
    }
    if (path === "/volatile.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
      res.end("void 0;");
      return;
    }
    if (path === "/redirect/policy") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    if (path === "/redirect/hop") {
      res.writeHead(302, { location: "/static/hop" });
      res.end();
      return;
    }
    if (path === "/iso/read") return html(isoHtml(false));
    if (path === "/iso/set") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": "srv=1; Max-Age=3600; Path=/",
      });
      res.end(isoHtml(true));
      return;
    }
    if (path.startsWith("/paced/") || path.startsWith("/many/") || path === "/one.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end("void 0;");
      return;
    }
    if (path === "/shared.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
      res.end("window.shared = true;");
      return;
    }
    if (path === "/limited.js") {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
      res.end("slow down");
      return;
    }
    if (path === "/own.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(0));
      return;
    }
    if (path === "/own.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      // A fourth word, appended only if this file was fetched AND executed.
      res.end("document.body.insertAdjacentHTML('beforeend', '<p>four</p>');");
      return;
    }
    if (path === "/hang") {
      // Headers, then silence: the navigation never reaches domcontentloaded.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head><title>Hang</title>");
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>404</title>");
  });
  // A WebSocket handshake is a request too: logged, then dropped.
  server.on("upgrade", (req: IncomingMessage, socket) => {
    hits.push({ path: `UPGRADE ${(req.url ?? "/").split("?")[0]}`, at: Date.now() });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: siteBase(server),
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

function siteBase(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** The other origin: it answers everything, and records that it was asked. */
async function startThirdParty(): Promise<Site> {
  const hits: Array<{ path: string; at: number }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push({ path, at: Date.now() });
    if (path === "/widget.js") {
      // Served, so a page whose call to it fails proves the script was never
      // fetched: the renderer blocked it, the server did not refuse it.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`window.${WIDGET_FN} = function () {};`);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from somewhere else");
  });
  server.on("upgrade", (req: IncomingMessage, socket) => {
    hits.push({ path: `UPGRADE ${(req.url ?? "/").split("?")[0]}`, at: Date.now() });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: siteBase(server),
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe("PageRenderer", () => {
  let site: Site;
  let third: Site;
  let renderer: PageRenderer;
  /**
   * Where this describe's serialised documents go. A real directory, because
   * the write is part of what a render IS from Phase 8 — a renderer pointed at
   * `/dev/null` would be testing a code path production never takes — and a
   * temporary one, because the suite must leave nothing behind that reads like
   * a pass's evidence.
   */
  let htmlDir: string;
  const blocked: string[] = [];

  beforeAll(async () => {
    third = await startThirdParty();
    site = await startSite(() => third.base);
    htmlDir = await mkdtemp(join(tmpdir(), "ariadne-render-unit-"));
    renderer = await PageRenderer.launch({
      origin: site.base,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      // No `navigationTimeoutMs`: the production 15s. Every page this renderer
      // is pointed at answers, so the timeout is never meant to be reached and
      // shortening it would only add a way to fail under load.
      settleMs: SETTLE_MS,
      allowPrivate: true,
      onRequestBlocked: (url) => blocked.push(url),
    });
  }, 120_000);

  afterAll(async () => {
    await renderer.close();
    await site.close();
    await third.close();
    await rm(htmlDir, { recursive: true, force: true });
  });

  it("pins the production navigation timeout and settle", () => {
    expect(RENDERER_DEFAULTS.navigationTimeoutMs).toBe(15_000);
    expect(RENDERER_DEFAULTS.settleMs).toBe(3_000);
  });

  it("measures the DOM a browser builds, not the bytes the server sent", async () => {
    const result = await renderer.render(`${site.base}/csr`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);
    // The raw document body carried 2 words ("Loading now"); the browser sees
    // 15. That delta is exactly what CHECK-01 exists to find.
    expect(result.wordCount).toBe(CSR_RENDERED_WORDS);
    expect(result.linkCount).toBe(6);
    expect(result.navLinkCount).toBe(2);
    expect(result.footerLinkCount).toBe(2);
    // `/b?sort=asc` and `/d?page=2` (a `?`) and `/facet/blue` (the word).
    expect(result.filterLinkCount).toBe(3);
    expect(result.redirectUrl).toBeNull();

    // THE SECOND INSTRUMENT (P8-T1), on the same render. `analyzeHtml` over the
    // serialised post-JS DOM sees the same 15 words the browser does, and that
    // agreement is derivable rather than lucky: `<a>` is an inline tag in both
    // (INLINE_TEXT_TAGS), so `<a>a</a><a>b</a>` is the single word "ab" to the
    // tokenizer exactly as it is to `innerText`. This page hides nothing, so
    // the renderable count is the same number again — the `/chrome` test below
    // is where the three diverge.
    expect(result.analyzerWordCount).toBe(CSR_RENDERED_WORDS);
    expect(result.renderableWordCount).toBe(CSR_RENDERED_WORDS);
    expect(result.title).toBe("CSR");
    expect(result.h1Count).toBe(1);
    expect(result.canonical).toBeNull();
    // P23-T6: the three values the script wrote, which the raw HTML lacks.
    expect(result.robotsMeta).toBe(CSR_ROBOTS);
    expect(result.metaDescription).toBe(CSR_DESCRIPTION);
    expect(result.h1Text).toBe(CSR_H1);
  });

  it("keeps the document the numbers came from, named by the URL's hash", async () => {
    const url = `${site.base}/csr`;
    const result = await renderer.render(url);

    expect(result.htmlPath).toBe(join(htmlDir, renderedHtmlFilename(url)));
    const saved = await readFile(result.htmlPath!, "utf8");

    // 1. IT IS THE POST-JS DOM, not the bytes the server sent: the paragraph
    // the script wrote is in it and the `insertAdjacentHTML` call that wrote it
    // is still there too, which is what makes the file a document rather than a
    // diff.
    expect(saved).toContain("<div id=\"app\"><h1>one two three four five six seven");
    expect(saved).toContain("<nav><a href=\"/a\">a</a>");

    // 2. IT IS THE SAME STRING THE MEASUREMENT WAS TAKEN FROM. Re-running the
    // analyzer over the file reproduces the row's numbers exactly — which is
    // the property that makes this evidence an auditor can check rather than a
    // souvenir. If the renderer ever analysed one string and wrote another,
    // this is where it would show.
    const reanalyzed = analyzeHtml(saved, url);
    expect(reanalyzed.wordCount).toBe(result.analyzerWordCount);
    expect(reanalyzed.renderableWordCount).toBe(result.renderableWordCount);
    expect(reanalyzed.title).toBe(result.title);
  });

  it("counts markup-hidden and class-hidden chrome the way each instrument can", async () => {
    // The divergence Phase 8 is built around, as three numbers on one page.
    const result = await renderer.render(`${site.base}/chrome`);

    expect(result.error).toBeNull();
    // The browser: five words, because both blocks are invisible to a reader.
    expect(result.wordCount).toBe(5);
    // The analyzer: fifteen, because it counts every word the markup carries…
    expect(result.analyzerWordCount).toBe(15);
    // …and ten once it removes what the MARKUP itself says is hidden. The five
    // it cannot remove are the class-hidden block: no tokenizer can, and that
    // is the residual the Phase 7 gate measured at ~425 words on a real theme.
    expect(result.renderableWordCount).toBe(10);

    // AND THE POINT OF ALL THREE: the same five class-hidden words are in the
    // RAW document too, so the analyzer counts them on both sides and they
    // cancel in the subtraction `content.csr-dependent` makes. Asserted by
    // running the analyzer over the bytes the server sent and getting the same
    // renderable count back — this page runs no script, so the two documents
    // differ in nothing at all.
    const raw = analyzeHtml(chromeHtml(), `${site.base}/chrome`);
    expect(raw.renderableWordCount).toBe(result.renderableWordCount);
    expect(raw.wordCount).toBe(result.analyzerWordCount);
  });

  it("reads a browser-repaired tree exactly as the browser does", async () => {
    // The malformed-DOM round trip, and the evidence behind a decision this
    // phase took: `nav.js-only` was NOT re-sided onto the analyzer's rendered
    // counts (see its docblock in src/rules/query/render-diff.ts).
    //
    // The raw byte stream leaves an `<a href>` open across a `<nav>` boundary.
    // A streaming tokenizer counts the anchors it was given; a tree builder
    // reconstructs the open one inside the container. So the raw count is UNDER
    // the browser's — one-directional, at most one per unclosed anchor — and
    // that is the divergence the nav rule's six-anchor margin absorbs.
    const url = `${site.base}/malformed`;
    const result = await renderer.render(url);
    const rawNav = analyzeHtml(malformedHtml(), url).navLinkCount;

    expect(rawNav).toBeLessThan(result.navLinkCount!);

    // …and re-siding WOULD remove it, which is why the decision had to be
    // argued rather than assumed: the same analyzer over the browser's own
    // serialisation agrees with the browser's selector exactly. The rule keeps
    // the browser's counts anyway, because a bounded ±1 inside a margin of six
    // is not worth two more columns and a re-derivation of every threshold.
    const saved = await readFile(result.htmlPath!, "utf8");
    expect(analyzeHtml(saved, url).navLinkCount).toBe(result.navLinkCount);
  });

  it("throws when the document cannot be saved: an environment failure is not a site's", async () => {
    // THE PHASE BOUNDARY, and the one place the suite can provoke it.
    //
    // `render()` is in two phases (see its docblock). Phase 1 is what the SITE
    // does and is classified into a `render_error`; phase 2 is what WE do to a
    // document the browser already built — serialise, analyse, write — and sits
    // outside that classifier, so a failure in it propagates. A directory that
    // does not exist is the portable way to make `writeFile` fail; ENOSPC and
    // EACCES take the same path.
    //
    // WHY A THROW RATHER THAN A CLASSIFIED ROW. A full disk is not evidence
    // about a page. Recording it as a `render_error` would put an engine defect
    // in site-evidence clothes AND consume the URL — `runWorker` completes the
    // frontier row in the same transaction — so the page would be spent on a
    // render whose document was thrown away, and `render.coverage` would count
    // it against the site. A throw leaves the URL `render_pending` and
    // unrendered: fix the disk, re-run, and no polite navigation was wasted.
    const missing = join(htmlDir, "no-such-directory");
    const doomed = await PageRenderer.launch({
      origin: site.base,
      htmlDir: missing,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
    });
    try {
      await expect(doomed.render(`${site.base}/csr`)).rejects.toThrow(
        /render evidence not written/,
      );

      // …and the thrown value itself, because what it IS decides how the API
      // reports it. A plain Error, never a `RenderPassRefusal` — a refusal
      // means "this crawl is busy, wait" and `mapRenderPassError` turns it into
      // a 409, which would tell an operator to retry a full disk. This is a
      // 500. The message names the file and the URL, the two things they need
      // before they can act on it.
      const thrown: unknown = await doomed.render(`${site.base}/csr`).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(RenderPassRefusal);
      expect(String((thrown as Error).message)).toContain(missing);
      expect(String((thrown as Error).message)).toContain(`${site.base}/csr`);
    } finally {
      await doomed.close();
    }
  });

  it("records where a page sent itself with JavaScript", async () => {
    // Margin: the fixture's timer is armed for 5ms and the settle is 500ms, so
    // the browser has 100× the timer's own delay to fire it in (see SETTLE_MS).
    const result = await renderer.render(`${site.base}/js-redirect`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);
    expect(result.redirectUrl).toBe(`${site.base}/csr`);
    // The measurement is of the page the browser ended on.
    expect(result.wordCount).toBe(CSR_RENDERED_WORDS);
  });

  it("blocks third-party and paint-only requests, and renders the page anyway", async () => {
    blocked.length = 0;
    const beforeThird = third.hits.length;
    const beforeSite = site.hits.length;

    const result = await renderer.render(`${site.base}/third-party`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);

    // 1. THIRD PARTY: the other origin was never asked. Not "we ignored the
    // response" — the request never left the machine.
    expect(third.hits.length).toBe(beforeThird);
    expect(blocked.sort()).toEqual([`${third.base}/pixel.png`, `${third.base}/tracker.js`]);
    expect(result.blockedRequests).toBe(2);

    // 2. PAINT-ONLY, SAME ORIGIN: the site's own image is aborted too. It
    // cannot move a word count or an anchor count, and every one skipped is one
    // fewer request in the burst a browser makes at a client's server.
    const paths = site.hits.slice(beforeSite).map((h) => h.path);
    expect(paths).not.toContain("/own.png");
    expect(result.skippedPaintRequests).toBe(1);

    // 3. DOM-BUILDING, SAME ORIGIN: the site's own script is allowed, and the
    // word it appends is the proof it both arrived and ran. Blocking these
    // would make every client-rendered page look empty — the exact defect this
    // pass exists to detect.
    expect(paths).toContain("/own.js");
    expect(result.wordCount).toBe(4);
  });

  it("blocks an off-site navigation and records it as the redirect", async () => {
    // Same 5ms-against-500ms margin as the same-origin redirect above.
    const before = third.hits.length;

    const result = await renderer.render(`${site.base}/offsite-redirect`);

    // The other origin was never asked, and the page it wanted is recorded.
    expect(third.hits.length).toBe(before);
    expect(result.redirectUrl).toBe(`${third.base}/elsewhere`);
    // Chromium is left on its own error surface, so there is no DOM of this
    // site's to measure: a failed render carrying a redirect, not a render.
    expect(result.rendered).toBe(false);
    expect(result.error).toBe(`off-site navigation: ${third.base}/elsewhere`);
    expect(result.wordCount).toBeNull();
  });

  it("classifies a URL the policy refuses, without opening a page", async () => {
    const result = await renderer.render("http://169.254.169.254/latest/meta-data/");

    expect(result.rendered).toBe(false);
    expect(result.error).toMatch(/^policy refusal: /);
    expect(result.error).toContain("169.254.169.254");
    expect(result.wordCount).toBeNull();
    // No page was opened, so nothing was looked at: null, not zero counts.
    expect(result.console).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Phase 25: render evidence — console, exceptions, failed requests.
  // -------------------------------------------------------------------------

  it("records a thrown error, a console.error and a missing same-origin script", async () => {
    const result = await renderer.render(`${site.base}/console-errors`);

    expect(result.rendered).toBe(true);
    const evidence = result.console!;
    expect(evidence).not.toBeNull();
    expect(evidence.exceptionsTotal).toBeGreaterThanOrEqual(1);
    expect(evidence.exceptions.some((e) => e.text.includes("site threw on purpose"))).toBe(true);
    expect(evidence.console).toContainEqual({ level: "error", text: "site says no", cut: false });
    expect(evidence.console).toContainEqual({ level: "warning", text: "site warns", cut: false });
    // `console.log` is not a level kept.
    expect(evidence.console.some((m) => m.text.includes("site chats"))).toBe(false);
    expect(evidence.failedRequests).toContainEqual({
      url: `${site.base}/missing.js`,
      status: 404,
      reason: "http 404",
      cut: false,
    });
    // The browser's own "Failed to load resource" lines are not the site's
    // console. (That the DOCUMENT is never a failed request is pinned on a 404
    // document below: this one answered 200, so it could not have been.)
    expect(evidence.console.some((m) => m.text.includes("Failed to load resource"))).toBe(false);
    // Every total counts what was seen, and every entry kept is within it.
    expect(evidence.consoleTotal).toBe(evidence.console.length);
    expect(evidence.failedRequestsTotal).toBe(1);
  });

  it("records a failed console.assert at level error", async () => {
    const result = await renderer.render(`${site.base}/console-assert`);

    expect(result.rendered).toBe(true);
    // The protocol's type for a failed assertion is `assert`; it is an error
    // the page reported, and the passing assertion logged nothing at all.
    expect(result.console!.console).toEqual([
      { level: "error", text: "site asserts", cut: false },
    ]);
    expect(result.console!.consoleTotal).toBe(1);
  });

  it("never records the top-level document as a failed request, even when it is a 404", async () => {
    const result = await renderer.render(`${site.base}/gone-with-script`);

    // A 404 document is still a document the browser renders.
    expect(result.rendered).toBe(true);
    // The script's 404 is the page's failed request, so capture was running;
    // the document's own 404 is the row's status and is not listed beside it.
    expect(result.console!.failedRequests).toEqual([
      { url: `${site.base}/missing.js`, status: 404, reason: "http 404", cut: false },
    ]);
    expect(result.console!.failedRequestsTotal).toBe(1);
  });

  it("records a JS redirect the page made to a 404 as a failed request", async () => {
    const result = await renderer.render(`${site.base}/js-redirect-missing`);

    expect(result.redirectUrl).toBe(`${site.base}/no-such-page`);
    // The navigated-to document answered 200 and is on the row; the page's
    // own navigation answered 404 and is stored nowhere else.
    expect(result.console!.failedRequests).toEqual([
      { url: `${site.base}/no-such-page`, status: 404, reason: "http 404", cut: false },
    ]);
    expect(result.console!.failedRequestsTotal).toBe(1);
  });

  it("records a request the network failed with Chromium's net error and no status", async () => {
    const result = await renderer.render(`${site.base}/reset-script`);

    expect(result.rendered).toBe(true);
    const failed = result.console!.failedRequests;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      url: `${site.base}/reset.js`,
      status: null,
      reason: "net::ERR_EMPTY_RESPONSE",
      cut: false,
    });
    // Not one of OUR aborts: those are counts, never failed requests.
    expect(failed[0]!.reason).not.toBe("net::ERR_BLOCKED_BY_CLIENT");
    expect(failed[0]!.reason).not.toBe("net::ERR_ABORTED");
    expect(result.console!.blockedByRenderer).toEqual({ thirdParty: 0, sameOriginAssets: 0 });
  });

  it("a blocked third-party script is a count, not a failure", async () => {
    const before = third.hits.length;

    const result = await renderer.render(`${site.base}/console-errors`);

    // The other origin was never asked: the call below failed because WE
    // blocked its script.
    expect(third.hits.length).toBe(before);
    const evidence = result.console!;
    expect(evidence.blockedByRenderer.thirdParty).toBeGreaterThanOrEqual(1);
    expect(evidence.blockedByRenderer).toEqual({
      thirdParty: result.blockedRequests,
      sameOriginAssets: result.skippedPaintRequests,
    });
    expect(evidence.failedRequests.some((f) => f.url.startsWith(third.base))).toBe(false);
    // The error our blocking caused is recorded as the page's — telling it
    // apart is a later rule's job, which `blockedByRenderer` is kept for.
    expect(evidence.exceptions.some((e) => e.text.includes(`${WIDGET_FN} is not defined`))).toBe(true);
    // Our abort is not a console line either.
    expect(evidence.console.some((m) => m.text.includes("ERR_BLOCKED_BY_CLIENT"))).toBe(false);
  });

  it("a clean page has zero counts", async () => {
    const result = await renderer.render(`${site.base}/console-clean`);

    expect(result.rendered).toBe(true);
    // Looked, found nothing: a fact, not a null.
    expect(result.console).toEqual({
      console: [],
      consoleTotal: 0,
      exceptions: [],
      exceptionsTotal: 0,
      failedRequests: [],
      failedRequestsTotal: 0,
      blockedByRenderer: { thirdParty: 0, sameOriginAssets: 0 },
    });
  });

  it("keeps what it captured when the render then fails", async () => {
    // Its own browser at the short navigation timeout, for the reason the
    // `/hang` test below gives.
    const hangRenderer = await PageRenderer.launch({
      origin: site.base,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      navigationTimeoutMs: NAV_TIMEOUT_MS,
      settleMs: SETTLE_MS,
      allowPrivate: true,
    });
    try {
      const result = await hangRenderer.render(`${site.base}/console-hang`);

      expect(result.rendered).toBe(false);
      expect(result.error).toMatch(/^timeout under pacing /);
      expect(result.console).not.toBeNull();
      expect(result.console!.consoleTotal).toBeGreaterThanOrEqual(1);
      expect(result.console!.console).toContainEqual({
        level: "error",
        text: "logged before the hang",
        cut: false,
      });
    } finally {
      await hangRenderer.close();
    }
  });

  it("classifies a navigation that never finishes as a timeout", async () => {
    // THE ONE TEST THAT SHORTENS THE NAVIGATION TIMEOUT, and it gets its own
    // browser to do it in. `/hang` sends headers and then goes quiet, so this
    // test can only end by waiting the timeout out: 1s here rather than the
    // production 15s the shared renderer above keeps. The cost is one extra
    // Chromium launch; the alternative — the shared renderer at 1s — puts a 1s
    // deadline on every OTHER test's real navigation, which is a way for a busy
    // machine to fail a test about anything but timeouts.
    const hangRenderer = await PageRenderer.launch({
      origin: site.base,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render test)",
      perHostDelayMs: 0,
      navigationTimeoutMs: NAV_TIMEOUT_MS,
      settleMs: SETTLE_MS,
      allowPrivate: true,
    });
    try {
      const result = await hangRenderer.render(`${site.base}/hang`);

      expect(result.rendered).toBe(false);
      // `/hang` has no subresources, so the one request paced is the document.
      expect(result.error).toBe(
        `timeout under pacing (1 requests paced): navigation did not reach ` +
          `domcontentloaded within ${NAV_TIMEOUT_MS}ms`,
      );
      expect(result.wordCount).toBeNull();
      expect(result.redirectUrl).toBeNull();
    } finally {
      await hangRenderer.close();
    }
  });

  it("classifies a navigation the server refuses to answer", async () => {
    const result = await renderer.render(`${site.base}/404`);

    // A 404 is still a document: the browser renders the error page, and the
    // render pass records what it saw. The selection never offers one (T3
    // filters to ok/200), so this only pins that nothing throws.
    expect(result.rendered).toBe(true);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 24a: every same-origin request paced, the cache shared, state cleared.
// ---------------------------------------------------------------------------

describe("PageRenderer under the crawl's pacing (Phase 24a)", () => {
  let site: Site;
  let third: Site;
  let htmlDir: string;
  /** Timer and loopback noise allowed on a server-side gap (the brief's 20 ms). */
  const toleranceMs = 20;
  /**
   * Clock slack on a release-time claim: `Date.now()` is read in the gate's
   * `acquire` and again at the release, a millisecond tick can fall between.
   */
  const RELEASE_CLOCK_MS = 5;

  beforeAll(async () => {
    third = await startThirdParty();
    site = await startSite(() => third.base);
    htmlDir = await mkdtemp(join(tmpdir(), "ariadne-render-paced-"));
  }, 120_000);

  afterAll(async () => {
    await site.close();
    await third.close();
    await rm(htmlDir, { recursive: true, force: true });
  });

  function launch(overrides: Partial<Parameters<typeof PageRenderer.launch>[0]> = {}) {
    return PageRenderer.launch({
      origin: site.base,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render pacing test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      ...overrides,
    });
  }

  it("starts every same-origin request at least one spacing after the last", async () => {
    // Review Focus 5. The preload scanner asks for all six scripts the moment
    // it sees them; the gate is what spaces them.
    const spacingMs = 300;
    /** Every release the renderer made, timed on the gate's own clock. */
    const releases: Array<{ url: string; at: number }> = [];
    const renderer = await launch({
      perHostDelayMs: spacingMs,
      testFaults: { onRelease: (url, at) => releases.push({ url, at }) },
    });
    try {
      // WARM-UP (see the configured-delay test in the pass suite): the
      // browser's first navigation is cold and arrives late, which would
      // SHORTEN the gap after it by our own start-up cost.
      await renderer.render(`${site.base}/static/warm`);
      const before = site.hits.length;
      releases.length = 0;

      const result = await renderer.render(`${site.base}/paced`);

      expect(result.error).toBeNull();
      expect(result.rendered).toBe(true);
      const expectedPaths = [
        "/paced",
        ...Array.from({ length: PACED_SCRIPTS }, (_, i) => `/paced/${i + 1}.js`),
      ];
      // THE RELEASES, measured where the gate imposes them. A server-side gap
      // also carries each request's own trip through Chromium's network stack,
      // and one late arrival shortens the gap after it (263-267 ms seen under a
      // parallel suite) though the releases were spaced correctly.
      //
      // WHAT THE GATE GUARANTEES is a SLOT per request, `spacing` after the
      // previous slot, and a release never before its slot. It does not
      // guarantee a full spacing between two RELEASES: a release whose timer
      // fires late under load shortens the gap after it by that lateness while
      // the next release still lands on its own slot (measured beside a
      // parallel full suite: 293 and 280 ms gaps at a 300 ms spacing, 2 runs in
      // 40). So the claim is the slot claim, made on release times: the
      // document is admitted at once (the warm-up's 500 ms settle is longer
      // than the spacing, so it waits on no timer and its release IS its slot),
      // and release i is at least i spacings after it. Timer lateness only
      // ever makes a release later, so this needs no load allowance; a burst —
      // two releases on one slot — still fails it.
      const released = releases.filter((r) => new URL(r.url).pathname.startsWith("/paced"));
      expect(released.map((r) => new URL(r.url).pathname)).toEqual(expectedPaths);
      for (let i = 1; i < released.length; i += 1) {
        expect(released[i]!.at - released[0]!.at).toBeGreaterThanOrEqual(i * spacingMs - RELEASE_CLOCK_MS);
      }
      // AT THE SERVER: the same requests in the same order, and the SPAN over
      // all seven arrivals at least six spacings within the brief's 20 ms — no
      // burst can hide in it, whatever the network stack did to one gap.
      const arrivals = site.hits.slice(before).filter((h) => h.path.startsWith("/paced"));
      expect(arrivals.map((h) => h.path)).toEqual(expectedPaths);
      const span = arrivals[arrivals.length - 1]!.at - arrivals[0]!.at;
      expect(span).toBeGreaterThanOrEqual((arrivals.length - 1) * spacingMs - toleranceMs);
      // The document and six scripts, each through the gate; nothing cached.
      expect(result.pacedRequests).toBe(1 + PACED_SCRIPTS);
      expect(result.cachedResponses).toBe(0);
      expect(result.unpacedNetworkRequests).toBe(0);
    } finally {
      await renderer.close();
    }
  });

  it("clears cookies and storage between pages and keeps the HTTP cache", async () => {
    // Review Focus 4, both halves on one pair of renders in ONE context.
    const renderer = await launch();
    try {
      const before = site.hits.length;

      const a = await renderer.render(`${site.base}/iso/set`);
      // Page A really did set them: its own title reads all three back.
      expect(a.error).toBeNull();
      expect(a.title).toBe("cookie=[srv=1; js=1] ls=[1]");

      const b = await renderer.render(`${site.base}/iso/read`);
      expect(b.error).toBeNull();
      // Page B, next in the same context, sees none of them…
      expect(b.title).toBe("cookie=[] ls=[null]");
      // …and the server was not sent the cookies either.
      const readHit = site.hits.slice(before).find((h) => h.path === "/iso/read")!;
      expect(readHit.cookie).toBeUndefined();

      // THE CACHE SURVIVED: `/shared.js` was asked for once across two pages,
      // and page B's copy came from the cache, without a gate slot.
      const shared = site.hits.slice(before).filter((h) => h.path === "/shared.js");
      expect(shared.length).toBe(1);
      expect(b.cachedResponses).toBe(1);
      expect(b.pacedRequests).toBe(1); // the document only
      expect(b.unpacedNetworkRequests).toBe(0);
    } finally {
      await renderer.close();
    }
  });

  it("classifies a page that cannot finish inside its budget at the site's pace", async () => {
    // Review Focus 5's second half: six scripts at 500 ms need 3 s; the budget
    // is 2 s. A classified `render_error`, never a dropped URL.
    const renderer = await launch({ perHostDelayMs: 500, navigationTimeoutMs: 2_000 });
    try {
      const result = await renderer.render(`${site.base}/paced`);

      expect(result.rendered).toBe(false);
      expect(result.error).toMatch(
        /^timeout under pacing \(\d+ requests paced\): navigation did not reach domcontentloaded within 2000ms$/,
      );
      expect(result.pacedRequests).toBeGreaterThan(1);
      expect(result.wordCount).toBeNull();
    } finally {
      await renderer.close();
    }
  });

  it("escalates the host on a subresource 429 and counts it", async () => {
    const renderer = await launch();
    try {
      const host = new URL(site.base).host;
      expect(renderer.effectiveDelayMs()).toBe(0);

      const result = await renderer.render(`${site.base}/limited`);

      // The page still renders: a refused script is the site's, not a failure.
      expect(result.rendered).toBe(true);
      const record = renderer.throttleRecord()[host]!;
      expect(record.responses429).toBe(1);
      expect(record.retryAfterSeen).toBe(1);
      expect(record.escalations).toBe(1);
      // Base 0 escalates from the gate's 500 ms seed: ×2.
      expect(renderer.effectiveDelayMs()).toBe(1_000);
    } finally {
      await renderer.close();
    }
  });

  it("re-enters the host at the spacing the crawl earned, from its first render", async () => {
    // §3.4.1: configured 1000 ms, escalated twice by the crawl to 4000 ms. The
    // first render's script waits 4 s after its document, not 1 s.
    const host = new URL(site.base).host;
    const seeded: HostSpacingEntry = {
      spacingMs: 4_000,
      baseMs: 1_000,
      responses429: 2,
      retryAfterSeen: 0,
      escalations: 2,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 4_000,
    };
    const renderer = await launch({ perHostDelayMs: 1_000, hostSpacing: { [host]: seeded } });
    try {
      expect(renderer.effectiveDelayMs()).toBe(4_000);
      const before = site.hits.length;

      const result = await renderer.render(`${site.base}/one-script`);

      expect(result.error).toBeNull();
      const hits = site.hits.slice(before);
      const doc = hits.find((h) => h.path === "/one-script")!;
      const script = hits.find((h) => h.path === "/one.js")!;
      expect(script.at - doc.at).toBeGreaterThanOrEqual(4_000 - toleranceMs);
      // The crawl's counters ride on: the record is the crawl's plus the render's.
      expect(renderer.throttleSnapshot()[host]!.responses429).toBe(2);
    } finally {
      await renderer.close();
    }
  }, 30_000);

  it("never predicts a URL twice once a prediction for it was wrong", async () => {
    // The priming page teaches the ledger; the fetch-only pages then ask for the URL.
    // Which page the wrong prediction lands on depends on CDP event order, so assert
    // the releases themselves: exactly one prediction, never a second.
    const releases: { url: string; predicted: boolean }[] = [];
    const renderer = await launch({ testFaults: { onRelease: (url, _at, r) => releases.push({ url, predicted: r.predicted }) } });
    try {
      expect((await renderer.render(`${site.base}/mispredict/prime`)).error).toBeNull();
      let unpaced = 0;
      for (const n of [1, 2, 3]) {
        const result = await renderer.render(`${site.base}/mispredict/fetch/${n}`);
        expect(result.error).toBeNull();
        unpaced += result.unpacedNetworkRequests;
      }
      const volatile = releases.filter((r) => r.url.endsWith("/volatile.js"));
      // The script on the priming page (paced), then three fetches.
      expect(volatile.map((r) => r.predicted)).toEqual([false, true, false, false]);
      expect(unpaced).toBe(1);
    } finally {
      await renderer.close();
    }
  });

  it("clears state AFTER the page is closed: unload and timer writes do not survive", async () => {
    // Fix round 1, I2. A teardown that cleared storage and THEN closed the
    // page left a window for these writes to land in the next page's context.
    const renderer = await launch();
    try {
      const writer = await renderer.render(`${site.base}/iso/unload`);
      expect(writer.error).toBeNull();

      const reader = await renderer.render(`${site.base}/iso/read`);
      expect(reader.error).toBeNull();
      expect(reader.title).toBe("cookie=[] ls=[null]");
    } finally {
      await renderer.close();
    }
  });

  it("sends nothing a page asks for once its render has ended", async () => {
    // SECURITY (fail-closed teardown). The traffic is shut before the page is
    // closed, so the pagehide requests and the timer's next ticks are failed,
    // never released — including the keepalive kinds that outlive a page.
    const renderer = await launch({ perHostDelayMs: 0 });
    try {
      const result = await renderer.render(`${site.base}/teardown`);
      expect(result.error).toBeNull();
      const atReturn = site.hits.length;

      await new Promise((resolve) => setTimeout(resolve, 750));

      const late = site.hits.slice(atReturn).map((h) => h.path);
      expect(late).toEqual([]);
      const all = site.hits.map((h) => h.path);
      expect(all).not.toContain("/teardown-beacon");
      expect(all).not.toContain("/teardown-keepalive");
      expect(all).not.toContain("/teardown-fetch");
    } finally {
      await renderer.close();
    }
  });

  it("reports an answer that arrives after the render ended, for a request it released", async () => {
    // Final review #3: a request released BEFORE the shut is on the wire, and
    // its answer is the site speaking about the host. The fetch is released
    // during the render and answered 429 only after it ended (the hold keeps
    // the page open across the answer); the 429 still reaches the gate.
    const renderer = await launch({
      testFaults: { holdAfterShut: () => new Promise((resolve) => setTimeout(resolve, 2_000)) },
    });
    try {
      const host = new URL(site.base).host;
      const result = await renderer.render(`${site.base}/late-429`);

      expect(result.error).toBeNull();
      // Released inside the render: the document and the fetch, both paced.
      expect(result.pacedRequests).toBe(2);
      const record = renderer.throttleRecord()[host]!;
      expect(record.responses429).toBe(1);
      expect(record.retryAfterSeen).toBe(1);
      expect(record.escalations).toBe(1);
    } finally {
      await renderer.close();
    }
  }, 30_000);

  it("fails the requests it holds when a protocol command breaks, and releases none", async () => {
    // SECURITY (fail-closed on a session failure). The release of the third
    // script fails as a refused protocol command would; the render must
    // throw it (ours, not the site's), and neither that script nor the three
    // still queued behind it may reach the server.
    const before = site.hits.length;
    const broken = new Error("injected: Fetch.continueRequest refused");
    const renderer = await launch({
      perHostDelayMs: 100,
      testFaults: {
        failRelease: (url) => (url.endsWith("/paced/3.js") ? broken : null),
      },
    });
    try {
      await expect(renderer.render(`${site.base}/paced`)).rejects.toBe(broken);
      await new Promise((resolve) => setTimeout(resolve, 750));
      const paths = site.hits.slice(before).map((h) => h.path);
      expect(paths).toEqual(["/paced", "/paced/1.js", "/paced/2.js"]);
    } finally {
      await renderer.close();
    }
  });

  it("fences off what the interception cannot see, and counts what it cannot stop", async () => {
    // Fix round 1, I3 + SECURITY (interception bypass). Measured bypasses of
    // a page-session `Fetch` interception, each closed or accounted for:
    //  - WebSockets (origin and elsewhere): the network fence drops them;
    //  - a shared worker and its own fetch: shared workers are disabled;
    //  - a prerender: disabled, so `/spec-pre.js` is never asked for;
    //  - a speculation-rules prefetch of ANOTHER origin: fenced;
    //  - a speculation-rules prefetch of THIS origin: not stoppable in this
    //    build — it may arrive, and every one that does is counted.
    const renderer = await launch();
    try {
      const beforeSite = site.hits.length;
      const beforeThird = third.hits.length;

      const result = await renderer.render(`${site.base}/escape`);
      expect(result.error).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const sitePaths = site.hits.slice(beforeSite).map((h) => h.path);
      expect(sitePaths.filter((p) => p.startsWith("UPGRADE"))).toEqual([]);
      expect(sitePaths).not.toContain("/shared-worker.js");
      expect(sitePaths).not.toContain("/from-shared-worker");
      expect(sitePaths).not.toContain("/spec-pre.js");
      expect(third.hits.slice(beforeThird)).toEqual([]);
      expect(renderer.fencedConnections()).toBeGreaterThanOrEqual(1);

      // The same-origin prefetch does arrive (this build cannot be told not
      // to), and every speculative arrival is in the count.
      const speculative = sitePaths.filter((p) => p === "/spec-pf" || p === "/spec-pre");
      expect(speculative).toContain("/spec-pf");
      expect(result.unpacedNetworkRequests).toBe(speculative.length);
    } finally {
      await renderer.close();
    }
  });

  it("puts every redirect hop through url-policy", async () => {
    // Fix round 1, M4. The 302 names the metadata address, which url-policy
    // refuses even with `allowPrivate` on.
    const renderer = await launch();
    try {
      const result = await renderer.render(`${site.base}/redirect/policy`);
      expect(result.rendered).toBe(false);
      expect(result.error).toMatch(/^policy refusal: http:\/\/169\.254\.169\.254\/latest\/meta-data\/ \(/);
    } finally {
      await renderer.close();
    }
  });

  it("paces a redirect hop like any other request", async () => {
    const spacingMs = 300;
    const renderer = await launch({ perHostDelayMs: spacingMs });
    try {
      await renderer.render(`${site.base}/static/warm-redirect`);
      const before = site.hits.length;

      const result = await renderer.render(`${site.base}/redirect/hop`);

      expect(result.error).toBeNull();
      const hits = site.hits.slice(before);
      expect(hits.map((h) => h.path)).toEqual(["/redirect/hop", "/static/hop"]);
      expect(hits[1]!.at - hits[0]!.at).toBeGreaterThanOrEqual(spacingMs - toleranceMs);
      expect(result.pacedRequests).toBe(2);
    } finally {
      await renderer.close();
    }
  });

  it("renders a NAMED origin through the address url-policy approved, pinned", async () => {
    // Fix round 2, DNS pin. `shop.test` resolves nowhere on this machine; the
    // only way the browser reaches the fixture is the `--host-resolver-rules`
    // mapping to the address the injected resolver gave url-policy. The
    // resolver is asked only at launch — A + AAAA for `shop.test` and for
    // `www.shop.test` — and a later change of answer is never asked for, so
    // it cannot redirect the pass.
    const port = new URL(site.base).port;
    const origin = `http://shop.test:${port}`;
    let lookups = 0;
    let answer = "127.0.0.1";
    const renderer = await PageRenderer.launch({
      origin,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render pin test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      resolve: async (_host, type) => {
        lookups += 1;
        return type === "A" ? [answer] : [];
      },
    });
    try {
      expect(lookups).toBe(4);
      expect(renderer.unpinnedHosts()).toEqual([]);
      const first = await renderer.render(`${origin}/csr`);
      expect(first.error).toBeNull();
      expect(first.wordCount).toBe(CSR_RENDERED_WORDS);
      // Rebinding: the name now "answers" a private address elsewhere. The
      // browser never asks; the pin holds.
      answer = "10.9.9.9";
      const second = await renderer.render(`${origin}/csr`);
      expect(second.error).toBeNull();
      expect(lookups).toBe(4);
      // Fix round 3: the `www.` spelling `isSameOrigin` admits is pinned and
      // exempt from the fence too, so a page on it renders.
      const www = await renderer.render(`http://www.shop.test:${port}/csr`);
      expect(www.error).toBeNull();
      expect(www.wordCount).toBe(CSR_RENDERED_WORDS);
    } finally {
      await renderer.close();
    }
  });

  it("leaves a spelling whose address is refused out of the pin, and says so", async () => {
    // Fix round 3: `www.shop.test` answers a metadata address, which url-policy
    // refuses even under `allowPrivate`. The launch still succeeds on the
    // crawl's own hostname; the refused spelling is recorded, and a page on it
    // is a classified render error — never a silent drop.
    const port = new URL(site.base).port;
    const renderer = await PageRenderer.launch({
      origin: `http://shop.test:${port}`,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render pin test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      resolve: async (host, type) =>
        type !== "A" ? [] : host === "www.shop.test" ? ["169.254.169.254"] : ["127.0.0.1"],
    });
    try {
      const unpinned = renderer.unpinnedHosts();
      expect(unpinned.map((u) => u.host)).toEqual(["www.shop.test"]);
      expect(unpinned[0]!.reason).toMatch(/blocked address space \(169\.254\.169\.254/);

      const result = await renderer.render(`http://www.shop.test:${port}/csr`);
      expect(result.rendered).toBe(false);
      expect(result.error).toMatch(/^policy refusal: www\.shop\.test was not approved for this pass \(/);
      // The crawl's own spelling is unaffected.
      expect((await renderer.render(`http://shop.test:${port}/csr`)).error).toBeNull();
    } finally {
      await renderer.close();
    }
  });

  it("says a spelling's resolver failure plainly, and keeps the resolver's text for the log", async () => {
    // Fix round 4: the DoH resolver's own message (transport error, HTTP
    // status, rcode) reaches the API through `unpinnedHosts[].reason` and the
    // render error, so `reason` says only that the name could not be resolved
    // and `detail` carries the resolver's text for the server log alone.
    const port = new URL(site.base).port;
    const renderer = await PageRenderer.launch({
      origin: `http://shop.test:${port}`,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render pin test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      resolve: async (host, type) => {
        if (host === "www.shop.test") {
          throw new UrlPolicyError(
            "DNS_RESOLUTION_FAILED",
            `DoH ${type} lookup for ${host} failed: TypeError: fetch failed (ECONNREFUSED 10.0.0.53:443)`,
          );
        }
        return type === "A" ? ["127.0.0.1"] : [];
      },
    });
    try {
      const unpinned = renderer.unpinnedHosts();
      expect(unpinned).toHaveLength(1);
      expect(unpinned[0]!.host).toBe("www.shop.test");
      expect(unpinned[0]!.reason).toBe("www.shop.test could not be resolved");
      expect(unpinned[0]!.detail).toMatch(/^DoH A lookup for www\.shop\.test failed: TypeError: fetch failed/);

      const result = await renderer.render(`http://www.shop.test:${port}/csr`);
      expect(result.rendered).toBe(false);
      expect(result.error).toBe(
        "policy refusal: www.shop.test was not approved for this pass (www.shop.test could not be resolved)",
      );
    } finally {
      await renderer.close();
    }
  });

  it("fails the launch on a resolver defect, even when it is the other spelling that hit it", async () => {
    // Fix round 4, rule 7: only a `UrlPolicyError` is a fact about the site
    // that leaves a spelling unpinned. A resolver that throws anything else is
    // broken, and a launch over a broken resolver is a loud failure, not a
    // pass that quietly renders without the `www.` spelling.
    const defect = new Error("resolver exploded");
    await expect(
      PageRenderer.launch({
        origin: "http://shop.test:8080",
        htmlDir,
        userAgent: "AriadneBot/0.1 (render pin test)",
        perHostDelayMs: 0,
        allowPrivate: true,
        resolve: async (host, type) => {
          if (host === "www.shop.test") throw defect;
          return type === "A" ? ["127.0.0.1"] : [];
        },
      }),
    ).rejects.toBe(defect);
  });

  it("refuses to launch for an origin whose name resolves into blocked space", async () => {
    await expect(
      PageRenderer.launch({
        origin: "http://shop.test:8080",
        htmlDir,
        userAgent: "AriadneBot/0.1 (render pin test)",
        perHostDelayMs: 0,
        resolve: async (_host, type) => (type === "A" ? ["93.184.216.34", "127.0.0.1"] : []),
      }),
    ).rejects.toThrow(/resolves into blocked address space/);
  });

  it("names every spelling isSameOrigin admits", () => {
    expect(originVariants("https://shop.com")).toEqual({
      hostnames: ["shop.com", "www.shop.com"],
      schemePorts: [{ protocol: "https:", port: "443" }],
    });
    expect(originVariants("http://www.shop.com/")).toEqual({
      hostnames: ["www.shop.com", "shop.com"],
      schemePorts: [
        { protocol: "http:", port: "80" },
        { protocol: "https:", port: "443" },
      ],
    });
    // An explicit port is as-is, and has no upgrade partner.
    expect(originVariants("http://shop.com:8080").schemePorts).toEqual([
      { protocol: "http:", port: "8080" },
    ]);
    // An IP literal has no `www.` spelling.
    expect(originVariants("http://127.0.0.1:3000").hostnames).toEqual(["127.0.0.1"]);
    expect(originVariants("http://[2001:db8::1]:8080").hostnames).toEqual(["[2001:db8::1]"]);
    // Fix round 4: the one spelling `isSameOrigin` admits that is NOT listed,
    // deliberately — nobody owns `www.www.shop.com`, and a URL on it fails as a
    // classified policy refusal instead. (`www.127.0.0.1` is not a hostname
    // the URL parser accepts at all, so `isSameOrigin` never admits it.)
    expect(isSameOrigin("http://www.www.shop.com/", "http://www.shop.com")).toBe(true);
    expect(originVariants("http://www.shop.com").hostnames).not.toContain("www.www.shop.com");
    expect(isSameOrigin("http://www.127.0.0.1:3000/", "http://127.0.0.1:3000")).toBe(false);
  });

  it("builds network switches that pin every approved spelling's port and address", () => {
    // Fix round 2, I-NEW-1: a bypass rule without a port matches EVERY port,
    // and a default-port origin's `URL.host` has none.
    expect(
      browserNetworkSwitches({
        origin: "https://shop.com",
        fencePort: 4100,
        pinned: [
          { hostname: "shop.com", address: "203.0.113.7" },
          { hostname: "www.shop.com", address: "203.0.113.8" },
        ],
      }),
    ).toEqual([
      "--proxy-server=http://127.0.0.1:4100",
      "--proxy-bypass-list=<-loopback>;https://shop.com:443;https://www.shop.com:443",
      "--host-resolver-rules=MAP shop.com 203.0.113.7,MAP www.shop.com 203.0.113.8," +
        "MAP * ~NOTFOUND,EXCLUDE 127.0.0.1",
    ]);
    // Default-port http: both the origin's own :80 and the https:443 upgrade.
    expect(
      browserNetworkSwitches({
        origin: "http://shop.com/",
        fencePort: 4100,
        pinned: [{ hostname: "shop.com", address: "203.0.113.7" }],
      })[1],
    ).toBe("--proxy-bypass-list=<-loopback>;http://shop.com:80;https://shop.com:443");
    // Explicit port, and an IPv6 pinned address (bracketed in a MAP).
    expect(
      browserNetworkSwitches({
        origin: "https://shop.com:8443",
        fencePort: 4100,
        pinned: [{ hostname: "shop.com", address: "2001:db8::7" }],
      }).slice(1),
    ).toEqual([
      "--proxy-bypass-list=<-loopback>;https://shop.com:8443",
      "--host-resolver-rules=MAP shop.com [2001:db8::7],MAP * ~NOTFOUND,EXCLUDE 127.0.0.1",
    ]);
    // An IP-literal origin: brackets kept in the bypass, BARE in the EXCLUDE
    // (Chromium does not match a bracketed EXCLUDE — fix round 3).
    expect(
      browserNetworkSwitches({
        origin: "http://[2001:db8::1]:8080",
        fencePort: 4100,
        pinned: [{ hostname: "[2001:db8::1]", address: "2001:db8::1" }],
      }).slice(1),
    ).toEqual([
      "--proxy-bypass-list=<-loopback>;http://[2001:db8::1]:8080",
      "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE 2001:db8::1",
    ]);
    expect(
      browserNetworkSwitches({
        origin: "https://[2001:db8::1]",
        fencePort: 4100,
        pinned: [{ hostname: "[2001:db8::1]", address: "2001:db8::1" }],
      })[1],
    ).toBe("--proxy-bypass-list=<-loopback>;https://[2001:db8::1]:443");
  });

  it("refuses to launch over a spacing record it cannot read", async () => {
    await expect(launch({ hostSpacing: { "a.example": "fast" } })).rejects.toThrow(
      /host_spacing_jsonb cannot be restored/,
    );
  });

  it("predicts the cache only from an explicit, positive max-age", () => {
    expect(freshLifetimeMs({ "cache-control": "public, max-age=3600" })).toBe(3_600_000 - 5_000);
    expect(freshLifetimeMs({ "cache-control": "max-age=3600", age: "600" })).toBe(
      3_000_000 - 5_000,
    );
    expect(freshLifetimeMs({ "cache-control": "max-age=3600, no-cache" })).toBeNull();
    expect(freshLifetimeMs({ "cache-control": "no-store" })).toBeNull();
    expect(freshLifetimeMs({ "cache-control": "max-age=3" })).toBeNull();
    expect(freshLifetimeMs({ "cache-control": "max-age=3600", vary: "*" })).toBeNull();
    // M8: Vary absent or exactly Accept-Encoding, and nothing else.
    expect(freshLifetimeMs({ "cache-control": "max-age=3600", vary: "Accept-Encoding" })).toBe(
      3_600_000 - 5_000,
    );
    expect(freshLifetimeMs({ "cache-control": "max-age=3600", vary: "Cookie" })).toBeNull();
    expect(
      freshLifetimeMs({ "cache-control": "max-age=3600", vary: "accept-encoding, User-Agent" }),
    ).toBeNull();
    // A repeated header arrives newline-joined: its no-store still counts.
    expect(freshLifetimeMs({ "cache-control": "max-age=3600\nno-store" })).toBeNull();
    expect(freshLifetimeMs({ "last-modified": "Tue, 01 Jan 2030 00:00:00 GMT" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The pass driver, against the database.
// ---------------------------------------------------------------------------

describe("runRenderPass", () => {
  let db: Db;
  let site: Site;
  let third: Site;
  /** The root the pass makes its per-crawl directory under. See `passConfig`. */
  let htmlRoot: string;
  const createdCrawls: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
    third = await startThirdParty();
    site = await startSite(() => third.base);
    htmlRoot = await mkdtemp(join(tmpdir(), "ariadne-render-pass-"));
  }, 120_000);

  afterAll(async () => {
    for (const id of createdCrawls) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
    await site.close();
    await third.close();
    await rm(htmlRoot, { recursive: true, force: true });
  });

  function passConfig(overrides: Record<string, unknown> = {}): Parameters<typeof runRenderPass>[2] {
    return {
      siteUrl: site.base,
      userAgent: "AriadneBot/0.1 (render pass test)",
      perHostDelayMs: 0,
      // These sites are 1-3 pages: the production 5% budget would round down to
      // a single seat and the test would be asserting the budget, not the pass.
      renderBudgetPct: 100,
      allowPrivate: true,
      settleMs: SETTLE_MS,
      // A temporary root, not the production `renders/`: the pass creates
      // `<root>/<crawlId>/` under it and this suite runs dozens of crawls.
      renderHtmlDir: htmlRoot,
      // No `navigationTimeoutMs`: the pass gets the production 15s. Only the
      // `/hang` test below overrides it, because only that test is about a
      // navigation deadline — see the module header.
      renderConcurrency: 2,
      ...overrides,
    } as Parameters<typeof runRenderPass>[2];
  }

  /**
   * A crawl with page rows for `paths`, each one a suspect (no outgoing links)
   * so the whole set is selected. Rows are inserted rather than crawled: what
   * is under test is the pass, not the crawler that fed it.
   */
  async function newCrawl(
    paths: string[],
    where: { base?: string; siteUrl?: string } = {},
  ): Promise<string> {
    const base = where.base ?? site.base;
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: where.siteUrl ?? site.base,
      config: {},
      rulesetVersion: "test",
      status: "finished",
    });
    createdCrawls.push(id);
    await db.insert(pages).values(
      paths.map((path) => ({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `${base}${path}`,
        urlNormalised: `${base}${path}`,
        pageType: "content",
        fetchClass: "ok",
        statusCode: 200,
        isIndexable: true,
        wordCount: 2,
        htmlBytes: 1_000,
        title: "A page",
        depth: 1,
        discoveredVia: "link",
      })),
    );
    // Every page is `done` in the frontier, which is what a crawled URL is —
    // and what `selectRenderSet` promotes out of.
    const urls = paths.map((path) => `${base}${path}`);
    await enqueueUrls(
      db,
      id,
      urls.map((url) => ({ url, depth: 1, discoveredVia: "link" })),
    );
    await completeUrls(db, id, urls);
    return id;
  }

  async function pageRow(crawlId: string, path: string) {
    const rows = await db
      .select()
      .from(pages)
      .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${site.base}${path}`)));
    return rows[0]!;
  }

  it("pins the pass defaults", () => {
    expect(RENDER_PASS_DEFAULTS.renderConcurrency).toBe(4);
  });

  it("refuses to run while the crawl is still live", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // A URL the crawl has not reached yet, leased by the worker still crawling.
    // Selecting now would upsert `render_pending` over rows that worker owns.
    await enqueueUrls(db, crawlId, [
      { url: `${site.base}/still-crawling`, depth: 1, discoveredVia: "link" },
    ]);
    const leased = await leaseBatch(db, crawlId, "worker-crawl", 1, 60);
    expect(leased.length).toBe(1);

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(/live crawl/i);
    // And it refused BEFORE selecting: nothing moved.
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(0);
  });

  it("refuses to run while another render pass holds leases", async () => {
    const crawlId = await newCrawl(["/csr", "/static/8"]);
    // The other pass: it selected, and its worker is holding a URL. Note that
    // this leaves NO row in state 'leased' — a render lease does not change
    // state — so the live-crawl check above cannot see this at all.
    await selectRenderSet(db, crawlId, { renderBudgetPct: 100 });
    const held = await leaseRenderUrls(db, crawlId, "other-render-worker", 1, 600);
    expect(held.length).toBe(1);
    expect((await frontierCounts(db, crawlId)).leased).toBe(0);

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(
      /another render pass/i,
    );
    // The other pass's rows are exactly where it left them.
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(2);

    // An EXPIRED render lease is a dead worker's, and reclaiming it is the
    // resume mechanism — so it must not keep the guard shut forever.
    await db.execute(sql`
      update frontier set leased_until = now() - interval '1 hour'
      where crawl_id = ${crawlId} and leased_until is not null`);
    const summary = await runRenderPass(db, crawlId, passConfig());
    expect(summary.rendered).toBe(2);
  });

  describe("a pass that cannot launch (Phase 25 T4)", () => {
    async function launchErrorOf(crawlId: string): Promise<string | null> {
      const rows = await db
        .select({ e: crawls.renderLaunchError })
        .from(crawls)
        .where(eq(crawls.id, crawlId));
      return rows[0]!.e;
    }

    async function coverage(crawlId: string): Promise<Record<string, unknown>> {
      const rule = renderMetrics.find((r) => r.id === "render.coverage")!;
      const rows = await rule.run(db, crawlId);
      return rows[0]!.value as Record<string, unknown>;
    }

    it("leaves rows pending, records why, and coverage says failed", async () => {
      const crawlId = await newCrawl(["/csr", "/js-redirect"]);
      const raw = new Error("browserType.launch: /home/tenant/.cache/ms-playwright missing");
      const spy = vi.spyOn(PageRenderer, "launch").mockRejectedValueOnce(raw);
      try {
        // The original error is rethrown unchanged.
        await expect(runRenderPass(db, crawlId, passConfig())).rejects.toBe(raw);
      } finally {
        spy.mockRestore();
      }
      expect((await frontierCounts(db, crawlId)).renderPending).toBe(2);
      const recorded = await launchErrorOf(crawlId);
      expect(recorded).toBe("the render browser could not be launched");
      expect(recorded).not.toContain("/home/tenant");
      const value = await coverage(crawlId);
      expect(value.renderPassEvidence).toBe(RENDER_PASS_EVIDENCE.failed);
      expect(value.renderLaunchError).toBe(recorded);
    });

    it("keeps the last launched pass's renderPassCount when a later pass cannot start", async () => {
      const crawlId = await newCrawl(["/csr"]);
      // An earlier pass rendered 50 pages: that count is the "a render
      // happened" signal the audit skill reads, and the failed launch must not
      // erase it.
      await db.update(crawls).set({ renderPassCount: 50 }).where(eq(crawls.id, crawlId));
      const spy = vi.spyOn(PageRenderer, "launch").mockRejectedValueOnce(new Error("no browser"));
      try {
        await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow("no browser");
      } finally {
        spy.mockRestore();
      }
      const rows = await db
        .select({ n: crawls.renderPassCount })
        .from(crawls)
        .where(eq(crawls.id, crawlId));
      expect(rows[0]!.n).toBe(50);
      expect((await coverage(crawlId)).renderPassEvidence).toBe(RENDER_PASS_EVIDENCE.failed);
    });

    it("refuses a site URL that is not a URL before selecting, and records no launch error", async () => {
      const crawlId = await newCrawl(["/csr"]);
      const before = await frontierCounts(db, crawlId);
      await expect(
        runRenderPass(db, crawlId, passConfig({ siteUrl: "not a url" })),
      ).rejects.toThrow(/siteUrl is not a URL/);
      // Nothing was selected and nothing was recorded as a launch failure.
      expect(await frontierCounts(db, crawlId)).toEqual(before);
      expect(await launchErrorOf(crawlId)).toBeNull();
    });

    it("records a launch-time UrlPolicyError as an address refusal, with no resolver text", async () => {
      const crawlId = await newCrawl(["/csr"]);
      const refusal = new UrlPolicyError(
        "CRAWL_TARGET_BLOCKED",
        "host resolves to a private address",
        { cause: new Error("getaddrinfo ENOTFOUND resolver.internal.tenant.example") },
      );
      const spy = vi.spyOn(PageRenderer, "launch").mockRejectedValueOnce(refusal);
      try {
        await expect(runRenderPass(db, crawlId, passConfig())).rejects.toBe(refusal);
      } finally {
        spy.mockRestore();
      }
      // The selection stands: the row the refused pass chose is still waiting
      // to be rendered, exactly as after a browser that would not launch.
      expect((await frontierCounts(db, crawlId)).renderPending).toBe(1);
      const recorded = await launchErrorOf(crawlId);
      expect(recorded).toBe(
        "address refused: host resolves to a private address (CRAWL_TARGET_BLOCKED)",
      );
      expect(recorded).not.toContain("getaddrinfo");
      expect(recorded).not.toContain("tenant.example");
      // And the metric reads the same column: `failed`, with the reason beside it.
      const value = await coverage(crawlId);
      expect(value.renderPassEvidence).toBe(RENDER_PASS_EVIDENCE.failed);
      expect(value.renderLaunchError).toBe(recorded);
    });

    it("records an uncreatable render directory without the path", async () => {
      const crawlId = await newCrawl(["/csr"]);
      // A directory beneath a regular file cannot be created.
      const file = join(htmlRoot, `not-a-dir-${randomUUID()}`);
      await writeFile(file, "x");
      await expect(
        runRenderPass(db, crawlId, passConfig({ renderHtmlDir: file })),
      ).rejects.toThrow();
      const recorded = await launchErrorOf(crawlId);
      expect(recorded).toBe("the render directory could not be created");
      expect((await coverage(crawlId)).renderPassEvidence).toBe(RENDER_PASS_EVIDENCE.failed);
    });

    it("keeps the original launch error when recording it fails too", async () => {
      const crawlId = await newCrawl(["/csr"]);
      const raw = new Error("no browser");
      const spy = vi.spyOn(PageRenderer, "launch").mockRejectedValueOnce(raw);
      const failing = {
        update: () => {
          throw new Error("db down");
        },
      } as unknown as Db;
      // selection runs on the real db inside a transaction, so wrap only the
      // post-selection update: proxy `update`, delegate everything else.
      const proxy = new Proxy(db, {
        get: (target, prop, receiver) =>
          prop === "update" ? failing.update : Reflect.get(target, prop, receiver),
      });
      try {
        const err = await runRenderPass(proxy, crawlId, passConfig()).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AggregateError);
        expect((err as AggregateError).errors[0]).toBe(raw);
      } finally {
        spy.mockRestore();
      }
    });

    it("a later pass that launches clears it", async () => {
      const crawlId = await newCrawl(["/csr"]);
      const spy = vi
        .spyOn(PageRenderer, "launch")
        .mockRejectedValueOnce(new Error("no browser"));
      try {
        await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow("no browser");
      } finally {
        spy.mockRestore();
      }
      expect(await launchErrorOf(crawlId)).not.toBeNull();

      const summary = await runRenderPass(db, crawlId, passConfig());
      expect(summary.rendered).toBe(1);
      expect(await launchErrorOf(crawlId)).toBeNull();
      const value = await coverage(crawlId);
      expect(value.renderPassEvidence).toBe(RENDER_PASS_EVIDENCE.ran);
      expect(value.renderLaunchError).toBeNull();
    });
  });

  it("refuses to run while the crawl row still says running", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // No lease outstanding — a live crawl between batches, or one that died
    // mid-run and was never resumed or marked failed. Its frontier is in
    // flight either way, and its next lease would take rows we promoted.
    await db.update(crawls).set({ status: "running" }).where(eq(crawls.id, crawlId));

    await expect(runRenderPass(db, crawlId, passConfig())).rejects.toThrow(/'running'/);
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(0);
  });

  it("renders a finished crawl that stopped at maxPages with URLs still queued", async () => {
    const crawlId = await newCrawl(["/csr"]);
    // What a capped crawl looks like: `finished`, with the frontier it never
    // got to still `pending`. On a real site this is the NORMAL outcome, so
    // refusing a queued frontier would refuse most crawls there are — the
    // guard asks whether the crawl stopped, not whether it drained.
    await enqueueUrls(db, crawlId, [
      { url: `${site.base}/never-reached`, depth: 1, discoveredVia: "link" },
    ]);
    expect((await frontierCounts(db, crawlId)).pending).toBe(1);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(1);
    expect((await pageRow(crawlId, "/csr")).rendered).toBe(true);
    // The URL the crawl never reached is left exactly where it was: the render
    // pass selects out of `pages`, and that URL has no page row.
    const counts = await frontierCounts(db, crawlId);
    expect(counts.pending).toBe(1);
    expect(counts.renderPending).toBe(0);
  });

  it("renders the selection, writes the columns and settles the frontier", async () => {
    const crawlId = await newCrawl(["/csr", "/js-redirect"]);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(2);
    expect(summary.failures).toBe(0);
    expect(summary.selection.selected.sort()).toEqual(
      [`${site.base}/csr`, `${site.base}/js-redirect`].sort(),
    );

    const csr = await pageRow(crawlId, "/csr");
    expect(csr.rendered).toBe(true);
    expect(csr.renderedWordCount).toBe(CSR_RENDERED_WORDS);
    expect(csr.renderedLinkCount).toBe(6);
    expect(csr.renderedNavLinkCount).toBe(2);
    expect(csr.renderedFooterLinkCount).toBe(2);
    expect(csr.renderedFilterLinkCount).toBe(3);
    expect(csr.renderedRedirectUrl).toBeNull();
    expect(csr.renderError).toBeNull();
    // The P8 family, written by the same statement: `rendered = true` never
    // reaches the database with one family filled and the other empty.
    expect(csr.renderedAnalyzerWordCount).toBe(CSR_RENDERED_WORDS);
    expect(csr.renderedRenderableWordCount).toBe(CSR_RENDERED_WORDS);
    expect(csr.renderedTitle).toBe("CSR");
    expect(csr.renderedH1Count).toBe(1);
    expect(csr.renderedCanonical).toBeNull();
    // P23-T6, in the same statement: the three values the divergence rules
    // compare, and the flag that says this pass read them — so a null among
    // them on this row would mean "the DOM had none", not "nobody looked".
    expect(csr.renderedRobotsMeta).toBe(CSR_ROBOTS);
    expect(csr.renderedMetaDescription).toBe(CSR_DESCRIPTION);
    expect(csr.renderedH1Text).toBe(CSR_H1);
    expect(csr.renderedTagsRead).toBe(true);
    // …and the document itself, under the directory the PASS created for this
    // crawl. One file per rendered page, and the crawl id in the path is what
    // makes a run's evidence a thing a reader can archive or delete whole.
    const crawlDir = join(htmlRoot, crawlId);
    expect(csr.renderedHtmlPath).toBe(
      join(crawlDir, renderedHtmlFilename(`${site.base}/csr`)),
    );
    expect((await readdir(crawlDir)).sort()).toEqual(
      [
        renderedHtmlFilename(`${site.base}/csr`),
        renderedHtmlFilename(`${site.base}/js-redirect`),
      ].sort(),
    );

    const redirected = await pageRow(crawlId, "/js-redirect");
    expect(redirected.renderedRedirectUrl).toBe(`${site.base}/csr`);

    const counts = await frontierCounts(db, crawlId);
    expect(counts.renderPending).toBe(0);
    expect(counts.done).toBe(2);

    const crawl = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    expect(crawl.renderPassCount).toBe(2);
  });

  it("records a failed render as evidence and never retries it", async () => {
    const crawlId = await newCrawl(["/hang"]);

    // The other half of the `/hang` pair, and the only pass in this file that
    // shortens the navigation timeout: this URL never answers, so the pass can
    // only get its failure by waiting the deadline out.
    const summary = await runRenderPass(
      db,
      crawlId,
      passConfig({ navigationTimeoutMs: NAV_TIMEOUT_MS }),
    );

    expect(summary.rendered).toBe(0);
    expect(summary.failures).toBe(1);

    const row = await pageRow(crawlId, "/hang");
    expect(row.rendered).toBe(false);
    expect(row.renderError).toMatch(/^timeout under pacing \(\d+ requests paced\): /);
    expect(row.renderedWordCount).toBeNull();
    expect(row.renderedRenderableWordCount).toBeNull();
    expect(row.renderedHtmlPath).toBeNull();
    // A failed render read nothing, so it says so: no tags-read flag, and no
    // value for a divergence rule to mistake for an absence.
    expect(row.renderedRobotsMeta).toBeNull();
    expect(row.renderedMetaDescription).toBeNull();
    expect(row.renderedH1Text).toBeNull();
    expect(row.renderedTagsRead).toBeNull();

    const frontierRows = await db
      .select()
      .from(frontier)
      .where(and(eq(frontier.crawlId, crawlId), eq(frontier.url, `${site.base}/hang`)));
    expect(frontierRows[0]!.state).toBe("done");
    // One lease, one attempt, no retry loop: the failure is the record.
    expect(frontierRows[0]!.attempts).toBe(1);
  });

  it("spaces same-host navigations by the configured per-host delay", async () => {
    // WARM-UP, and it is load-bearing.
    //
    // The measured gaps are between server-side ARRIVALS, so anything sitting
    // between acquiring the host gate and the request reaching the socket lands
    // inside a gap: gap = delay + (latency of the later navigation - latency of
    // the earlier one). That latency is not symmetric. A browser's FIRST
    // navigation pays to spin up its first renderer process and page in
    // Chromium's libraries; the ones after it do not. So the first arrival
    // slipped late, the second was on time, the gap between them came out
    // ~950ms, and under load this flaked about one run in three.
    //
    // The Phase 5 ruling stands and the tolerance below must NOT be widened: it
    // guards a ~57ms bug and a wider margin would hide it. The asymmetry is the
    // thing to remove, so FOUR pages are rendered and the first arrival is
    // discarded as the warm-up. It has to be a page in THIS pass, not a
    // separate one: `runRenderPass` launches its own browser, so a warm-up in
    // another pass leaves this browser's first navigation still cold (measured:
    // it bought ~15ms of the ~50ms needed).
    //
    // Which of the four is the warm-up is not fixed — three workers race for
    // the gate — and it does not need to be: they are the same page, so
    // dropping arrival[0] drops the cold one whichever URL it was. The two gaps
    // that remain are between warm navigations, and both still see the ~57ms
    // bug, which was paid on every render rather than only the first.
    const paths = ["/static/1", "/static/2", "/static/3", "/static/4"];
    const crawlId = await newCrawl(paths);
    const before = site.hits.length;
    // A SECOND OF DELAY AGAINST 50ms OF TOLERANCE, deliberately. The bug this
    // test exists to catch — acquiring the gate before launching the context,
    // so our own setup was spent out of the site's spacing — cost ~57ms and
    // slipped under a 400ms/50ms margin. The regression has to be impossible to
    // hide in timer noise, so the signal is 20x the noise.
    const delayMs = 1_000;
    const epsilonMs = 50;

    await runRenderPass(db, crawlId, passConfig({ perHostDelayMs: delayMs, renderConcurrency: 3 }));

    // Measured at the SERVER, not in the renderer: what politeness means is
    // when the request arrived, not when we decided to make it.
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path.startsWith("/static/"))
      .map((h) => h.at);
    expect(arrivals.length).toBe(4);
    // arrivals[0] is the warm-up. Every gap asserted is warm-to-warm.
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(delayMs - epsilonMs);
    expect(arrivals[3]! - arrivals[2]!).toBeGreaterThanOrEqual(delayMs - epsilonMs);
  });

  it("paces from the spacing the crawl earned, not the one it was configured with", async () => {
    // The gate crawl's exact situation: configured at 1000 ms, ratcheted to
    // 2000 ms by the site's own pushback, and the render pass that followed
    // went straight back to 1000 ms. `crawls.host_spacing_ms` is a finding, not
    // a setting, and a later pass over the same host does not get to forget it.
    const crawlId = await newCrawl(["/static/5", "/static/6", "/static/7"]);
    await db.update(crawls).set({ hostSpacingMs: 2_000 }).where(eq(crawls.id, crawlId));

    const before = site.hits.length;
    const configuredMs = 1_000;
    const earnedMs = 2_000;
    const epsilonMs = 50;

    await runRenderPass(
      db,
      crawlId,
      passConfig({ perHostDelayMs: configuredMs, renderConcurrency: 3 }),
    );

    // Measured at the SERVER, and with the same warm-up discipline the
    // configured-delay test above explains: the browser's first navigation is
    // cold, so arrivals[0] is dropped and the one remaining gap is warm-to-warm.
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path.startsWith("/static/"))
      .map((h) => h.at);
    expect(arrivals.length).toBe(3);
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(earnedMs - epsilonMs);
  });

  it("paces from the per-host state the crawl earned, at its level, not doubled again", async () => {
    // Phase 24a §3.4.1: the gate is seeded from `host_spacing_jsonb`. The crawl
    // was configured at 1000 ms and escalated once to 2000 ms, and — as every
    // real crawl does — wrote both the per-host entry and the crawl-wide
    // `host_spacing_ms` = 2000. The render must pace at 2000: the BASE comes
    // back as 1000 at level 1. Folding the crawl-wide 2000 into the base and
    // then re-applying the level would pace at 4000 — the upper bound below is
    // that defect's tripwire.
    const crawlId = await newCrawl(["/static/11", "/static/12", "/static/13"]);
    const host = new URL(site.base).host;
    const entry: HostSpacingEntry = {
      spacingMs: 2_000,
      baseMs: 1_000,
      responses429: 1,
      retryAfterSeen: 0,
      escalations: 1,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 2_000,
    };
    await db
      .update(crawls)
      .set({ hostSpacingMs: 2_000, hostSpacingJsonb: { [host]: entry } })
      .where(eq(crawls.id, crawlId));
    const before = site.hits.length;

    await runRenderPass(db, crawlId, passConfig({ perHostDelayMs: 1_000, renderConcurrency: 3 }));

    // Warm-up discipline as above: arrivals[0] is the cold navigation.
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path.startsWith("/static/"))
      .map((h) => h.at);
    expect(arrivals.length).toBe(3);
    const gap = arrivals[2]! - arrivals[1]!;
    expect(gap).toBeGreaterThanOrEqual(2_000 - 50);
    expect(gap).toBeLessThan(3_000);
  });

  it("writes the render's own throttle answers back into the crawl's record", async () => {
    // §3.4.5: a 429 on a subresource during the render escalates the host AND
    // counts in `crawl_status.throttle`, which is read from this column.
    const crawlId = await newCrawl(["/limited"]);
    const host = new URL(site.base).host;
    const entry: HostSpacingEntry = {
      spacingMs: 0,
      baseMs: 0,
      responses429: 0,
      retryAfterSeen: 0,
      escalations: 0,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 0,
    };
    await db
      .update(crawls)
      .set({ hostSpacingMs: 0, hostSpacingJsonb: { [host]: entry } })
      .where(eq(crawls.id, crawlId));

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(1);
    // The document and the refused script, each through the gate.
    expect(summary.requests.paced).toBe(2);
    expect(summary.requests.unpacedNetwork).toBe(0);
    const row = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    const record = throttleRecordOf(row.hostSpacingJsonb)!;
    expect(record[host]!.responses429).toBe(1);
    expect(record[host]!.retryAfterSeen).toBe(1);
    expect(record[host]!.escalations).toBe(1);
    // Base 0 escalates from the 500 ms seed: ×2 = 1000 ms.
    expect(record[host]!.finalSpacingMs).toBe(1_000);
    expect(row.hostSpacingMs).toBe(1_000);
  });

  it("refuses to overwrite a throttle record somebody else changed under the pass", async () => {
    // Fix round 1, M6: the write-back is compare-and-set. A record that moved
    // between the pass reading it and writing it is not ours to replace.
    const crawlId = await newCrawl(["/limited"]);
    const host = new URL(site.base).host;
    const entry: HostSpacingEntry = {
      spacingMs: 0,
      baseMs: 0,
      responses429: 0,
      retryAfterSeen: 0,
      escalations: 0,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 0,
    };
    await db
      .update(crawls)
      .set({ hostSpacingMs: 0, hostSpacingJsonb: { [host]: entry } })
      .where(eq(crawls.id, crawlId));
    // The other writer, landing while the pass renders.
    const other = { [host]: { ...entry, responses429: 7 } };
    const before = site.hits.length;
    const pass = runRenderPass(db, crawlId, passConfig());
    // Once the page is being rendered the pass has read the record; it writes
    // after the render (the 429 moves the spacing). Land in between.
    while (!site.hits.slice(before).some((h) => h.path === "/limited")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await db.update(crawls).set({ hostSpacingJsonb: other }).where(eq(crawls.id, crawlId));

    await expect(pass).rejects.toThrow(/host_spacing_jsonb changed under the render pass/);
    const row = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    expect(row.hostSpacingJsonb).toEqual(other);
  });

  it("leaves a pre-24a spacing map exactly as it was: that crawl never counted", async () => {
    // A record written over a `{host: ms}` map would present the render's
    // counters as the crawl's (Task 2: `throttle` is null for such a crawl).
    const crawlId = await newCrawl(["/limited"]);
    const host = new URL(site.base).host;
    await db
      .update(crawls)
      .set({ hostSpacingMs: 0, hostSpacingJsonb: { [host]: 0 } })
      .where(eq(crawls.id, crawlId));

    await runRenderPass(db, crawlId, passConfig());

    const row = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    expect(row.hostSpacingJsonb).toEqual({ [host]: 0 });
    expect(row.hostSpacingMs).toBe(0);
  });

  it("renders a page whose paced scripts need more than 15 s: the budget grows with the spacing", async () => {
    // Final review #1. 32 same-origin scripts at 500 ms are 16 s of pacing
    // before `domcontentloaded` — past the old fixed 15 s budget, inside the
    // 15 s + 30 × 500 ms = 30 s it is now.
    const crawlId = await newCrawl(["/many-scripts"]);
    const spacingMs = 500;
    const before = site.hits.length;

    const summary = await runRenderPass(
      db,
      crawlId,
      passConfig({ perHostDelayMs: spacingMs, renderConcurrency: 1 }),
    );

    expect(summary.failures).toBe(0);
    expect(summary.rendered).toBe(1);
    const row = await pageRow(crawlId, "/many-scripts");
    expect(row.renderError).toBeNull();
    expect(row.rendered).toBe(true);
    // The pacing really did take longer than the old budget.
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path === "/many-scripts" || h.path.startsWith("/many/"));
    expect(arrivals.length).toBe(1 + MANY_SCRIPTS);
    expect(arrivals[arrivals.length - 1]!.at - arrivals[0]!.at).toBeGreaterThan(15_000);
  }, 90_000);

  it("keys the gate by each request's own host: www state earned by the crawl, apex siteUrl", async () => {
    // Final review #2. The crawl was given the apex and crawled `www.`, so
    // its earned state is under `www.`. A render of `www.` pages paces at
    // THAT state (2000 ms: base 1000 at level 1, no crawl-wide column to
    // hide behind), and a 429 a `www.` asset answers lands in the `www.`
    // entry of the throttle record — no apex entry appears.
    const port = new URL(site.base).port;
    const apex = `http://shop.test:${port}`;
    const www = `http://www.shop.test:${port}`;
    const wwwHost = `www.shop.test:${port}`;
    const crawlId = await newCrawl(["/static/21", "/static/22", "/static/23", "/limited"], {
      base: www,
      siteUrl: apex,
    });
    const entry: HostSpacingEntry = {
      spacingMs: 2_000,
      baseMs: 1_000,
      responses429: 1,
      retryAfterSeen: 0,
      escalations: 1,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 2_000,
    };
    await db
      .update(crawls)
      .set({ hostSpacingMs: null, hostSpacingJsonb: { [wwwHost]: entry } })
      .where(eq(crawls.id, crawlId));
    const before = site.hits.length;

    const summary = await runRenderPass(
      db,
      crawlId,
      passConfig({
        siteUrl: apex,
        perHostDelayMs: 1_000,
        renderConcurrency: 1,
        resolveAddress: async (_host: string, type: string) => (type === "A" ? ["127.0.0.1"] : []),
      }),
    );

    expect(summary.failures).toBe(0);
    expect(summary.rendered).toBe(4);
    // Warm-to-warm gaps between `www.` documents: at least the earned 2000 ms
    // (the apex, unseeded, would be at the configured 1000 ms).
    const arrivals = site.hits
      .slice(before)
      .filter((h) => h.path.startsWith("/static/2"))
      .map((h) => h.at);
    expect(arrivals.length).toBe(3);
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(2_000 - 50);

    const row = (await db.select().from(crawls).where(eq(crawls.id, crawlId)))[0]!;
    const record = throttleRecordOf(row.hostSpacingJsonb)!;
    expect(Object.keys(record)).toEqual([wwwHost]);
    // The crawl's one 429 and the render's.
    expect(record[wwwHost]!.responses429).toBe(2);
    expect(record[wwwHost]!.escalations).toBe(2);
  }, 90_000);

  it("derives the render lease from the gate cap, the navigation budget and the settle", () => {
    // (2W + 1) × 30 s of gate wait + navigation + settle + 30 s allowance.
    expect(
      renderLeaseSeconds({ renderConcurrency: 4, navigationTimeoutMs: 15_000, settleMs: 3_000 }),
    ).toBe(318);
    // The Shopify profile: one browser, a 60 s budget.
    expect(
      renderLeaseSeconds({ renderConcurrency: 1, navigationTimeoutMs: 60_000, settleMs: 3_000 }),
    ).toBe(183);
  });

  it("leaves its selection alone when the pass is aborted before it starts", async () => {
    const crawlId = await newCrawl(["/csr", "/static/9"]);
    const signal = AbortSignal.abort();

    const summary = await runRenderPass(db, crawlId, passConfig(), { signal });

    expect(summary.rendered).toBe(0);
    expect(summary.failures).toBe(0);
    // The honest count of what the abort left behind, not a rounding error.
    expect(summary.unrendered).toBe(2);
    expect((await frontierCounts(db, crawlId)).renderPending).toBe(2);
    // No lease outlives the pass: a resumed pass may start immediately.
    const rows = await db.select().from(frontier).where(eq(frontier.crawlId, crawlId));
    expect(rows.every((r) => r.leasedUntil === null)).toBe(true);
  });

  it("refuses to write a render result for a page row that is not there", async () => {
    const crawlId = await newCrawl(["/csr"]);
    const ghost: RenderResult = {
      url: `${site.base}/not-a-page`,
      rendered: true,
      wordCount: 1,
      linkCount: 0,
      navLinkCount: 0,
      footerLinkCount: 0,
      filterLinkCount: 0,
      analyzerWordCount: 1,
      renderableWordCount: 1,
      title: "A ghost",
      h1Count: 0,
      canonical: null,
      robotsMeta: null,
      metaDescription: null,
      h1Text: null,
      htmlPath: "/dev/null",
      redirectUrl: null,
      error: null,
      blockedRequests: 0,
      skippedPaintRequests: 0,
      pacedRequests: 0,
      cachedResponses: 0,
      unpacedNetworkRequests: 0,
      console: null,
    };

    await expect(writeRenderResult(db, crawlId, ghost)).rejects.toThrow(/no page row/i);
  });

  it("stores rendered strings holding a NUL or a lone surrogate (ruling R10)", async () => {
    const crawlId = await newCrawl(["/hostile-render"]);
    const result: RenderResult = {
      url: `${site.base}/hostile-render`,
      rendered: true,
      wordCount: 1,
      linkCount: 0,
      navLinkCount: 0,
      footerLinkCount: 0,
      filterLinkCount: 0,
      analyzerWordCount: 1,
      renderableWordCount: 1,
      title: "Ti\u0000tle",
      h1Count: 1,
      canonical: null,
      robotsMeta: "noindex\u0000",
      metaDescription: "d\uD800",
      h1Text: "H\u0000\uDC00",
      htmlPath: "/dev/null",
      redirectUrl: null,
      error: null,
      blockedRequests: 0,
      skippedPaintRequests: 0,
      pacedRequests: 0,
      cachedResponses: 0,
      unpacedNetworkRequests: 0,
      console: null,
    };

    await writeRenderResult(db, crawlId, result);

    const row = await pageRow(crawlId, "/hostile-render");
    expect(row.renderedTitle).toBe("Ti␀tle");
    expect(row.renderedRobotsMeta).toBe("noindex␀");
    expect(row.renderedMetaDescription).toBe("d�");
    expect(row.renderedH1Text).toBe("H␀�");
  });

  // -------------------------------------------------------------------------
  // Phase 25: render_console and render_version on the page row.
  // -------------------------------------------------------------------------

  it("writes render_console and render_version 2", async () => {
    const crawlId = await newCrawl(["/console-errors", "/console-clean"]);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.failures).toBe(0);
    const errors = await pageRow(crawlId, "/console-errors");
    expect(errors.renderVersion).toBe(2);
    const stored = errors.renderConsole as RenderConsole;
    expect(stored.exceptionsTotal).toBeGreaterThanOrEqual(1);
    expect(stored.console).toContainEqual({ level: "error", text: "site says no", cut: false });
    expect(stored.failedRequests).toContainEqual({
      url: `${site.base}/missing.js`,
      status: 404,
      reason: "http 404",
      cut: false,
    });
    expect(stored.blockedByRenderer.thirdParty).toBeGreaterThanOrEqual(1);

    const clean = await pageRow(crawlId, "/console-clean");
    expect(clean.renderVersion).toBe(2);
    expect(clean.renderConsole).toEqual({
      console: [],
      consoleTotal: 0,
      exceptions: [],
      exceptionsTotal: 0,
      failedRequests: [],
      failedRequestsTotal: 0,
      blockedByRenderer: { thirdParty: 0, sameOriginAssets: 0 },
    });
  });

  it("stores a page that logs a NUL and a lone surrogate without error", async () => {
    // Postgres jsonb rejects both; unsanitised, this one page would make the
    // writer throw and stop the whole pass.
    const crawlId = await newCrawl(["/console-hostile"]);

    const summary = await runRenderPass(db, crawlId, passConfig());

    expect(summary.rendered).toBe(1);
    const row = await pageRow(crawlId, "/console-hostile");
    expect(row.renderVersion).toBe(2);
    const stored = row.renderConsole as RenderConsole;
    // The NUL is marked as U+2400 (␀), never dropped; the lone surrogate is U+FFFD.
    expect(stored.console).toEqual([
      { level: "error", text: "nul:\u2400 lone:\uFFFD end", cut: false },
    ]);
    expect(stored.exceptionsTotal).toBe(1);
    expect(stored.exceptions[0]!.text).toContain("thrown nul:\u2400 lone:\uFFFD");
  });

  it("a pre-browser policy refusal writes render_version 2 with render_console null", async () => {
    // `www.` answers a metadata address, so it is left out of the pin at
    // launch and a page on it is refused before any browser page opens.
    const port = new URL(site.base).port;
    const apex = `http://shop.test:${port}`;
    const www = `http://www.shop.test:${port}`;
    const crawlId = await newCrawl(["/csr"], { base: www, siteUrl: apex });

    const summary = await runRenderPass(
      db,
      crawlId,
      passConfig({
        siteUrl: apex,
        resolveAddress: async (host: string, type: string) =>
          type !== "A" ? [] : host === "www.shop.test" ? ["169.254.169.254"] : ["127.0.0.1"],
      }),
    );

    expect(summary.failures).toBe(1);
    const row = (
      await db
        .select()
        .from(pages)
        .where(and(eq(pages.crawlId, crawlId), eq(pages.url, `${www}/csr`)))
    )[0]!;
    expect(row.rendered).toBe(false);
    expect(row.renderError).toMatch(/^policy refusal: www\.shop\.test was not approved/);
    // The render writer wrote this row (its stamp says so), and nothing was
    // looked at: null, which `render_version` tells apart from a pre-25 null.
    expect(row.renderVersion).toBe(2);
    expect(row.renderConsole).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 27c Task 5: credentials in the render pass.
// ---------------------------------------------------------------------------

describe("PageRenderer credentials", () => {
  const HEADER_SECRET = "render-hdr-s3cret";
  const COOKIE_SECRET = "render-ck-s3cret";
  const seen: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
  let credSite: Server;
  let credBase: string;
  let third: Site;
  let htmlDir: string;
  let renderer: PageRenderer;
  const blocked: string[] = [];

  beforeAll(async () => {
    third = await startThirdParty();
    credSite = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      seen.push({ path, headers: req.headers });
      if (path === "/cred-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><title>Cred</title>` +
            `<script src="/cred.js"></script>` +
            `<script src="${third.base}/widget.js"></script>` +
            `</head><body><p>one two</p></body></html>`,
        );
        return;
      }
      if (path === "/cred.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("document.title = 'Cred ran';");
        return;
      }
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>404</title>");
    });
    await new Promise<void>((resolve) => credSite.listen(0, "127.0.0.1", resolve));
    credBase = siteBase(credSite);
    htmlDir = await mkdtemp(join(tmpdir(), "ariadne-render-cred-"));
    renderer = await PageRenderer.launch({
      origin: credBase,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render credentials test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      onRequestBlocked: (url) => blocked.push(url),
      credentials: {
        siteUrl: credBase,
        values: {
          requestHeaders: { "X-Tenant": HEADER_SECRET },
          cookies: [{ name: "session", value: COOKIE_SECRET }],
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await renderer.close();
    await new Promise<void>((resolve, reject) =>
      credSite.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await third.close();
    await rm(htmlDir, { recursive: true, force: true });
  });

  it("sends the cookie and the header on the document and a same-origin script, and still blocks the third party", async () => {
    const result = await renderer.render(`${credBase}/cred-page`);

    expect(result.error).toBeNull();
    expect(result.rendered).toBe(true);
    // The same-origin script ran: it was fetched, with the credentials.
    expect(result.title).toBe("Cred ran");
    for (const path of ["/cred-page", "/cred.js"]) {
      const hits = seen.filter((s) => s.path === path);
      expect(hits.length, path).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.headers["x-tenant"], path).toBe(HEADER_SECRET);
        expect(hit.headers.cookie ?? "", path).toContain(`session=${COOKIE_SECRET}`);
        // The browser's own identity is kept (rule 9).
        expect(hit.headers["user-agent"], path).toBe("AriadneBot/0.1 (render credentials test)");
      }
    }
    // The third party was never asked, so it never saw a credential either.
    expect(third.hits).toEqual([]);
    expect(blocked).toContain(`${third.base}/widget.js`);
    expect(result.blockedRequests).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 27d Task 7 (27c M6): a credentialed render keeps each request header
// as exactly one line — the credential replaces the page's own value of the
// same name, and every other header the page set is kept once.
// ---------------------------------------------------------------------------

describe("PageRenderer credentials: one line per request header (27c M6)", () => {
  const rawLines: string[][] = [];
  let echoSite: Server;
  let echoBase: string;
  let htmlDir: string;
  let renderer: PageRenderer;

  beforeAll(async () => {
    echoSite = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/echo") {
        // The raw header lines exactly as they arrived: name and value, in order.
        const lines: string[] = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          lines.push(`${req.rawHeaders[i]!.toLowerCase()}: ${req.rawHeaders[i + 1]}`);
        }
        rawLines.push(lines);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (path === "/hdr-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><title>Hdr</title></head><body><p>one two</p>` +
            `<script>fetch('/echo', {headers: {'x-own': 'one', 'authorization': 'page-value'}})` +
            `.then(() => { document.title = 'Hdr done'; });</script></body></html>`,
        );
        return;
      }
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>404</title>");
    });
    await new Promise<void>((resolve) => echoSite.listen(0, "127.0.0.1", resolve));
    echoBase = siteBase(echoSite);
    htmlDir = await mkdtemp(join(tmpdir(), "ariadne-render-hdr-"));
    renderer = await PageRenderer.launch({
      origin: echoBase,
      htmlDir,
      userAgent: "AriadneBot/0.1 (render header lines test)",
      perHostDelayMs: 0,
      settleMs: SETTLE_MS,
      allowPrivate: true,
      credentials: { siteUrl: echoBase, values: { requestHeaders: { authorization: "Bearer cred" } } },
    });
  }, 120_000);

  afterAll(async () => {
    await renderer.close();
    await new Promise<void>((resolve, reject) =>
      echoSite.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(htmlDir, { recursive: true, force: true });
  });

  it("a page's own header of a credential's name is replaced, and the others stay, each as one line", async () => {
    const result = await renderer.render(`${echoBase}/hdr-page`);

    expect(result.error).toBeNull();
    expect(result.title).toBe("Hdr done");
    expect(rawLines.length).toBeGreaterThan(0);
    for (const lines of rawLines) {
      expect(lines.filter((l) => l.startsWith("authorization:"))).toEqual(["authorization: Bearer cred"]);
      expect(lines.filter((l) => l.startsWith("x-own:"))).toEqual(["x-own: one"]);
    }
  });
});
