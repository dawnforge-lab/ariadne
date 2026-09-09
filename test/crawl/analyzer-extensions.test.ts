import { describe, expect, it } from "vitest";
import {
  analyzePage,
  SOFT_404_PHRASES,
} from "../../src/crawl/parse/page-analyzer.js";
import { simhash64, hammingDistance } from "../../src/crawl/parse/simhash.js";
import {
  P7_HIDDEN_CHROME_BODY,
  P7_RENDERABLE_WORD_COUNT,
  P7_WORD_COUNT,
} from "../fixtures/pages/authored-p7.js";

const HTML = `<!doctype html><html><head>
<title>P2</title>
<link rel="next" href="/list?page=3"><link rel="prev" href="/list?page=1">
<link rel="alternate" hreflang="en-gb" href="https://ex.com/en/">
<link rel="alternate" hreflang="de" href="https://ex.com/de/">
<script type="application/ld+json">{"@type":"Product","name":"W","offers":{"price":"9"}}</script>
</head><body><p>short text body</p></body></html>`;

describe("analyzer extensions", () => {
  const a = analyzePage(HTML, "https://ex.com/list?page=2");
  it("captures rel next/prev", () => {
    expect(a.relNext).toBe("/list?page=3");
    expect(a.relPrev).toBe("/list?page=1");
  });
  it("captures hreflang pairs", () => {
    expect(a.hreflang).toEqual([
      { code: "en-gb", href: "https://ex.com/en/" },
      { code: "de", href: "https://ex.com/de/" },
    ]);
  });
  it("captures JSON-LD types with raw objects", () => {
    expect(a.structuredData).toHaveLength(1);
    expect(a.structuredData[0]?.type).toBe("Product");
    expect(a.structuredData[0]?.raw).toEqual({
      "@type": "Product",
      name: "W",
      offers: { price: "9" },
    });
    expect(a.structuredDataParseErrors).toBe(0);
  });
  it("computes dom size, text ratio, hashes", () => {
    expect(a.domSize).toBeGreaterThan(5);
    expect(a.textRatio).toBeGreaterThan(0);
    expect(a.textRatio).toBeLessThan(1);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof a.simhash).toBe("bigint");
  });
  it("tolerates malformed JSON-LD without throwing", () => {
    const bad = HTML.replace('{"@type"', '{"@type!!!');
    const b = analyzePage(bad, "https://ex.com/x");
    expect(b.structuredData).toEqual([]); // recorded as zero blocks, not a crash
    // No silent fallback: the failure is visible as a count, not a fake block.
    expect(b.structuredDataParseErrors).toBe(1);
  });
});

describe("rel is matched as a token list, not a whole value", () => {
  const a = analyzePage(
    `<html><head>
     <link rel="next prefetch" href="/p/3">
     <link rel="PREFETCH PREV" href="/p/1">
     <link rel="canonical shortlink" href="/c">
     <link rel="alternate stylesheet" hreflang="fr" href="/fr">
     <link rel="amphtml noopener" href="/amp/">
     </head><body></body></html>`,
    "https://ex.com/p/2",
  );
  it("reads next/prev out of multi-token rel, case-insensitively", () => {
    expect(a.relNext).toBe("/p/3");
    expect(a.relPrev).toBe("/p/1");
  });
  it("brings canonical, alternate/hreflang and amphtml along", () => {
    expect(a.canonicalHtml).toBe("/c");
    expect(a.canonicalCount).toBe(1);
    expect(a.hreflang).toEqual([{ code: "fr", href: "/fr" }]);
    expect(a.hasAmp).toBe(true);
  });
});

describe("rel next/prev edge cases", () => {
  it("is null when absent", () => {
    const a = analyzePage(`<html><head></head><body></body></html>`, "https://ex.com/");
    expect(a.relNext).toBeNull();
    expect(a.relPrev).toBeNull();
  });
  it("keeps the first of duplicates", () => {
    const a = analyzePage(
      `<head><link rel="next" href="/a"><link rel="next" href="/b"></head>`,
      "https://ex.com/",
    );
    expect(a.relNext).toBe("/a");
  });
  it("ignores rel=next on elements other than <link>", () => {
    const a = analyzePage(
      `<body><a href="/next-page" rel="next">next</a></body>`,
      "https://ex.com/",
    );
    expect(a.relNext).toBeNull();
  });
});

describe("hreflang capture", () => {
  it("skips alternates that carry no href — a pair needs both halves", () => {
    const a = analyzePage(
      `<head><link rel="alternate" hreflang="es"><link rel="alternate" hreflang="it" href="/it"></head>`,
      "https://ex.com/",
    );
    expect(a.hreflang).toEqual([{ code: "it", href: "/it" }]);
  });
  it("caps at 200 pairs", () => {
    const links = Array.from(
      { length: 250 },
      (_, i) => `<link rel="alternate" hreflang="x-${i}" href="/${i}">`,
    ).join("");
    const a = analyzePage(`<head>${links}</head>`, "https://ex.com/");
    expect(a.hreflang).toHaveLength(200);
    expect(a.hreflang[199]).toEqual({ code: "x-199", href: "/199" });
  });
});

