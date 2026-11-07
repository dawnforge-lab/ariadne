import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { HEAD_LOST_MAX, HEAD_SNIPPET_MAX } from "../../src/crawl/parse/page-facts.js";

const HTML = `<!doctype html><html><head>
<title>Widget Shop</title>
<meta name="description" content="Buy widgets.">
<link rel="canonical" href="https://shop.example/widgets">
<meta property="og:title" content="Widgets">
</head><body>
<h1>Widgets</h1><h3>Skipped level</h3>
<a href="/a" rel="nofollow">A</a><a href="https://other.example/b">B</a>
<img src="x.png"><img src="y.png" alt="">
<p>${"word ".repeat(200)}</p>
</body></html>`;

describe("analyzePage", () => {
  it("extracts the head and body signals", () => {
    const a = analyzePage(HTML, "https://shop.example/widgets");
    expect(a.title).toBe("Widget Shop");
    expect(a.metaDescription).toBe("Buy widgets.");
    expect(a.canonicalHtml).toBe("https://shop.example/widgets");
    expect(a.headingCounts[0]).toBe(1);
    expect(a.headingOrder).toEqual([1, 3]);
    expect(a.imagesTotal).toBe(2);
    expect(a.imagesMissingAlt).toBe(1); // alt="" present ≠ missing
    expect(a.links).toHaveLength(2);
    expect(a.links[0]?.nofollow).toBe(true);
    expect(a.wordCount).toBeGreaterThan(190);
  });

  it("resolves link hrefs and records document position", () => {
    const a = analyzePage(HTML, "https://shop.example/widgets");
    expect(a.links[0]).toEqual({
      href: "https://shop.example/a",
      anchor: "A",
      ariaLabel: null,
      rel: "nofollow",
      nofollow: true,
      position: 0,
    });
    expect(a.links[1]?.href).toBe("https://other.example/b");
    expect(a.links[1]?.position).toBe(1);
    expect(a.links[1]?.rel).toBeNull();
  });

  it("reports absent head elements as null, present-but-empty as empty", () => {
    const absent = analyzePage("<html><body><p>x</p></body></html>", "https://x.test/");
    expect(absent.title).toBeNull();
    expect(absent.metaDescription).toBeNull();
    expect(absent.canonicalHtml).toBeNull();
    expect(absent.canonicalCount).toBe(0);
    expect(absent.hasAmp).toBe(false);

    const empty = analyzePage(
      `<html><head><title>  </title><meta name="description" content=""></head><body></body></html>`,
      "https://x.test/",
    );
    expect(empty.title).toBe("");
    expect(empty.metaDescription).toBe("");
  });

  // HTML metadata names, link types and MIME types are ASCII case-insensitive.
  // Reading `name="Description"` as "no description" would report a present
  // tag as a missing one — a false audit fact, not just a miss.
  it("matches meta name/property, rel and script type case-insensitively", () => {
    const a = analyzePage(
      `<html><head>
       <meta name="Description" content="Present, not missing.">
       <meta name="ROBOTS" content="noindex">
       <meta property="OG:title" content="T">
       <meta property="og:Description" content="D">
       <meta property="OG:IMAGE" content="/og.png">
       <link rel=" Canonical " href="/c">
       <link rel="AMPHTML" href="/amp/">
       </head><body><a href="/x" rel="NoFollow">x</a></body></html>`,
      "https://x.test/",
    );
    expect(a.metaDescription).toBe("Present, not missing.");
    expect(a.robotsMeta).toBe("noindex");
    expect(a.ogTitle).toBe("T");
    expect(a.ogDescription).toBe("D");
    expect(a.ogImage).toBe("/og.png");
    expect(a.canonicalHtml).toBe("/c");
    expect(a.canonicalCount).toBe(1);
    expect(a.hasAmp).toBe(true);
    expect(a.links[0]?.rel).toBe("nofollow");
    expect(a.links[0]?.nofollow).toBe(true);
  });

  it("ignores a <title> inside <svg>", () => {
    const a = analyzePage(
      `<html><head></head><body><svg><title>icon</title></svg></body></html>`,
      "https://x.test/",
    );
    expect(a.title).toBeNull();
    expect(a.wordCount).toBe(0);
  });

  it("treats <noscript> contents as raw text, not markup", () => {
    const a = analyzePage(
      `<html><body><noscript><img src="/ns.png"><a href="/ns">ns</a></noscript><p>real</p></body></html>`,
      "https://x.test/",
    );
    expect(a.imagesTotal).toBe(0);
    expect(a.links).toHaveLength(0);
    expect(a.wordCount).toBe(1);
  });

  it("implicitly closes a nested anchor the way a browser does", () => {
    const a = analyzePage(
      `<body><a href="/one">first <a href="/two">second</a></body>`,
      "https://x.test/",
    );
    expect(a.links.map((l) => [l.href, l.anchor])).toEqual([
      ["https://x.test/one", "first"],
      ["https://x.test/two", "second"],
    ]);
  });

  it("dedupes links by resolved target, keeping the first anchor", () => {
    const a = analyzePage(
      `<body><a href="/x?b=2&a=1">first</a><a href="/x?a=1&b=2">second</a></body>`,
      "https://x.test/",
    );
    expect(a.links).toHaveLength(1);
    expect(a.links[0]?.anchor).toBe("first");
  });

  it("counts every canonical but keeps the first href", () => {
    const a = analyzePage(
      `<html><head><link rel="canonical" href="/a"><link rel="canonical" href="/b"></head><body></body></html>`,
      "https://x.test/",
    );
    expect(a.canonicalHtml).toBe("/a");
    expect(a.canonicalCount).toBe(2);
  });

  it("falls back to whole-document text when the page has no <body>", () => {
    const a = analyzePage(
      `<h1>Bare fragment</h1> <p>three more words</p>`,
      "https://x.test/",
    );
    expect(a.wordCount).toBe(5);
    expect(a.headingCounts).toEqual([1, 0, 0, 0, 0, 0]);
  });

  // Was a documented limitation inherited from upstream (text nodes joined
  // with no separator, so `</h1><p>` merged two words into one and
  // undercounted); Task 6 fixed it, since wordCount, textRatio, contentHash
  // and simhash all read that accumulator. Element boundaries are whitespace
  // now — see the element-boundary block in analyzer-extensions.test.ts.
  it("counts words across block boundaries in minified markup", () => {
    const a = analyzePage(
      `<body><h1>Bare fragment</h1><p>three more words</p></body>`,
      "https://x.test/",
    );
    expect(a.wordCount).toBe(5);
  });

  it("does not count head text as content", () => {
    const a = analyzePage(
      `<html><head><title>Head words here</title><style>.a{color:red}</style></head><body><p>one two</p></body></html>`,
      "https://x.test/",
    );
    expect(a.wordCount).toBe(2);
  });

  it("detects AMP from rel=amphtml and from the root element", () => {
    expect(
      analyzePage(
        `<html><head><link rel="amphtml" href="/amp/"></head><body></body></html>`,
        "https://x.test/",
      ).hasAmp,
    ).toBe(true);
    expect(
      analyzePage(`<html ⚡><body></body></html>`, "https://x.test/").hasAmp,
    ).toBe(true);
  });

  it("skips non-http link protocols", () => {
    const a = analyzePage(
      `<body><a href="mailto:a@b.test">m</a><a href="tel:+1">t</a><a href="#frag">f</a><a href="javascript:void(0)">j</a><a href="ftp://h/x">ftp</a></body>`,
      "https://x.test/",
    );
    expect(a.links).toHaveLength(0);
  });
});

