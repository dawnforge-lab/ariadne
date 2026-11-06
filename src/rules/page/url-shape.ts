import { finding, isJudged, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";
import { INTERNAL_SEARCH_PARAMS, INTERNAL_SEARCH_PATH } from "../thresholds.js";

/**
 * URL shape (Phase 26a, CHECK-30 and CHECK-67). Seven page rules over the PATH
 * of the stored `pages.url`; the query, the host and the scheme are never read
 * (`?utm_source=X` and `https://Example.com/` fire nothing). The one exception
 * is `url.internal-search`, whose subject is the query keys.
 *
 * The cohort is `isJudged`, as `url.too-long` has it: a URL shape is a fault of
 * a page that is meant to be indexed.
 *
 * THE STORED FORM IS `normalizeUrl` OUTPUT, which is `new URL(...).toString()`:
 * it keeps case, underscores and `//` exactly as linked, and it
 * percent-encodes a space (`%20`) and a non-ASCII character (UTF-8 bytes, upper
 * case hex). So every shape below survives to the rule, and the encoded form is
 * the one `url.non-ascii` and `url.spaces` meet in practice; the literal-
 * character branches stay because a rule that judges a path should not depend
 * on who normalised it.
 *
 * A URL that does not parse THROWS (hard rule 7). Every stored URL went through
 * `normalizeUrl`, so one that does not is a corrupt row, and a rule that
 * skipped it would be a silent hole.
 */

/** The percent-escapes of a path, whose hex digits are not letters of the URL. */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;

function pathOf(p: PageRecord): string {
  return new URL(p.url).pathname;
}

/**
 * The first run of segments that is immediately repeated, as the run joined
 * with `/`, or null. Empty segments are dropped first, so `//` neither makes
 * nor hides a repeat. Shorter runs are tried first, then earlier positions, so
 * `/a/a/a/a` reports `a`. Comparison is exact: `/Shop/shop` is not a repeat.
 */
function repeatedRun(path: string): string | null {
  const segments = path.split("/").filter((s) => s !== "");
  for (let len = 1; len * 2 <= segments.length; len++) {
    for (let i = 0; i + len * 2 <= segments.length; i++) {
      let same = true;
      for (let k = 0; k < len; k++) {
        if (segments[i + k] !== segments[i + len + k]) {
          same = false;
          break;
        }
      }
      if (same) return segments.slice(i, i + len).join("/");
    }
  }
  return null;
}

/** A path rule: fires when `test(path)` and writes `{ path }` as its evidence. */
function pathRule(
  id: string,
  severity: "info" | "warning",
  test: (path: string) => boolean,
): PageRule {
  return pageRule(
    id,
    ["CHECK-30"],
    "url",
    severity,
    [{ key: "path", label: "URL Path" }],
    (p, self) => {
      if (!isJudged(p)) return [];
      const path = pathOf(p);
      return test(path) ? [finding(self, p, { path })] : [];
    },
  );
}

export const urlShapeRules: PageRule[] = [
  // Letters only: the hex of `%C3%A9` is not an upper-case URL.
  pathRule("url.uppercase", "info", (path) => /[A-Z]/.test(path.replace(PERCENT_ESCAPE, ""))),

  pathRule("url.underscores", "info", (path) => path.includes("_")),

  // A character above U+007F, or an escaped byte of 0x80 or more (the UTF-8
  // bytes of any non-ASCII character), in either hex case.
  pathRule("url.non-ascii", "info", (path) => /[^\x00-\x7f]|%[89a-f][0-9a-f]/i.test(path)),

  // A space only: `%20` or a literal one. A `+` in a PATH is a literal plus
  // (`/c++-guide`); it means a space only in a form-encoded query string.
  pathRule("url.spaces", "warning", (path) => /%20| /.test(path)),

  pathRule("url.multiple-slashes", "warning", (path) => path.includes("//")),

  pageRule(
    "url.repetitive-path",
    ["CHECK-30"],
    "url",
    "warning",
    [
      { key: "path", label: "URL Path" },
      { key: "repeated", label: "Repeated Segments" },
    ],
    (p, self) => {
      if (!isJudged(p)) return [];
      const path = pathOf(p);
      const repeated = repeatedRun(path);
      return repeated === null ? [] : [finding(self, p, { path, repeated })];
    },
  ),

  // The query is read by KEY, whole and case-sensitively, through
  // URLSearchParams so an escaped key is decoded first. `param` is the first
  // matching key in the URL's order, and the key is omitted (optional column)
  // when only the path matched.
  pageRule(
    "url.internal-search",
    ["CHECK-67"],
    "url",
    "warning",
    [
      { key: "path", label: "URL Path" },
      { key: "param", label: "Search Parameter", optional: true },
    ],
    (p, self) => {
      if (!isJudged(p)) return [];
      const url = new URL(p.url);
      const keys: readonly string[] = INTERNAL_SEARCH_PARAMS;
      let param: string | null = null;
      for (const key of url.searchParams.keys()) {
        if (keys.includes(key)) {
          param = key;
          break;
        }
      }
      if (param === null && !INTERNAL_SEARCH_PATH.test(url.pathname)) return [];
      return [
        finding(self, p, param === null ? { path: url.pathname } : { path: url.pathname, param }),
      ];
    },
  ),
];
