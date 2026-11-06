/**
 * The Phase 26a calibration ladders: pages built to sit on either side of a
 * threshold, crawled by Screaming Frog and by Ariadne in the same run so the
 * first rung each tool flags can be read off (scripts/calibrate-sf.ts, report
 * in docs/gates/phase-26a-calibration.md).
 *
 * THESE ARE NOT HARNESS FIXTURES. `allFixtures()` does not include them and
 * nothing asserts their findings: a ladder exists to be crawled once by two
 * tools and compared, and the rung that fires depends on the threshold being
 * calibrated, so pinning it here would pin the answer the run is meant to give.
 * Each page's `expectedIssues` is therefore empty and none is `exact`.
 *
 * The ladders (spec "Calibration", plan Task 13):
 *
 *  - **title pixel width:** 12 rungs from 150 to 600 px in even steps, plus
 *    bracket rungs a few pixels either side of each starting bound;
 *  - **description pixel width:** 12 rungs from 300 to 1,050 px, plus brackets;
 *  - **outlinks:** internal 50 … 1,001 distinct targets, external 10 … 101;
 *  - **response time:** the handler waits 250 … 3,000 ms before the first byte;
 *  - **click depth:** a chain 1 … 10 links below the hub.
 *
 * Every width is computed with the same `serpWidth` the pixel rules call, so a
 * rung's width in our measure is known exactly; Screaming Frog's own width for
 * the same string is read from its export, and the report sets the two side by
 * side.
 *
 * Every page starts from the control recipe (one `<h1>`, sections, a self
 * canonical) so the only thing that varies along a ladder is the measured
 * quantity.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Fixture } from "../fixture.js";
import { serpWidth } from "../../../src/rules/serp-width.js";
import { article, serve } from "../render.js";

/** Every calibration path starts with this, so the report can tell them apart. */
export const CALIBRATION_PREFIX = "/calib26";

/** The even title ladder: 12 rungs, 150 … 600 px. */
export const TITLE_PX_LADDER: readonly number[] = evenSteps(150, 600, 12);
/** The even description ladder: 12 rungs, 300 … 1,050 px. */
export const META_PX_LADDER: readonly number[] = evenSteps(300, 1050, 12);

/**
 * Bracket rungs: the starting bounds (561 / 200 title, 985 / 400 description,
 * the values `src/rules/thresholds.ts` shipped with before this calibration)
 * and three and one pixels either side. Literal numbers rather than the
 * constants on purpose: these rungs probe the STARTING values, and must not
 * move if the calibration moves the constants.
 */
const BRACKET_OFFSETS = [-3, -1, 0, 1, 3] as const;
/**
 * The title brackets, and six rungs below the upper one (540 … 556 px in our
 * measure). Those six were added after the first run: Screaming Frog measured
 * our titles up to twelve pixels WIDER than `serpWidth` does, so no rung landed
 * between its last unflagged width (524) and its first flagged one (568), and
 * the bound could not be read off. Rungs a little narrower in our measure land
 * in that gap in its.
 */
export const TITLE_PX_BRACKETS: readonly number[] = [
  ...[200, 561].flatMap((b) => BRACKET_OFFSETS.map((o) => b + o)),
  540,
  545,
  550,
  552,
  554,
  556,
];
export const META_PX_BRACKETS: readonly number[] = [400, 985].flatMap((b) =>
  BRACKET_OFFSETS.map((o) => b + o),
);

/** Distinct internal link targets per internal outlink rung. */
export const INTERNAL_OUTLINK_LADDER: readonly number[] = [50, 100, 150, 200, 300, 500, 750, 1000, 1001];
/**
 * Distinct external link targets per external outlink rung: the plan's
 * 10, 25, 50, 75, 100, 101, and every count from 11 to 24 between the first
 * two, because the first run found Screaming Frog's boundary there (10 not
 * flagged, 25 flagged) and a ladder that cannot name the rung is not a
 * calibration.
 */
export const EXTERNAL_OUTLINK_LADDER: readonly number[] = [
  10,
  ...Array.from({ length: 14 }, (_, i) => 11 + i),
  25,
  50,
  75,
  100,
  101,
];
/** Milliseconds each response-time rung waits before its first byte. */
export const RESPONSE_TIME_LADDER: readonly number[] = [250, 500, 1000, 1500, 2000, 3000];
/** The click-depth chain's length: rung k is k links below the hub. */
export const DEPTH_CHAIN_LENGTH = 10;

