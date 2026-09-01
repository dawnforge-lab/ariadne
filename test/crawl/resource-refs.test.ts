/**
 * The analyzer's resource references (P11-T1): the per-page list of images,
 * stylesheets and scripts the markup points at, emitted from the SAME single
 * streaming pass that counts images.
 *
 * What these cases pin, and why each is a separate question:
 *  - THE CLOSED LIST. Five attribute sites and no others (`<img src>`,
 *    `<img srcset>`, `<source src>` / `<source srcset>` inside a `<picture>`,
 *    `<script src>`, `<link rel=stylesheet href>`). A sixth source added by
 *    accident — a favicon, a preload hint, a `<video><source>` — is a resource
 *    the fetch pass would then politely request from somebody's server, so the
 *    list is tested as CLOSED rather than as a set of positives.
 *  - THE DROPS. `data:` URIs, `javascript:`, and fragment-only references are
 *    not resources: nothing is on the other end of them. They are dropped
 *    silently HERE because they were never a fetch, which is the one place a
 *    silence is honest (hard rule 7 is about failed work, not about markup that
 *    names no resource).
 *  - THE SRCSET RULE. First candidate only, documented at the analyzer.
 *  - COUNTS AND REFS ARE DIFFERENT FACTS and both survive. `imagesTotal` and
 *    its two siblings stay exactly what they were — cheap scalar page facts,
 *    uncapped — while the refs feed the resource pipeline and carry the
 *    per-page cap every other extracted collection carries.
 */
import { describe, expect, it } from "vitest";
import {
  analyzePage,
  MAX_RESOURCE_REFS,
  type ResourceRef,
} from "../../src/crawl/parse/page-analyzer.js";

const PAGE = "https://ex.com/blog/post";

function refs(html: string, url = PAGE): ResourceRef[] {
  return analyzePage(html, url).resourceRefs;
}

