import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { A11Y_RULES } from "../../src/crawl/render/a11y.js";
import {
  COPY_TEMPLATES,
  ISSUE_COPY,
  copyFor,
  renderCopy,
} from "../../src/rules/registry/copy/index.js";
import {
  DEFAULT_THRESHOLDS,
  OVERRIDABLE_THRESHOLDS,
  type ThresholdName,
} from "../../src/rules/threshold-table.js";

type Entry = { title: string; explanation: string; howToFix: string };

// Rules removed after 0.22.0: their entry stays in the frozen fixture and is
// dropped from the comparison, named here so an accidental removal still fails.
const REMOVED_SINCE_0_22 = ["schema.product-incomplete"]; // Phase 29a T6

// The text committed at ruleset 0.22.0, before copy became a template.
const FIXTURE_FILE: Record<string, Entry> = JSON.parse(
  readFileSync(new URL("./__fixtures__/issue-copy-0.22.json", import.meta.url), "utf8"),
);

const FIXTURE: Record<string, Entry> = Object.fromEntries(
  Object.entries(FIXTURE_FILE).filter(([id]) => !REMOVED_SINCE_0_22.includes(id)),
);
// The frozen file must still carry what is declared removed.
for (const id of REMOVED_SINCE_0_22) {
  if (!(id in FIXTURE_FILE)) throw new Error(`REMOVED_SINCE_0_22 names '${id}', absent from the fixture`);
}

const OLD_EXPL = "the sitemaps were only partly read because a size, entry, file-count or nesting limit was reached, or a page";
const NEW_EXPL = "the sitemaps were only partly read because a size, entry, file-count, nesting or time limit was reached or the crawl stopped or failed while re-reading or re-recording them, or a page";
const OLD_TAIL = "after a sitemap that could not be read those checks did run,";
const NEW_TAIL = "a time limit means the sitemap walk spent its whole 10-minute budget, usually on sitemaps that are slow to generate; an interruption means the crawl stopped or failed while re-reading or re-recording the sitemaps, and resuming it to the end, or re-crawling, reads them in full; after a sitemap that could not be read those checks did run,";
const OLD_FIX = "where the sitemaps were only partly read, split any sitemap over 50 MB into smaller files; where a page";
const NEW_FIX = "where the sitemaps were only partly read, split any sitemap over 50 MB into smaller files; where the sitemap walk ran out of time (Sitemap Time Limit Reached), find the slow sitemaps, make them quicker to serve (cache or pre-generate them) and re-crawl when the site answers faster; where the sitemap walk was interrupted (Sitemap Walk Interrupted), resume the crawl to the end or re-crawl; where a page";

const FIELDS = ["title", "explanation", "howToFix"] as const;

