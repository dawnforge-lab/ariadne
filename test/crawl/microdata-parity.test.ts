/**
 * Parity: the streaming microdata machine against a DOM oracle.
 *
 * The oracle is cheerio over parse5 with scripting enabled — the tree builder a
 * browser and a search engine run — so implied closes, foster parenting and
 * `<noscript>`-as-raw-text are the real tree's, not the tokenizer's. It
 * implements the same spec subset as `src/crawl/parse/microdata.ts`, written
 * here independently over the DOM:
 *  - an item is an element with `itemscope`; it is a property of the nearest
 *    ancestor item when it carries `itemprop`, else a top-level item;
 *  - a top-level item needs a non-empty first `itemtype` token (R0.2); a
 *    nested one may be untyped;
 *  - values: `content` on ANY element that carries it, as written (Google's
 *    reading, wider than the HTML spec's meta-only list: 29a final review M1),
 *    else "" on meta, href/src on the URL elements (resolved), `datetime` on
 *    time (else text), `value` on data/meter, else text;
 *  - text is read outside script/style/noscript/svg and never inside
 *    `<template>` (R0.9), whitespace collapsed and trimmed;
 *  - `<template>` and `<noscript>` subtrees, the elements themselves included,
 *    are inert;
 *  - top-level items are listed in the order they CLOSE (post-order), which is
 *    the order a forward pass can emit them in.
 * The size caps are not modelled: the corpus is small. They are pinned by
 * test/crawl/microdata.test.ts.
 */
import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeHtml } from "../../src/crawl/parse/page-analyzer.js";
import { startFixtureApp, type FixtureApp } from "../fixtures/app.js";
import { startAssetHost, type AssetHost } from "../fixtures/assets.js";
import { allFixtures } from "../fixtures/fixture.js";
import { startOffsiteHost, type OffsiteHost } from "../fixtures/pages/render-p5.js";

const PAGE_URL = "https://example.com/dir/page";

