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
 *  - A complete, consistent Open Graph / X set is the default too (Phase 26b),
 *    for the same reason: the social rules would otherwise fire on every page.
 *    `social: false` opts out, an object overrides (`PageSpec.social`), and
 *    `htmlLang` makes the root's `lang` a knob, default `"en"`.
 *  - Responses are `node:http` writes rather than Workers `Response` objects,
 *    so upstream's `htmlResponse` / `redirect` become `serve` / `redirect`
 *    over a `ServerResponse`, and `delayMs` is a `setTimeout` before the write
 *    rather than an awaited sleep.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { SocialFacts } from "../../src/crawl/parse/page-facts.js";
import { SHARED_IMAGE_PATH } from "./assets.js";

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
      `<img src="${SHARED_IMAGE_PATH}" alt="${escapeHtml(
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
  /**
   * Raw HTML written into `<head>` BEFORE the title, description, canonical and
   * robots tags (after the charset and viewport metas). For markup that ends
   * the head early, so the tags after it land in the body (P23-T5).
   */
  headPrefix?: string;
  /** `<html lang>`. Default `"en"`; `""` renders the attribute empty. */
  htmlLang?: string;
  /**
   * The Open Graph / X set (Phase 26b). By default a complete, consistent one:
   * `og:title` and `twitter:title` = the page title (both omitted when the page
   * has no `<title>`), `og:type` `website`, `og:url` = this page's own URL,
   * `og:image` = the site's shared image (`SHARED_IMAGE_PATH`, absolute) and
   * `twitter:card` `summary_large_image`. An object overrides those values and
   * may add `description` / `site_name`; a key given as `undefined` omits that
   * tag. `false` renders no social tag at all.
   */
  social?: false | Partial<SocialFacts["og"] & { xCard: string }>;
  bodyHtml: string;
}

/** The social tags `renderDocument` writes for `spec` (see `PageSpec.social`). */
function socialTags(spec: PageSpec, self: string): string[] {
  if (spec.social === false) return [];
  const override = spec.social ?? {};
  const pick = <K extends keyof typeof override>(key: K, value: string | undefined) =>
    key in override ? override[key] : value;
  const og: Array<[string, string | undefined]> = [
    ["og:title", pick("title", spec.title)],
    ["og:type", pick("type", "website")],
    ["og:url", pick("url", self)],
    ["og:image", pick("image", `${new URL(self).origin}${SHARED_IMAGE_PATH}`)],
    ["og:description", pick("description", undefined)],
    ["og:site_name", pick("site_name", undefined)],
  ];
  const tags = og.flatMap(([property, value]) =>
    value === undefined
      ? []
      : [`<meta property="${property}" content="${escapeHtml(value)}">`],
  );
  const card = pick("xCard", "summary_large_image");
  if (card !== undefined) tags.push(`<meta name="twitter:card" content="${escapeHtml(card)}">`);
  if (spec.title !== undefined) {
    tags.push(`<meta name="twitter:title" content="${escapeHtml(spec.title)}">`);
  }
  return tags;
}

export interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  /** Milliseconds to wait before the first byte. */
  delayMs?: number;
}

/**
 * Build a complete HTML document with exact `<head>` control. `self` is this
 * page's own absolute URL, which the default `og:url` and `og:image` name.
 */
export function renderDocument(spec: PageSpec, self: string): string {
  const head: string[] = ['<meta charset="utf-8">'];
  if (spec.viewport !== false) {
    head.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  if (spec.headPrefix !== undefined) head.push(spec.headPrefix);
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
  head.push(...socialTags(spec, self));
  if (spec.headExtra !== undefined) head.push(spec.headExtra);

  // `lang` defaults to "en" (every fixture page is in English); Phase 26b's
  // `hreflang.html-lang-mismatch` reads it, so a fixture can now set it.
  return `<!doctype html>
<html lang="${escapeHtml(spec.htmlLang ?? "en")}">
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
  const html = renderDocument(
    {
      ...spec,
      canonical: spec.canonical === undefined ? self : spec.canonical,
    },
    self,
  );
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