// Rules added after 0.22.0 have no entry in the fixture, which is frozen text.
// Each is named here, so a rule that is missing from the fixture by accident
// still fails the key comparison below.
const ADDED_SINCE_0_22 = [
  "crawl.list-mode", // 0.24.0, Phase 27c
  // 0.26.0, Phase 29a T7: the per-node schema rules.
  "schema.parse-error",
  "schema.unknown-type",
  "schema.unknown-property",
  "schema.property-pending-or-superseded",
  "schema.embedded-type-mismatch",
  "schema.template-inconsistent", // 0.26.0, Phase 29a T8
  // 0.26.0, 29a rework (2026-11-16): two standards rules and the coverage metric;
  // the three Google rules of T7 are gone.
  "schema.empty-value",
  "schema.unresolved-reference",
  "schema.property-coverage",
  // 0.27.0, Phase 29b T5: the render console rules (CHECK-51).
  "render.js-exception",
  "render.console-error",
  "render.failed-request",
  // 0.27.0, Phase 29b T6: the oversized image rule and its metric (CHECK-49).
  "images.larger-than-displayed",
  "render.image-measurement",
  // 0.27.0, Phase 29b T7: the render family's marker, and the accessibility
  // rules (25, then 24 once Task 8 dropped duplicate-id-aria), named from the table they are generated from (CHECK-89).
  "render.not-recorded",
  ...A11Y_RULES.map((r) => `a11y.${r.axeId}`),
  // 0.28.0, Phase 29c T3: the link score distribution (CHECK-33).
  "links.score-distribution",
];
// Entries whose text was deliberately changed after 0.22.0: the fields that
// differ from the fixture, spelled out so any other drift still fails.
const CHANGED_SINCE_0_22: Record<string, Partial<Entry>> = {
  // 0.26.0, Phase 29a T8: microdata and RDFa are read, and self-serving reviews walk the Organization hierarchy.
  // 0.26.0, 29a final review M3: the none-on-site title and opening name all three formats.
  // 0.26.0, 29a rework: no rich results; validate against schema.org, not one engine's test.
  "schema.none-on-site": {
    title: "Structured data: No structured data on the site",
    explanation: FIXTURE["schema.none-on-site"]!.explanation
      .replace(
        "No page in the crawl carries JSON-LD.",
        "No page in the crawl carries JSON-LD, microdata or RDFa, the three formats that are read.",
      )
      .replace(" Only JSON-LD is read; microdata and RDFa are not detected.", "")
      .replace("read to build rich results and cite sources.", "read to understand a page and cite it."),
    howToFix: FIXTURE["schema.none-on-site"]!.howToFix.replace(
      "Validate with the Rich Results Test.",
      "Check each block with the schema.org validator (validator.schema.org).",
    ),
  },
  // 0.26.0, 29a final review: breadcrumb-absent names all three formats it reads, like none-on-site.
  // 0.26.0, 29a rework review M4: the second sentence cites schema.org, for every consumer.
  "schema.breadcrumb-absent": {
    explanation: FIXTURE["schema.breadcrumb-absent"]!.explanation
      .replace(
        "no page carries BreadcrumbList JSON-LD.",
        "no page carries a BreadcrumbList in JSON-LD, microdata or RDFa, the three formats that are read.",
      )
      .replace(
        "Breadcrumb markup lets search results show the path to a page and tells search engines how sections relate.",
        "A schema.org BreadcrumbList states in machine-readable form the path to a page and how the site's sections relate, for every consumer of the markup, search engines and agents alike.",
      ),
  },
  // 0.26.0, 29a final review M7: the Organization branch includes directory and booking sites.
  // 0.26.0, 29a rework: the fact, not a search engine's policy — title, policy sentence and fix.
  "schema.self-serving-reviews": {
    title: "Structured data: Organization or LocalBusiness markup rating itself",
    explanation: FIXTURE["schema.self-serving-reviews"]!.explanation
      .replace(
        "typed exactly Organization or LocalBusiness carries a rating or reviews about the business itself.",
        "typed Organization or any of its subtypes (LocalBusiness, Restaurant, …) carries a rating or reviews (aggregateRating or review) about the business itself.",
      )
      .replace(
        " Google's review snippet policy treats these as self-serving and does not show the stars.",
        " In schema.org a rating or review on a node is about that node, so the business's own markup rates the business.",
      )
      .concat(
        " Because every Organization subtype is matched, a directory, booking or review site that marks up ratings of businesses it does not own is listed too; those ratings are of other businesses, and the finding can be dismissed on such a site.",
      ),
    howToFix:
      "Check what the ratings are about. If they rate a product or service, move them to the Product, Service or Course node they describe; if they rate the business, decide whether the business's own pages should state them.",
  },
  // 0.25.0, Phase 27d: the sitemap walk's time budget, and a stop during a re-walk, are causes of "partly read".
  "hreflang.declarations-incomplete": {
    explanation: FIXTURE["hreflang.declarations-incomplete"]!.explanation
      .replace(OLD_EXPL, NEW_EXPL)
      .replace(OLD_TAIL, NEW_TAIL),
    howToFix: FIXTURE["hreflang.declarations-incomplete"]!.howToFix.replace(OLD_FIX, NEW_FIX),
  },
};
const expected = (id: string): Entry => ({ ...FIXTURE[id]!, ...CHANGED_SINCE_0_22[id] });

