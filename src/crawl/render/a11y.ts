/**
 * The accessibility run of the render pass (Phase 29b, render capture 3):
 * a pinned axe-core, a fixed WCAG A/AA rule subset, and the shaping of what it
 * finds into the rows `render_a11y` stores.
 *
 * WHAT RUNS. axe-core 4.14.0, exactly (package.json pins it without a caret),
 * unmodified (MPL-2.0; THIRD_PARTY_NOTICES.md), loaded from the package's own
 * `axe.min.js` (`axeSource`). It runs the 24 rules of `A11Y_RULES` and nothing
 * else (`AXE_RUN_OPTIONS.runOnly`), reports violations only, and is asked for
 * CSS selectors and no element references, ancestry or XPath. The benchmark is
 * WCAG 2.x through axe's own tags — a web standard, not any engine's list.
 *
 * WHERE IT RUNS (controller ruling A). In the render's ISOLATED WORLD of the
 * main frame (`RenderTraffic.runAxe`, renderer.ts): the page's DOM, its own
 * JavaScript globals. A page that replaced `Array.prototype.map`, `Promise` or
 * `Node.prototype.contains` changes nothing axe sees, which is how the browser
 * extensions that run axe do it. The expression evaluated there
 * (`axeRunExpression`) injects the source and runs it in ONE evaluation, so
 * axe never runs against a document other than the one it was injected into.
 *
 * WHEN. After phase 2 of `render` — the document is serialised and analysed
 * first (ruling R10), so a hung axe can never block `page.content()` and every
 * other measurement is already taken whatever axe does.
 *
 * HOW IT ENDS (`RenderA11y.status`, ruling R3 widened by ruling B):
 *  - `ran` — axe finished; `violations` are what it found, `[]` is "none".
 *  - `disabled` — the crawl's `renderAccessibility` is false.
 *  - `timeout` — not finished in `AXE_TIMEOUT_MS`; the renderer sent
 *    `Runtime.terminateExecution` and kept everything else.
 *  - `interrupted` — the page's document went away under it: the page
 *    navigated (its execution context was destroyed) or its target closed.
 *  - `error` — axe threw or rejected inside the page; `error` holds the first
 *    line. A page can make that happen through its DOM, so it is the page's
 *    fact on the row, never a stopped pass.
 * What stops the pass is only what is clearly OURS: the CDP session gone while
 * the render is open, the package file unreadable, or `shapeAxeResults`
 * meeting a result shape it does not know.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { storableText } from "../storable-text.js";

/** The time one page's axe run may take before it is terminated (ruling R10). */
export const AXE_TIMEOUT_MS = 30_000;
/**
 * How long, after `Runtime.terminateExecution`, the renderer waits for the
 * page's thread to answer one trivial evaluation (`RenderTraffic.terminateAxe`)
 * before it moves on. With `AXE_TIMEOUT_MS` it bounds the whole axe step, and
 * the render lease counts both (`renderLeaseSeconds`, run-render.ts).
 */
export const AXE_TERMINATE_GRACE_MS = 5_000;
/** Selectors kept per violated rule; `nodeCount` still counts every element. */
export const A11Y_TARGETS_MAX = 5;
/** Each kept selector is cut to this many UTF-16 units (`storableText`). */
export const A11Y_TARGET_CHARS = 200;
/** The first line of an axe error is cut to this many (`render_a11y_error`). */
export const A11Y_ERROR_CHARS = 500;

/**
 * One rule of the subset: its axe id, the group it is reported under, the
 * severity Ariadne gives it — axe 4.14.0's declared impact, critical or
 * serious → `warning`, moderate or minor → `info` — and its WCAG level.
 */
export interface A11yRuleRow {
  axeId: string;
  group: string;
  severity: "warning" | "info";
  wcag: "A" | "AA";
}

/**
 * The pinned subset, in report order. Task 7 writes one rule per row.
 *
 * Only rules that give a VERDICT belong here: the run stores violations only,
 * so a rule axe reports as "needs review" could never fire. That is why
 * `duplicate-id-aria` is not in the subset (Phase 29b Task 8): axe-core 4.14.0
 * declares it `reviewOnFail`, so every failure comes back `incomplete`, and the
 * WCAG criterion it tested, 4.1.1 Parsing, was removed in WCAG 2.2.
 * test/crawl/a11y.test.ts reads the pinned package and fails if any row here is
 * `reviewOnFail` or disabled by default.
 */