interface DomNode {
  type?: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

type OracleValue = string | OracleNode;
interface OracleNode {
  type: string | null;
  id: string | null;
  props: Map<string, OracleValue[]>;
}

const NON_CONTENT = new Set(["script", "style", "noscript", "svg"]);
const URL_ATTR: Record<string, string> = {
  a: "href",
  link: "href",
  img: "src",
  audio: "src",
  video: "src",
  source: "src",
  iframe: "src",
  embed: "src",
  track: "src",
};

const isElement = (n: DomNode) => n.type === "tag" || n.type === "script" || n.type === "style";

function resolve(value: string, base: string): string {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** Text content outside NON_CONTENT and template subtrees (R0.9). */
function textOf(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  if (!isElement(node)) return "";
  const name = node.name!.toLowerCase();
  if (NON_CONTENT.has(name) || name === "template") return "";
  return (node.children ?? []).map(textOf).join("");
}

function oracle(html: string, pageUrl: string): { blocks: unknown[]; errors: number; itemref: number } {
  const $ = cheerio.load(html);
  const blocks: unknown[] = [];
  let errors = 0;
  let itemref = 0;

  const finalize = (node: OracleNode, top: boolean): Record<string, unknown> => {
    const entries: [string, unknown][] = [];
    if (top) entries.push(["@context", "https://schema.org"]);
    if (node.type !== null) entries.push(["@type", node.type]);
    if (node.id !== null) entries.push(["@id", node.id]);
    for (const [k, vs] of node.props) {
      const f = vs.map((v) => (typeof v === "string" ? v : finalize(v, false)));
      entries.push([k, f.length === 1 ? f[0] : f]);
    }
    return Object.fromEntries(entries);
  };
  const typeOf = (attribs: Record<string, string>): string | null => {
    const first = (attribs["itemtype"] ?? "").trim().split(/\s+/)[0] ?? "";
    if (first === "") return null;
    const m =
      /^https?:\/\/(?:www\.)?schema\.org\/([^/?#\s]+)$/i.exec(first) ??
      /^schema:([^/?#\s]+)$/i.exec(first);
    return m ? m[1]! : first;
  };
  const makeNode = (attribs: Record<string, string>): OracleNode => {
    const id = attribs["itemid"]?.trim();
    return {
      type: typeOf(attribs),
      id: id === undefined || id === "" ? null : resolve(id, pageUrl),
      props: new Map(),
    };
  };
  const add = (node: OracleNode, names: string[], value: OracleValue) => {
    for (const n of names) {
      const list = node.props.get(n);
      if (list) list.push(value);
      else node.props.set(n, [value]);
    }
  };

  /**
   * `scope`: the nearest enclosing item's node, `"dead"` inside an item whose
   * properties attach to nothing, or null outside every item.
   */
  const walk = (el: DomNode, scope: OracleNode | "dead" | null) => {
    if (!isElement(el)) return;
    const name = el.name!.toLowerCase();
    if (name === "template" || name === "noscript") return;
    const attribs = el.attribs ?? {};
    if ("itemref" in attribs) itemref += 1;
    let names: string[] | null = null;
    if (attribs["itemprop"] !== undefined) {
      const tokens = [...new Set(attribs["itemprop"].trim().split(/\s+/).filter((t) => t !== ""))];
      const keywords = tokens.filter((t) => t.startsWith("@"));
      errors += keywords.length;
      const kept = tokens.filter((t) => !t.startsWith("@"));
      names = kept.length > 0 ? kept : null;
    }
    if (names !== null && scope === null) errors += 1;
    let childScope = scope;
    let topLevel: OracleNode | null = null;
    if ("itemscope" in attribs) {
      if (names !== null && scope !== null) {
        if (scope === "dead") {
          childScope = "dead";
        } else {
          const node = makeNode(attribs);
          add(scope, names, node);
          childScope = node;
        }
      } else if (typeOf(attribs) === null) {
        errors += 1;
        childScope = "dead";
      } else {
        topLevel = makeNode(attribs);
        childScope = topLevel;
      }
    } else if (names !== null && scope !== null && scope !== "dead") {
      const urlAttr = URL_ATTR[name];
      let value: string;
      if (attribs["content"] !== undefined) value = attribs["content"];
      else if (name === "meta") value = "";
      else if (urlAttr !== undefined) {
        const raw = attribs[urlAttr];
        value = raw === undefined ? "" : resolve(raw, pageUrl);
      } else if (name === "time" && attribs["datetime"] !== undefined) value = attribs["datetime"];
      else if (name === "data" || name === "meter") value = attribs["value"] ?? "";
      else value = textOf(el).replace(/\s+/g, " ").trim();
      add(scope, names, value);
    }
    for (const child of el.children ?? []) walk(child, childScope);
    if (topLevel !== null) blocks.push(finalize(topLevel, true));
  };
  for (const child of ($.root()[0] as unknown as DomNode).children ?? []) walk(child, null);
  return { blocks, errors, itemref };
}

function stream(html: string, pageUrl: string) {
  const result = analyzeHtml(html, pageUrl);
  return {
    blocks: result.structuredData.filter((b) => b.format === "microdata").map((b) => b.raw),
    errors: result.structuredDataMicrodataErrors,
    itemref: result.structuredDataSkips.microdataItemrefSkipped,
  };
}

const T = (t: string) => `itemscope itemtype="https://schema.org/${t}"`;

/** Review Focus 1: malformed or implied nesting. */
const MALFORMED: Record<string, string> = {
  "an unclosed div item":
    `<!doctype html><html><body><div ${T("Product")}><span itemprop="name">Mug</span>` +
    `<div itemprop="offers" ${T("Offer")}><meta itemprop="price" content="3">` +
    `<p>after</p></body></html>`,
  "an item inside an implicitly closed p":
    `<!doctype html><html><body><p ${T("Thing")}><span itemprop="name">in p</span>` +
    `<div itemprop="description">block closes the p</div></p>` +
    `<div ${T("Thing")}><p><span itemprop="name">kept</span><div itemprop="alternateName">x</div></p></div>` +
    `</body></html>`,
  "the document ending inside an item":
    `<!doctype html><html><body><div ${T("Event")}><span itemprop="name">Gig</span>` +
    `<div itemprop="location" ${T("Place")}><span itemprop="name">Hall`,
  "an itemprop on a void element":
    `<!doctype html><html><body><div ${T("Product")}><img itemprop="image" src="/a.png">tail` +
    `<br itemprop="note">x<input itemprop="sku" value="9"><meta itemprop="mpn" content="m">` +
    `<link itemprop="url" href="?q=1"><hr itemprop="sep"></div></body></html>`,
  "an item inside table foster-parenting":
    `<!doctype html><html><body><table><div ${T("Thing")}><span itemprop="name">foster</span></div>` +
    `<tr><td><div ${T("Thing")}><span itemprop="name">cell</span></div></td></tr></table></body></html>`,
  "an itemscope on html":
    `<!doctype html><html ${T("WebPage")}><head><title itemprop="name">Page</title>` +
    `<meta itemprop="description" content="d"></head><body><span itemprop="keywords">k</span></body></html>`,
};

/** Well-formed pages covering the value list, nesting, arrays and the inert subtrees. */
const WELL_FORMED: Record<string, string> = {
  "product with offers and review":
    `<!doctype html><html><body><div ${T("Product")} itemid="#p">` +
    `<h1 itemprop="name"> The   Mug </h1><img itemprop="image" src="a.png"><img itemprop="image" src="b.png">` +
    `<div itemprop="offers" ${T("Offer")}><meta itemprop="price" content="14.00">` +
    `<link itemprop="availability" href="https://schema.org/InStock"></div>` +
    `<div itemprop="review" ${T("Review")}><span itemprop="author">Ann</span>` +
    `<div itemprop="reviewRating" ${T("Rating")}><data itemprop="ratingValue" value="5">five</data></div></div>` +
    `</div></body></html>`,
  "content on elements other than meta (29a final review M1)":
    `<!doctype html><html><body><div ${T("Product")}><span itemprop="name">Mug</span>` +
    `<div itemprop="offers" ${T("Offer")}><span itemprop="price" content="10.00">$10</span>` +
    `<span itemprop="priceCurrency" content="USD"></span></div>` +
    `<a itemprop="url" href="/mug" content="https://example.com/m">m</a>` +
    `<time itemprop="releaseDate" datetime="2026-01-01" content="2026-02-02">Feb</time>` +
    `<data itemprop="sku" value="v" content="c">d</data><img itemprop="image" src="/i.png" content="">` +
    `<meta itemprop="mpn"></div></body></html>`,
  "breadcrumb list":
    `<!doctype html><html><body><ol ${T("BreadcrumbList")}>` +
    `<li itemprop="itemListElement" ${T("ListItem")}><a itemprop="item" href="/"><span itemprop="name">Home</span></a>` +
    `<meta itemprop="position" content="1"></li>` +
    `<li itemprop="itemListElement" ${T("ListItem")}><a itemprop="item" href="/shop/"><span itemprop="name">Shop</span></a>` +
    `<meta itemprop="position" content="2"></li></ol></body></html>`,
  "untyped nested, stray props, itemref and inert subtrees":
    `<!doctype html><html><body><span itemprop="stray">s</span>` +
    `<div ${T("Person")} itemref="x"><span itemprop="name">A<script>no</script> B</span>` +
    `<div itemprop="address" itemscope><span itemprop="streetAddress">1 Main</span></div>` +
    `<time itemprop="birthDate" datetime="2000-01-01">Jan</time><time itemprop="deathDate">  later </time>` +
    `<meter itemprop="m" value="0.5"></meter><template><span itemprop="t">t</span></template>` +
    `<noscript><span itemprop="n">n</span></noscript></div>` +
    `<div itemscope><span itemprop="x">untyped top</span></div>` +
    `<div ${T("Organization")}><div ${T("WebSite")}><span itemprop="name">inner top</span></div>` +
    `<span itemprop="name">outer</span></div></body></html>`,
};

let offsite: OffsiteHost;
let assetHost: AssetHost;
let app: FixtureApp;
/** The fixture site's HTML, every page that carries `itemscope`. */
const fixturePages: { path: string; html: string }[] = [];
let fixturesFetched = 0;

// Fixtures whose response cannot be read as a page by design (Phase 23): one
// resets the connection, the other sends a coding that does not decode. Every
// other fixture is fetched.
const UNREADABLE = new Set(["/authored23/no-response", "/authored23/brotli"]);

beforeAll(async () => {
  // Both before the app: the hub and a render fixture read these origins on
  // every request and throw if they are not up (the harness does the same).
  offsite = await startOffsiteHost();
  assetHost = await startAssetHost();
  app = await startFixtureApp(allFixtures());
  for (const fixture of allFixtures()) {
    if (UNREADABLE.has(fixture.path)) continue;
    const res = await fetch(`${app.base}${fixture.path}`, { redirect: "manual" });
    const html = await res.text();
    fixturesFetched += 1;
    if (html.includes("itemscope")) fixturePages.push({ path: fixture.path, html });
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await assetHost.close();
  await offsite.close();
});

describe("microdata parity with the DOM oracle", () => {
  for (const [name, html] of Object.entries({ ...MALFORMED, ...WELL_FORMED })) {
    it(name, () => {
      const expected = oracle(html, PAGE_URL);
      // A corpus page that yields nothing proves nothing.
      expect(expected.blocks.length).toBeGreaterThan(0);
      expect(stream(html, PAGE_URL)).toEqual(expected);
    });
  }

  it("every fixture page carrying itemscope", () => {
    // The site was really read; until the Task 10 fixtures land, no page on it
    // carries `itemscope` and the snippets above are the whole corpus.
    expect(fixturesFetched).toBe(allFixtures().length - UNREADABLE.size);
    for (const { path, html } of fixturePages) {
      const url = `${app.base}${path}`;
      expect(stream(html, url), path).toEqual(oracle(html, url));
    }
  });
});
