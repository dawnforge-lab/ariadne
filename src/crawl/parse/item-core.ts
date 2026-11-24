/**
 * The machinery microdata and RDFa Lite share (Phase 29a): the item / value
 * stores, the bounded text collectors, the per-page value budget, the
 * depth-identity frame stack and block emission at item close. A format
 * machine (microdata.ts, rdfa.ts) decides WHICH element is an item or a value
 * and what its names and value are; this module does the rest, so the two
 * cannot drift apart on budgets, caps, ordering or error handling.
 *
 * Frames and text collectors close by the `elementDepth` they opened at (the
 * analyzer's `hiddenOpenedAt` idiom), never by tag name. A top-level item is
 * handed to the sink when it CLOSES. See microdata.ts for the semantics each
 * format maps onto this.
 *
 * MEMORY. Bounded by the budget: at most `MAX_ITEM_VALUES` values per page,
 * each text value at most `MICRODATA_TEXT_MAX` (+ one window) characters, and
 * the frame stacks are bounded by the open-element depth. Finalising a node
 * recurses at most `MAX_ITEM_DEPTH` levels and writes at most
 * `MAX_ITEM_VALUES` values and `MAX_ITEM_WRITTEN_CHARS` characters per page
 * (`valuesWritten`, `charsWritten`), so a value held under several names
 * cannot multiply the output.
 */
import { storableCap } from "../storable-text.js";
import type {
  StructuredDataBlock,
  StructuredDataFormat,
  StructuredDataSkips,
} from "./page-analyzer.js";
import { SCHEMA_ORG_CONTEXT } from "./schema-names.js";

/** Characters kept per text value, applied with `storableCap`. */
export const MICRODATA_TEXT_MAX = 500;
/** Property values kept per page, across microdata and RDFa (`counts.valuesUsed`). */
export const MAX_ITEM_VALUES = 1000;
/** Nested item levels; the top-level item is level 1. */
export const MAX_ITEM_DEPTH = 32;
/**
 * Characters written into finished nodes per page, across microdata and RDFa
 * (`counts.charsWritten`): 2 Mi, the fetcher's MAX_BODY, so markup written
 * once always fits and only copies of a value held under several names can
 * reach it. Attribute values, ids, types and names are not cut to
 * `MICRODATA_TEXT_MAX`, so the value count alone does not bound the output.
 */
export const MAX_ITEM_WRITTEN_CHARS = 2 * 1024 * 1024;

/** Where a finished top-level node goes; the analyzer's sink owns the 50-block cap. */
export type BlockSink = (block: StructuredDataBlock) => void;

/** A streaming extractor driven from the analyzer's tokenizer hooks. */
export interface ItemMachine {
  open(name: string, attribs: Record<string, string>, depth: number): void;
  text(t: string): void;
  close(depth: number): void;
  /** Called after the tokenizer has closed every element; throws if a frame is still open. */
  end(): void;
}

/**
 * The per-page counters every item machine writes to. One object per page,
 * shared by the microdata and RDFa machines: `valuesUsed` is the shared
 * `MAX_ITEM_VALUES` budget, `errors` the one structural-error counter.
 */
export interface StructuredDataCounts {
  errors: number;
  skips: StructuredDataSkips;
  valuesUsed: number;
  /**
   * Values written into finished nodes, across both machines, capped at
   * `MAX_ITEM_VALUES` like `valuesUsed`. It differs from `valuesUsed` only
   * when one value is held under several names (see `finalize`).
   */
  valuesWritten: number;
  /** Characters written with those values, capped at `MAX_ITEM_WRITTEN_CHARS` (see `finalize`). */
  charsWritten: number;
}

/** Raw text is collapsed this many characters at a time, so a huge text node is never copied whole. */
const TEXT_WINDOW = 4096;

type Value = string | ItemNode;

/** A type list as `@type` stores it: one name as a string, two or more as an array, none as null. */
export function typeValue(names: readonly string[]): string | readonly string[] | null {
  if (names.length === 0) return null;
  return names.length === 1 ? names[0]! : names;
}

/** The first type name: what `schema_type` holds. */
function firstType(type: string | readonly string[]): string {
  return typeof type === "string" ? type : type[0]!;
}

/** The characters a type spends from the write budget. */
function typeChars(type: string | readonly string[] | null): number {
  if (type === null) return 0;
  return typeof type === "string" ? type.length : type.reduce((n, t) => n + t.length, 0);
}