export const A11Y_RULES: readonly A11yRuleRow[] = [
  { group: "Text alternatives", axeId: "image-alt", severity: "warning", wcag: "A" },
  { group: "Text alternatives", axeId: "input-image-alt", severity: "warning", wcag: "A" },
  { group: "Text alternatives", axeId: "role-img-alt", severity: "warning", wcag: "A" },
  { group: "Text alternatives", axeId: "area-alt", severity: "warning", wcag: "A" },
  { group: "Text alternatives", axeId: "object-alt", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "link-name", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "button-name", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "input-button-name", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "select-name", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "label", severity: "warning", wcag: "A" },
  { group: "Names", axeId: "frame-title", severity: "warning", wcag: "A" },
  { group: "Language", axeId: "document-title", severity: "warning", wcag: "A" },
  { group: "Language", axeId: "html-has-lang", severity: "warning", wcag: "A" },
  { group: "Language", axeId: "html-lang-valid", severity: "warning", wcag: "A" },
  { group: "Language", axeId: "valid-lang", severity: "warning", wcag: "AA" },
  { group: "Behaviour", axeId: "meta-viewport", severity: "info", wcag: "AA" },
  { group: "Behaviour", axeId: "meta-refresh", severity: "warning", wcag: "A" },
  { group: "ARIA", axeId: "aria-hidden-focus", severity: "warning", wcag: "A" },
  { group: "ARIA", axeId: "aria-required-attr", severity: "warning", wcag: "A" },
  { group: "ARIA", axeId: "aria-valid-attr", severity: "warning", wcag: "A" },
  { group: "ARIA", axeId: "aria-valid-attr-value", severity: "warning", wcag: "A" },
  { group: "Structure", axeId: "list", severity: "warning", wcag: "A" },
  { group: "Structure", axeId: "listitem", severity: "warning", wcag: "A" },
  { group: "Contrast", axeId: "color-contrast", severity: "warning", wcag: "AA" },
];

const SUBSET: ReadonlySet<string> = new Set(A11Y_RULES.map((r) => r.axeId));

/** The options `axe.run` is called with: the subset, violations only, selectors only. */
export const AXE_RUN_OPTIONS = {
  runOnly: { type: "rule", values: A11Y_RULES.map((r) => r.axeId) },
  resultTypes: ["violations"],
  iframes: false,
  elementRef: false,
  selectors: true,
  ancestry: false,
  xpath: false,
} as const;

/** One violated rule on one page, as a `render_a11y` row stores it. */
export interface A11yViolation {
  /** The axe rule id, one of `A11Y_RULES`. */
  rule: string;
  /** axe's impact for the rule on this page, or null when it gave none. */
  impact: string | null;
  /** Every element that failed the rule. */
  nodeCount: number;
  /** The selectors of the first `A11Y_TARGETS_MAX`, each storable and cut. */
  targets: string[];
}

export type A11yStatus = "ran" | "disabled" | "timeout" | "interrupted" | "error";

/**
 * One page's accessibility run, as the page row stores it
 * (`render_a11y_status`, `_ms`, `_error`) beside its `render_a11y` rows.
 * `RenderResult.a11y` is null on a failed render: nothing was run.
 */
export interface RenderA11y {
  status: A11yStatus;
  /** Wall time of the run (injection included); null exactly when `disabled`. */
  ms: number | null;
  /** The first line of what axe threw; non-null exactly when `error`. */
  error: string | null;
  /** Non-empty only when `ran`. */
  violations: A11yViolation[];
}

/** The run a crawl with `renderAccessibility: false` records. */
export function a11yDisabled(): RenderA11y {
  return { status: "disabled", ms: null, error: null, violations: [] };
}

let memoisedSource: string | null = null;

/**
 * The pinned `axe.min.js`, read from the package once per process and kept.
 * A file that cannot be read throws — ours, and it stops the pass.
 */
export function axeSource(): string {
  if (memoisedSource === null) {
    const path = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
    memoisedSource = readFileSync(path, "utf8");
  }
  return memoisedSource;
}

/**
 * The ONE expression the isolated world evaluates: the axe source, then the
 * run, its result cut down THERE to what `shapeAxeResults` reads — per rule
 * its id, its impact, `nodeCount` (every failing element) and the targets of
 * the first `A11Y_TARGETS_MAX` nodes only — so what crosses the protocol is
 * bounded by the subset, never by the page's size, and the checks' messages
 * and HTML snippets never cross at all.
 *
 * `fault` is `RenderTestFaults.axeFault`: in place of the run, a rejection,
 * still in the isolated world after the source was injected — the shape of an
 * axe the page made throw. `{error: m}` rejects with `new Error(m)`;
 * `{value: v}` rejects with the bare value `v` (a page can make a library
 * reject with a string as easily as with an Error). `{ownNoise: m}` is not a
 * rejection: the isolated world logs `console.error(m)` and schedules an
 * uncaught `throw new Error(m)` that lands while axe runs, and then the run
 * proceeds as normal — the shape of axe's own console output, which must
 * never be counted as the site's (29b final review M1).
 */