/** The page every internal rung links to, once per `?n=`. */
export const OUTLINK_TARGET_PATH = `${CALIBRATION_PREFIX}/target`;

/**
 * The external targets. The same addresses the `/authored26/high-outlinks`
 * fixture links, so the external rungs add no address a crawler that checks
 * external links has not already been given: rung N links targets 1 … N.
 */
export function externalTarget(i: number): string {
  return `https://example.com/outlink/${i}`;
}

function evenSteps(from: number, to: number, count: number): number[] {
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round((from + i * step) * 10) / 10);
}

/** Words the width builder draws on: plain English, nothing a rule reads. */
const WORD_BANK =
  "measured line of plain text that grows by one word at a time until it reaches the width this rung was built to have and then stops".split(
    " ",
  );

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * A string whose `serpWidth` lands within half a pixel of `target`.
 *
 * Words from the bank are appended to `prefix` while there is comfortably more
 * room than one long word needs; the last stretch is one more "word" of
 * letters chosen by a small search over letter advances (sums kept at 0.05 px
 * resolution, at most 14 letters) for the total nearest the target. The result
 * is measured with `serpWidth` and THROWS if it is not within half a pixel or
 * has no width at all: a rung whose width is not the one its label claims would
 * be a ladder that lies about where it is.
 */
export function textOfWidth(prefix: string, target: number, kind: "title" | "description"): string {
  const width = (s: string): number => {
    const w = serpWidth(s, kind);
    if (w === null) throw new Error(`calibration: no width for ${JSON.stringify(s)}`);
    return w;
  };
  let base = prefix;
  for (let i = 0; ; i++) {
    const word = WORD_BANK[i % WORD_BANK.length]!;
    if (width(`${base} ${word}`) > target - 60) break;
    base = `${base} ${word}`;
  }
  const remaining = target - width(`${base} `);
  const advance = new Map<string, number>();
  for (const ch of LETTERS) advance.set(ch, width(ch.repeat(20)) / 20);

  // reachable sum (in 0.05 px units) -> the letters that reach it
  let frontier = new Map<number, string>([[0, ""]]);
  const all = new Map<number, string>();
  for (let step = 0; step < 14; step++) {
    const next = new Map<number, string>();
    for (const [units, letters] of frontier) {
      for (const ch of LETTERS) {
        const sum = units / 20 + advance.get(ch)!;
        if (sum > remaining + 0.5) continue;
        const key = Math.round(sum * 20);
        if (!all.has(key) && !next.has(key)) next.set(key, letters + ch);
      }
    }
    for (const [k, v] of next) all.set(k, v);
    frontier = next;
    if (frontier.size === 0) break;
  }
  let best: string | undefined;
  let bestErr = Infinity;
  for (const letters of all.values()) {
    const err = Math.abs(width(`${base} ${letters}`) - target);
    if (err < bestErr) {
      bestErr = err;
      best = letters;
    }
  }
  if (best === undefined || bestErr > 0.5) {
    throw new Error(
      `calibration: could not build a ${kind} of ${target} px from ${JSON.stringify(prefix)} (best error ${bestErr})`,
    );
  }
  return `${base} ${best}`;
}

/** The control recipe's body, labelled so no two rungs share a heading. */
function body(label: string, extraHtml = ""): string {
  return (
    article({
      h1: `Calibration page: ${label}`,
      lede: "This page is one rung of a ladder built to find the point where an audit starts to report a measured quantity. Everything else about it is in order.",
      withImage: false,
      sections: [
        {
          h2: "What this page is for",
          body: "A ladder is a set of pages that differ in one measured quantity and in nothing else. Two crawlers read every rung, and the first rung each of them reports is where that crawler draws its line, which is how a threshold nobody published can still be read off.",
        },
        {
          h2: "What stays the same",
          body: "The headings, the canonical link, the length of the text and the shape of the document are the same on every rung. Only the quantity named in the heading above changes from one page to the next, so a finding that appears on one rung and not on the one below it is about that quantity alone.",
        },
        {
          h2: "Where the result goes",
          body: "The rungs each crawler reports are compared side by side in the calibration report of the gate, together with the measured value of every rung, and a threshold is set from the boundary the comparison shows.",
        },
      ],
    }) + extraHtml
  );
}

const DESCRIPTION =
  "One rung of a calibration ladder: a page that is in order except for the one measured quantity its heading names, which changes from rung to rung.";

