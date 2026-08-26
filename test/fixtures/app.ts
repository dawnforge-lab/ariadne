/**
 * The fixture site: a `node:http` server that serves the fixture collection
 * over real HTTP so the real crawler can crawl it.
 *
 * Three things this server owns beyond dispatch:
 *  - **The hub.** `/` links every fixture path, so one crawl from the seed
 *    reaches the whole collection at depth 1. The deep click-path is the single
 *    exception: only its first rung is linked, because the point of those pages
 *    is how far from the seed they are (see DEEP_CHAIN_TAIL).
 *  - **robots.txt.** Allow all, no crawl-delay, no `Sitemap:` line. The site
 *    deliberately has no sitemap: every page is reached by link, so a fixture
 *    that is not linked is not crawled, and that is a visible failure rather
 *    than a page the sitemap quietly rescued.
 *  - **404 for everything else**, including `/sitemap.xml`.
 *
 * Bound to 127.0.0.1 on port 0. Crawling it needs `allowPrivate: true`, which
 * is the sanctioned test-only use of that flag (see CrawlConfig).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Fixture } from "./fixture.js";
import { escapeHtml, selfUrl } from "./render.js";

export interface FixtureApp {
  /** Origin, no trailing slash: `http://127.0.0.1:{port}`. */
  base: string;
  close(): Promise<void>;
}

/**
 * Rungs of the deep click-path the hub must NOT link. `/deep/1` is the
 * entrance; every rung after it is reachable only from the rung above, which is
 * what gives those pages their depth.
 */
const DEEP_CHAIN_TAIL = /^\/deep\/(?!1$)\d+$/;

/**
 * The hub is not a fixture and nothing is asserted about it, but it is still
 * crawled and judged, so it carries the head tags a healthy page carries — a
 * self-referential canonical included. Findings it does produce are ignored by
 * the harness, which counts coverage from fixture paths only.
 */
function hubHtml(fixtures: readonly Fixture[], self: string): string {
  const links = fixtures
    .filter((f) => !DEEP_CHAIN_TAIL.test(f.path))
    .map((f) => `<li><a href="${escapeHtml(f.path)}">${escapeHtml(f.name)}</a></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ariadne fixture site</title>
<meta name="description" content="The hub page of the Ariadne fixture site: it links every fixture so one crawl from the seed reaches all of them.">
<link rel="canonical" href="${escapeHtml(self)}">
</head>
<body>
<main>
<h1>Ariadne fixture site</h1>
<p>Every page below is engineered to make the rule engine say something, except the control page, which is engineered to make it say nothing.</p>
<ul>
${links}
</ul>
</main>
</body>
</html>`;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Start the fixture site. Duplicate fixture paths throw here rather than
 * shadowing each other silently — two fixtures on one path would make the
 * harness assert against a page that is not the one it thinks it is.
 */
export async function startFixtureApp(fixtures: readonly Fixture[]): Promise<FixtureApp> {
  const byPath = new Map<string, Fixture>();
  for (const fixture of fixtures) {
    if (!fixture.path.startsWith("/")) {
      throw new Error(`fixture path must start with "/": ${fixture.path}`);
    }
    if (byPath.has(fixture.path)) {
      throw new Error(`two fixtures claim the path ${fixture.path}`);
    }
    byPath.set(fixture.path, fixture);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Query strings are not part of a fixture's identity: the canonical-conflict
    // page is asked for with `?via=…` and must still be itself.
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path === "/") {
      send(res, 200, "text/html; charset=utf-8", hubHtml(fixtures, selfUrl(req)));
      return;
    }
    if (path === "/robots.txt") {
      send(res, 200, "text/plain; charset=utf-8", "User-agent: *\nAllow: /\n");
      return;
    }

    const fixture = byPath.get(path);
    if (fixture === undefined) {
      send(res, 404, "text/html; charset=utf-8", "<!doctype html><title>404</title><p>No fixture here.</p>");
      return;
    }
    fixture.handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    ),
  };
}
