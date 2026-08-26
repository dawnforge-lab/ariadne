/**
 * Rendering primitives for the fixture site.
 *
 * Adapted from open-seo (MIT), badseo/src/lib.ts and badseo/src/fixtures/helpers.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 *
 * `escapeHtml`, `lorem`, `article` and the head-tag layout of `renderDocument`
 * are upstream's, content and all. Changes:
 *  - The chrome upstream wrapped every page in — nav, footer, the "what this
 *    page tests" panel, Plausible analytics, Google Fonts, a stylesheet — is
 *    gone. It made badseo.dev browsable; here it would add words, links and
 *    head tags to pages whose word count and head tags *are* the thing under
 *    test, and every one of those bytes would have to be reasoned about again
 *    on the control page.
 *  - A self-referential absolute canonical is the default. Upstream emitted a
 *    canonical only when a fixture asked for one, so nearly every badseo page
 *    was also a missing-canonical page. Defaulting to self keeps each absorbed
 *    page carrying the one defect it names, and leaves `canonical.missing` for
 *    a fixture that means it (`canonical: null` opts out).
 *  - Responses are `node:http` writes rather than Workers `Response` objects,
 *    so upstream's `htmlResponse` / `redirect` become `serve` / `redirect`
 *    over a `ServerResponse`, and `delayMs` is a `setTimeout` before the write
 *    rather than an awaited sleep.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Deterministic filler text so pages can clear the thin-content threshold.
 * Upstream's word bank, verbatim — note it contains no "lorem ipsum", so
 * filler never trips `content.placeholder` by accident.
 */
export function lorem(words: number): string {
  const bank =
    "the quick brown fox jumps over a lazy search engine while crawling deep into a sprawling website looking for signals headings titles descriptions and links that help people find genuinely useful content on the open web".split(
      " ",
    );
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(bank[i % bank.length] ?? "");
  return out.join(" ");
}

/**
 * A healthy article body: exactly one `<h1>`, headings that descend one level
 * at a time, comfortably more than 150 words, and an image WITH alt text and
 * dimensions. Fixtures that break the head reuse this unchanged, so the engine
 * sees a single injected defect and nothing else.
 */
export function article(opts: {
  h1: string;
  lede: string;
  sections: Array<{
    h2: string;
    body: string;
    h3?: { h3: string; body: string };
  }>;
  /** Include a properly-described image. Default true. */
  withImage?: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`<h1>${escapeHtml(opts.h1)}</h1>`);
  parts.push(`<p class="lede">${escapeHtml(opts.lede)}</p>`);
  if (opts.withImage !== false) {
    parts.push(
      `<img src="/img/placeholder.svg" alt="${escapeHtml(
        opts.h1,
      )}, an illustrative diagram" width="720" height="360">`,
    );
  }
  for (const s of opts.sections) {
    parts.push(`<h2>${escapeHtml(s.h2)}</h2>`);
    parts.push(`<p>${escapeHtml(s.body)}</p>`);
    if (s.h3) {
      parts.push(`<h3>${escapeHtml(s.h3.h3)}</h3>`);
      parts.push(`<p>${escapeHtml(s.h3.body)}</p>`);
    }
  }
  return parts.join("\n");
}

export interface PageSpec {
  /** Omit entirely to render NO `<title>` element. */
  title?: string;
  /** Omit entirely to render NO meta description. */
  metaDescription?: string;
  /**
   * `<link rel=canonical>` href. Defaults to this page's own absolute URL;
   * `null` renders no canonical at all.
   */
  canonical?: string | null;
  /** `<meta name=robots>` content. */
  robotsMeta?: string;
  /** Render the viewport meta. Default true. */
  viewport?: boolean;
  /** Raw HTML appended to `<head>` — extra link tags, JSON-LD, hreflang. */
  headExtra?: string;
  bodyHtml: string;
}

export interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  /** Milliseconds to wait before the first byte. */
  delayMs?: number;
}

/** Build a complete HTML document with exact `<head>` control. */
export function renderDocument(spec: PageSpec): string {
  const head: string[] = ['<meta charset="utf-8">'];
  if (spec.viewport !== false) {
    head.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  if (spec.title !== undefined) head.push(`<title>${escapeHtml(spec.title)}</title>`);
  if (spec.metaDescription !== undefined) {
    head.push(`<meta name="description" content="${escapeHtml(spec.metaDescription)}">`);
  }
  if (spec.canonical !== null && spec.canonical !== undefined) {
    head.push(`<link rel="canonical" href="${escapeHtml(spec.canonical)}">`);
  }
  if (spec.robotsMeta !== undefined) {
    head.push(`<meta name="robots" content="${escapeHtml(spec.robotsMeta)}">`);
  }
  if (spec.headExtra !== undefined) head.push(spec.headExtra);

  // `lang` is fixed rather than a knob: every fixture page is in English, and
  // no rule reads the attribute. A per-page override would be a seam nothing
  // uses, and an unused seam is a claim the fixture set does not back up.
  return `<!doctype html>
<html lang="en">
<head>
${head.join("\n")}
</head>
<body>
<main class="main">
${spec.bodyHtml}
</main>
</body>
</html>`;
}

/**
 * The absolute URL this request was made to. Built from the Host header rather
 * than from a captured base, because the port is only known once the server is
 * listening and a fixture's canonical has to name the URL the crawler actually
 * asked for.
 */
export function selfUrl(req: IncomingMessage): string {
  const host = req.headers.host;
  if (host === undefined) {
    throw new Error("fixture: request arrived without a Host header");
  }
  return `http://${host}${req.url ?? "/"}`;
}

/**
 * Render and send one fixture page. `build` receives this page's own absolute
 * URL, which is what a self-referential canonical and any deliberate
 * points-elsewhere canonical are written against.
 */
export function serve(
  req: IncomingMessage,
  res: ServerResponse,
  build: (self: string) => PageSpec,
  opts: ResponseSpec = {},
): void {
  const self = selfUrl(req);
  const spec = build(self);
  const html = renderDocument({
    ...spec,
    canonical: spec.canonical === undefined ? self : spec.canonical,
  });
  const send = (): void => {
    res.writeHead(opts.status ?? 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...opts.headers,
    });
    res.end(html);
  };
  if (opts.delayMs !== undefined && opts.delayMs > 0) {
    setTimeout(send, opts.delayMs);
    return;
  }
  send();
}

/** A manual 3xx. The crawler records each hop as its own page row. */
export function redirect(res: ServerResponse, location: string, status = 301): void {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}