describe("copy rendering (27a T4)", () => {
  it("renders every entry at the defaults exactly as 0.22.0 wrote it", () => {
    const withoutAdded = (o: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(o).filter(([id]) => !ADDED_SINCE_0_22.includes(id)));
    expect(Object.keys(COPY_TEMPLATES).sort()).toEqual(
      [...Object.keys(FIXTURE), ...ADDED_SINCE_0_22].sort(),
    );
    for (const id of Object.keys(FIXTURE)) {
      expect(renderCopy(id, DEFAULT_THRESHOLDS), id).toEqual(expected(id));
      expect(copyFor(id), id).toEqual(expected(id));
    }
    expect(withoutAdded(ISSUE_COPY)).toEqual(
      Object.fromEntries(Object.keys(FIXTURE).map((id) => [id, expected(id)])),
    );
  });

  it("only names overridable thresholds in placeholders", () => {
    for (const [id, c] of Object.entries(COPY_TEMPLATES)) {
      for (const f of FIELDS) {
        for (const m of c[f].matchAll(/\{([^}]*)\}/g)) {
          const name = m[1]!.replace(/:n$/, "");
          expect(name in OVERRIDABLE_THRESHOLDS, `${id}.${f} names unknown '${m[1]}'`).toBe(true);
        }
      }
    }
  });

  // Every rule whose title carries an overridable threshold's number, and the
  // placeholder it must use (":n" where the default is written with a comma).
  const IN_TITLE: Record<string, [ThresholdName, boolean]> = {
    "title.too-short": ["TITLE_MIN", false],
    "title.too-long": ["TITLE_MAX", false],
    "meta-description.too-short": ["META_MIN", false],
    "meta-description.too-long": ["META_MAX", false],
    "headings.h1-too-long": ["H1_MAX", false],
    "h2.too-long": ["H2_MAX", false],
    "url.too-long": ["URL_MAX", false],
    "content.thin": ["THIN_WORDS", false],
    "performance.slow-response": ["SLOW_MS", false],
    "structure.deep-page": ["DEEP_DEPTH", false],
    "images.oversized": ["IMAGE_WEIGHT_WARN", true],
    "images.legacy-format": ["IMAGE_WEIGHT_WARN", true],
    "directives.unavailable-after": ["UNAVAILABLE_AFTER_WARN_DAYS", false],
    "content.soft-404": ["SOFT_404_WORDS", false],
    "redirect.chain": ["CHAIN_HOPS", false],
    "links.high-outlinks": ["HIGH_INTERNAL_OUTLINKS", true],
    "title.pixel-too-long": ["TITLE_PX_MAX", false],
    "title.pixel-too-short": ["TITLE_PX_MIN", false],
    "meta-description.pixel-too-long": ["META_PX_MAX", false],
    "meta-description.pixel-too-short": ["META_PX_MIN", false],
  };

  it.each(Object.entries(IN_TITLE))("%s title follows its threshold", (id, [name, comma]) => {
    const shown = comma ? "7,777" : "7777";
    const title = renderCopy(id, { ...DEFAULT_THRESHOLDS, [name]: 7777 }).title;
    expect(title).toContain(shown);
  });

  it("follows HIGH_EXTERNAL_OUTLINKS in the high-outlinks copy", () => {
    const c = renderCopy("links.high-outlinks", { ...DEFAULT_THRESHOLDS, HIGH_EXTERNAL_OUTLINKS: 7777 });
    expect(c.title).toContain("7777 external");
    expect(c.explanation).toContain("more than 7777 different external");
    expect(c.explanation).toContain("7777 is a review threshold");
  });

  it("renders an override into the explanation", () => {
    const c = renderCopy("title.too-long", { ...DEFAULT_THRESHOLDS, TITLE_MAX: 50 });
    expect(c.explanation).toContain("50 characters");
    expect(c.explanation).not.toContain("60 characters");
  });

  it("throws, naming the rule and the placeholder, on an unknown placeholder", () => {
    COPY_TEMPLATES["test.bad-name"] = { title: "t {NOPE}", explanation: "e", howToFix: "f" };
    try {
      expect(() => renderCopy("test.bad-name", DEFAULT_THRESHOLDS)).toThrow(/test\.bad-name.*NOPE/);
    } finally {
      delete COPY_TEMPLATES["test.bad-name"];
    }
  });

  it("throws on a malformed placeholder left after substitution", () => {
    COPY_TEMPLATES["test.bad-form"] = { title: "t {TITLE_MAX:x}", explanation: "e", howToFix: "f" };
    try {
      expect(() => renderCopy("test.bad-form", DEFAULT_THRESHOLDS)).toThrow(/test\.bad-form.*TITLE_MAX:x/);
    } finally {
      delete COPY_TEMPLATES["test.bad-form"];
    }
  });

  it("throws on a rule with no copy", () => {
    expect(() => renderCopy("no.such-rule", DEFAULT_THRESHOLDS)).toThrow(/no\.such-rule/);
  });
});