describe("JSON-LD capture", () => {
  it("expands a top-level array into one block per node", () => {
    const a = analyzePage(
      `<script type="application/ld+json">[{"@type":"Organization"},{"@type":"WebSite"}]</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData.map((b) => b.type)).toEqual([
      "Organization",
      "WebSite",
    ]);
  });
  it("expands @graph into one block per typed node", () => {
    const a = analyzePage(
      `<script type="application/ld+json">
       {"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Article"}]}
       </script>`,
      "https://ex.com/",
    );
    expect(a.structuredData.map((b) => b.type)).toEqual([
      "BreadcrumbList",
      "Article",
    ]);
  });
  it("uses the first entry of a @type array", () => {
    const a = analyzePage(
      `<script type="application/ld+json">{"@type":["Product","Thing"]}</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData[0]?.type).toBe("Product");
  });
  it("labels an untyped node 'unknown' rather than dropping it", () => {
    const a = analyzePage(
      `<script type="application/ld+json">{"name":"no type here"}</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData).toHaveLength(1);
    expect(a.structuredData[0]?.type).toBe("unknown");
  });
  it("matches the script type case-insensitively and with whitespace", () => {
    const a = analyzePage(
      `<script type=" Application/LD+JSON ">{"@type":"FAQPage"}</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData[0]?.type).toBe("FAQPage");
  });
  it("counts every failed block, not just the first", () => {
    const a = analyzePage(
      `<script type="application/ld+json">{oops</script>
       <script type="application/ld+json">{"@type":"Article"}</script>
       <script type="application/ld+json">also bad</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData.map((b) => b.type)).toEqual(["Article"]);
    expect(a.structuredDataParseErrors).toBe(2);
  });
  it("counts an empty JSON-LD block as a parse error", () => {
    const a = analyzePage(
      `<script type="application/ld+json"></script>`,
      "https://ex.com/",
    );
    expect(a.structuredData).toEqual([]);
    expect(a.structuredDataParseErrors).toBe(1);
  });
  it("caps stored blocks at 50 while still counting parse failures", () => {
    const blocks = Array.from(
      { length: 60 },
      (_, i) =>
        `<script type="application/ld+json">{"@type":"T${i}"}</script>`,
    ).join("");
    const a = analyzePage(
      `${blocks}<script type="application/ld+json">{bad</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData).toHaveLength(50);
    expect(a.structuredData[0]?.type).toBe("T0");
    expect(a.structuredDataParseErrors).toBe(1);
  });
  it("refuses to buffer a block over 100KB and counts it as a failure", () => {
    const huge = `{"@type":"Product","name":"${"x".repeat(120_000)}"}`;
    const a = analyzePage(
      `<script type="application/ld+json">${huge}</script><script type="application/ld+json">{"@type":"Article"}</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData.map((b) => b.type)).toEqual(["Article"]);
    expect(a.structuredDataParseErrors).toBe(1);
  });
  it("does not treat JSON-LD text as visible content", () => {
    const a = analyzePage(
      `<body><script type="application/ld+json">{"@type":"Article","headline":"alpha beta gamma"}</script><p>one two</p></body>`,
      "https://ex.com/",
    );
    expect(a.wordCount).toBe(2);
  });
});

describe("dom size", () => {
  it("counts open-tag events, including void and unclosed elements", () => {
    // html, head, body, p, br, img = 6 open-tag events.
    const a = analyzePage(
      `<html><head></head><body><p>x<br><img src="/i.png"></body></html>`,
      "https://ex.com/",
    );
    expect(a.domSize).toBe(6);
  });
  it("is zero for an empty document", () => {
    expect(analyzePage("", "https://ex.com/").domSize).toBe(0);
  });
});

describe("text ratio", () => {
  it("is visible-text bytes over html bytes", () => {
    const html = `<html><body><p>one two three</p></body></html>`;
    const a = analyzePage(html, "https://ex.com/");
    expect(a.textRatio).toBeCloseTo(
      Buffer.byteLength("one two three") / Buffer.byteLength(html),
      10,
    );
  });
  it("is 0 for a markup-only page and for an empty document", () => {
    expect(
      analyzePage(`<html><body><div></div></body></html>`, "https://ex.com/")
        .textRatio,
    ).toBe(0);
    expect(analyzePage("", "https://ex.com/").textRatio).toBe(0);
  });
  it("counts bytes, not code points", () => {
    const html = `<body><p>é</p></body>`;
    const a = analyzePage(html, "https://ex.com/");
    expect(a.textRatio).toBeCloseTo(2 / Buffer.byteLength(html), 10);
  });
});

describe("content hash and simhash share the word-count accumulator", () => {
  it("hashes the normalised visible text", () => {
    const a = analyzePage(
      `<body><p>  Alpha   beta \n gamma </p></body>`,
      "https://ex.com/",
    );
    const b = analyzePage(`<body><p>Alpha beta gamma</p></body>`, "https://ex.com/");
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.simhash).toBe(b.simhash);
    expect(a.simhash).toBe(simhash64("Alpha beta gamma"));
  });
  it("differs when the visible text differs", () => {
    const a = analyzePage(`<body><p>alpha beta</p></body>`, "https://ex.com/");
    const b = analyzePage(`<body><p>alpha gamma</p></body>`, "https://ex.com/");
    expect(a.contentHash).not.toBe(b.contentHash);
  });
  it("ignores markup that carries no text", () => {
    const plain = analyzePage(`<body>alpha beta gamma</body>`, "https://ex.com/");
    const wrapped = analyzePage(
      `<body><div class="a"><section id="b"><p>alpha beta gamma</p></section></div></body>`,
      "https://ex.com/",
    );
    expect(wrapped.contentHash).toBe(plain.contentHash);
  });
  it("puts near-duplicate pages close in hamming distance", () => {
    const body = (extra: string) =>
      `<body><p>${"sitemaps robots and canonical tags ".repeat(20)}${extra}</p></body>`;
    const a = analyzePage(body("one last clause"), "https://ex.com/a");
    const b = analyzePage(body("one final clause"), "https://ex.com/b");
    expect(hammingDistance(a.simhash, b.simhash)).toBeLessThanOrEqual(3);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

// Controller ruling: the inherited accumulator joined text nodes with no
// separator, so minified markup (`</h1><p>`) merged the last word of one block
// into the first word of the next and undercounted. Element boundaries are
// whitespace now — for wordCount, textRatio, contentHash and simhash alike,
// which all read the one fixed accumulator. This is a deliberate divergence
// from the old DOM implementation (cheerio's .text() concatenates the same way
// upstream did); the parity oracle was adjusted to match.
describe("element boundaries separate words", () => {
  it("no longer merges words across block boundaries in minified markup", () => {
    const a = analyzePage(
      `<body><h1>Bare fragment</h1><p>three more words</p></body>`,
      "https://ex.com/",
    );
    expect(a.wordCount).toBe(5);
  });
  it("gives minified and pretty-printed markup the same hash", () => {
    const minified = analyzePage(
      `<body><h1>Bare fragment</h1><p>three more words</p></body>`,
      "https://ex.com/",
    );
    const pretty = analyzePage(
      `<body>\n  <h1>Bare fragment</h1>\n  <p>three more words</p>\n</body>`,
      "https://ex.com/",
    );
    expect(minified.contentHash).toBe(pretty.contentHash);
    expect(minified.simhash).toBe(pretty.simhash);
  });
  it("keeps inline elements inside a word, the way a browser renders them", () => {
    const a = analyzePage(
      `<body><p>un<em>believ</em>able <b>bold</b><span>ed</span></p></body>`,
      "https://ex.com/",
    );
    expect(a.wordCount).toBe(2); // "unbelievable bolded"
  });
  it("treats <br> as a separator", () => {
    const a = analyzePage(`<body><p>one<br>two</p></body>`, "https://ex.com/");
    expect(a.wordCount).toBe(2);
  });
  it("does not let a stripped script join two words", () => {
    const a = analyzePage(
      `<body><p>al<script>ignored()</script>pha</p></body>`,
      "https://ex.com/",
    );
    expect(a.wordCount).toBe(1); // "alpha", as a browser renders it
  });
});

describe("bonus signals", () => {
  it("detects the viewport meta", () => {
    const withVp = analyzePage(`<html><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><p>x</p></body></html>`, "https://ex.com/");
    const without = analyzePage(`<html><head><title>t</title></head><body><p>x</p></body></html>`, "https://ex.com/");
    expect(withVp.hasViewport).toBe(true);
    expect(without.hasViewport).toBe(false);
  });
  it("counts images missing width/height", () => {
    const a = analyzePage(`<html><body><img src="a.png" width="10" height="10"><img src="b.png" width="10"><img src="c.png"></body></html>`, "https://ex.com/");
    expect(a.imagesMissingDimensions).toBe(2); // b (no height) and c (neither)
  });
  it("flags lorem ipsum placeholder text", () => {
    const a = analyzePage(`<html><body><p>Lorem ipsum dolor sit amet, consectetur.</p></body></html>`, "https://ex.com/");
    const b = analyzePage(`<html><body><p>Real product copy about widgets.</p></body></html>`, "https://ex.com/");
    expect(a.hasLoremIpsum).toBe(true);
    expect(b.hasLoremIpsum).toBe(false);
  });
  it("does not flag lorem inside script/style", () => {
    const a = analyzePage(`<html><body><script>var x="lorem ipsum dolor";</script><p>clean</p></body></html>`, "https://ex.com/");
    expect(a.hasLoremIpsum).toBe(false);
  });
  // The `name` match is folded like every other meta name (see the analyzer's
  // provenance header), and an element boundary between the words must not
  // hide the phrase the way it would if the accumulator had no separator.
  it("folds the viewport name and spans element boundaries for lorem", () => {
    const a = analyzePage(`<html><head><meta name=" Viewport " content="width=device-width"></head><body><p>lorem</p><p>ipsum dolor</p></body></html>`, "https://ex.com/");
    expect(a.hasViewport).toBe(true);
    expect(a.hasLoremIpsum).toBe(true);
  });
  it("counts an image with no dimensions once, not twice", () => {
    const a = analyzePage(`<html><body><img src="a.png"><img src="b.png" height="4"></body></html>`, "https://ex.com/");
    expect(a.imagesTotal).toBe(2);
    expect(a.imagesMissingDimensions).toBe(2);
  });
});

/**
 * The soft-404 phrase flag: `hasLoremIpsum`'s twin, read off the same
 * visible-text accumulator. The query rule that consumes it (CHECK-16) pairs a
 * phrase with a thin body and the site's own 404 template, so a false positive
 * here becomes a false finding there — which is why the list is phrases and
 * never a bare "404".
 */
describe("soft-404 phrases", () => {
  it("fires on visible text", () => {
    const a = analyzePage(
      `<html><body><p>Sorry — this page cannot be found.</p></body></html>`,
      "https://ex.com/x",
    );
    expect(a.hasSoft404Phrases).toBe(true);
  });

  it("does not fire from script text", () => {
    const a = analyzePage(
      `<html><body><script>var msg = "Page not found";</script><p>A real article about widgets.</p></body></html>`,
      "https://ex.com/x",
    );
    expect(a.hasSoft404Phrases).toBe(false);
  });

  it("does not fire on a bare 404 in prose", () => {
    for (const text of ["He was born in 404 BC.", "Meet us in room 404 upstairs."]) {
      const a = analyzePage(`<html><body><p>${text}</p></body></html>`, "https://ex.com/x");
      expect(a.hasSoft404Phrases, text).toBe(false);
    }
  });

  it("matches every phrase in the list, case-insensitively", () => {
    for (const phrase of SOFT_404_PHRASES) {
      const a = analyzePage(
        `<html><body><p>${phrase.toUpperCase()}</p></body></html>`,
        "https://ex.com/x",
      );
      expect(a.hasSoft404Phrases, phrase).toBe(true);
    }
  });

  it("reads a typographic apostrophe as an apostrophe", () => {
    const a = analyzePage(
      `<html><body><p>Sorry, this page doesn’t exist.</p></body></html>`,
      "https://ex.com/x",
    );
    expect(a.hasSoft404Phrases).toBe(true);
  });

  it("spans element boundaries, like every other text derivation", () => {
    const a = analyzePage(
      `<html><body><h1>Page</h1><p>not found</p></body></html>`,
      "https://ex.com/x",
    );
    expect(a.hasSoft404Phrases).toBe(true);
  });

  it("stays false on ordinary copy", () => {
    const a = analyzePage(
      `<html><body><p>Our widgets are found in every good hardware shop.</p></body></html>`,
      "https://ex.com/x",
    );
    expect(a.hasSoft404Phrases).toBe(false);
  });
});

/**
 * The Phase 7 measurement correction (P7-T1), whose evidence is
 * `audits/lavishalice.com/render-diagnosis.md`.
 *
 * Two claims, tested apart because they are separate defects that happened to
 * be found together: `<template>` text was never content and `word_count`
 * itself now excludes it, and `renderableWordCount` is a second count over the
 * same stream that also drops what the markup says is not displayed.
 *
 * Every expected number here is derived in the assertion beside it, and the two
 * counts are stated together wherever both are in play — a case that moved one
 * and not the other is exactly the drift this file exists to catch.
 */
const body = (inner: string) =>
  analyzePage(`<html><body>${inner}</body></html>`, "https://ex.com/x");

describe("template content is counted by nothing", () => {
  it("excludes template text from wordCount and renderableWordCount alike", () => {
    // "one two three" = 3. The template's four words are in no document.
    const a = body(`<p>one two three</p><template><p>four five six seven</p></template>`);
    expect(a.wordCount).toBe(3);
    expect(a.renderableWordCount).toBe(3);
  });

  it("excludes a template that carries the whole page", () => {
    const a = body(`<template><h2>a b</h2><p>c d e</p></template>`);
    expect(a.wordCount).toBe(0);
    expect(a.renderableWordCount).toBe(0);
  });

  it("excludes nested templates, and the nesting cannot re-open the stream", () => {
    // The inner </template> must not take the outer one's suppression down
    // with it — the depth counter is what makes that true, as for <script>.
    const a = body(
      `<template><p>a b</p><template><p>c d</p></template><p>e f</p></template><p>g h</p>`,
    );
    expect(a.wordCount).toBe(2);
    expect(a.renderableWordCount).toBe(2);
  });

  it("keeps the text derivations off template text, like script text", () => {
    const a = body(`<template><p>lorem ipsum dolor</p></template><p>real copy here</p>`);
    expect(a.hasLoremIpsum).toBe(false);
    expect(a.wordCount).toBe(3);
  });

  it("leaves every ELEMENT inside a template exactly where it was", () => {
    // The exclusion is of text and of nothing else. A template's elements are
    // still elements to this file, because they are still elements to the DOM
    // oracle's selectors — see TEMPLATE_TAG in page-analyzer.ts and the four
    // parity cases in page-analyzer.upstream.test.ts.
    const a = body(
      `<template><h1>Phantom heading</h1><a href="/x">anchor text</a><img src="/a.png">` +
        `</template><h1>Real heading</h1><p>visible copy</p>`,
    );
    expect(a.headingCounts[0], "both h1s counted").toBe(2);
    expect(a.imagesTotal, "the template's image counted").toBe(1);
    expect(a.links.map((l) => l.anchor), "the template's anchor and its TEXT").toEqual([
      "anchor text",
    ]);
    // AND THE OPEN QUESTION, pinned rather than answered: first-h1-wins, so a
    // phantom heading a script will clone later is the heading `h1Text`
    // reports. Whether a template's elements should count as the page's
    // elements at all is a ruling this task deliberately does not make — but
    // the shadowing is visible here instead of being discovered downstream.
    expect(a.h1Text).toBe("Phantom heading");
    // The words, meanwhile, are the visible ones alone: 2 (real heading) + 2.
    expect(a.wordCount).toBe(4);
  });
});

describe("renderableWordCount drops what the markup says is hidden", () => {
  it("drops a subtree carrying the hidden attribute", () => {
    // raw: 3 visible + 3 in the drawer = 6; renderable: the 3 visible.
    const a = body(`<p>visible words here</p><div hidden><p>secret hidden words</p></div>`);
    expect(a.wordCount).toBe(6);
    expect(a.renderableWordCount).toBe(3);
  });

  it("reads every spelling of the hidden attribute as hidden", () => {
    for (const attr of ["hidden", 'hidden=""', 'hidden="hidden"', 'hidden="until-found"']) {
      const a = body(`<p>one two</p><div ${attr}><p>three four five</p></div>`);
      expect(a.wordCount, attr).toBe(5);
      expect(a.renderableWordCount, attr).toBe(2);
    }
  });

  it("drops an inline display:none, however it is spelled", () => {
    for (const style of [
      "display:none",
      "display: none",
      "DISPLAY : NONE",
      "color:red;display:none;",
      "display:none !important",
    ]) {
      const a = body(`<p>one two</p><div style="${style}"><p>three four five</p></div>`);
      expect(a.wordCount, style).toBe(5);
      expect(a.renderableWordCount, style).toBe(2);
    }
  });

  it("leaves an inline style that hides nothing alone", () => {
    for (const style of ["display:block", "color:none", "display:inline-block"]) {
      const a = body(`<p>one two</p><div style="${style}"><p>three four five</p></div>`);
      expect(a.renderableWordCount, style).toBe(5);
    }
  });

  it("counts a display:none later overridden in the same attribute as hidden", () => {
    // The documented false positive: matching the attribute string IS the
    // rule, and anything finer is a CSS parser (module header).
    const a = body(`<p>one two</p><div style="display:none;display:block"><p>x y z</p></div>`);
    expect(a.wordCount).toBe(5);
    expect(a.renderableWordCount).toBe(2);
  });

  it("drops a dialog that is not open, and keeps one that is", () => {
    const closed = body(`<dialog><p>modal copy</p></dialog><p>page copy</p>`);
    expect(closed.wordCount).toBe(4);
    expect(closed.renderableWordCount).toBe(2);

    const open = body(`<dialog open><p>modal copy</p></dialog><p>page copy</p>`);
    expect(open.renderableWordCount).toBe(4);
  });

  it("keeps a closed details' summary and drops the rest of it", () => {
    // "Size guide" is what a browser renders on a closed accordion; the three
    // words behind it are what it does not.
    const closed = body(
      `<details><summary>Size guide</summary><p>hidden details body</p></details>`,
    );
    expect(closed.wordCount).toBe(5);
    expect(closed.renderableWordCount).toBe(2);

    const open = body(
      `<details open><summary>Size guide</summary><p>hidden details body</p></details>`,
    );
    expect(open.renderableWordCount).toBe(5);
  });

  it("hides even the summary when the details itself is hidden", () => {
    const a = body(`<details hidden><summary>Size guide</summary><p>a b</p></details><p>c d</p>`);
    expect(a.wordCount).toBe(6);
    expect(a.renderableWordCount).toBe(2);
  });

  it("does not split a word around an inline hidden element", () => {
    // The two streams share every element boundary, so dropping text can merge
    // two words and can never split one. `<span>` is inline: no boundary.
    const a = body(`<p>un<span hidden>x</span>believable</p>`);
    expect(a.wordCount).toBe(1);
    expect(a.renderableWordCount).toBe(1);
  });

  it("composes with the template exclusion", () => {
    const a = body(
      `<p>one two three</p><template><p>t t t t</p></template><div hidden><p>h h</p></div>`,
    );
    expect(a.wordCount).toBe(5);
    expect(a.renderableWordCount).toBe(3);
  });
});

describe("the hidden-surface counters survive real markup", () => {
  it("does not un-hide when an inner element of the same name closes", () => {
    const a = body(`<div hidden><div>a b</div></div><p>c d</p>`);
    expect(a.wordCount).toBe(4);
    expect(a.renderableWordCount).toBe(2);
  });

  it("stays hidden to the end of the document when the hidden element never closes", () => {
    const a = body(`<p>x</p><div hidden><p>y z`);
    expect(a.wordCount).toBe(3);
    expect(a.renderableWordCount).toBe(1);
  });

  it("is not confused by a stray close tag", () => {
    const a = body(`<div hidden>a</div></div><p>b c</p>`);
    expect(a.wordCount).toBe(3);
    expect(a.renderableWordCount).toBe(2);
  });

  it("handles a hidden element inside a hidden element", () => {
    const a = body(`<div hidden><span hidden>a</span> b</div><p>c</p>`);
    expect(a.wordCount).toBe(3);
    expect(a.renderableWordCount).toBe(1);
  });

  it("handles implicitly closed paragraphs", () => {
    // htmlparser2 closes the first <p> when the second opens, which is what a
    // browser does; the counter has to see that close, or the hidden paragraph
    // would swallow the rest of the page.
    const a = body(`<p hidden>a b<p>c d`);
    expect(a.wordCount).toBe(4);
    expect(a.renderableWordCount).toBe(2);
  });

  it("never counts more renderable words than raw words", () => {
    const pages = [
      `<p>plain copy with nothing hidden at all</p>`,
      `<div hidden>a</div><p>b</p>`,
      `<template>a b c</template><p>d</p>`,
      `<details><summary>s</summary>a b</details>`,
      `<dialog>a</dialog><p>b</p>`,
      `<div style="display:none"><p>a</p><div hidden>b</div></div><p>c</p>`,
      `<p>un<span hidden>x</span>believable</p>`,
      `<div hidden><p>a</p>`,
    ];
    for (const html of pages) {
      const a = body(html);
      expect(a.renderableWordCount, html).toBeLessThanOrEqual(a.wordCount);
    }
  });
});

describe("h1Text captures the first heading's words", () => {
  it("takes the first h1, whitespace collapsed", () => {
    const a = body(`<h1>  The   first\nheading </h1><h1>the second</h1>`);
    expect(a.h1Text).toBe("The first heading");
  });

  it("is null when there is no h1, and empty when the h1 is", () => {
    expect(body(`<p>no heading</p>`).h1Text).toBeNull();
    expect(body(`<h1></h1><p>x</p>`).h1Text).toBe("");
  });

  it("reads through inline markup, as the heading text does", () => {
    const a = body(`<h1>Buy <em>this</em> today</h1>`);
    expect(a.h1Text).toBe("Buy this today");
  });

  it("caps at 300 characters", () => {
    expect(body(`<h1>${"w".repeat(400)}</h1>`).h1Text).toHaveLength(300);
  });
});

describe("the Phase 7 fixture page measures what its own arithmetic says", () => {
  it("reproduces the fixture's derived counts", () => {
    const a = analyzePage(
      `<html><head><title>t</title></head><body><main>${P7_HIDDEN_CHROME_BODY}</main></body></html>`,
      "https://ex.com/authored7/hidden-chrome",
    );
    expect(a.wordCount).toBe(P7_WORD_COUNT);
    expect(a.renderableWordCount).toBe(P7_RENDERABLE_WORD_COUNT);
    // The gap is the three hidden blocks named in the fixture (34 + 20 + 28),
    // and it is a third of the page.
    expect(a.wordCount - a.renderableWordCount).toBe(82);
  });
});

/**
 * The Phase 19 main-content pair. The DOM parity oracle already holds the two
 * numbers to a tree (page-analyzer.upstream.test.ts); these cases pin what the
 * numbers MEAN — which subtree is measured, when the pair is null, and the one
 * property the whole change exists for: two pages that differ only in their
 * chrome are far apart in the main fingerprint and next to each other in the
 * whole-page one.
 */
describe("mainWordCount / mainSimhash: the main-content fingerprint", () => {
  const CHROME =
    `<header><p>the shop brand</p></header>` +
    `<nav><a href="/a">shop all</a> <a href="/b">new in</a></nav>` +
    `<aside><p>you may also like these</p></aside>` +
    `<footer><p>terms and delivery and returns</p></footer>`;
  const page = (body: string) => analyzePage(`<html><body>${body}</body></html>`, "https://ex.com/p");

  it("measures the text inside <main> when the page declares one", () => {
    const a = page(`${CHROME}<main><p>one two three four five</p></main>`);
    // 3 + 4 + 5 + 5 of chrome, and five words of the page's own.
    expect(a.wordCount).toBe(22);
    expect(a.mainWordCount).toBe(5);
    expect(a.mainSimhash).toBe(simhash64("one two three four five"));
    // And it is NOT the whole-page fingerprint, which is the entire point.
    expect(a.mainSimhash).not.toBe(a.simhash);
  });

  it("falls back to the body minus nav, header, footer and aside", () => {
    const a = page(`${CHROME}<div class="content"><p>one two three four five</p></div>`);
    expect(a.wordCount).toBe(22);
    expect(a.mainWordCount).toBe(5);
    // The same five words as the `<main>` page above, so the same fingerprint:
    // the two routes to the main content are one measurement.
    expect(a.mainSimhash).toBe(simhash64("one two three four five"));
  });

  it("tells two chrome-heavy pages apart where the whole-page hash cannot", () => {
    // THE DEFECT THIS COLUMN CLOSES, reproduced at the size that produced it
    // (spec §2): a site whose pages carry ~900 words of identical header,
    // navigation and footer around ~150 words of their own. Here that is 970
    // words per page, 150 of them the product's.
    const CHROME_HEAVY =
      `<header><p>${"the shop brand tagline ".repeat(25)}</p></header>` +
      `<nav><p>${"shop all new in dresses knitwear sale gifts ".repeat(40)}</p></nav>` +
      `<aside><p>${"you may also like these ".repeat(30)}</p></aside>` +
      `<footer><p>${"terms delivery returns privacy contact ".repeat(50)}</p></footer>`;
    const product = (topic: string) =>
      `<p>${`a paragraph about our ${topic} and how it is made `.repeat(15)}</p>`;
    const a = page(`${CHROME_HEAVY}<main>${product("dresses")}</main>`);
    const b = page(`${CHROME_HEAVY}<main>${product("candles")}</main>`);
    expect(a.wordCount).toBe(970);
    expect(a.mainWordCount).toBe(150);
    // Two unrelated products. Read whole, they are 3 bits apart — INSIDE
    // `content.near-duplicate`'s threshold of 3, which is how 500 findings
    // across unrelated templates happened.
    expect(hammingDistance(a.simhash, b.simhash)).toBeLessThanOrEqual(3);
    // Read over their main content, they are not the same page at all.
    expect(hammingDistance(a.mainSimhash!, b.mainSimhash!)).toBeGreaterThan(3);
  });

  it("still calls two pages with the same main content duplicates", () => {
    // The other direction, and the reason the column is not just a filter: one
    // product page under two URLs, with the chrome differing (a menu that
    // highlights the current section). Same main content, same fingerprint.
    const a = page(`<nav><p>shop all NEW IN sale</p></nav><main><p>one two three four five</p></main>`);
    const b = page(`<nav><p>shop all new in SALE</p></nav><main><p>one two three four five</p></main>`);
    expect(hammingDistance(a.mainSimhash!, b.mainSimhash!)).toBe(0);
  });

  it("is null on a page that is nothing but chrome — not zero", () => {
    const a = page(CHROME);
    expect(a.wordCount).toBe(17);
    // "Nothing to fingerprint", which a rule must be able to tell from a page
    // it measured. Zero would be a measurement.
    expect(a.mainWordCount).toBeNull();
    expect(a.mainSimhash).toBeNull();
  });

  it("is null on an empty <main>, whatever else the body carries", () => {
    const a = page(`${CHROME}<main>  </main>`);
    expect(a.mainWordCount).toBeNull();
    expect(a.mainSimhash).toBeNull();
  });

  it("counts a nested <main> as part of the first one", () => {
    // Invalid HTML that real pages ship. The depth idiom keeps the inner close
    // from ending the outer element.
    const a = page(`<main><p>outer copy</p><main><p>inner copy</p></main><p>after</p></main>`);
    expect(a.mainWordCount).toBe(5);
  });

  it("measures the FIRST <main> and not the second", () => {
    const a = page(`<main><p>the first main</p></main><main><p>the second main here</p></main>`);
    expect(a.mainWordCount).toBe(3);
    expect(a.mainSimhash).toBe(simhash64("the first main"));
  });

  it("keeps chrome that sits INSIDE the main content", () => {
    // A document that says where its content is has said so about the in-page
    // nav in it too: the exclusion is the FALLBACK's rule, not a filter.
    const a = page(`<header><p>site chrome</p></header><main><nav><a href="/x">jump to</a></nav><p>article copy</p></main>`);
    expect(a.mainWordCount).toBe(4);
  });

  it("excludes template text from the main content, as it does from wordCount", () => {
    const a = page(`<main><p>real copy</p><template><p>a card the js clones</p></template></main>`);
    expect(a.mainWordCount).toBe(2);
  });

  it("does not let a <main> inside a <template> claim the page", () => {
    // The template's `<main>` is in no rendered document, so the fallback runs
    // and measures the body minus its chrome.
    const a = page(`<template><main><p>a cloned layout</p></main></template><nav><p>chrome words here</p></nav><p>the page's own copy</p>`);
    expect(a.mainWordCount).toBe(4);
    expect(a.mainSimhash).toBe(simhash64("the page's own copy"));
  });

  // The other three subtrees a `<main>` can hide in, and the same rule: the
  // element is in no rendered document, so it neither claims the page nor
  // contributes a word. `<template>` above is the fourth. Pinned one by one
  // because each is suppressed by a DIFFERENT mechanism in the parser — script
  // and svg by `NON_CONTENT_TAGS`, noscript by the raw-text early return that
  // sits above the whole open-tag switch — and a change to any of them could
  // let a `<main>` through while the other two stayed correct.
  it.each([
    ["<script>", `<script><main><p>a cloned layout</p></main></script>`],
    ["<svg>", `<svg><main><p>a drawn layout</p></main></svg>`],
    ["<noscript>", `<noscript><main><p>a fallback layout</p></main></noscript>`],
  ])("does not let a <main> inside a %s claim the page", (_label, hidden) => {
    const a = page(`${hidden}<nav><p>chrome words here</p></nav><p>the page's own copy</p>`);
    // The fallback ran: body minus the chrome, and the hidden subtree's words
    // are in neither measurement.
    expect(a.mainWordCount).toBe(4);
    expect(a.mainSimhash).toBe(simhash64("the page's own copy"));
    expect(a.wordCount).toBe(7);
  });

  it("counts markup-hidden text in the main content", () => {
    // Deliberately NOT `renderableWordCount`'s rule: this fingerprint is over
    // the main content AS SERVED, and a hamming distance between two templates
    // must not depend on which of them hides a dialog.
    const a = page(`<main><p>visible copy</p><div hidden><p>hidden copy</p></div></main>`);
    expect(a.mainWordCount).toBe(4);
    expect(a.renderableWordCount).toBe(2);
  });

  it("does not merge the words on either side of a chrome block", () => {
    // No element between the text and the `<nav>`: the fallback stream still
    // has to put a separator where the chrome was.
    const a = page(`before<nav><p>menu</p></nav>after`);
    expect(a.mainWordCount).toBe(2);
  });

  it("excludes all four chrome elements and nothing else", () => {
    const a = page(
      `<header>h</header><nav>n</nav><aside>a</aside><footer>f</footer>` +
        `<section>section</section><article>article</article><div>div</div>`,
    );
    expect(a.wordCount).toBe(7);
    expect(a.mainWordCount).toBe(3);
  });
});