export interface ItemNode {
  /**
   * Every type token in document order, deduplicated: a string for one, an
   * array only for two or more, null for none (extraction 5, Phase 29d).
   */
  type: string | readonly string[] | null;
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

export function resolveUrl(value: string, pageUrl: string): string {
  try {
    return new URL(value, pageUrl).href;
  } catch {
    // Not a resolvable URL: stored as written, for the rules to judge.
    return value;
  }
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

/**
 * The plain JSON-LD-shaped object for a node; `@context` on the top-level node
 * only. A value held under several names is written once per name, so
 * without a cap nested items under K names D levels deep would write K^D
 * nodes from D values of budget, and one long attribute under K names would be
 * written K times. So every value written spends one of `counts.valuesWritten`
 * (capped at `MAX_ITEM_VALUES`) and its characters from `counts.charsWritten`
 * (capped at `MAX_ITEM_WRITTEN_CHARS`): the property name plus the string, or
 * plus a nested node's type and id (its own values charge themselves). The
 * first value that does not fit ends writing for the page: it and every value
 * after it are dropped and counted in `skips.valuesCapped`. A property left
 * with no value is omitted.
 */
function finalize(node: ItemNode, topLevel: boolean, counts: StructuredDataCounts): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  if (topLevel) entries.push(["@context", SCHEMA_ORG_CONTEXT]);
  if (node.type !== null) entries.push(["@type", typeof node.type === "string" ? node.type : [...node.type]]);
  if (node.id !== null) entries.push(["@id", node.id]);
  for (const [name, values] of node.props) {
    const out: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      const chars =
        name.length + (typeof v === "string" ? v.length : typeChars(v.type) + (v.id?.length ?? 0));
      if (counts.valuesWritten >= MAX_ITEM_VALUES || counts.charsWritten + chars > MAX_ITEM_WRITTEN_CHARS) {
        // Full: nothing more is written on this page.
        counts.charsWritten = MAX_ITEM_WRITTEN_CHARS;
        counts.skips.valuesCapped += values.length - i;
        break;
      }
      counts.valuesWritten += 1;
      counts.charsWritten += chars;
      out.push(typeof v === "string" ? v : finalize(v, false, counts));
    }
    if (out.length > 0) entries.push([name, out.length === 1 ? out[0] : out]);
  }
  // Defined, never assigned: a property named `__proto__` stays an own key.
  return Object.fromEntries(entries);
}

export interface ItemCore {
  /** Whether an item is open: the enclosing scope for the element being opened. */
  hasScope(): boolean;
  /**
   * An item element. Nested (a property of the enclosing item) when `names`
   * is non-null and a scope exists; else a top-level item, which needs
   * `hasType`, or it is an error and a dead scope. `makeNode` builds the node.
   */
  openItem(
    depth: number,
    names: readonly string[] | null,
    hasType: boolean,
    makeNode: () => ItemNode,
  ): void;
  /** An item that contributes nothing and under which properties attach to nothing, uncounted. */
  openDead(depth: number): void;
  /**
   * A property element that is not an item: one value from the budget, held
   * as `value`, or collected from the element's text when `value` is
   * undefined. A no-op without names or a counted scope.
   */
  openValue(depth: number, names: readonly string[] | null, value: string | undefined): void;
  text(t: string): void;
  close(depth: number): void;
  end(): void;
}

/** The shared store for one format machine; `format` names it in output and errors. */
export function createItemCore(
  format: "microdata" | "rdfa",
  sink: BlockSink,
  counts: StructuredDataCounts,
): ItemCore {
  const frames: Frame[] = [];
  const collectors: TextCollector[] = [];
  let unfullCollectors = 0;
  const blockFormat: StructuredDataFormat = format;

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
      throw new Error(`${format}: a counted item with value budget left has no node`);
    }
    return frame.node;
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
    if (node.type === null) throw new Error(`${format}: a top-level item has no type`);
    sink({ type: firstType(node.type), format: blockFormat, raw: finalize(node, true, counts) });
  };

  return {
    hasScope: () => frames.length > 0,

    openItem(depth, names, hasType, makeNode) {
      const scope = frames[frames.length - 1];
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
          const node = makeNode();
          reserve(liveNode(scope), names, node);
          frames.push({ openedAt: depth, level, node, counted: true, topLevel: false });
        }
      } else if (!hasType) {
        counts.errors += 1;
        frames.push({ openedAt: depth, level: 1, node: null, counted: false, topLevel: false });
      } else {
        frames.push({ openedAt: depth, level: 1, node: makeNode(), counted: true, topLevel: true });
      }
    },

    openDead(depth) {
      const scope = frames[frames.length - 1];
      frames.push({
        openedAt: depth,
        level: scope === undefined ? 1 : scope.level + 1,
        node: null,
        counted: false,
        topLevel: false,
      });
    },

    openValue(depth, names, value) {
      const scope = frames[frames.length - 1];
      if (names === null || scope === undefined || !scope.counted) return;
      if (!spend()) return;
      const node = liveNode(scope);
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

    close(depth) {
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
    },

    end() {
      // htmlparser2's `onend` has closed every element, so an open frame here
      // is depth drift between the analyzer and this machine: never recovered
      // from quietly (hard rule 7).
      if (frames.length > 0 || collectors.length > 0) {
        throw new Error(
          `${format}: end() with ${frames.length} item frame(s) and ${collectors.length} text collector(s) still open (depth drift)`,
        );
      }
    },
  };
}