function page(
  path: string,
  name: string,
  build: (req: IncomingMessage, res: ServerResponse) => void,
  rest: Pick<Fixture, "linkedFromHub" | "inSitemap"> = {},
): Fixture {
  return { path, category: "calibration", name, expectedIssues: [], ...rest, handler: build };
}

function pad(i: number): string {
  return String(i + 1).padStart(2, "0");
}

/** One ladder rung per title width: the even ladder, then the brackets. */
function titleRungs(): Fixture[] {
  return [...TITLE_PX_LADDER, ...TITLE_PX_BRACKETS].map((target, i) => {
    const title = textOfWidth(`Title rung ${pad(i)}`, target, "title");
    return page(
      `${CALIBRATION_PREFIX}/title-px/${pad(i)}`,
      `Title ${serpWidth(title, "title")} px (target ${target})`,
      (req, res) =>
        serve(req, res, () => ({
          title,
          metaDescription: DESCRIPTION,
          bodyHtml: body(`title width rung ${pad(i)}`),
        })),
    );
  });
}

/** One ladder rung per description width: the even ladder, then the brackets. */
function metaRungs(): Fixture[] {
  return [...META_PX_LADDER, ...META_PX_BRACKETS].map((target, i) => {
    const description = textOfWidth(`Description rung ${pad(i)}`, target, "description");
    return page(
      `${CALIBRATION_PREFIX}/meta-px/${pad(i)}`,
      `Description ${serpWidth(description, "description")} px (target ${target})`,
      (req, res) =>
        serve(req, res, () => ({
          title: `Calibration ladder, description width rung ${pad(i)}`,
          metaDescription: description,
          bodyHtml: body(`description width rung ${pad(i)}`),
        })),
    );
  });
}

function outlinkRungs(): Fixture[] {
  const internal = INTERNAL_OUTLINK_LADDER.map((n) =>
    page(`${CALIBRATION_PREFIX}/outlinks/internal/${n}`, `${n} distinct internal outlinks`, (req, res) =>
      serve(req, res, () => ({
        title: `Calibration ladder, ${n} distinct internal links`,
        metaDescription: DESCRIPTION,
        bodyHtml: body(
          `${n} internal links`,
          `\n<p>${Array.from(
            { length: n },
            (_, i) => `<a href="${OUTLINK_TARGET_PATH}?n=${i + 1}">Ladder target ${i + 1}</a>`,
          ).join(" ")}</p>`,
        ),
      })),
    ),
  );
  const external = EXTERNAL_OUTLINK_LADDER.map((n) =>
    page(`${CALIBRATION_PREFIX}/outlinks/external/${n}`, `${n} distinct external outlinks`, (req, res) =>
      serve(req, res, () => ({
        title: `Calibration ladder, ${n} distinct external links`,
        metaDescription: DESCRIPTION,
        bodyHtml: body(
          `${n} external links`,
          `\n<p>${Array.from(
            { length: n },
            (_, i) => `<a href="${externalTarget(i + 1)}">Reference number ${i + 1}</a>`,
          ).join(" ")}</p>`,
        ),
      })),
    ),
  );
  return [...internal, ...external];
}

/**
 * The page every internal rung links to, answered for any `?n=`. Deliberately
 * small: a thousand rungs' worth of full articles would be a thousand
 * near-duplicates of one template for the rule engine to pair up, and nothing
 * about these pages is under test. It is thin, and both tools may say so.
 */
const outlinkTarget: Fixture = page(
  OUTLINK_TARGET_PATH,
  "Internal outlink ladder target",
  (req, res) => {
    const n = new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "none";
    serve(req, res, () => ({
      title: `Calibration outlink target number ${n}`,
      metaDescription: `Target ${n} of the internal outlink ladder. It exists so each rung has distinct addresses to link to, and says nothing else.`,
      bodyHtml: `<h1>Outlink target ${n}</h1>\n<p>A page one rung of the outlink ladder links to.</p>`,
    }));
  },
  // Reached only through the rungs: the hub must not link the bare path, and a
  // sitemap entry would seed a page no rung asked for.
  { linkedFromHub: false, inSitemap: false },
);

function responseTimeRungs(): Fixture[] {
  return RESPONSE_TIME_LADDER.map((ms) =>
    page(`${CALIBRATION_PREFIX}/slow/${ms}`, `Responds after ${ms} ms`, (req, res) =>
      serve(
        req,
        res,
        () => ({
          title: `Calibration ladder, response after ${ms} milliseconds`,
          metaDescription: DESCRIPTION,
          bodyHtml: body(`a ${ms} ms response`),
        }),
        { delayMs: ms },
      ),
    ),
  );
}