describe("placeholderSnippet: the evidence for hasLoremIpsum", () => {
  const page = (body: string) => analyzePage(`<html><body>${body}</body></html>`, "https://ex.com/p");

  it("is null when the page carries no placeholder copy", () => {
    const a = page(`<p>a page with real copy on it</p>`);
    expect(a.hasLoremIpsum).toBe(false);
    expect(a.placeholderSnippet).toBeNull();
  });

  it("quotes the whole text when the page is shorter than the window", () => {
    const a = page(`<p>Lorem ipsum dolor sit amet.</p>`);
    expect(a.hasLoremIpsum).toBe(true);
    expect(a.placeholderSnippet).toBe("Lorem ipsum dolor sit amet.");
  });

  it("matches across a line break, because the text it reads is collapsed", () => {
    const a = page(`<p>Lorem\n   ipsum dolor sit amet.</p>`);
    expect(a.hasLoremIpsum).toBe(true);
    expect(a.placeholderSnippet).toBe("Lorem ipsum dolor sit amet.");
  });

  it("matches across an element boundary and quotes the collapsed form", () => {
    const a = page(`<p>Lorem</p><p>ipsum dolor sit amet.</p>`);
    expect(a.hasLoremIpsum).toBe(true);
    expect(a.placeholderSnippet).toBe("Lorem ipsum dolor sit amet.");
  });

  it("is case-insensitive, like the flag it is evidence for", () => {
    const a = page(`<p>LOREM IPSUM DOLOR.</p>`);
    expect(a.placeholderSnippet).toBe("LOREM IPSUM DOLOR.");
  });

  it("quotes the excerpt a reader will find on the listing page", () => {
    // The shape from the crawl that provoked the column (spec §3): a 1,000-word
    // post whose only placeholder copy is the card excerpt, and evidence that
    // said `{wordCount}`.
    const a = page(
      `<header><p>${"the shop brand ".repeat(20)}</p></header>` +
        `<main><h1>A post about something</h1>` +
        `<p class="excerpt">Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>` +
        `<p>${"the real body copy of this post ".repeat(40)}</p></main>`,
    );
    const snippet = a.placeholderSnippet!;
    expect(snippet).toContain("Lorem ipsum dolor sit amet, consectetur adipiscing elit.");
    expect(snippet.length).toBeLessThanOrEqual(160);
    // Whole words at both ends: a quotation that starts mid-word reads as a
    // corruption of the page rather than a quotation from it.
    expect(snippet).toBe(snippet.trim());
    expect(a.wordCount).toBeGreaterThan(300);
  });

  it("centres the window on the match and keeps whole words at both ends", () => {
    const before = "alpha ".repeat(60);
    const after = "omega ".repeat(60);
    const a = page(`<p>${before}Lorem ipsum dolor. ${after}</p>`);
    const snippet = a.placeholderSnippet!;
    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet).toContain("Lorem ipsum dolor.");
    // Centred: there is text from both sides of the match in the quotation.
    expect(snippet.startsWith("alpha")).toBe(true);
    expect(snippet.endsWith("omega")).toBe(true);
    // Whole words: every token in the snippet is one of the page's own.
    for (const word of snippet.split(" ")) {
      expect(["alpha", "omega", "Lorem", "ipsum", "dolor."]).toContain(word);
    }
  });

  it("quotes the first match when a page carries several", () => {
    const a = page(
      `<p>${"filler ".repeat(40)}</p><p>Lorem ipsum one.</p>` +
        `<p>${"filler ".repeat(40)}</p><p>Lorem ipsum two.</p>`,
    );
    expect(a.placeholderSnippet).toContain("Lorem ipsum one.");
    expect(a.placeholderSnippet).not.toContain("Lorem ipsum two.");
  });

  it("is null exactly when hasLoremIpsum is false, over every case above", () => {
    for (const html of [
      `<p>real copy</p>`,
      `<p>Lorem ipsum.</p>`,
      `<script>var x = "lorem ipsum";</script><p>real copy</p>`,
      `<template><p>lorem ipsum in a template</p></template><p>real copy</p>`,
      `<p>${"w ".repeat(500)}lorem ipsum${" w".repeat(500)}</p>`,
    ]) {
      const a = page(html);
      expect(a.placeholderSnippet === null, html).toBe(!a.hasLoremIpsum);
    }
  });
});