function doc(body: string, head = ""): string {
  return `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

describe("resource refs — the closed extraction list", () => {
  const html = doc(
    `<img src="/img/a.png" alt="a">
     <img src="../img/b.png" srcset="/img/b-480.png 480w, /img/b-960.png 960w" alt="b">
     <picture>
       <source srcset="/img/c.avif 1x, /img/c-2x.avif 2x" type="image/avif">
       <source src="/img/c.webp">
       <img src="/img/c.png" alt="c">
     </picture>
     <script src="/js/app.js"></script>
     <script src="//cdn.ex.com/vendor.js"></script>`,
    `<link rel="stylesheet" href="/css/site.css">
     <link rel="preload stylesheet" href="/css/late.css" as="style">`,
  );

  it("resolves every one of the five sites to an absolute URL, with its kind", () => {
    expect(refs(html)).toEqual([
      { url: "https://ex.com/css/site.css", kind: "css" },
      { url: "https://ex.com/css/late.css", kind: "css" },
      { url: "https://ex.com/img/a.png", kind: "image" },
      // `src` and the first `srcset` candidate are two different files and both
      // are referenced: the fallback every client without srcset support gets,
      // and the first candidate.
      { url: "https://ex.com/img/b.png", kind: "image" },
      { url: "https://ex.com/img/b-480.png", kind: "image" },
      { url: "https://ex.com/img/c.avif", kind: "image" },
      { url: "https://ex.com/img/c.webp", kind: "image" },
      { url: "https://ex.com/img/c.png", kind: "image" },
      { url: "https://ex.com/js/app.js", kind: "js" },
      { url: "https://cdn.ex.com/vendor.js", kind: "js" },
    ]);
  });

  it("leaves the image counters exactly where they were", () => {
    const a = analyzePage(html, PAGE);
    // Three <img> elements: a, b, c. The <source> elements are not images by
    // the counter's definition and never were.
    expect(a.imagesTotal).toBe(3);
    expect(a.imagesMissingAlt).toBe(0);
    expect(a.imagesMissingDimensions).toBe(3);
  });
});

describe("resource refs — what is NOT a resource", () => {
  it("drops data: URIs, javascript: and fragment-only references", () => {
    expect(
      refs(
        doc(
          `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline">
           <img src="DATA:image/png;base64,iVBOR" alt="cased">
           <img src="#" alt="fragment">
           <img src="#hero" alt="fragment target">
           <img src="   " alt="blank">
           <img alt="no src at all">
           <script src="javascript:void(0)"></script>
           <script src="data:text/javascript,console.log(1)"></script>`,
        ),
      ),
    ).toEqual([]);
  });

  it("drops the protocols normalizeUrl refuses, and keeps the counters honest", () => {
    const a = analyzePage(
      doc(`<img src="mailto:a@b.c" alt="x"><img src="about:blank" alt="y">`),
      PAGE,
    );
    expect(a.resourceRefs).toEqual([]);
    expect(a.imagesTotal).toBe(2);
  });

  it("takes no <source> outside a <picture> — video and audio are not our scope", () => {
    expect(
      refs(
        doc(
          `<video controls><source src="/media/clip.mp4" type="video/mp4"></video>
           <audio><source src="/media/tune.mp3"></audio>`,
        ),
      ),
    ).toEqual([]);
  });

  it("takes no favicon, preload, prefetch or font link", () => {
    expect(
      refs(
        doc(
          "",
          `<link rel="icon" href="/favicon.ico">
           <link rel="shortcut icon" href="/favicon-2.ico">
           <link rel="apple-touch-icon" href="/touch.png">
           <link rel="preload" href="/fonts/x.woff2" as="font">
           <link rel="prefetch" href="/next.js">
           <link rel="preconnect" href="https://cdn.ex.com">
           <link rel="canonical" href="https://ex.com/blog/post">`,
        ),
      ),
    ).toEqual([]);
  });

  it("takes no inline style url() and no @import in a <style> body", () => {
    expect(
      refs(
        doc(
          `<div style="background-image:url(/img/hero.jpg)">x</div>
           <style>@import url("/css/imported.css"); .a{background:url(/img/bg.png)}</style>`,
        ),
      ),
    ).toEqual([]);
  });

  it("takes a stylesheet link only when it carries an href", () => {
    expect(refs(doc("", `<link rel="stylesheet">`))).toEqual([]);
  });

  /**
   * An ALTERNATE stylesheet (`rel="alternate stylesheet"`, the user-selectable
   * theme mechanism) is not loaded on render: a browser parses the link and
   * fetches nothing until a reader picks that style. Fetching it here would
   * spend a client's politeness budget — a request against their server, a slot
   * in their host queue — on a file no page load asks for, and would then weigh
   * a page by bytes no visitor downloads. The token list is order-free, so both
   * spellings are dropped.
   */
  it("drops an alternate stylesheet and keeps the plain one", () => {
    expect(
      refs(
        doc(
          "",
          `<link rel="stylesheet" href="/css/site.css">
           <link rel="alternate stylesheet" href="/css/hi-contrast.css" title="High contrast">
           <link rel="stylesheet alternate" href="/css/sepia.css" title="Sepia">`,
        ),
      ),
    ).toEqual([{ url: "https://ex.com/css/site.css", kind: "css" }]);
  });
});

describe("resource refs — srcset is read to its FIRST candidate only", () => {
  it("takes the first candidate and ignores the rest, descriptors and all", () => {
    expect(
      refs(doc(`<img srcset="/a.png 1x, /b.png 2x, /c.png 3x" alt="x">`)),
    ).toEqual([{ url: "https://ex.com/a.png", kind: "image" }]);
  });

  it("tolerates leading whitespace and leading commas", () => {
    expect(refs(doc(`<img srcset="  ,  /a.png 480w, /b.png 960w" alt="x">`))).toEqual([
      { url: "https://ex.com/a.png", kind: "image" },
    ]);
  });

  it("strips the trailing comma of a descriptor-less first candidate", () => {
    expect(refs(doc(`<img srcset="/a.png, /b.png 2x" alt="x">`))).toEqual([
      { url: "https://ex.com/a.png", kind: "image" },
    ]);
  });

  it("keeps commas INSIDE a candidate URL — the split is on whitespace", () => {
    // Cloudinary-shaped transforms put commas in the path; splitting a srcset
    // on commas would cut such a URL in half and reference a file that does
    // not exist.
    expect(
      refs(doc(`<img srcset="/i/w_100,h_200/a.png 1x, /i/w_200,h_400/a.png 2x" alt="x">`)),
    ).toEqual([{ url: "https://ex.com/i/w_100,h_200/a.png", kind: "image" }]);
  });

  it("emits nothing for an empty or comma-only srcset", () => {
    expect(refs(doc(`<img srcset="" alt="x"><img srcset="  , ," alt="y">`))).toEqual([]);
  });
});

describe("resource refs — one page, one entry per URL", () => {
  it("collapses a URL referenced twice on the same page", () => {
    expect(
      refs(
        doc(
          `<img src="/img/logo.png" alt="1"><img src="/img/logo.png" alt="2">
           <img src="/img/logo.png" srcset="/img/logo.png 2x" alt="3">`,
        ),
      ),
    ).toEqual([{ url: "https://ex.com/img/logo.png", kind: "image" }]);
  });

  it("collapses two spellings normalizeUrl says are one URL", () => {
    // The link extraction's own key: fragment stripped, query params sorted,
    // hostname lowercased. Resources are keyed the same way, so the fetch pass
    // asks for one file rather than three.
    expect(
      refs(
        doc(
          `<img src="/i/a.png?b=2&a=1" alt="1">
           <img src="/i/a.png?a=1&b=2" alt="2">
           <img src="//EX.com/i/a.png?a=1&b=2#x" alt="3">`,
        ),
      ),
    ).toEqual([{ url: "https://ex.com/i/a.png?a=1&b=2", kind: "image" }]);
  });

  it("keeps the first kind when one URL is referenced as two kinds", () => {
    expect(
      refs(doc(`<script src="/x"></script><img src="/x" alt="also">`)),
    ).toEqual([{ url: "https://ex.com/x", kind: "js" }]);
  });
});

describe("resource refs — volume", () => {
  it("emits one ref per image on a 200-image page without moving the counters", () => {
    const body = Array.from(
      { length: 200 },
      (_, i) => `<img src="/i/${i}.png" alt="${i}">`,
    ).join("");
    const a = analyzePage(doc(body), PAGE);
    expect(a.resourceRefs).toHaveLength(200);
    expect(a.imagesTotal).toBe(200);
    expect(a.imagesMissingAlt).toBe(0);
    expect(a.imagesMissingDimensions).toBe(200);
    expect(a.resourceRefs[199]).toEqual({
      url: "https://ex.com/i/199.png",
      kind: "image",
    });
  });

  it("caps the refs and does NOT cap the counters", () => {
    const n = MAX_RESOURCE_REFS + 50;
    const body = Array.from(
      { length: n },
      (_, i) => `<img src="/i/${i}.png" alt="${i}">`,
    ).join("");
    const a = analyzePage(doc(body), PAGE);
    expect(a.resourceRefs).toHaveLength(MAX_RESOURCE_REFS);
    // The scalar counters are the page's own facts and stay exact — the same
    // split the link cap already makes (analyzer caps: links 2000, headings
    // uncapped).
    expect(a.imagesTotal).toBe(n);
  });
});

describe("resource refs — where the tokenizer does and does not look", () => {
  it("reads a <template>'s markup, as every other element extraction does", () => {
    // Template content is in no rendered document, which is why its TEXT leaves
    // the word counts; its ELEMENTS are still elements, and the image counter
    // has always counted them. Refs ride the same walk and agree with it.
    const a = analyzePage(
      doc(`<template><img src="/t/a.png" alt="a"></template>`),
      PAGE,
    );
    expect(a.resourceRefs).toEqual([{ url: "https://ex.com/t/a.png", kind: "image" }]);
    expect(a.imagesTotal).toBe(1);
  });

  it("reads nothing inside <noscript>, as every other element extraction does", () => {
    // parse5 (the DOM the port is held to) treats noscript content as raw text
    // when scripting is enabled, so no element in there is an element.
    const a = analyzePage(
      doc(`<noscript><img src="/n/a.png" alt="a"></noscript>`),
      PAGE,
    );
    expect(a.resourceRefs).toEqual([]);
    expect(a.imagesTotal).toBe(0);
  });
});
