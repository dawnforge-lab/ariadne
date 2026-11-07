import { describe, expect, it } from "vitest";
import {
  analyzePage,
  MAX_LD_JSON_NESTING,
  MAX_SOCIAL_IMAGE_REFS,
  shareImageRef,
  SOFT_404_PHRASES,
} from "../../src/crawl/parse/page-analyzer.js";
import { simhash64, hammingDistance } from "../../src/crawl/parse/simhash.js";
import {
  ALT_TEXT_LONG_CHARS,
  H2_TEXT_MAX,
  HTML_LANG_MAX,
  IMAGE_SAMPLE_MAX,
  IMAGE_SAMPLE_SRC_MAX,
  INSECURE_SAMPLE_MAX,
  INSECURE_SAMPLE_URL_MAX,
  ROBOTS_META_CONTENT_MAX,
  ROBOTS_METAS_MAX,
  SOCIAL_TEXT_MAX,
  SOCIAL_URL_MAX,
} from "../../src/crawl/parse/page-facts.js";
import {
  P7_HIDDEN_CHROME_BODY,
  P7_RENDERABLE_WORD_COUNT,
  P7_WORD_COUNT,
} from "../fixtures/pages/authored-p7.js";
import { SHARED_IMAGE_PATH } from "../fixtures/assets.js";
import { renderDocument } from "../fixtures/render.js";

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
  it("refuses a block nested deeper than MAX_LD_JSON_NESTING as a parse error (R11)", () => {
    const nested = (depth: number) =>
      `{"@type":"X","a":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}}`;
    // The object is level 1, so `depth - 1` arrays put the deepest at `depth`.
    const atCap = analyzePage(
      `<script type="application/ld+json">${nested(MAX_LD_JSON_NESTING)}</script>`,
      "https://ex.com/",
    );
    expect(atCap.structuredData.map((b) => b.type)).toEqual(["X"]);
    expect(atCap.structuredDataParseErrors).toBe(0);
    for (const depth of [MAX_LD_JSON_NESTING + 1, 5_000]) {
      const a = analyzePage(
        `<script type="application/ld+json">${nested(depth)}</script>` +
          `<script type="application/ld+json">{"@type":"Article"}</script>`,
        "https://ex.com/",
      );
      expect(a.structuredData.map((b) => b.type), String(depth)).toEqual(["Article"]);
      expect(a.structuredDataParseErrors, String(depth)).toBe(1);
    }
  });
  it("counts nesting outside string literals only, escapes included", () => {
    const deepInString = `{"@type":"X","s":"${"[".repeat(200)}\\"${"{".repeat(200)}"}`;
    const a = analyzePage(
      `<script type="application/ld+json">${deepInString}</script>`,
      "https://ex.com/",
    );
    expect(a.structuredData.map((b) => b.type)).toEqual(["X"]);
    expect(a.structuredDataParseErrors).toBe(0);
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

  it("excludes chrome that sits INSIDE the main content", () => {
    // INVERTED by the §11 amendment. This case used to expect 4 — the in-page
    // `<nav>`'s two words plus the article's two — on the reasoning that a
    // document which says where its content is has said so about the nav in it.
    // The re-crawl said otherwise (see below), so chrome is furniture wherever
    // it sits and only "article copy" is measured.
    const a = page(`<header><p>site chrome</p></header><main><nav><a href="/x">jump to</a></nav><p>article copy</p></main>`);
    expect(a.mainWordCount).toBe(2);
    expect(a.mainSimhash).toBe(simhash64("article copy"));
  });

  it("does not let a footer inside <main> fingerprint 79 empty pages alike", () => {
    // THE §11 DEFECT, reproduced at the size that produced it: a Shopify theme
    // whose `<main>` carries the newsletter block and the footer navigation
    // inside a `<footer>` landmark, so 79 empty `/pages/*` URLs each measured
    // 105 main words — their `<h1>` plus the theme's footer — and the crawl
    // returned 500 capped near-duplicate pairs at hamming 0 to 2.
    // 91 words of newsletter block and 14 of footer navigation: 105, the count
    // every one of those pages reported.
    const THEME_FOOTER =
      `<footer><p>${"join our newsletter for offers and news ".repeat(13)}</p>` +
      `<nav><p>${"about contact delivery returns privacy terms shipping ".repeat(2)}</p></nav></footer>`;
    const empty = (heading: string) => page(`<main><h1>${heading}</h1>${THEME_FOOTER}</main>`);
    const a = empty("Size guide");
    const b = empty("Store finder");
    // 105 words on the page, 2 of them its own — which is what the fingerprint
    // now measures, and it is below `content.near-duplicate`'s 50-word floor,
    // so these pages never reach that rule at all. `content.thin` owns them.
    expect(a.wordCount).toBe(107);
    expect(a.mainWordCount).toBe(2);
    expect(b.mainWordCount).toBe(2);
    // Read whole they are one bit apart; read over the main content they are
    // two different two-word headings. No claim about their hamming distance is
    // made — at two words there is nothing to be a near-duplicate of.
    expect(hammingDistance(a.simhash, b.simhash)).toBeLessThanOrEqual(3);
  });

  it("is null when the <main> holds nothing but chrome — not zero", () => {
    // The empty template page itself: a `/pages/*` whose `<main>` is only the
    // theme's footer block, with no copy of its own at all. "Nothing to
    // fingerprint" — the same answer as a body that is all chrome, and the
    // reason `content.near-duplicate` never sees these rows.
    const a = page(
      `<main><footer><p>${"join our newsletter for offers and news ".repeat(15)}</p></footer></main>`,
    );
    expect(a.wordCount).toBe(105);
    expect(a.mainWordCount).toBeNull();
    expect(a.mainSimhash).toBeNull();
  });

  it("ignores chrome ENCLOSING the <main>, and excludes chrome below it", () => {
    // Malformed markup that real templates ship. The measurement starts at the
    // `<main>`, so the `<footer>` around it is not on the way down and does not
    // silence the page; the `<nav>` inside it is, and is excluded.
    const a = page(`<footer><main><p>the page copy</p><nav><p>an in main menu</p></nav></main></footer>`);
    expect(a.mainWordCount).toBe(3);
    expect(a.mainSimhash).toBe(simhash64("the page copy"));
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

  it("quotes the whole remainder when the page is shorter than the window", () => {
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
    // The quotation OPENS on the placeholder: the 300 words of header chrome
    // that precede it on the page are not what the reader was sent to find.
    expect(snippet.startsWith("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")).toBe(true);
    expect(snippet).not.toContain("the shop brand");
    expect(snippet.length).toBeLessThanOrEqual(160);
    // A whole word at the cut end: a quotation that ends mid-word reads as a
    // corruption of the page rather than a quotation from it.
    expect(snippet).toBe(snippet.trim());
    expect(a.wordCount).toBeGreaterThan(300);
  });

  it("starts the window at the match and keeps a whole word at the cut end", () => {
    const before = "alpha ".repeat(60);
    const after = "omega ".repeat(60);
    const a = page(`<p>${before}Lorem ipsum dolor. ${after}</p>`);
    const snippet = a.placeholderSnippet!;
    expect(snippet.length).toBeLessThanOrEqual(160);
    // Zero characters before the match, and the run of text after it.
    expect(snippet.startsWith("Lorem ipsum dolor.")).toBe(true);
    expect(snippet).not.toContain("alpha");
    expect(snippet.endsWith("omega")).toBe(true);
    // Whole words: every token in the snippet is one of the page's own.
    for (const word of snippet.split(" ")) {
      expect(["omega", "Lorem", "ipsum", "dolor."]).toContain(word);
    }
  });

  it("quotes from the match even when the whole text would fit in the window", () => {
    // 120 characters of header chrome precede the placeholder, so a centred
    // window — or a short-text shortcut that returned `bodyText` whole — would
    // spend the quotation on the chrome. The window opens at the match.
    const chrome =
      "£ NZD $ USD $ Help Center Lavish Alice Cart Close Your bag is empty Blog and some more of the header chrome furniture too";
    expect(chrome.length).toBe(121);
    const a = page(`<header><p>${chrome}</p></header><main><p>Lorem ipsum dolor sit amet.</p></main>`);
    expect(a.placeholderSnippet).toBe("Lorem ipsum dolor sit amet.");
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

/**
 * Phase 26b (extraction version 2): the head facts and the social set. Each
 * `describe` is one fact; the shapes and caps are src/crawl/parse/page-facts.ts.
 */
const P26B_URL = "https://ex.com/blog/post";
function headPage(head: string, bodyHtml = "<p>body text</p>", htmlTag = "<html>") {
  return analyzePage(
    `<!doctype html>${htmlTag}<head>${head}</head><body>${bodyHtml}</body></html>`,
    P26B_URL,
  );
}

describe("htmlLang: the first <html> start tag's lang", () => {
  it("is trimmed", () => {
    expect(headPage("<title>t</title>", "<p>x</p>", `<html lang=" en-GB ">`).htmlLang).toBe("en-GB");
  });

  it("is null when the attribute is absent or blank", () => {
    expect(headPage("<title>t</title>").htmlLang).toBeNull();
    expect(headPage("<title>t</title>", "<p>x</p>", `<html lang="  ">`).htmlLang).toBeNull();
  });

  it("reads the first <html> tag only", () => {
    const a = analyzePage(`<html lang="de"><html lang="fr"><body>x</body></html>`, P26B_URL);
    expect(a.htmlLang).toBe("de");
  });

  it("is capped at HTML_LANG_MAX", () => {
    const a = headPage("", "<p>x</p>", `<html lang="${"x".repeat(HTML_LANG_MAX + 40)}">`);
    expect(a.htmlLang).toHaveLength(HTML_LANG_MAX);
  });
});

describe("social: the Open Graph and X set", () => {
  it("records first values, per-tag counts and a conflicting tag", () => {
    const a = headPage(
      `<meta property="og:title" content=" First ">` +
        `<meta property="og:title" content="Second">` +
        `<meta property="og:title" content="First">` +
        `<meta property="og:type" content="website">` +
        `<meta name="twitter:card" content="summary">`,
    );
    expect(a.social).toEqual({
      og: { title: "First", type: "website" },
      x: { card: "summary" },
      counts: { "og:title": 3, "og:type": 1, "twitter:card": 1 },
      conflicting: ["og:title"],
      outsideHead: false,
      xViaProperty: false,
      imageRefs: { og: null, x: null },
    });
  });

  it("fills the legacy og columns from the element the social set reads (PR #23 P9)", () => {
    // `name=` as well as `property=`, the FIRST element naming the tag, the
    // value untrimmed as the column always stored it, null with no content.
    const a = headPage(
      `<meta name="og:title" content=" Named title ">` +
        `<meta property="og:title" content="Second title">` +
        `<meta name="description" property="og:description" content=" Both ">` +
        `<meta name="og:image">` +
        `<meta property="og:image" content="https://ex.com/later.png">`,
    );
    expect(a.ogTitle).toBe(" Named title ");
    expect(a.metaDescription).toBe("Both");
    expect(a.ogDescription).toBe(" Both ");
    expect(a.ogImage).toBeNull();
    expect(a.social?.og).toMatchObject({ title: "Named title", description: "Both", image: "" });
    // The property= form is unchanged.
    const b = headPage(`<meta property="og:title" content="T"><meta property="og:image" content="/i.png">`);
    expect([b.ogTitle, b.ogDescription, b.ogImage]).toEqual(["T", null, "/i.png"]);
  });

  it("does not call a repeated tag with one trimmed value conflicting", () => {
    const a = headPage(
      `<meta property="og:url" content="https://ex.com/a">` +
        `<meta property="og:url" content=" https://ex.com/a ">`,
    );
    expect(a.social?.counts["og:url"]).toBe(2);
    expect(a.social?.conflicting).toEqual([]);
  });

  it("sorts the conflicting list", () => {
    const a = headPage(
      `<meta name="twitter:title" content="a"><meta name="twitter:title" content="b">` +
        `<meta property="og:description" content="a"><meta property="og:description" content="b">`,
    );
    expect(a.social?.conflicting).toEqual(["og:description", "twitter:title"]);
  });

  it("reads twitter:* given as property=, and says so", () => {
    const a = headPage(`<meta property="twitter:card" content="summary_large_image">`);
    expect(a.social?.x.card).toBe("summary_large_image");
    expect(a.social?.xViaProperty).toBe(true);
  });

  it("does not raise xViaProperty for twitter:* given as name=", () => {
    expect(headPage(`<meta name="twitter:card" content="summary">`).social?.xViaProperty).toBe(false);
  });

  it("reads og:* given as name=", () => {
    const a = headPage(`<meta name="og:title" content="By name">`);
    expect(a.social?.og.title).toBe("By name");
    expect(a.social?.counts["og:title"]).toBe(1);
  });

  it("folds the case of the tag name", () => {
    const a = headPage(`<meta property="OG:Title" content="Folded">`);
    expect(a.social?.og.title).toBe("Folded");
  });

  it("records a tag with no content attribute as present and empty", () => {
    const a = headPage(`<meta property="og:title"><meta property="og:title" content="Later">`);
    expect(a.social?.og.title).toBe("");
    expect(a.social?.counts["og:title"]).toBe(2);
    expect(a.social?.conflicting).toEqual(["og:title"]);
  });

  it("raises outsideHead for a social tag in the body", () => {
    const a = headPage(
      `<meta property="og:title" content="In head">`,
      `<div>x</div><meta property="og:image" content="https://ex.com/i.png">`,
    );
    expect(a.social?.outsideHead).toBe(true);
    expect(a.social?.og.image).toBe("https://ex.com/i.png");
  });

  it("keeps outsideHead false when every tag is in the head", () => {
    expect(headPage(`<meta property="og:title" content="t">`).social?.outsideHead).toBe(false);
  });

  it("resolves an absolute http(s) og:image into socialImageRefs", () => {
    const a = headPage(`<meta property="og:image" content=" HTTPS://Ex.com/img/share.png ">`);
    expect(a.social?.og.image).toBe("HTTPS://Ex.com/img/share.png");
    expect(a.socialImageRefs).toEqual(["https://ex.com/img/share.png"]);
  });

  it("refs no relative or non-http(s) share image, keeping the raw value in social", () => {
    // `social.image-broken` reports these as relative / invalid from the stored
    // value and never reads a fetch, so no `resources` row is spent on them.
    const a = headPage(
      `<meta property="og:image" content="/og.png">` +
        `<meta name="twitter:image" content="ftp://x/a.png">`,
    );
    expect(a.social?.og.image).toBe("/og.png");
    expect(a.social?.x.image).toBe("ftp://x/a.png");
    expect(a.social?.imageRefs).toEqual({ og: null, x: null });
    expect(a.socialImageRefs).toEqual([]);
    for (const value of ["//cdn.ex.com/a.png", "og.png", "mailto:a@b.c", "httpx://a/b.png"]) {
      expect(shareImageRef(value, "https://ex.com/"), value).toBeNull();
    }
    expect(shareImageRef("Http://ex.com/a.png", "https://ex.com/")).toBe("http://ex.com/a.png");
  });

  it("refs only the two judged images: the FIRST og:image and the FIRST twitter:image", () => {
    // Final review I1: an og:image array (a product gallery) must not crowd out
    // the twitter:image `social.image-broken` judges, nor spend fetches on
    // alternates no rule reads.
    const a = headPage(
      `<meta property="og:image" content="https://ex.com/1.png">` +
        `<meta property="og:image" content="https://ex.com/2.png">` +
        `<meta property="og:image" content="https://ex.com/3.png">` +
        `<meta property="og:image" content="https://ex.com/4.png">` +
        `<meta name="twitter:image" content="https://ex.com/x.png">`,
    );
    expect(a.socialImageRefs).toEqual(["https://ex.com/1.png", "https://ex.com/x.png"]);
    expect(a.social?.imageRefs).toEqual({ og: "https://ex.com/1.png", x: "https://ex.com/x.png" });
    expect(MAX_SOCIAL_IMAGE_REFS).toBe(2);
    expect(a.resourceRefs).toEqual([]);
  });

  it("dedupes the two refs when both tags name one file", () => {
    const a = headPage(
      `<meta property="og:image" content="https://ex.com/1.png">` +
        `<meta name="twitter:image" content="https://ex.com/1.png#frag">`,
    );
    expect(a.socialImageRefs).toEqual(["https://ex.com/1.png"]);
    expect(a.social?.imageRefs).toEqual({ og: "https://ex.com/1.png", x: "https://ex.com/1.png" });
  });

  it("refs nothing for a tag whose FIRST value is empty, even if a later one is not", () => {
    const a = headPage(
      `<meta property="og:image" content=""><meta property="og:image" content="https://ex.com/later.png">`,
    );
    expect(a.social?.og.image).toBe("");
    expect(a.social?.imageRefs).toEqual({ og: null, x: null });
    expect(a.socialImageRefs).toEqual([]);
  });

  it("resolves a share image over SOCIAL_URL_MAX from its whole value, not the capped one", () => {
    const long = `https://ex.com/og/${"u".repeat(1_500)}.png`;
    const a = headPage(`<meta property="og:image" content="${long}">`);
    expect(a.social?.og.image).toHaveLength(SOCIAL_URL_MAX);
    expect(a.social?.imageRefs.og).toBe(long);
    expect(a.socialImageRefs).toEqual([long]);
  });

  it("skips an image value that names no fetchable file, keeping it in social", () => {
    const a = headPage(
      `<meta property="og:image" content="data:image/png;base64,AAAA">` +
        `<meta name="twitter:image" content="  ">` +
        `<meta name="twitter:image" content="#top">`,
    );
    expect(a.socialImageRefs).toEqual([]);
    expect(a.social?.imageRefs).toEqual({ og: null, x: null });
    expect(a.social?.og.image).toBe("data:image/png;base64,AAAA");
    expect(a.social?.x.image).toBe("");
  });

  it("caps text values at SOCIAL_TEXT_MAX and URL values at SOCIAL_URL_MAX", () => {
    const longText = "t".repeat(SOCIAL_TEXT_MAX + 50);
    const longUrl = `https://ex.com/${"u".repeat(SOCIAL_URL_MAX + 50)}`;
    const a = headPage(
      `<meta property="og:title" content="${longText}">` +
        `<meta property="og:url" content="${longUrl}">`,
    );
    expect(a.social?.og.title).toHaveLength(SOCIAL_TEXT_MAX);
    expect(a.social?.og.url).toHaveLength(SOCIAL_URL_MAX);
  });

  it("is null when the page carries no social tag", () => {
    expect(headPage(`<title>t</title><meta name="description" content="d">`).social).toBeNull();
    expect(headPage(`<title>t</title>`).socialImageRefs).toEqual([]);
  });

  it("ignores social tags inside <noscript>, as every meta is", () => {
    expect(headPage(`<noscript><meta property="og:title" content="x"></noscript>`).social).toBeNull();
  });

  it("reads ogTitle / ogDescription / ogImage from the first element naming the tag, raw", () => {
    // PR #23 review: `name=` counts as `property=` does, as in the social set.
    const a = headPage(
      `<meta name="og:title" content="by name">` +
        `<meta property="og:title" content=" raw ">` +
        `<meta property="og:image" content="/i.png">`,
    );
    expect(a.ogTitle).toBe("by name");
    expect(a.ogImage).toBe("/i.png");
    expect(a.ogDescription).toBeNull();
  });
});

describe("h2Text: the first <h2>'s words", () => {
  it("collapses whitespace and reads through inline markup", () => {
    expect(headPage("", `<h2> A <b>b</b> </h2><h2>second</h2>`).h2Text).toBe("A b");
  });

  it("is null without an h2 and empty for an empty one", () => {
    expect(headPage("", `<p>x</p>`).h2Text).toBeNull();
    expect(headPage("", `<h2></h2>`).h2Text).toBe("");
  });

  it("caps at H2_TEXT_MAX", () => {
    expect(headPage("", `<h2>${"w".repeat(H2_TEXT_MAX + 100)}</h2>`).h2Text).toHaveLength(H2_TEXT_MAX);
  });

  it("does not disturb h1Text", () => {
    const a = headPage("", `<h1>One</h1><h2>Two</h2>`);
    expect(a.h1Text).toBe("One");
    expect(a.h2Text).toBe("Two");
  });
});

describe("titleCount / metaDescriptionCount", () => {
  it("counts every element", () => {
    const a = headPage(
      `<title>a</title><title>b</title>` +
        `<meta name="description" content="a"><meta name="Description" content="b">`,
    );
    expect(a.titleCount).toBe(2);
    expect(a.metaDescriptionCount).toBe(2);
  });

  it("is zero, not null, when there are none", () => {
    const a = headPage("");
    expect(a.titleCount).toBe(0);
    expect(a.metaDescriptionCount).toBe(0);
  });

  it("does not count an <svg> title", () => {
    const a = headPage(`<title>a</title>`, `<svg><title>icon</title></svg>`);
    expect(a.titleCount).toBe(1);
  });
});

describe("robots metas", () => {
  it("joins every robots meta and records the bot-specific ones apart", () => {
    const a = headPage(
      `<meta name="robots" content="index">` +
        `<meta name="robots" content="noarchive">` +
        `<meta name="googlebot" content="noindex">`,
    );
    expect(a.robotsMeta).toBe("index, noarchive");
    expect(a.robotsMetas).toEqual([{ name: "googlebot", content: "noindex" }]);
  });

  it("keeps robotsMeta null with no robots meta, and robotsMetas empty", () => {
    const a = headPage(`<title>t</title>`);
    expect(a.robotsMeta).toBeNull();
    expect(a.robotsMetas).toEqual([]);
  });

  it("keeps robotsOutsideHead about the FIRST robots meta", () => {
    const a = headPage(
      `<meta name="robots" content="index">`,
      `<div>x</div><meta name="robots" content="noindex">`,
    );
    expect(a.robotsMeta).toBe("index, noindex");
    expect(a.robotsOutsideHead).toBe(false);
  });

  it("lower-cases the bot name, keeps document order and caps count and content", () => {
    const metas = Array.from(
      { length: ROBOTS_METAS_MAX + 3 },
      (_, i) => `<meta name="${i % 2 === 0 ? "Bingbot" : "googlebot-news"}" content="c${i}">`,
    ).join("");
    const a = headPage(metas);
    expect(a.robotsMetas).toHaveLength(ROBOTS_METAS_MAX);
    expect(a.robotsMetas[0]).toEqual({ name: "bingbot", content: "c0" });
    expect(a.robotsMetas[1]).toEqual({ name: "googlebot-news", content: "c1" });
    const long = headPage(
      `<meta name="googlebot" content="${"n".repeat(ROBOTS_META_CONTENT_MAX + 9)}">`,
    );
    expect(long.robotsMetas[0]?.content).toHaveLength(ROBOTS_META_CONTENT_MAX);
  });

  it("ignores names that are not robots-class", () => {
    expect(headPage(`<meta name="robotsx" content="noindex">`).robotsMetas).toEqual([]);
  });

  it("ignores robots metas inside <noscript>", () => {
    const a = headPage(
      `<noscript><meta name="robots" content="noindex"><meta name="googlebot" content="noindex"></noscript>`,
    );
    expect(a.robotsMeta).toBeNull();
    expect(a.robotsMetas).toEqual([]);
  });
});

describe("the fixture site's default social set reads as complete and consistent", () => {
  it("carries every tag the social rules ask for, once, in the head", () => {
    const self = "http://127.0.0.1:4000/authored/control";
    const a = analyzePage(
      renderDocument({ title: "Control page", canonical: self, bodyHtml: "<p>x</p>" }, self),
      self,
    );
    expect(a.htmlLang).toBe("en");
    expect(a.social).toEqual({
      og: {
        title: "Control page",
        type: "website",
        url: self,
        image: `http://127.0.0.1:4000${SHARED_IMAGE_PATH}`,
      },
      x: { card: "summary_large_image", title: "Control page" },
      counts: {
        "og:title": 1, "og:type": 1, "og:url": 1, "og:image": 1,
        "twitter:card": 1, "twitter:title": 1,
      },
      conflicting: [],
      outsideHead: false,
      xViaProperty: false,
      imageRefs: { og: `http://127.0.0.1:4000${SHARED_IMAGE_PATH}`, x: null },
    });
    expect(a.socialImageRefs).toEqual([`http://127.0.0.1:4000${SHARED_IMAGE_PATH}`]);
  });

  it("renders none with social: false", () => {
    const self = "http://127.0.0.1:4000/x";
    const a = analyzePage(renderDocument({ title: "t", social: false, bodyHtml: "" }, self), self);
    expect(a.social).toBeNull();
  });
});

describe("metaRefresh: the first <meta http-equiv=refresh>", () => {
  it("parses the delay and resolves the target", () => {
    const a = headPage(`<meta http-equiv="Refresh" content="0;url=/x">`);
    expect(a.metaRefresh).toEqual({ raw: "0;url=/x", delaySeconds: 0, target: "https://ex.com/x" });
  });

  it("takes the first of two", () => {
    const a = headPage(
      `<meta http-equiv="refresh" content="5"><meta http-equiv="refresh" content="0;url=/y">`,
    );
    expect(a.metaRefresh).toEqual({ raw: "5", delaySeconds: 5, target: null });
  });

  it("is null when there is none", () => {
    expect(headPage(`<meta http-equiv="content-type" content="text/html">`).metaRefresh).toBeNull();
  });
});

/**
 * Ruling R6 (Task 2 review): repeated identical robots metas collapse, and one
 * meta naming a twitter: tag by name= and an og: tag by property= is both.
 */
describe("ruling R6: robots dedupe and one element naming two social tags", () => {
  it("drops identical robots contents (after trim), keeping first-seen order and every directive", () => {
    const a = headPage(
      `<meta name="robots" content="index, follow">` +
        `<meta name="robots" content=" index, follow ">` +
        `<meta name="robots" content="noarchive">` +
        `<meta name="robots" content="index, follow">`,
      `<div>x</div><meta name="robots" content="noindex">`,
    );
    expect(a.robotsMeta).toBe("index, follow, noarchive, noindex");
  });

  it("keeps a single robots content raw, as before", () => {
    expect(headPage(`<meta name="robots" content=" noindex ">`).robotsMeta).toBe(" noindex ");
  });

  it("records <meta name=twitter:title property=og:title> as both tags", () => {
    const a = headPage(`<meta name="twitter:title" property="og:title" content="x">`);
    expect(a.social?.og.title).toBe("x");
    expect(a.social?.x.title).toBe("x");
    expect(a.social?.counts).toEqual({ "og:title": 1, "twitter:title": 1 });
    expect(a.social?.xViaProperty).toBe(false);
  });

  it("still counts an element naming one tag twice once", () => {
    const a = headPage(`<meta name="og:title" property="og:title" content="x">`);
    expect(a.social?.counts).toEqual({ "og:title": 1 });
    const b = headPage(`<meta name="twitter:card" property="twitter:card" content="summary">`);
    expect(b.social?.counts).toEqual({ "twitter:card": 1 });
    expect(b.social?.xViaProperty).toBe(false);
  });
});

/**
 * Phase 26b, Task 3: the body facts — anchor counts, image alt in anchor text,
 * rel next/prev counts, insecure references and the image alt facts.
 */
function bodyPage(bodyHtml: string, url = P26B_URL) {
  return analyzePage(
    `<!doctype html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`,
    url,
  );
}
const NO_ANCHORS = { noHref: 0, javascript: 0, hashOnly: 0, emptyHref: 0, unsafeBlank: 0 };
const NO_INSECURE = { iframe: 0, media: 0, formAction: 0, forms: 0, sample: [] };

describe("anchorCounts: anchors that are not links (review focus 4)", () => {
  it("does not count a bookmark: <a name> and <a id> carry no href and no link role", () => {
    expect(bodyPage(`<a name="top"></a><a id="x">y</a>`).anchorCounts).toEqual(NO_ANCHORS);
  });

  it("counts an href-less anchor with onclick, role=link or role=button", () => {
    const a = bodyPage(
      `<a onclick="go()">a</a><a role="LINK">b</a><a role=" button ">c</a><a role="tab">d</a>`,
    );
    expect(a.anchorCounts).toEqual({ ...NO_ANCHORS, noHref: 3 });
  });

  it("does not call #section hash-only; # and #! are", () => {
    const a = bodyPage(`<a href="#section">s</a><a href="#">h</a><a href=" #! ">b</a>`);
    expect(a.anchorCounts).toEqual({ ...NO_ANCHORS, hashOnly: 2 });
  });

  it("counts ' JavaScript:void(0)' as javascript", () => {
    const a = bodyPage(`<a href=" JavaScript:void(0)">x</a><a href="javascript:go()">y</a>`);
    expect(a.anchorCounts).toEqual({ ...NO_ANCHORS, javascript: 2 });
  });

  it("counts href=\"\" as emptyHref, not noHref", () => {
    const a = bodyPage(`<a href="">x</a><a href="   ">y</a>`);
    expect(a.anchorCounts).toEqual({ ...NO_ANCHORS, emptyHref: 2 });
  });

  it("does not call target=_BLANK with rel=noopener unsafe", () => {
    expect(bodyPage(`<a target="_BLANK" rel="noopener" href="/x">x</a>`).anchorCounts).toEqual(
      NO_ANCHORS,
    );
  });

  it("counts target=_blank without noopener/noreferrer as unsafe, never on a javascript: or missing href", () => {
    const a = bodyPage(
      `<a target="_blank" href="https://o.test/">a</a>` +
        `<a target="_blank" rel="nofollow NoReferrer" href="/b">b</a>` +
        `<a target="_blank" rel="nofollow" href="/c">c</a>` +
        `<a target="_blank" href="javascript:void(0)">d</a>` +
        `<a target="_blank">e</a>` +
        `<a target="_self" href="/f">f</a>`,
    );
    expect(a.anchorCounts).toEqual({ ...NO_ANCHORS, javascript: 1, unsafeBlank: 2 });
  });

  it("ignores anchors inside <noscript>", () => {
    expect(
      bodyPage(`<noscript><a href="#">x</a><a onclick="y">y</a></noscript>`).anchorCounts,
    ).toEqual(NO_ANCHORS);
  });
});

describe("anchor text takes an image's alt", () => {
  it("gives the alt as the anchor of an image link", () => {
    const a = bodyPage(`<a href="/x"><img src="a.png" alt="Logo"></a>`);
    expect(a.links).toHaveLength(1);
    expect(a.links[0]?.anchor).toBe("Logo");
  });

  it("gives an empty anchor when the image has no alt", () => {
    expect(bodyPage(`<a href="/x"><img src="a.png"></a>`).links[0]?.anchor).toBe("");
  });

  it("trims the alt and ignores a blank one", () => {
    expect(bodyPage(`<a href="/x"><img src="a.png" alt="  Home  "></a>`).links[0]?.anchor).toBe(
      "Home",
    );
    expect(bodyPage(`<a href="/x"><img src="a.png" alt="   "></a>`).links[0]?.anchor).toBe("");
  });

  it("separates an alt from the anchor's text around it (final review I2)", () => {
    expect(bodyPage(`<a href="/x">Home<img alt="Logo"></a>`).links[0]?.anchor).toBe("Home Logo");
    expect(bodyPage(`<a href="/x"><img alt="Logo">Home</a>`).links[0]?.anchor).toBe("Logo Home");
    expect(bodyPage(`<a href="/x"><img alt="A"><img alt="B"></a>`).links[0]?.anchor).toBe("A B");
    expect(bodyPage(`<a href="/x"><img alt="Logo"></a>`).links[0]?.anchor).toBe("Logo");
    expect(bodyPage(`<a href="/x">Home</a>`).links[0]?.anchor).toBe("Home");
  });

  it("does not take the alt of an image outside any anchor", () => {
    const a = bodyPage(`<img src="a.png" alt="Loose"><a href="/x">Text</a>`);
    expect(a.links[0]?.anchor).toBe("Text");
  });
});

describe("relNextCount / relPrevCount: every rel next/prev link", () => {
  it("counts each, with or without href, and keeps the first-only relNext", () => {
    const a = headPage(
      `<link rel="next" href="/2"><link rel="next" href="/3"><link rel="prev">` +
        `<link rel="Prev prefetch" href="/0">`,
    );
    expect(a.relNextCount).toBe(2);
    expect(a.relNext).toBe("/2");
    expect(a.relPrevCount).toBe(2);
    expect(a.relPrev).toBeNull();
  });

  it("is zero, not null, without any", () => {
    const a = headPage(`<title>t</title>`);
    expect(a.relNextCount).toBe(0);
    expect(a.relPrevCount).toBe(0);
  });
});

describe("insecureRefs: http: references from iframes, media and forms", () => {
  it("counts the brief's page on https", () => {
    const a = bodyPage(
      `<iframe src="http://x.test/a"></iframe>` +
        `<video><source src="http://x.test/v.mp4"></video>` +
        `<form action="http://x.test/post"></form><form action="/ok"></form>`,
      "https://s.test/",
    );
    expect(a.insecureRefs).toEqual({
      iframe: 1,
      media: 1,
      formAction: 1,
      forms: 2,
      sample: [
        { kind: "iframe", url: "http://x.test/a" },
        { kind: "media", url: "http://x.test/v.mp4" },
        { kind: "form", url: "http://x.test/post" },
      ],
    });
  });

  it("reads every media site and none outside the closed list", () => {
    const a = bodyPage(
      `<video src="http://m.test/1" poster="http://m.test/2"></video>` +
        `<audio src="http://m.test/3"><source src="http://m.test/4"></audio>` +
        `<track src="http://m.test/5"><embed src="http://m.test/6">` +
        `<object data="http://m.test/7"></object>` +
        `<picture><source srcset="http://m.test/p.png" src="http://m.test/p2.png"></picture>` +
        `<img src="http://m.test/i.png"><script src="http://m.test/s.js"></script>`,
      "https://s.test/",
    );
    expect(a.insecureRefs?.media).toBe(7);
    expect(a.insecureRefs?.sample.map((s) => s.url)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => `http://m.test/${n}`),
    );
  });

  it("does not count https:, protocol-relative on https, data: or javascript: references", () => {
    const a = bodyPage(
      `<iframe src="https://x.test/"></iframe><iframe src="//x.test/rel"></iframe>` +
        `<embed src="data:video/mp4;base64,AAAA"><form action="javascript:void(0)"></form><form></form>`,
      "https://s.test/",
    );
    expect(a.insecureRefs).toEqual({ ...NO_INSECURE, forms: 2 });
  });

  it("records relative references on an http page — the rules decide by the page's scheme", () => {
    const a = bodyPage(`<iframe src="/frame"></iframe><form action="/post"></form>`, "http://s.test/");
    expect(a.insecureRefs).toEqual({
      iframe: 1,
      media: 0,
      formAction: 1,
      forms: 1,
      sample: [
        { kind: "iframe", url: "http://s.test/frame" },
        { kind: "form", url: "http://s.test/post" },
      ],
    });
  });

  it("caps the sample at INSECURE_SAMPLE_MAX per kind while the counters stay exact", () => {
    const n = INSECURE_SAMPLE_MAX + 3;
    const frames = Array.from({ length: n }, (_, i) => `<iframe src="http://x.test/f${i}"></iframe>`);
    const media = Array.from({ length: n }, (_, i) => `<embed src="http://x.test/m${i}">`);
    const forms = Array.from({ length: n }, (_, i) => `<form action="http://x.test/a${i}"></form>`);
    const a = bodyPage([...frames, ...media, ...forms].join(""), "https://s.test/");
    expect(a.insecureRefs?.iframe).toBe(n);
    expect(a.insecureRefs?.media).toBe(n);
    expect(a.insecureRefs?.formAction).toBe(n);
    expect(a.insecureRefs?.forms).toBe(n);
    const sample = a.insecureRefs?.sample ?? [];
    expect(sample).toHaveLength(3 * INSECURE_SAMPLE_MAX);
    for (const [kind, prefix] of [["iframe", "f"], ["media", "m"], ["form", "a"]] as const) {
      expect(sample.filter((s) => s.kind === kind).map((s) => s.url)).toEqual(
        Array.from({ length: INSECURE_SAMPLE_MAX }, (_, i) => `http://x.test/${prefix}${i}`),
      );
    }
  });

  it("one kind filling its sample never crowds out another kind", () => {
    const frames = Array.from(
      { length: INSECURE_SAMPLE_MAX },
      (_, i) => `<iframe src="http://x.test/${i}"></iframe>`,
    );
    const a = bodyPage(
      frames.join("") + `<form action="http://x.test/post"></form>`,
      "https://s.test/",
    );
    expect(a.insecureRefs?.sample).toHaveLength(INSECURE_SAMPLE_MAX + 1);
    expect(a.insecureRefs?.sample.at(-1)).toEqual({ kind: "form", url: "http://x.test/post" });
  });

  it("caps each sampled URL at INSECURE_SAMPLE_URL_MAX; the counters see it whole", () => {
    expect(INSECURE_SAMPLE_URL_MAX).toBe(1024);
    const frames = Array.from(
      { length: 10 },
      (_, i) => `<iframe src="http://x.test/${i}${"p".repeat(5_000)}"></iframe>`,
    );
    const a = bodyPage(frames.join(""), "https://s.test/");
    expect(a.insecureRefs?.iframe).toBe(10);
    expect(a.insecureRefs?.sample).toHaveLength(10);
    for (const [i, s] of (a.insecureRefs?.sample ?? []).entries()) {
      expect(s.url).toHaveLength(INSECURE_SAMPLE_URL_MAX);
      expect(s.url.startsWith(`http://x.test/${i}p`)).toBe(true);
    }
  });

  it("ignores references inside <noscript>", () => {
    const a = bodyPage(
      `<noscript><iframe src="http://gtm.test/ns"></iframe></noscript>`,
      "https://s.test/",
    );
    expect(a.insecureRefs).toEqual(NO_INSECURE);
  });
});

describe("image alt facts", () => {
  it("samples the first IMAGE_SAMPLE_MAX images with no alt, in document order", () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="/i${i}.png">`).join("");
    const a = bodyPage(`<img src="/has.png" alt="x">${imgs}`);
    expect(a.imagesMissingAlt).toBe(12);
    expect(IMAGE_SAMPLE_MAX).toBe(10);
    expect(a.imagesMissingAltSample).toEqual(Array.from({ length: 10 }, (_, i) => `/i${i}.png`));
  });

  it("samples the raw src, capped at IMAGE_SAMPLE_SRC_MAX, and '' for an image with no src", () => {
    const long = `/${"s".repeat(IMAGE_SAMPLE_SRC_MAX + 20)}`;
    const a = bodyPage(`<img src=" ./a.png "><img src="${long}"><img data-src="/lazy.png">`);
    expect(a.imagesMissingAltSample).toEqual([
      " ./a.png ",
      long.slice(0, IMAGE_SAMPLE_SRC_MAX),
      "",
    ]);
  });

  it("counts alt=\"\" (after trim) as empty", () => {
    const a = bodyPage(
      `<img src="/a.png" alt=""><img src="/b.png" alt="   "><img src="/c.png" alt="c">`,
    );
    expect(a.imagesEmptyAlt).toBe(2);
    expect(a.imagesMissingAlt).toBe(0);
    expect(a.imagesMissingAltSample).toEqual([]);
  });

  it("counts an alt over ALT_TEXT_LONG_CHARS (after trim) as too long", () => {
    expect(ALT_TEXT_LONG_CHARS).toBe(100);
    const a = bodyPage(
      `<img src="/a.png" alt="${"a".repeat(101)}">` +
        `<img src="/b.png" alt="${"b".repeat(100)}">` +
        `<img src="/c.png" alt="  ${"c".repeat(100)}  ">`,
    );
    expect(a.imagesAltTooLong).toBe(1);
  });

  it("ignores images inside <noscript>", () => {
    const a = bodyPage(`<noscript><img src="/ns.png"><img src="/e.png" alt=""></noscript>`);
    expect(a.imagesMissingAltSample).toEqual([]);
    expect(a.imagesEmptyAlt).toBe(0);
  });
});