// The raw-HTML half of CHECK-34 (navigation that only exists after JavaScript
// runs). The comparison target is the browser's own
// `document.querySelectorAll('nav a[href]').length` / `footer a[href]`, which
// the render pass will read on the same page: an anchor counts when it carries
// an `href` attribute at all — value irrelevant, protocol irrelevant — and it
// counts once per container it is inside, so an anchor nested in a `<nav>`
// inside a `<footer>` is one nav link AND one footer link.
describe("nav and footer link counts", () => {
  it("counts anchors with an href inside each container, and nothing else", () => {
    const a = analyzePage(
      `<body>
        <nav><a href="/a">A</a><a href="/b">B</a><a>no href</a></nav>
        <footer><a href="">empty</a><a href="/c">C</a></footer>
        <a href="/d">outside both</a>
      </body>`,
      "https://x.test/",
    );
    // nav a[href]: /a and /b. The href-less anchor is not `a[href]`.
    expect(a.navLinkCount).toBe(2);
    // footer a[href]: href="" is present-and-empty, which the selector matches.
    expect(a.footerLinkCount).toBe(2);
  });

  it("counts anchors of any protocol, the way a[href] does", () => {
    const a = analyzePage(
      `<body><nav><a href="mailto:a@b.test">m</a><a href="#top">t</a><a href="javascript:void(0)">j</a></nav></body>`,
      "https://x.test/",
    );
    // None of the three become `links` rows; all three are `nav a[href]`.
    expect(a.links).toHaveLength(0);
    expect(a.navLinkCount).toBe(3);
  });

  it("counts a nav inside a footer for both containers", () => {
    const a = analyzePage(
      `<body><footer><nav><a href="/x">x</a></nav><a href="/y">y</a></footer></body>`,
      "https://x.test/",
    );
    expect(a.navLinkCount).toBe(1);
    expect(a.footerLinkCount).toBe(2);
  });

  it("survives an unclosed nav the way an implicit close does", () => {
    // `</footer>` closes the still-open <nav> first — htmlparser2 emits both
    // close events, exactly as the HTML parsing spec pops both elements — so
    // the anchor after the footer is inside neither container.
    const a = analyzePage(
      `<body><footer><nav><a href="/x">x</a></footer><a href="/after">after</a></body>`,
      "https://x.test/",
    );
    expect(a.navLinkCount).toBe(1);
    expect(a.footerLinkCount).toBe(1);
  });

  it("ignores a stray close tag rather than going negative", () => {
    const a = analyzePage(
      `<body></nav><a href="/z">z</a><nav><a href="/w">w</a></nav></body>`,
      "https://x.test/",
    );
    expect(a.navLinkCount).toBe(1);
  });

  it("counts every anchor of nested navs once each", () => {
    const a = analyzePage(
      `<body><nav><a href="/1">1</a><nav><a href="/2">2</a></nav><a href="/3">3</a></nav></body>`,
      "https://x.test/",
    );
    expect(a.navLinkCount).toBe(3);
    expect(a.footerLinkCount).toBe(0);
  });

  it("reports zero on a page with no nav or footer", () => {
    const a = analyzePage(`<body><a href="/a">A</a></body>`, "https://x.test/");
    expect(a.navLinkCount).toBe(0);
    expect(a.footerLinkCount).toBe(0);
  });
});

