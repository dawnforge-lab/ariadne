import {
  finding,
  isAuditable,
  pageRule,
  parseRobotsDate,
  robotsTokens,
  unavailableAfterOf,
} from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";
import { RESTRICTIVE_DIRECTIVES, UNAVAILABLE_AFTER_WARN_DAYS } from "../thresholds.js";

const CATEGORY = "indexability";
const DAY_MS = 86_400_000;

/**
 * All three keep the fetched-OK cohort (`isAuditable`), as `indexability.noindex`
 * does: they are facts about any served page, and a judged-cohort gate would
 * silence the rules on exactly the pages they are about (a `none` page is not
 * indexable).
 *
 * Every directive is compared as a WHOLE TOKEN (`robotsTokens`), never as a
 * substring: `nofollowing` is not `nofollow`, `noimageindexer` is not
 * `noimageindex` and `max-snippet:-1` (no limit) is not `max-snippet:0`.
 * A bot prefix is ignored, consistent with `saysNoindex`; bot-specific
 * directives are 26b's job.
 */

/** The tokens of both robots channels, meta first, each channel in source order. */
function tokensOf(p: PageRecord): { meta: string[]; header: string[] } {
  return { meta: robotsTokens(p.robotsMeta), header: robotsTokens(p.xRobotsTag) };
}

const says = (tokens: string[], ...wanted: string[]): boolean =>
  tokens.some((t) => wanted.includes(t));

export const directiveRules: PageRule[] = [
  // `nofollow` (or `none`, which is noindex plus nofollow) tells engines to
  // ignore every outgoing link of the page. Often deliberate on user-generated
  // or login pages; a warning because on an ordinary page it starves the pages
  // it links to of internal equity and discovery.
  pageRule(
    "indexability.nofollow",
    ["CHECK-04"],
    CATEGORY,
    "warning",
    [
      { key: "robotsMeta", label: "Meta Robots" },
      { key: "xRobotsTag", label: "X-Robots-Tag" },
      { key: "source", label: "Directive Source" },
    ],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const { meta, header } = tokensOf(p);
      const inMeta = says(meta, "nofollow", "none");
      const inHeader = says(header, "nofollow", "none");
      if (!inMeta && !inHeader) return [];
      const source = inMeta && inHeader ? "both" : inMeta ? "meta" : "header";
      return [finding(self, p, { source, robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag })];
    },
  ),

  // Directives that keep the page indexed but narrow what a result may show.
  // Easy to leave behind after a launch or a copy-paste from another template.
  pageRule(
    "directives.restrictive",
    ["CHECK-04"],
    CATEGORY,
    "warning",
    [{ key: "directives", label: "Restrictive Directives" }],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const { meta, header } = tokensOf(p);
      const restrictive: readonly string[] = RESTRICTIVE_DIRECTIVES;
      const matched = [...new Set([...meta, ...header].filter((t) => restrictive.includes(t)))];
      return matched.length > 0 ? [finding(self, p, { directives: matched })] : [];
    },
  ),

  // The page leaves the index on a date. Judged against the page's own
  // `fetched_at`, so re-judging an old crawl gives the same answer. A date that
  // does not parse fires too: Google ignores a directive it cannot parse, so
  // the page is not leaving the index when its author thinks it is. The date is
  // read by `parseRobotsDate` (ISO 8601 and the RFC 822 / 850 / 1123 forms,
  // nothing else), never by `Date.parse`; a zone-less ISO form is read as UTC
  // and the evidence carries `assumedUtc: true`.
  pageRule(
    "directives.unavailable-after",
    ["CHECK-04"],
    CATEGORY,
    "warning",
    [
      { key: "unavailableAfter", label: "Unavailable After" },
      { key: "dateParsed", label: "Date Parsed" },
      { key: "daysFromFetch", label: "Days From Fetch" },
      { key: "assumedUtc", label: "Assumed UTC", optional: true },
    ],
    (p, self) => {
      // A fetched-OK page always has a `fetched_at`; null is a row from before
      // migration 0016, which has no time to judge the date against.
      if (!isAuditable(p) || p.fetchedAt === null) return [];
      const dates = [unavailableAfterOf(p.robotsMeta), unavailableAfterOf(p.xRobotsTag)]
        .filter((d): d is string => d !== null)
        .map((raw) => ({ raw, parsed: parseRobotsDate(raw) }));
      if (dates.length === 0) return [];

      const unparsed = dates.find((d) => d.parsed === null);
      if (unparsed) {
        return [finding(self, p, { unavailableAfter: unparsed.raw, dateParsed: false })];
      }
      const parsed = dates.map((d) => ({ raw: d.raw, ...d.parsed! }));
      // The earliest date wins: the page is gone from the moment either source
      // says so.
      const earliest = parsed.reduce((a, b) => (b.at < a.at ? b : a));
      const fetched = p.fetchedAt.getTime();
      if (earliest.at >= fetched + UNAVAILABLE_AFTER_WARN_DAYS * DAY_MS) return [];
      return [
        finding(self, p, {
          unavailableAfter: earliest.raw,
          dateParsed: true,
          ...(earliest.assumedUtc ? { assumedUtc: true } : {}),
          daysFromFetch: Math.floor((earliest.at - fetched) / DAY_MS),
        }),
      ];
    },
  ),
];
