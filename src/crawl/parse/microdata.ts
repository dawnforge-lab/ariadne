/**
 * Streaming microdata extraction (Phase 29a), into the JSON-LD node shape.
 *
 * Driven from the page analyzer's htmlparser2 hooks (`open` / `text` /
 * `close` / `end`); never a DOM (hard rule 4). Each top-level item becomes one
 * `StructuredDataBlock` of format `"microdata"` whose `raw` is
 *   `{"@context":"https://schema.org","@type":T,"@id"?:itemid,<prop>:value|value[]}`
 * with `@context` on the top-level node only. `T` is
 * `schemaOrgName(firstItemtype) ?? firstItemtype`. A property seen once is a
 * scalar; seen again it becomes an array in document order (the order the
 * property ELEMENTS start in: a text value's slot is reserved when its element
 * opens and filled when it closes). `itemprop="a b"` gives the value to both.
 *
 * ITEMS AND SCOPES. An element with `itemscope` is an item. With an `itemprop`
 * and an enclosing item it is that item's property, a nested node, which may
 * be untyped (R0.2). Without an `itemprop` it is a top-level item and needs a
 * non-empty first `itemtype` token, or it is an error and its properties
 * attach to nothing. An element carrying `itemprop` AND `itemscope` with no
 * enclosing item is an `itemprop` with no scope (an error) and still opens as
 * a top-level item, so a typed item a page publishes is judged rather than
 * lost; the error says the markup is wrong.
 *
 * Items and text-valued properties close by the `elementDepth` they opened at
 * (the analyzer's `hiddenOpenedAt` idiom), never by tag name, so implied
 * closes and unclosed elements cannot pop the wrong one. A top-level item is
 * handed to the sink when it CLOSES, so an item nested without `itemprop`
 * inside another item is emitted before its container. A document truncated
 * mid-item is closed by the tokenizer's own end-of-input closes; `end()` then
 * throws if a frame is still open, which would be depth drift.
 *
 * VALUES (spec §29a: the WHATWG HTML Microdata spec's "property value" list,
 * widened by one reading):
 *  - any element carrying `content`: that attribute, as written (29a final
 *    review M1). The WHATWG spec reads `content` on `meta` only; schema.org's
 *    own markup guide puts it on other elements too, e.g.
 *    `<span itemprop="price" content="10.00">$10</span>`, and that reading is
 *    kept. So an `empty-value` from `content=""` on an element with visible
 *    text is a fact about the attribute as read (a v5 question);
 *  - `meta` without `content`: "";
 *  - `a`, `link`: `href`; `img`, `audio`, `video`, `source`, `iframe`,
 *    `embed`, `track`: `src`. Resolved with `new URL(v, pageUrl).href`, the raw
 *    string when it does not parse, "" when absent;
 *  - `time`: `datetime` when present, else the text (the spec's "datetime
 *    value" is the attribute, or the element's text when it has none);
 *  - `data`, `meter`: `value` ("" when absent);
 *  - anything else: the text, read outside `NON_CONTENT_TAGS` and never inside
 *    `<template>` (R0.9; the analyzer gates what it feeds `text`), whitespace
 *    collapsed, trimmed, and cut to `MICRODATA_TEXT_MAX` with `storableCap`.
 *    Text is accumulated already collapsed and stops once past the cap, so a
 *    1 MB text node never builds a 1 MB string per open property.
 *
 * COUNTS (all on the shared `counts` object the analyzer owns):
 *  - `errors += 1`: an element with `itemprop` and no enclosing item; a
 *    top-level `itemscope` with no usable `itemtype`; an item nested deeper
 *    than `MAX_ITEM_DEPTH` (not opened; the properties under it attach to
 *    nothing and are not counted again); and each `@`-prefixed `itemprop`
 *    token, which would collide with a JSON-LD keyword and is never a
 *    property.
 *  - `skips.microdataItemrefSkipped += 1` per element carrying `itemref`.
 *    `itemref` points at ids anywhere in the document, which one forward pass
 *    cannot resolve, so it is not followed; a referenced `itemprop` outside
 *    every item is then counted as an error like any other.
 *  - `skips.valuesCapped += 1` per property value dropped by `MAX_ITEM_VALUES`.
 *
 * THE VALUE BUDGET is per page and shared with the RDFa machine:
 * `counts.valuesUsed` is the one counter both machines spend from. One
 * `itemprop` element is one value, however many names it carries; an element
 * that is both `itemprop` and `itemscope` is one value (the nested node), and
 * its own properties count themselves. A nested item dropped by the budget is
 * still tracked so its properties attach to nothing, and each of them is
 * counted as capped too (the budget is already spent). Top-level items are not
 * values. The values of an item the analyzer's 50-block cap then drops have
 * still been spent.
 *
 * The stores, budget, bounded text collectors and block emission live in
 * item-core.ts, shared with the RDFa machine (memory bounds are stated there).
 */