/**
 * The chain: the hub links rung 1 and rung k links rung k+1, so rung k is k
 * clicks below the hub. Not in the sitemap, which would seed every rung at
 * depth 0 in Ariadne's frontier (see absorbed.ts, the deep click-path).
 */
function depthRungs(): Fixture[] {
  return Array.from({ length: DEPTH_CHAIN_LENGTH }, (_, i) => {
    const level = i + 1;
    const next =
      level < DEPTH_CHAIN_LENGTH
        ? `\n<p><a href="${CALIBRATION_PREFIX}/depth/${level + 1}">Go one level deeper, to level ${level + 1}</a></p>`
        : "";
    return page(
      `${CALIBRATION_PREFIX}/depth/${level}`,
      `Click depth ${level}`,
      (req, res) =>
        serve(req, res, () => ({
          title: `Calibration ladder, ${level} clicks below the home page`,
          metaDescription: DESCRIPTION,
          bodyHtml: body(`click depth ${level}`, next),
        })),
      { linkedFromHub: level === 1, inSitemap: false },
    );
  });
}

/** The pagination probe's two pages: A names B as next, B declares no prev. */
export const NO_PREV_A = `${CALIBRATION_PREFIX}/pagination/no-prev-a`;
export const NO_PREV_B = `${CALIBRATION_PREFIX}/pagination/no-prev-b`;

/**
 * Not a ladder: a probe for one carried question. `pagination.sequence-error`
 * fires when A's `rel=next` is B and B has NO `rel=prev` at all, as well as
 * when B's `rel=prev` names another page (the harness fixture
 * `/authored26/seq-*` is that second case). This pair is the first case alone,
 * so the report can say whether Screaming Frog treats a missing prev as a
 * sequence error. Both pages are linked from the hub, so both are crawled.
 */
function noPrevProbe(): Fixture[] {
  return [
    page(NO_PREV_A, "Pagination probe: page 1, rel=next to page 2", (req, res) =>
      serve(req, res, (self) => ({
        title: "Calibration probe, first page of a series without rel=prev",
        metaDescription: DESCRIPTION,
        headExtra: `<link rel="next" href="${new URL(NO_PREV_B, self).href}">`,
        bodyHtml: body("pagination page 1 of 2", `\n<p><a href="${NO_PREV_B}">Page 2</a></p>`),
      })),
    ),
    page(NO_PREV_B, "Pagination probe: page 2, no rel=prev", (req, res) =>
      serve(req, res, () => ({
        title: "Calibration probe, second page of a series without rel=prev",
        metaDescription: DESCRIPTION,
        bodyHtml: body("pagination page 2 of 2", `\n<p><a href="${NO_PREV_A}">Page 1</a></p>`),
      })),
    ),
  ];
}

/** The hreflang probe: a page whose ONE alternate (`en`) names itself, no `x-default`. */
export const SELF_ONLY_SINGLE = `${CALIBRATION_PREFIX}/hreflang/self-only-single`;

/**
 * Not a ladder: a probe for one question the analysis-on run left. The harness
 * fixture `/authored26/hreflang-self-only` names itself under `en` AND under
 * `x-default`, and Screaming Frog's "Self Reference Only" stayed empty on it
 * with its post-crawl analysis on. This page names itself once, under `en`
 * only, so the report can say whether the `x-default` is what keeps it out.
 */
function selfOnlyProbe(): Fixture {
  return page(SELF_ONLY_SINGLE, "Hreflang probe: one alternate, to itself", (req, res) =>
    serve(req, res, (self) => ({
      title: "Calibration probe, a page whose only alternate is itself",
      metaDescription: DESCRIPTION,
      headExtra: `<link rel="alternate" hreflang="en" href="${self}">`,
      bodyHtml: body("hreflang self reference only"),
    })),
  );
}

/** Every calibration page. Not part of `allFixtures()`; see the header. */
export function calibrationFixtures(): Fixture[] {
  return [
    ...titleRungs(),
    ...metaRungs(),
    ...outlinkRungs(),
    outlinkTarget,
    ...responseTimeRungs(),
    ...depthRungs(),
    ...noPrevProbe(),
    selfOnlyProbe(),
  ];
}