// The client-rendered-framework tell, read off the raw HTML. It says which
// framework shipped the page, not whether the page needs JavaScript — the
// render pass answers that. Markers are reported in the constant's order, not
// document order, so the column is a set with a stable spelling.
describe("framework markers", () => {
  it("detects the Next.js data script", () => {
    expect(
      analyzePage(
        `<body><script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script></body>`,
        "https://x.test/",
      ).frameworkMarkers,
    ).toEqual(["__NEXT_DATA__"]);
  });

  it("detects data-reactroot on any element", () => {
    expect(
      analyzePage(`<body><div data-reactroot=""><p>x</p></div></body>`, "https://x.test/")
        .frameworkMarkers,
    ).toEqual(["data-reactroot"]);
  });

  it("detects ng-app on any element", () => {
    expect(
      analyzePage(`<html ng-app="shopApp"><body></body></html>`, "https://x.test/")
        .frameworkMarkers,
    ).toEqual(["ng-app"]);
  });

  it("reports every marker present, in the constant's order", () => {
    expect(
      analyzePage(
        `<html><body><div ng-app="a"><span data-reactroot></span></div>
         <script id="__NEXT_DATA__">{}</script></body></html>`,
        "https://x.test/",
      ).frameworkMarkers,
    ).toEqual(["__NEXT_DATA__", "data-reactroot", "ng-app"]);
  });

  it("reports an empty list when the page carries no marker", () => {
    expect(
      analyzePage(
        `<html><body><script id="app-data">{}</script><div id="root"></div></body></html>`,
        "https://x.test/",
      ).frameworkMarkers,
    ).toEqual([]);
  });

  it("does not read a marker out of a <noscript> body", () => {
    // <noscript> content is raw text to a scripting-enabled parser, so the
    // element inside it is not an element (the port's existing rule).
    expect(
      analyzePage(
        `<html><body><noscript><div data-reactroot></div></noscript></body></html>`,
        "https://x.test/",
      ).frameworkMarkers,
    ).toEqual([]);
  });

  it("matches the script id case-sensitively, as an id is", () => {
    expect(
      analyzePage(`<body><script id="__next_data__">{}</script></body>`, "https://x.test/")
        .frameworkMarkers,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 23 T5 — where the <head> really ends.
//
// Every case is asserted twice: once against the value the case was written
// for, and once against the DOM oracle — cheerio over parse5 with scripting
// enabled, the HTML tree builder a browser and a search engine run. The oracle
// answers "is this element inside <head>?" by walking DOWN from the root and
// noting when it passes the head element (template content included: its
// fragment hangs off the template's children but carries no parent pointer, so
// an upward `parents('head')` would miss it). It is a reading of the tree, not
// of the token stream. An svg `<title>` is not a document title on either side.
// ---------------------------------------------------------------------------

interface DomNode {
  type?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

interface HeadView {
  titleOutsideHead: boolean;
  metaDescriptionOutsideHead: boolean;
  robotsOutsideHead: boolean;
  canonicalOutsideHead: boolean;
  hreflangOutsideHeadCount: number;
}

/** The parse5 tree's answer to the five outside-head questions. */
function domHeadView(html: string): HeadView & { bodyFirst: string | null } {
  // A decoder strips the byte-order mark before any parser sees the text
  // (TextDecoder does, in fetch); handing parse5 a raw string skips that step.
  const $ = cheerio.load(html.replace(/^﻿/, ""));
  const view: HeadView = {
    titleOutsideHead: false,
    metaDescriptionOutsideHead: false,
    robotsOutsideHead: false,
    canonicalOutsideHead: false,
    hreflangOutsideHeadCount: 0,
  };
  const fold = (v: string | undefined) => v?.trim().toLowerCase();
  // FIRST OCCURRENCE in tree order for the four single-element flags: the
  // first one decides, and it decides whether it is inside or outside.
  const seen = new Set<string>();
  const first = (kind: keyof HeadView, outside: boolean) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    (view as unknown as Record<string, boolean>)[kind] = outside;
  };
  const walk = (node: DomNode, inHead: boolean, inSvg: boolean) => {
    const isElement = node.type === "tag" || node.type === "script" || node.type === "style";
    const name = isElement ? node.name?.toLowerCase() : undefined;
    const attribs = node.attribs ?? {};
    if (name !== undefined) {
      const rel = (fold(attribs["rel"]) ?? "").split(/\s+/);
      const outside = !inHead;
      if (name === "title" && !inSvg) first("titleOutsideHead", outside);
      if (name === "meta" && fold(attribs["name"]) === "description") {
        first("metaDescriptionOutsideHead", outside);
      }
      if (name === "meta" && fold(attribs["name"]) === "robots") first("robotsOutsideHead", outside);
      if (name === "link" && rel.includes("canonical")) first("canonicalOutsideHead", outside);
      if (outside && name === "link" && rel.includes("alternate") && attribs["hreflang"]) {
        view.hreflangOutsideHeadCount += 1;
      }
    }
    for (const child of node.children ?? []) {
      walk(child, inHead || name === "head", inSvg || name === "svg");
    }
  };
  walk($.root()[0] as unknown as DomNode, false, false);
  const body = $("body")[0] as unknown as DomNode | undefined;
  const firstChild = body?.children?.[0];
  const bodyFirst =
    firstChild === undefined
      ? null
      : firstChild.type === "text"
        ? "#text"
        : (firstChild.name ?? null);
  return { ...view, bodyFirst };
}

/**
 * The port's view, asserted equal to the oracle's on the five flags. When the
 * port names an ELEMENT or `#text` as the closer, the oracle's body must begin
 * with it, because the token that closes the head implicitly is the first thing
 * the tree builder puts in the body. (`body` itself and an end tag such as
 * `</html>` leave no node of their own at the body's start, so they are
 * asserted by value only.)
 */
function headOf(html: string) {
  const a = analyzePage(html, "https://x.test/");
  const { bodyFirst, ...domView } = domHeadView(html);
  const port: HeadView = {
    titleOutsideHead: a.titleOutsideHead,
    metaDescriptionOutsideHead: a.metaDescriptionOutsideHead,
    robotsOutsideHead: a.robotsOutsideHead,
    canonicalOutsideHead: a.canonicalOutsideHead,
    hreflangOutsideHeadCount: a.hreflangOutsideHeadCount,
  };
  expect(port, `oracle parity: ${html}`).toEqual(domView);
  const closer = a.headClosedBy;
  if (closer !== null && closer !== "body" && !closer.startsWith("</")) {
    expect(bodyFirst, `oracle: the body begins with the closer: ${html}`).toBe(closer);
  }
  return a;
}

const CANONICAL = `<link rel="canonical" href="https://x.test/">`;

describe("implicit head close: the brief's six cases", () => {
  it("an <img> in the head closes it: a canonical after it is outside", () => {
    const a = headOf(
      `<html><head><title>T</title><img src="/p.gif">${CANONICAL}</head><body><p>x</p></body></html>`,
    );
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.headClosedBy).toBe("img");
  });

  it("an <img> inside a <noscript> in the head does not close it", () => {
    const a = headOf(
      `<html><head><title>T</title><noscript><img src="/p.gif"></noscript>${CANONICAL}</head><body><p>x</p></body></html>`,
    );
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.headClosedBy).toBeNull();
  });

  it("a document with no <head> tag at all keeps a leading canonical in the head", () => {
    const a = headOf(`<!doctype html><html>${CANONICAL}<title>T</title><p>x</p></html>`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.titleOutsideHead).toBe(false);
    expect(a.headClosedBy).toBe("p");
  });

  it("text before the canonical closes the head", () => {
    const a = headOf(`<html><head><title>T</title>hello${CANONICAL}</head><body></body></html>`);
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.headClosedBy).toBe("#text");
  });

  it("a <div> inside a <template> in the head does not close it", () => {
    const a = headOf(
      `<html><head><template><div>tpl</div></template>${CANONICAL}</head><body></body></html>`,
    );
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.headClosedBy).toBeNull();
  });

  it("explicit </head>, canonical in the body: outside, closed by null", () => {
    const a = headOf(`<html><head><title>T</title></head><body>${CANONICAL}<p>x</p></body></html>`);
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.headClosedBy).toBeNull();
  });
});