import {
  createItemCore,
  resolveUrl,
  type BlockSink,
  type ItemMachine,
  type ItemNode,
  type StructuredDataCounts,
} from "./item-core.js";
import { schemaOrgName } from "./schema-names.js";

export {
  MAX_ITEM_DEPTH,
  MAX_ITEM_VALUES,
  MICRODATA_TEXT_MAX,
  type BlockSink,
  type ItemMachine,
  type StructuredDataCounts,
} from "./item-core.js";

/** Elements whose value is a URL attribute, and which attribute. */
const URL_ATTRIBUTE: Readonly<Record<string, string>> = {
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

/** The first `itemtype` token, normalised to a schema.org name when it is one; null when blank. */
function itemTypeOf(attribs: Record<string, string>): string | null {
  const first = (attribs["itemtype"] ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "") return null;
  return schemaOrgName(first) ?? first;
}

function attributeValue(
  name: string,
  attribs: Record<string, string>,
  pageUrl: string,
): string | undefined {
  // `content` wins on ANY element: a widening of the WHATWG Microdata
  // property-value rules (which read it on `meta` only), as schema.org's own
  // guide writes it (`<span itemprop="price" content="10.00">$10</span>`). An
  // empty element carrying it is not an empty value (29a final review M1).
  if ("content" in attribs) return attribs["content"];
  if (name === "meta") return "";
  const urlAttribute = URL_ATTRIBUTE[name];
  if (urlAttribute !== undefined) {
    const raw = attribs[urlAttribute];
    return raw === undefined ? "" : resolveUrl(raw, pageUrl);
  }
  if (name === "time") return attribs["datetime"];
  if (name === "data" || name === "meter") return attribs["value"] ?? "";
  return undefined;
}

export function createMicrodataMachine(
  pageUrl: string,
  sink: BlockSink,
  counts: StructuredDataCounts,
): ItemMachine {
  const core = createItemCore("microdata", sink, counts);

  const makeNode = (attribs: Record<string, string>): ItemNode => {
    const id = attribs["itemid"]?.trim();
    return {
      type: itemTypeOf(attribs),
      id: id === undefined || id === "" ? null : resolveUrl(id, pageUrl),
      props: new Map(),
    };
  };

  return {
    open(name, attribs, depth) {
      if ("itemref" in attribs) counts.skips.microdataItemrefSkipped += 1;

      let names: string[] | null = null;
      const itemprop = attribs["itemprop"];
      if (itemprop !== undefined) {
        const kept: string[] = [];
        for (const token of new Set(itemprop.trim().split(/\s+/))) {
          if (token === "") continue;
          if (token.startsWith("@")) counts.errors += 1;
          else kept.push(token);
        }
        if (kept.length > 0) names = kept;
      }

      if (names !== null && !core.hasScope()) counts.errors += 1;

      if ("itemscope" in attribs) {
        core.openItem(depth, names, itemTypeOf(attribs) !== null, () => makeNode(attribs));
        return;
      }
      core.openValue(depth, names, names === null ? undefined : attributeValue(name, attribs, pageUrl));
    },

    text: core.text,
    close: core.close,
    end: core.end,
  };
}
