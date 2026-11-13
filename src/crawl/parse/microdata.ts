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
 * inside another item is emitted before its container. `end()` closes what a
 * truncated document left open, innermost first.
 *
 * VALUES (spec §29a, the HTML microdata list):
 *  - `meta`: `content` ("" when absent);
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
 * MEMORY. Bounded by the budget: at most `MAX_ITEM_VALUES` values per page,
 * each text value at most `MICRODATA_TEXT_MAX` (+ one window) characters, and
 * the frame stacks are bounded by the open-element depth. Finalising a node
 * recurses at most `MAX_ITEM_DEPTH` levels.
 */
import { storableCap } from "../storable-text.js";
import type { StructuredDataBlock, StructuredDataSkips } from "./page-analyzer.js";
import { SCHEMA_ORG_CONTEXT, schemaOrgName } from "./schema-names.js";

/** Characters kept per text value, applied with `storableCap`. */
export const MICRODATA_TEXT_MAX = 500;
/** Property values kept per page, across microdata and RDFa (`counts.valuesUsed`). */
export const MAX_ITEM_VALUES = 1000;
/** Nested item levels; the top-level item is level 1. */
export const MAX_ITEM_DEPTH = 32;

/** Where a finished top-level node goes; the analyzer's sink owns the 50-block cap. */
export type BlockSink = (block: StructuredDataBlock) => void;

/** A streaming extractor driven from the analyzer's tokenizer hooks. */
export interface ItemMachine {
  open(name: string, attribs: Record<string, string>, depth: number): void;
  text(t: string): void;
  close(depth: number): void;
  end(): void;
}

/**
 * The per-page counters every item machine writes to. One object per page,
 * shared by the microdata and RDFa machines: `valuesUsed` is the shared
 * `MAX_ITEM_VALUES` budget.
 */
export interface StructuredDataCounts {
  errors: number;
  skips: StructuredDataSkips;
  valuesUsed: number;
}

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

/** Raw text is collapsed this many characters at a time, so a huge text node is never copied whole. */
const TEXT_WINDOW = 4096;

type Value = string | ItemNode;

interface ItemNode {
  type: string | null;
  id: string | null;
  /** Insertion order is first-seen order; each list is in document order. */
  props: Map<string, Value[]>;
}

interface Frame {
  openedAt: number;
  /** Property-nesting level: 1 for a top-level item. */
  level: number;
  /**
   * Where this item's properties go. Null when they go nowhere: a dead item
   * (untyped top level, too deep, or under a dead item), or one the value
   * budget dropped.
   */
  node: ItemNode | null;
  /**
   * Whether properties under this item are counted (against the budget, and
   * as capped when it is spent). False for a dead item: its properties attach
   * to nothing and are not counted again.
   */
  counted: boolean;
  topLevel: boolean;
}

interface Slot {
  values: Value[];
  index: number;
}

interface TextCollector {
  openedAt: number;
  slots: Slot[];
  parts: string[];
  length: number;
  /** A collapsed space is owed before the next text (trailing whitespace is never written). */
  pendingSpace: boolean;
  full: boolean;
}

function resolveUrl(value: string, pageUrl: string): string {
  try {
    return new URL(value, pageUrl).href;
  } catch {
    // Not a resolvable URL: stored as written, for the rules to judge.
    return value;
  }
}

/** The first `itemtype` token, normalised to a schema.org name when it is one; null when blank. */
function itemTypeOf(attribs: Record<string, string>): string | null {
  const first = (attribs["itemtype"] ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "") return null;
  return schemaOrgName(first) ?? first;
}

function appendCollapsed(collector: TextCollector, collapsed: string): void {
  let s = collapsed;
  if (s.startsWith(" ")) {
    collector.pendingSpace = true;
    s = s.slice(1);
  }
  if (s === "") return;
  const trailing = s.endsWith(" ");
  if (trailing) s = s.slice(0, -1);
  if (collector.pendingSpace && collector.length > 0) {
    collector.parts.push(" ");
    collector.length += 1;
  }
  collector.parts.push(s);
  collector.length += s.length;
  collector.pendingSpace = trailing;
  if (collector.length > MICRODATA_TEXT_MAX) collector.full = true;
}

/** The plain JSON-LD-shaped object for a node; `@context` on the top-level node only. */
function finalize(node: ItemNode, topLevel: boolean): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  if (topLevel) entries.push(["@context", SCHEMA_ORG_CONTEXT]);
  if (node.type !== null) entries.push(["@type", node.type]);
  if (node.id !== null) entries.push(["@id", node.id]);
  for (const [name, values] of node.props) {
    const out = values.map((v) => (typeof v === "string" ? v : finalize(v, false)));
    entries.push([name, out.length === 1 ? out[0] : out]);
  }
  // Defined, never assigned: an `itemprop="__proto__"` stays an own key.
  return Object.fromEntries(entries);
}