describe("implicit head close: Review Focus #2 and the tree builder's other rules", () => {
  it("whitespace, comments, script, style, noscript and a doctype never close the head", () => {
    const a = headOf(`<!DOCTYPE html>
      <html lang="en">
      <!-- before head -->
      <head>
        <!-- a comment -->
        <meta charset="utf-8">
        <script>document.write("<div>not a tag</div>")</script>
        <style>body > p { color: red }</style>
        <title>A <b>title</b> &amp; co</title>
        <noscript><style>.x{}</style><img src="/n.gif"><p>no js</p></noscript>
        <base href="/">
        ${CANONICAL}
        <meta name="robots" content="index">
        <meta name="description" content="d">
        <link rel="alternate" hreflang="de" href="/de">
      </head>
      <body><p>x</p></body></html>`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.robotsOutsideHead).toBe(false);
    expect(a.metaDescriptionOutsideHead).toBe(false);
    expect(a.titleOutsideHead).toBe(false);
    expect(a.hreflangOutsideHeadCount).toBe(0);
    expect(a.headClosedBy).toBeNull();
  });

  it("a byte-order mark and whitespace before an attributed <html> do not close the head", () => {
    const a = headOf(`﻿  \n<html lang="en" class="no-js">${CANONICAL}<p>x</p>`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.headClosedBy).toBe("p");
  });

  it("a fragment with no <html>, <head> or <body> at all", () => {
    const a = headOf(
      `<title>T</title><meta name="robots" content="noindex"><p>x</p><meta name="description" content="d">`,
    );
    expect(a.titleOutsideHead).toBe(false);
    expect(a.robotsOutsideHead).toBe(false);
    expect(a.metaDescriptionOutsideHead).toBe(true);
    expect(a.headClosedBy).toBe("p");
  });

  it("an <svg> in the head closes it, and a title after it is outside", () => {
    const a = headOf(
      `<html><head><svg><title>icon</title></svg><title>T</title></head><body></body></html>`,
    );
    expect(a.headClosedBy).toBe("svg");
    expect(a.titleOutsideHead).toBe(true);
  });

  it("a <math> in the head closes it", () => {
    const a = headOf(`<html><head><math></math>${CANONICAL}</head><body></body></html>`);
    expect(a.headClosedBy).toBe("math");
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("an svg <title> in the body is not a document title", () => {
    const a = headOf(
      `<html><head><title>T</title></head><body><svg><title>icon</title></svg></body></html>`,
    );
    expect(a.titleOutsideHead).toBe(false);
  });

  it("a non-breaking space is text, not whitespace, and closes the head", () => {
    const a = headOf(`<html><head>&nbsp;${CANONICAL}</head><body></body></html>`);
    expect(a.headClosedBy).toBe("#text");
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("a stray </p> or </div> in the head is ignored, as the tree builder ignores it", () => {
    const a = headOf(`<html><head></p></div>${CANONICAL}</head><body></body></html>`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.headClosedBy).toBeNull();
  });

  it("a stray </br> in the head closes it, as a <br>", () => {
    const a = headOf(`<html><head></br>${CANONICAL}</head><body></body></html>`);
    expect(a.headClosedBy).toBe("br");
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("head tags between </head> and <body> go back into the head", () => {
    // The "after head" insertion mode re-opens the head for these: a browser
    // puts the canonical in the head, so it is not outside.
    const a = headOf(
      `<html><head><title>T</title></head>\n${CANONICAL}<meta name="robots" content="noindex"><body><p>x</p></body></html>`,
    );
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.robotsOutsideHead).toBe(false);
    expect(a.headClosedBy).toBeNull();
  });

  it("text between </head> and <body> opens the body", () => {
    const a = headOf(`<html><head></head>stray${CANONICAL}<body></body></html>`);
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.headClosedBy).toBeNull();
  });

  it("KNOWN LIMIT: a </head> with no <head> open is invisible; only the closer's name differs", () => {
    // htmlparser2 drops an end tag whose element is not open, so the head ends
    // at <body> here, where the tree builder would call it explicit. The flags
    // still agree with the oracle: the canonical between the two is in the head
    // on both sides (the "after head" re-open).
    const a = headOf(`<html><title>T</title></head>${CANONICAL}<body><p>x</p></body></html>`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.headClosedBy).toBe("body");
  });

  it("KNOWN LIMIT: a stray </body> in the head is invisible — a false negative, pinned", () => {
    // parse5 reads `</body>` in the head as "anything else" and ends it, so the
    // canonical after it is in the body. htmlparser2 drops the end tag (no
    // <body> is open), the head stays open here, and the canonical reads as
    // inside. Never the other way round: this can only under-report.
    const html = `<html><head><title>T</title></body>${CANONICAL}</head><body><p>x</p></body></html>`;
    const a = analyzePage(html, "https://x.test/");
    expect(a.canonicalOutsideHead).toBe(false);
    expect(domHeadView(html).canonicalOutsideHead).toBe(true);
  });

  it("KNOWN LIMIT: a stray </html> with no <html> open is invisible — a false negative, pinned", () => {
    const html = `<title>T</title></html>${CANONICAL}<p>x</p>`;
    const a = analyzePage(html, "https://x.test/");
    expect(a.canonicalOutsideHead).toBe(false);
    expect(domHeadView(html).canonicalOutsideHead).toBe(true);
  });

  it("</html> with <html> open ends the head in head mode, and is named as the closer", () => {
    const a = headOf(`<html><head><title>T</title></html>${CANONICAL}`);
    expect(a.headClosedBy).toBe("</html>");
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.titleOutsideHead).toBe(false);
  });

  it("a second <head> in the body does not reopen it", () => {
    const a = headOf(`<html><head></head><body><head>${CANONICAL}</head><p>x</p></body></html>`);
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("an unclosed head on a document with no body keeps everything inside", () => {
    const a = headOf(`<html><head><title>T</title>${CANONICAL}`);
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.titleOutsideHead).toBe(false);
    expect(a.headClosedBy).toBeNull();
  });

  it("<body> closes an unclosed head and is named as the closer", () => {
    const a = headOf(`<html><head><title>T</title><body>${CANONICAL}</body></html>`);
    expect(a.headClosedBy).toBe("body");
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("a canonical inside a <noscript> in the body is raw text, not an element", () => {
    const a = headOf(`<html><head></head><body><noscript>${CANONICAL}</noscript></body></html>`);
    expect(a.canonicalOutsideHead).toBe(false);
  });

  it("a canonical inside a <template> in the body is outside, as a selector sees it", () => {
    const a = headOf(`<html><head></head><body><template>${CANONICAL}</template></body></html>`);
    expect(a.canonicalOutsideHead).toBe(true);
  });

  it("counts every hreflang alternate outside the head and none inside it", () => {
    const a = headOf(`<html><head><link rel="alternate" hreflang="en" href="/en"></head><body>
      <link rel="alternate" hreflang="de" href="/de">
      <link rel="Alternate" hreflang="fr" href="/fr">
      <link rel="alternate" href="/no-code">
      <link rel="alternate" hreflang="x-default">
    </body></html>`);
    expect(a.hreflangOutsideHeadCount).toBe(3);
  });

  it("leaves every extracted value as it was: first occurrence anywhere", () => {
    const a = headOf(
      `<html><head><img src="/p.gif">${CANONICAL}<title>Late</title><meta name="robots" content="noindex"></head><body></body></html>`,
    );
    expect(a.canonicalOutsideHead).toBe(true);
    expect(a.titleOutsideHead).toBe(true);
    expect(a.robotsOutsideHead).toBe(true);
    expect(a.canonicalHtml).toBe("https://x.test/");
    expect(a.title).toBe("Late");
    expect(a.robotsMeta).toBe("noindex");
  });
});

// Fix round 1 ruling: the four single-element flags are FIRST-OCCURRENCE flags.
// A correct in-head tag followed by a body duplicate is false (the duplicate is
// `canonical.multiple`'s business for canonicals); a body copy with no in-head
// one before it is true. The hreflang column stays a count.
describe("outside-head flags are first-occurrence flags", () => {
  const SHAPES = [
    {
      flag: "canonicalOutsideHead",
      tag: `<link rel="canonical" href="https://x.test/">`,
    },
    { flag: "robotsOutsideHead", tag: `<meta name="robots" content="index, follow">` },
    { flag: "titleOutsideHead", tag: `<title>T</title>` },
    { flag: "metaDescriptionOutsideHead", tag: `<meta name="description" content="d">` },
  ] as const;

  for (const { flag, tag } of SHAPES) {
    it(`${flag}: in the head, then a duplicate in the body -> false`, () => {
      const a = headOf(`<html><head>${tag}</head><body><p>x</p>${tag}</body></html>`);
      expect(a[flag]).toBe(false);
    });

    it(`${flag}: only in the body -> true`, () => {
      const a = headOf(`<html><head></head><body><p>x</p>${tag}</body></html>`);
      expect(a[flag]).toBe(true);
    });

    it(`${flag}: first after an implicit close, second in the body -> true`, () => {
      const a = headOf(`<html><head><img src="/p.gif">${tag}</head><body>${tag}</body></html>`);
      expect(a[flag]).toBe(true);
    });
  }

  it("a title inside an svg in the head does not take the first-title slot", () => {
    // The svg closes the head, so the document title after it is the first
    // non-svg title and it is outside.
    const a = headOf(`<html><head><title>T</title></head><body><svg><title>i</title></svg><title>U</title></body></html>`);
    expect(a.titleOutsideHead).toBe(false);
  });

  it("hreflang stays a count: in-head alternates do not offset body ones", () => {
    const a = headOf(`<html><head><link rel="alternate" hreflang="en" href="/en"></head><body>
      <link rel="alternate" hreflang="en" href="/en"></body></html>`);
    expect(a.hreflangOutsideHeadCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 26b T4 — HTML structure facts. Explicit start-tag counts, head/body
// order and the element that closed the head early (deviation 6). Cheerio
// cannot be the oracle for these: parse5 normalises the tree (one html, one
// head, one body, whatever the markup says), so every case is asserted by
// value. The head-flag cases go through `headOf`, so the oracle still holds the
// five outside-head flags while the structure facts are read beside them.
// ---------------------------------------------------------------------------

const structureOf = (html: string) => analyzePage(html, "https://x.test/").htmlStructure;

describe("html structure: explicit tag counts and order", () => {
  it("counts a second explicit <body>", () => {
    expect(structureOf(`<html><head></head><body></body><body></body>`)).toEqual({
      htmlTags: 1,
      headTags: 1,
      bodyTags: 2,
      headBeforeBody: true,
      closedEarly: null,
    });
  });

  it("a <head> after the <body> is out of order", () => {
    expect(structureOf(`<body></body><head></head>`).headBeforeBody).toBe(false);
  });

  it("no explicit tags at all: counts 0, order null", () => {
    expect(structureOf(`<title>t</title><p>x</p>`)).toEqual({
      htmlTags: 0,
      headTags: 0,
      bodyTags: 0,
      headBeforeBody: null,
      closedEarly: null,
    });
  });

  it("order is null when only one of the two is explicit", () => {
    expect(structureOf(`<html><head><title>t</title></head><p>x</p>`).headBeforeBody).toBeNull();
    expect(structureOf(`<title>t</title><body><p>x</p></body>`).headBeforeBody).toBeNull();
  });

  it("counts every explicit <html> and <head>; the first of head and body decides the order", () => {
    const s = structureOf(`<html><head></head><body><html lang="x"><head></head></body></html>`);
    expect(s).toMatchObject({ htmlTags: 2, headTags: 2, bodyTags: 1, headBeforeBody: true });
  });

  it("implied tags are not counted: htmlparser2 implies none of the three", () => {
    expect(structureOf(`<p>x`)).toMatchObject({ htmlTags: 0, headTags: 0, bodyTags: 0 });
  });
});

describe("html structure: the head closed early (deviation 6, Review Focus 3)", () => {
  it("a valid document that omits </head> and starts its body is not flagged", () => {
    expect(structureOf(`<!doctype html><title>x</title><div>a</div>`).closedEarly).toBeNull();
  });

  it("a non-head child of a head <noscript> is the candidate, and </head> confirms it", () => {
    const a = headOf(
      `<head><meta charset=utf-8><noscript><iframe src="https://gtm/x"></iframe></noscript></head><body>`,
    );
    expect(a.htmlStructure.closedEarly).toEqual({
      tag: "iframe",
      inNoscript: true,
      snippet: `<iframe src="https://gtm/x">`,
      lost: [],
    });
  });

  it("the head-noscript detection leaves the head machine exactly as it was", () => {
    // The iframe is invisible to the head machine (Phase 23): the canonical
    // after the noscript is still in the head, and nothing closed it.
    const a = headOf(
      `<html><head><noscript><iframe src="/x"></iframe></noscript>${CANONICAL}</head><body><p>x</p></body></html>`,
    );
    expect(a.headClosedBy).toBeNull();
    expect(a.canonicalOutsideHead).toBe(false);
    expect(a.htmlStructure.closedEarly).toMatchObject({ tag: "iframe", inNoscript: true });
  });

  it("link, meta and style inside a head <noscript> are not candidates", () => {
    const s = structureOf(
      `<html><head><noscript><link rel="stylesheet" href="/a.css"><meta name="x" content="y">` +
        `<style>p{}</style></noscript><title>t</title></head><body><p>x</p></body></html>`,
    );
    expect(s.closedEarly).toBeNull();
  });

  it("a <noscript> in the body is not a head noscript", () => {
    const s = structureOf(
      `<html><head><title>t</title></head><body><noscript><iframe src="/x"></iframe></noscript>` +
        `<meta itemprop="name" content="n"></body></html>`,
    );
    expect(s.closedEarly).toBeNull();
  });

  it("a non-head start tag followed by a head-only element", () => {
    const a = headOf(`<head><div>x</div><title>t</title>`);
    expect(a.htmlStructure.closedEarly).toEqual({
      tag: "div",
      inNoscript: false,
      snippet: "<div>",
      lost: ["title"],
    });
    expect(a.headClosedBy).toBe("div");
  });

  it("text in the head is recorded as #text with the trimmed text as its snippet", () => {
    const a = headOf(`<head>hello</head>`);
    expect(a.htmlStructure.closedEarly).toEqual({
      tag: "#text",
      inNoscript: false,
      snippet: "hello",
      lost: [],
    });
    expect(a.headClosedBy).toBe("#text");
  });

  it("a 500-character start tag is capped at HEAD_SNIPPET_MAX", () => {
    const tag = `<img src="/p.gif" data-x="${"x".repeat(500)}">`;
    const s = structureOf(`<head>${tag}<title>t</title></head>`);
    expect(s.closedEarly?.tag).toBe("img");
    expect(s.closedEarly?.snippet).toBe(tag.slice(0, HEAD_SNIPPET_MAX));
    expect(s.closedEarly?.snippet).toHaveLength(HEAD_SNIPPET_MAX);
  });

  it("long head text is capped at HEAD_SNIPPET_MAX", () => {
    const s = structureOf(`<head>${"t".repeat(500)}</head>`);
    expect(s.closedEarly?.snippet).toBe("t".repeat(HEAD_SNIPPET_MAX));
  });

  it("an explicit <body> after the candidate confirms it", () => {
    const s = structureOf(`<html><head><img src="/p.gif"><body><p>x</p></body></html>`);
    expect(s.closedEarly).toMatchObject({ tag: "img", inNoscript: false });
  });

  it("each head-only element after the candidate confirms it (ruling R8)", () => {
    const tails = [
      `<title>t</title>`,
      `<meta name="a" content="b">`,
      `<link rel="icon" href="/i">`,
      `<link rel="canonical" href="/c">`,
      `<link rel="stylesheet icon" href="/i">`,
      `<base href="/">`,
    ];
    for (const tail of tails) {
      expect(structureOf(`<head><img src="/p.gif"><p>x</p>${tail}`).closedEarly, tail).toMatchObject({
        tag: "img",
      });
    }
  });

  it("what a body may hold is not evidence (ruling R8)", () => {
    const tails = [
      `<style>p{}</style>`,
      `<meta itemprop="name" content="a">`,
      `<link rel="stylesheet" href="/a.css">`,
      `<link rel="stylesheet preload" href="/a.css">`,
      `<link rel="MODULEPRELOAD" href="/m.js">`,
      `<link href="/no-rel">`,
      `<link rel="  " href="/blank-rel">`,
      `<svg><title>i</title></svg>`,
    ];
    for (const tail of tails) {
      expect(structureOf(`<head><img src="/p.gif"><p>x</p>${tail}`).closedEarly, tail).toBeNull();
    }
  });

  it("a minified page: body-ok elements leave it unflagged, a head-only one confirms (R8)", () => {
    const page =
      `<title>t</title><div>x</div><meta itemprop="name" content="a">` +
      `<link rel="stylesheet" href="/a.css"><style>p{}</style><svg><title>i</title></svg>`;
    expect(structureOf(page).closedEarly).toBeNull();
    expect(structureOf(`${page}<meta name="description" content="d">`).closedEarly).toEqual({
      tag: "div",
      inNoscript: false,
      snippet: "<div>",
      lost: ["meta"],
    });
    expect(structureOf(`${page}<link rel="canonical" href="/c">`).closedEarly).toMatchObject({
      tag: "div",
    });
  });

  it("a title after a closed svg is evidence again", () => {
    expect(
      structureOf(`<title>t</title><div>x</div><svg><title>i</title></svg><title>u</title>`).closedEarly,
    ).toMatchObject({ tag: "div" });
  });

  it("nothing after the candidate but body content: not confirmed", () => {
    const s = structureOf(`<head><title>t</title><img src="/p.gif"><p>x</p><script>1</script>`);
    expect(s.closedEarly).toBeNull();
  });

  it("an explicit </head> before the body is not an early close", () => {
    const s = structureOf(
      `<html><head><title>t</title></head><body><div>x</div><title>u</title></body></html>`,
    );
    expect(s.closedEarly).toBeNull();
  });

  it("<body> is where the head ends, not an early close, whatever follows it", () => {
    // An omitted </head> with the body opened by <body>: the head ended where
    // it was meant to, so a stylesheet link or a microdata meta in the body is
    // no evidence of anything.
    const s = structureOf(
      `<html><head><title>t</title><body><link rel="stylesheet" href="/a.css">` +
        `<meta itemprop="n" content="v"></body></html>`,
    );
    expect(s.closedEarly).toBeNull();
  });

  it("the FIRST candidate wins: a head-noscript child before a non-head tag", () => {
    const s = structureOf(`<head><noscript><img src="/n.gif"></noscript><div>x</div></head>`);
    expect(s.closedEarly).toEqual({
      tag: "img",
      inNoscript: true,
      snippet: `<img src="/n.gif">`,
      lost: [],
    });
  });

  it("a stray </p> in the head is ignored; a stray </br> is a candidate, read as <br>", () => {
    expect(structureOf(`<head><title>t</title></p></head>`).closedEarly).toBeNull();
    expect(structureOf(`<head><title>t</title></br></head>`).closedEarly).toEqual({
      tag: "br",
      inNoscript: false,
      snippet: "</br>",
      lost: [],
    });
  });

  it("a <div> inside a head <template> is not a candidate", () => {
    const s = structureOf(`<head><template><div>x</div></template><title>t</title></head>`);
    expect(s.closedEarly).toBeNull();
  });

  it("a head tag inside a head <noscript> is never a candidate (R12, R12b)", () => {
    for (const child of [
      `<script>1</script>`,
      `<noframes>n</noframes>`,
      `<basefont size="3">`,
      `<bgsound src="/s.wav">`,
      `<title>nt</title>`,
      `<base href="/">`,
      `<template><p>t</p></template>`,
      `<link rel="stylesheet" href="/a.css">`,
      `<meta name="x" content="y">`,
      `<style>p{}</style>`,
    ]) {
      const s = structureOf(
        `<html><head><noscript>${child}</noscript><title>t</title></head><body></body></html>`,
      );
      expect(s.closedEarly, child).toBeNull();
    }
  });

  it("a tag the head cannot hold inside a head <noscript> is a candidate (R12b)", () => {
    for (const [child, tag] of [
      [`<iframe src="/f"></iframe>`, "iframe"],
      [`<div>x</div>`, "div"],
      [`<img src="/p.gif">`, "img"],
    ] as const) {
      const s = structureOf(
        `<html><head><noscript>${child}</noscript><title>t</title></head><body></body></html>`,
      );
      expect(s.closedEarly, child).toMatchObject({ tag, inNoscript: true });
    }
  });

  it("an orphan </head> is not evidence: htmlparser2 drops it (documented limit)", () => {
    expect(structureOf(`<title>t</title><div>x</div></head>`).closedEarly).toBeNull();
  });

  it("C1: a head text of 2 MiB of inner spaces is trimmed in linear time", () => {
    // `[ws]+$` backtracked quadratically on this shape (80k spaces: ~10 s); the
    // edge scan is linear, so 2 MiB finishes well inside the test timeout.
    const spaces = " ".repeat(2 * 1024 * 1024);
    const s = structureOf(`<head>a${spaces}b</head>`);
    expect(s.closedEarly).toEqual({
      tag: "#text",
      inNoscript: false,
      snippet: `a${" ".repeat(HEAD_SNIPPET_MAX - 1)}`,
      lost: [],
    });
    // Short text: both edges trimmed, the inner run kept.
    expect(structureOf(`<head> \t a  b \n</head>`).closedEarly?.snippet).toBe("a  b");
  });

  it("20 MB-safe: 100,000 divs leave a capped snippet and scalar state", () => {
    const div = `<div class="${"c".repeat(300)}">x</div>`;
    const s = structureOf(
      `<html><head>${div.repeat(100_000)}<title>t</title></head><body></body></html>`,
    );
    expect(s.closedEarly?.snippet.length).toBeLessThanOrEqual(HEAD_SNIPPET_MAX);
    // Four scalars and one fixed-shape object whose one array, `lost`, is
    // capped at HEAD_LOST_MAX (owner call O3).
    expect(s).toEqual({
      htmlTags: 1,
      headTags: 1,
      bodyTags: 1,
      headBeforeBody: true,
      closedEarly: {
        tag: "div",
        inNoscript: false,
        snippet: div.slice(0, HEAD_SNIPPET_MAX),
        lost: ["title"],
      },
    });
    expect(JSON.stringify(s).length).toBeLessThan(400);
  });
});

// Owner call O3 (2026-11-07): `closedEarly.lost`, the head tags after the
// candidate that a parser closing the head there moves into the body.
describe("html structure: what an early close loses (owner call O3)", () => {
  const PIXEL =
    `<noscript><img height="1" width="1" style="display:none" ` +
    `src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript>`;
  const HEAD =
    `<meta charset="utf-8"><title>t</title><meta name="description" content="d">` +
    `<link rel="canonical" href="/c">`;

  it("the Meta pixel last in the head loses nothing: </head> and <body> are evidence, never lost", () => {
    const s = structureOf(`<html><head>${HEAD}${PIXEL}</head><body><p>x</p></body></html>`);
    expect(s.closedEarly).toMatchObject({ tag: "img", inNoscript: true, lost: [] });
  });

  it("a pixel followed by a description and a canonical loses both, in document order", () => {
    const s = structureOf(
      `<html><head><title>t</title>${PIXEL}<meta name="description" content="d">` +
        `<link rel="canonical" href="/c"></head><body><p>x</p></body></html>`,
    );
    expect(s.closedEarly?.lost).toEqual(["meta", "link rel=canonical"]);
  });

  it("a body-ok link, a microdata meta and an svg title after the candidate are not lost", () => {
    const s = structureOf(
      `<html><head><title>t</title>${PIXEL}<link rel="stylesheet" href="/a.css">` +
        `<link rel="PRELOAD" href="/f.woff2"><link href="/no-rel"><meta itemprop="n" content="v">` +
        `<style>p{}</style><svg><title>i</title></svg></head><body><p>x</p></body></html>`,
    );
    expect(s.closedEarly).toMatchObject({ tag: "img", lost: [] });
  });

  it("records base, title, meta and each head-only link rel once, in first-seen order", () => {
    const s = structureOf(
      `<head><div>x</div><meta name="a" content="1"><title>t</title><meta name="b" content="2">` +
        `<link rel="stylesheet ICON" href="/i"><link rel="canonical" href="/c">` +
        `<link rel="alternate" hreflang="fr" href="/fr"><link rel="Canonical" href="/c2">` +
        `<base href="/"><title>u</title></head><body></body>`,
    );
    expect(s.closedEarly?.lost).toEqual([
      "meta",
      "title",
      "link rel=icon",
      "link rel=canonical",
      "link rel=alternate",
      "base",
    ]);
  });

  it("stops at the explicit <body>: a head tag after it is in the body whatever closed the head", () => {
    const s = structureOf(
      `<html><head><title>t</title>${PIXEL}<body><meta name="x" content="y">` +
        `<link rel="canonical" href="/c"></body></html>`,
    );
    expect(s.closedEarly).toMatchObject({ tag: "img", lost: [] });
    const t = structureOf(
      `<html><head>${PIXEL}<meta name="robots" content="noindex"></head><body>` +
        `<link rel="canonical" href="/c"></body></html>`,
    );
    expect(t.closedEarly?.lost).toEqual(["meta"]);
  });

  it("caps the list at HEAD_LOST_MAX", () => {
    const links = Array.from({ length: HEAD_LOST_MAX + 3 }, (_, i) => `<link rel="r${i}" href="/${i}">`).join("");
    const s = structureOf(`<head><div>x</div>${links}</head><body></body>`);
    expect(s.closedEarly?.lost).toEqual(
      Array.from({ length: HEAD_LOST_MAX }, (_, i) => `link rel=r${i}`),
    );
  });

  it("ignores tags inside a <template>: template content is never in the head", () => {
    const s = structureOf(
      `<html><head><div>x</div><template><meta name="x" content="y"><title>t</title></template></head><body></body></html>`,
    );
    // The `<body>` start tag is still evidence; nothing in the template is lost.
    expect(s.closedEarly).toMatchObject({ tag: "div", lost: [] });
    const t = structureOf(
      `<html><head><div>x</div><template><meta name="x" content="y"></template><link rel="canonical" href="/c"></head><body></body></html>`,
    );
    expect(t.closedEarly?.lost).toEqual(["link rel=canonical"]);
  });

  it("a hostile rel token is made storable and cut at HEAD_SNIPPET_MAX", () => {
    const token = "x".repeat(HEAD_SNIPPET_MAX + 50);
    const s = structureOf(`<head><div>x</div><link rel="${token}" href="/"></head>`);
    const [entry] = s.closedEarly?.lost ?? [];
    expect(entry).toHaveLength(HEAD_SNIPPET_MAX);
    expect(entry?.startsWith("link rel=xxx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 26b: every new page-derived string is storable (storable-text.ts):
// U+0000 to U+2400, a lone surrogate to U+FFFD, caps cut on a code point.
// ---------------------------------------------------------------------------

describe("Phase 26b strings are storable in Postgres", () => {
  const NUL = "\u0000";
  const MARK = "␀";

  it("a NUL in any 26b string fact is stored as U+2400", () => {
    const a = analyzePage(
      `<html lang="e${NUL}n"><head><meta property="og:title" content="T${NUL}">` +
        `<meta name="robots" content="index${NUL}"><meta name="googlebot" content="noindex${NUL}">` +
        `<meta http-equiv="refresh" content="5;url=/x${NUL}y"></head>` +
        `<body><h2>H${NUL}</h2><img src="/i${NUL}.png"><iframe src="http://x.test/f${NUL}g"></iframe></body></html>`,
      "https://x.test/",
    );
    expect(a.htmlLang).toBe(`e${MARK}n`);
    expect(a.social?.og.title).toBe(`T${MARK}`);
    expect(a.robotsMeta).toBe(`index${MARK}`);
    expect(a.robotsMetas).toEqual([{ name: "googlebot", content: `noindex${MARK}` }]);
    expect(a.metaRefresh?.raw).toBe(`5;url=/x${MARK}y`);
    // The URL parser percent-encodes an inner NUL; the helper leaves that alone.
    expect(a.metaRefresh?.target).toBe("https://x.test/x%00y");
    expect(a.h2Text).toBe(`H${MARK}`);
    expect(a.imagesMissingAltSample).toEqual([`/i${MARK}.png`]);
    expect(a.insecureRefs.sample[0]?.url).toBe("http://x.test/f%00g");
  });

  it("a NUL in head text and in a candidate tag reaches the snippet as U+2400", () => {
    expect(structureOf(`<head>a${NUL}b</head>`).closedEarly?.snippet).toBe(`a${MARK}b`);
    expect(structureOf(`<head><img alt="${NUL}"><title>t</title></head>`).closedEarly?.snippet).toBe(
      `<img alt="${MARK}">`,
    );
  });

  it("a snippet cut in the middle of an emoji drops the whole pair", () => {
    // `<img data-x="` is 13 units; 186 more put the emoji's high surrogate at
    // index 199, the last unit under the cap.
    const prefix = `<img data-x="${"x".repeat(186)}`;
    expect(prefix).toHaveLength(HEAD_SNIPPET_MAX - 1);
    expect(structureOf(`<head>${prefix}😀"><title>t</title></head>`).closedEarly?.snippet).toBe(prefix);
    const text = "t".repeat(HEAD_SNIPPET_MAX - 1);
    expect(structureOf(`<head>${text}😀</head>`).closedEarly?.snippet).toBe(text);
  });

  it("a social value cut in the middle of an emoji drops the whole pair", () => {
    const a = analyzePage(
      `<head><meta property="og:title" content="${"x".repeat(299)}😀"></head>`,
      "https://x.test/",
    );
    expect(a.social?.og.title).toBe("x".repeat(299));
  });

  it("a lone surrogate (a direct string: entities already decode to U+FFFD) becomes U+FFFD", () => {
    const a = analyzePage(
      `<head><meta property="og:title" content="a\uD800b"></head><body><h2>c\uDC00</h2></body>`,
      "https://x.test/",
    );
    expect(a.social?.og.title).toBe("a�b");
    expect(a.h2Text).toBe("c�");
    expect(structureOf(`<head>x\uD800</head>`).closedEarly?.snippet).toBe("x�");
  });
});
