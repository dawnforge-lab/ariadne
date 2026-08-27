import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";

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