export function createMicrodataMachine(
  pageUrl: string,
  sink: BlockSink,
  counts: StructuredDataCounts,
): ItemMachine {
  const frames: Frame[] = [];
  const collectors: TextCollector[] = [];
  let unfullCollectors = 0;

  const makeNode = (attribs: Record<string, string>): ItemNode => {
    const id = attribs["itemid"]?.trim();
    return {
      type: itemTypeOf(attribs),
      id: id === undefined || id === "" ? null : resolveUrl(id, pageUrl),
      props: new Map(),
    };
  };

  /** Reserve one slot per name, in document order, holding `value` until a collector fills it. */
  const reserve = (node: ItemNode, names: readonly string[], value: Value): Slot[] =>
    names.map((name) => {
      let values = node.props.get(name);
      if (values === undefined) {
        values = [];
        node.props.set(name, values);
      }
      values.push(value);
      return { values, index: values.length - 1 };
    });

  /** Spend one value from the shared budget; false (and counted) when it is spent. */
  const spend = (): boolean => {
    if (counts.valuesUsed >= MAX_ITEM_VALUES) {
      counts.skips.valuesCapped += 1;
      return false;
    }
    counts.valuesUsed += 1;
    return true;
  };

  /** A counted frame with budget left always has a node: only the budget detaches one. */
  const liveNode = (frame: Frame): ItemNode => {
    if (frame.node === null) {
      throw new Error("microdata: a counted item with value budget left has no node");
    }
    return frame.node;
  };

  const attributeValue = (name: string, attribs: Record<string, string>): string | undefined => {
    if (name === "meta") return attribs["content"] ?? "";
    const urlAttribute = URL_ATTRIBUTE[name];
    if (urlAttribute !== undefined) {
      const raw = attribs[urlAttribute];
      return raw === undefined ? "" : resolveUrl(raw, pageUrl);
    }
    if (name === "time") return attribs["datetime"];
    if (name === "data" || name === "meter") return attribs["value"] ?? "";
    return undefined;
  };

  const finishCollector = (collector: TextCollector) => {
    if (!collector.full) unfullCollectors -= 1;
    const text = storableCap(collector.parts.join(""), MICRODATA_TEXT_MAX);
    for (const slot of collector.slots) slot.values[slot.index] = text;
  };

  const finishFrame = (frame: Frame) => {
    if (!frame.topLevel || frame.node === null) return;
    const node = frame.node;
    // `topLevel` frames are only ever made with a type (R0.2).
    if (node.type === null) throw new Error("microdata: a top-level item has no type");
    sink({ type: node.type, format: "microdata", raw: finalize(node, true) });
  };

  const close = (depth: number) => {
    const collector = collectors[collectors.length - 1];
    if (collector !== undefined && collector.openedAt === depth) {
      collectors.pop();
      finishCollector(collector);
    }
    const frame = frames[frames.length - 1];
    if (frame !== undefined && frame.openedAt === depth) {
      frames.pop();
      finishFrame(frame);
    }
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

      const scope = frames[frames.length - 1];
      if (names !== null && scope === undefined) counts.errors += 1;

      if ("itemscope" in attribs) {
        if (names !== null && scope !== undefined) {
          const level = scope.level + 1;
          if (level > MAX_ITEM_DEPTH) {
            counts.errors += 1;
            frames.push({ openedAt: depth, level, node: null, counted: false, topLevel: false });
          } else if (!scope.counted) {
            frames.push({ openedAt: depth, level, node: null, counted: false, topLevel: false });
          } else if (!spend()) {
            frames.push({ openedAt: depth, level, node: null, counted: true, topLevel: false });
          } else {
            const node = makeNode(attribs);
            reserve(liveNode(scope), names, node);
            frames.push({ openedAt: depth, level, node, counted: true, topLevel: false });
          }
        } else if (itemTypeOf(attribs) === null) {
          counts.errors += 1;
          frames.push({ openedAt: depth, level: 1, node: null, counted: false, topLevel: false });
        } else {
          frames.push({ openedAt: depth, level: 1, node: makeNode(attribs), counted: true, topLevel: true });
        }
        return;
      }

      if (names === null || scope === undefined || !scope.counted) return;
      if (!spend()) return;
      const node = liveNode(scope);
      const value = attributeValue(name, attribs);
      if (value !== undefined) {
        reserve(node, names, value);
        return;
      }
      collectors.push({
        openedAt: depth,
        slots: reserve(node, names, ""),
        parts: [],
        length: 0,
        pendingSpace: false,
        full: false,
      });
      unfullCollectors += 1;
    },

    text(t) {
      if (unfullCollectors === 0) return;
      for (let i = 0; i < t.length && unfullCollectors > 0; i += TEXT_WINDOW) {
        const collapsed = t.slice(i, i + TEXT_WINDOW).replace(/\s+/g, " ");
        for (const collector of collectors) {
          if (collector.full) continue;
          appendCollapsed(collector, collapsed);
          if (collector.full) unfullCollectors -= 1;
        }
      }
    },

    close,

    end() {
      // Innermost first, by the depth each opened at; the outermost item
      // closes last, after everything it contains.
      for (;;) {
        const c = collectors[collectors.length - 1]?.openedAt ?? -1;
        const f = frames[frames.length - 1]?.openedAt ?? -1;
        if (c < 0 && f < 0) return;
        close(Math.max(c, f));
      }
    },
  };
}