export function axeRunExpression(fault: AxeFault | null = null): string {
  const normal = `axe.run(document, ${JSON.stringify(AXE_RUN_OPTIONS)}).then(function (r) {
  return { violations: r.violations.map(function (v) {
    return {
      id: v.id,
      impact: v.impact,
      nodeCount: v.nodes.length,
      nodes: v.nodes.slice(0, ${A11Y_TARGETS_MAX}).map(function (n) { return { target: n.target }; })
    };
  }) };
})`;
  let run: string;
  if (fault === null) run = normal;
  else if ("error" in fault) run = `Promise.reject(new Error(${JSON.stringify(fault.error)}))`;
  else if ("value" in fault) run = `Promise.reject(${JSON.stringify(fault.value)})`;
  else {
    const noise = JSON.stringify(fault.ownNoise);
    run =
      `(console.error(${noise}), ` +
      `setTimeout(function () { throw new Error(${noise}); }, 0), ${normal})`;
  }
  return `${axeSource()}\n;${run}`;
}

/**
 * TEST ONLY — how `axeRunExpression` stands in for an axe the page made throw,
 * or (`ownNoise`) for an axe that writes to the console as it runs.
 */
export type AxeFault = { error: string } | { value: string } | { ownNoise: string };

function shapeError(what: string): Error {
  return new Error(`unknown axe result shape: ${what} — the pinned axe-core answered something this reader does not know`);
}

/** One node's target as one selector: a shadow DOM path joined with ` >>> `. */
function targetSelector(target: unknown, rule: string): string {
  // `iframes: false`, so the frame path is one entry: the element's own.
  if (!Array.isArray(target) || target.length !== 1) {
    throw shapeError(`a ${rule} node's target is not a one-entry array`);
  }
  const only: unknown = target[0];
  if (typeof only === "string") return only;
  if (Array.isArray(only) && only.length > 0 && only.every((s) => typeof s === "string")) {
    return (only as string[]).join(" >>> ");
  }
  throw shapeError(`a ${rule} node's target is neither a selector nor a shadow path`);
}

/**
 * An axe result — `axe.run`'s whole object, or the cut-down one
 * `axeRunExpression` returns (with `nodeCount` and at most
 * `A11Y_TARGETS_MAX` nodes) — as `render_a11y` rows: one per violated rule,
 * in axe's order, each with its node count and the first `A11Y_TARGETS_MAX`
 * selectors through `storableText(…, A11Y_TARGET_CHARS)`.
 *
 * Only `violations` is read. Throws on any shape it does not know — a
 * non-array, a rule outside the subset (`runOnly` was not honoured), a rule
 * twice, a violation with no node, a `nodeCount` that is not an integer or
 * disagrees with the nodes sent, an iframe path — because each of those is
 * the pinned package answering differently from what this code was written
 * against: ours, never the page's.
 */
export function shapeAxeResults(raw: unknown): A11yViolation[] {
  if (typeof raw !== "object" || raw === null) throw shapeError("the result is not an object");
  const violations = (raw as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) throw shapeError("`violations` is not an array");
  const seen = new Set<string>();
  return violations.map((v: unknown): A11yViolation => {
    if (typeof v !== "object" || v === null) throw shapeError("a violation is not an object");
    const { id, impact, nodes, nodeCount } = v as {
      id?: unknown;
      impact?: unknown;
      nodes?: unknown;
      nodeCount?: unknown;
    };
    if (typeof id !== "string") throw shapeError("a violation has no rule id");
    if (!SUBSET.has(id)) throw shapeError(`rule ${JSON.stringify(id)} is outside the subset`);
    if (seen.has(id)) throw shapeError(`rule ${id} is reported twice`);
    seen.add(id);
    if (impact !== null && impact !== undefined && typeof impact !== "string") {
      throw shapeError(`rule ${id}'s impact is not text`);
    }
    if (!Array.isArray(nodes)) throw shapeError(`rule ${id}'s nodes are not an array`);
    if (nodes.length === 0) throw shapeError(`rule ${id} is a violation with no node`);
    // The cut-down wire shape counts in-world and sends the first targets
    // only; `axe.run`'s own object has neither the count nor the cut. The two
    // must agree with each other, or the count is not this run's.
    let count = nodes.length;
    if (nodeCount !== undefined) {
      if (typeof nodeCount !== "number" || !Number.isInteger(nodeCount)) {
        throw shapeError(`rule ${id}'s nodeCount is not an integer`);
      }
      if (nodes.length !== Math.min(nodeCount, A11Y_TARGETS_MAX)) {
        throw shapeError(`rule ${id} sent ${nodes.length} nodes for a nodeCount of ${nodeCount}`);
      }
      count = nodeCount;
    }
    const targets = nodes.map((n: unknown) => {
      if (typeof n !== "object" || n === null || !("target" in n)) {
        throw shapeError(`a ${id} node has no target`);
      }
      return targetSelector((n as { target: unknown }).target, id);
    });
    return {
      rule: id,
      impact: typeof impact === "string" ? impact : null,
      nodeCount: count,
      targets: targets.slice(0, A11Y_TARGETS_MAX).map((t) => storableText(t, A11Y_TARGET_CHARS).text),
    };
  });
}

/** The first line of an axe error, storable and cut, for `render_a11y_error`. */
export function a11yErrorLine(message: string): string {
  const first = (message.split("\n")[0] ?? message).trim();
  return storableText(first, A11Y_ERROR_CHARS).text;
}
