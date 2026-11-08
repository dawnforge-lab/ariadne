import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "../../src/rules/index.js";
import { TRUNCATED_LABEL } from "../../src/api/csv.js";
import { STANDARD_ISSUE_COLUMNS } from "../../src/api/service.js";
import {
  AGENT_CHECKS,
  CRAWL_CHECK_IDS,
  defineRule,
  expandList,
  perScope,
  perScopeMeasure,
  Registry,
  RULESET_VERSION,
  RuleDefinitionError,
  type PageRule,
  type Severity,
} from "../../src/rules/registry/registry.js";

const validPageRule = {
  kind: "page" as const,
  id: "title.missing",
  checkIds: ["CHECK-35"],
  category: "on-page" as const,
  severity: "warning" as const,
  title: "Missing title",
  explanation: "The page has no <title> element.",
  howToFix: "Add a unique, descriptive <title>.",
  rulesetVersion: RULESET_VERSION,
  columns: [{ key: "title", label: "Title 1" }],
  run: () => [],
};

/** The metric-rule twin of `validPageRule`: the smallest metric that ships. */
const validMetricRule = {
  kind: "metric" as const,
  id: "site.health",
  checkIds: ["CHECK-83"],
  category: "crawl" as const,
  severity: "info" as const,
  title: "Site: Health rollup",
  explanation: "A table of counts.",
  howToFix: "Read it.",
  rulesetVersion: RULESET_VERSION,
  table: perScope("Scope", [{ key: "urlsTotal", label: "Pages Judged" }]),
  run: async () => [],
};

/**
 * `defineRule` returns a rule that finds as a NEW object carrying its triage
 * (src/rules/registry/triage.ts; `title.missing` is issue / high there), and
 * leaves the definition it was given untouched.
 */
const triaged = <R extends object>(rule: R) => ({ ...rule, type: "issue", priority: "high" });

describe("defineRule", () => {
  it("accepts a well-formed rule", () => {
    expect(defineRule(validPageRule)).toEqual(triaged(validPageRule));
    expect(validPageRule).not.toHaveProperty("type");
  });
  it("throws on empty checkIds", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: [] }))
      .toThrow(RuleDefinitionError);
  });
  it("throws on malformed id", () => {
    expect(() => defineRule({ ...validPageRule, id: "Title Missing!" }))
      .toThrow(RuleDefinitionError);
  });
  it("throws on missing client copy", () => {
    expect(() => defineRule({ ...validPageRule, howToFix: "" }))
      .toThrow(RuleDefinitionError);
  });

  // The message assertions below pin each case to the specific validation branch
  // it is meant to exercise, so a future change cannot make them pass for the
  // wrong reason (e.g. tripping the id check instead of the checkId check).
  it("throws on a checkId with too few digits", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-5"] }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-5"] }))
      .toThrow(/bad checkId 'CHECK-5'/);
  });
  it("throws on a lowercase checkId", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["check-05"] }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, checkIds: ["check-05"] }))
      .toThrow(/bad checkId 'check-05'/);
  });
  it("throws on a checkId that is valid alongside an invalid one", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-35", "CHECK-999"] }))
      .toThrow(/bad checkId 'CHECK-999'/);
  });
  it("throws on a severity outside the allowed set", () => {
    expect(() => defineRule({ ...validPageRule, severity: "high" as Severity }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, severity: "high" as Severity }))
      .toThrow(/bad severity/);
  });
  it("throws when run is not a function", () => {
    const notAFunction = { ...validPageRule, run: "nope" as unknown as PageRule["run"] };
    expect(() => defineRule(notAFunction)).toThrow(RuleDefinitionError);
    expect(() => defineRule(notAFunction)).toThrow(/run must be a function/);
  });
  it("accepts a checkId with a letter suffix", () => {
    const suffixed = { ...validPageRule, checkIds: ["CHECK-38a"] };
    expect(defineRule(suffixed)).toEqual(triaged(suffixed));
  });
  it("throws on an unknown kind", () => {
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(/bad kind 'cosmic'/);
  });
  it("accepts a marker flag carrying a reason", () => {
    const marked = { ...validPageRule, marker: "a crawl condition the check cannot judge" };
    // A marker is warning / low (triage.ts); `title.missing`'s own row is not.
    const markerRow = () => ({ type: "warning" as const, priority: "low" as const });
    expect(defineRule(marked, markerRow)).toEqual({ ...marked, ...markerRow() });
  });
  it("throws on a present-but-empty marker flag — a flag with no reason", () => {
    expect(() => defineRule({ ...validPageRule, marker: "   " }))
      .toThrow(/marker, when present, must be a non-empty reason string/);
  });
  // ---------------------------------------------------------------- columns
  //
  // `RuleMeta.columns` is the rule's REPORT — the evidence fields a reader sees
  // and the heading each is printed under. What `defineRule` can hold is the
  // SHAPE; whether a declared key is a key the rule actually writes is a
  // question about a run, and test/fixtures/harness.test.ts answers it over a
  // real crawl in both directions.
  it("accepts an EMPTY column list — a report that is the standard columns and nothing else", () => {
    const bare = { ...validPageRule, columns: [] };
    expect(defineRule(bare)).toEqual(triaged(bare));
  });
  it("throws when a rule that finds declares no columns at all", () => {
    const { columns: _dropped, ...columnless } = validPageRule;
    expect(() => defineRule(columnless as typeof validPageRule))
      .toThrow(/columns is required on a rule that finds/);
  });
  it("throws on a column with no key or no label — a heading nobody can print", () => {
    expect(() => defineRule({ ...validPageRule, columns: [{ key: "  ", label: "Title 1" }] }))
      .toThrow(/non-empty key naming an evidence field/);
    expect(() => defineRule({ ...validPageRule, columns: [{ key: "title", label: "" }] }))
      .toThrow(/needs a non-empty label/);
  });
  it("throws on a column that repeats a key", () => {
    expect(() =>
      defineRule({
        ...validPageRule,
        columns: [
          { key: "title", label: "Title 1" },
          { key: "title", label: "Title" },
        ],
      }),
    ).toThrow(/declared twice/);
  });
  // The five keys the surface itself prints: `address`, `statusCode`,
  // `indexability` and `indexabilityStatus` are derived from the page row and
  // prepended to every rule's list, and `pageUrl` is `address` under the name
  // `runRules` writes it. A rule declaring one would print two columns under
  // one heading, filled from two different sources.
  it("throws on a column that claims a standard heading", () => {
    for (const key of ["address", "statusCode", "indexability", "indexabilityStatus", "pageUrl"]) {
      expect(
        () => defineRule({ ...validPageRule, columns: [{ key, label: "Mine" }] }),
        key,
      ).toThrow(/standard column the surface already prints/);
    }
  });
  // A HEADING IS AS UNIQUE AS A KEY, and unlike a duplicate key it is invisible
  // in the JSON: only the printed report — the CSV header, the demo's table —
  // has headings, so two columns under one word is a table whose reader cannot
  // tell which column is which.
  it("throws on two columns that share a heading", () => {
    expect(() =>
      defineRule({
        ...validPageRule,
        columns: [
          { key: "title", label: "Title 1" },
          { key: "titleLength", label: "title 1" },
        ],
      }),
    ).toThrow(/repeats the heading 'title 1'/);
  });
  // The other end of the reservation above: a rule may not print a heading the
  // SURFACE prints. `Truncated` is there for the same reason from a different
  // file — the `issue_urls` CSV always ends with that column.
  it("throws on a column headed like one the surface prints itself", () => {
    for (const label of [
      "Address",
      "Status Code",
      "Indexability",
      "Indexability Status",
      "Truncated",
      // Case and padding do not save it: a header collision is what the eye
      // sees, not what `===` sees.
      " status code ",
    ]) {
      expect(
        () => defineRule({ ...validPageRule, columns: [{ key: "mine", label }] }),
        label,
      ).toThrow(/which the surface prints itself/);
    }
  });
  it("throws on an `optional` that is not exactly true", () => {
    expect(() =>
      defineRule({
        ...validPageRule,
        columns: [{ key: "title", label: "Title 1", optional: false as unknown as true }],
      }),
    ).toThrow(/must be exactly true/);
  });
  it("refuses columns on a metric rule, which writes no finding row to head", () => {
    const metric = {
      kind: "metric" as const,
      id: "site.health",
      checkIds: ["CHECK-83"],
      category: "crawl" as const,
      severity: "info" as const,
      title: "Site: Health rollup",
      explanation: "A table of counts.",
      howToFix: "Read it.",
      rulesetVersion: RULESET_VERSION,
      table: perScope("Scope", [{ key: "urlsTotal", label: "Pages Judged" }]),
      run: async () => [],
    };
    expect(defineRule(metric)).toBe(metric);
    expect(() =>
      defineRule({ ...metric, columns: [{ key: "n", label: "N" }] } as unknown as typeof metric),
    ).toThrow(/a metric rule declares no columns/);
  });

  // THE MIRROR OF THE TEST ABOVE, one field along: `columns` is required on a
  // rule that finds and refused on a metric; `table` is required on a metric and
  // refused on a rule that finds. Neither kind may be silent about its report.
  it("requires a table on a metric rule and refuses one on a rule that finds", () => {
    const { table: _table, ...tableless } = validMetricRule;
    expect(() => defineRule(tableless as unknown as typeof validMetricRule)).toThrow(
      /must declare its `table`/,
    );
    expect(() =>
      defineRule({
        ...validPageRule,
        table: perScope("Scope", [{ key: "n", label: "N" }]),
      } as unknown as typeof validPageRule),
    ).toThrow(/only a metric rule declares a `table`/);
  });

  it("throws on a metric column with no key, or a heading used twice in one table", () => {
    const withTable = (table: unknown): unknown => ({ ...validMetricRule, table });
    expect(() =>
      defineRule(withTable(perScope("Scope", [{ key: "  ", label: "Pages" }])) as never),
    ).toThrow(/needs a non-empty key/);
    expect(() =>
      defineRule(withTable(perScope("Scope", [{ key: "urlsTotal", label: " " }])) as never),
    ).toThrow(/needs a non-empty label/);
    // Twice in the value columns...
    expect(() =>
      defineRule(
        withTable(
          perScope("Scope", [
            { key: "urlsTotal", label: "Pages" },
            { key: "urlsClean", label: " pages " },
          ]),
        ) as never,
      ),
    ).toThrow(/repeats the heading/);
    // ...and against the SCOPE column's own heading, which the surface writes.
    expect(() =>
      defineRule(withTable(perScope("Scope", [{ key: "urlsTotal", label: "scope" }])) as never),
    ).toThrow(/repeats the heading/);
    // ...and against a SUMMARY label, because the CSV writes both in one header.
    expect(() =>
      defineRule(
        withTable(
          expandList(
            "topParams",
            [{ key: "name", label: "Parameter" }],
            [{ key: "totalParams", label: "Parameter" }],
          ),
        ) as never,
      ),
    ).toThrow(/repeats the heading/);
  });

  it("throws on a metric column that takes a key this surface writes itself", () => {
    for (const key of ["scope", "measure"]) {
      expect(() =>
        defineRule({
          ...validMetricRule,
          table: perScope("Scope", [{ key, label: "Mine" }]),
        } as never),
        key,
      ).toThrow(/a key this surface writes itself/);
    }
  });

  // A merged list whose rows carry nothing saying which list they came from is
  // `inlinks.extremes` with its `List` column deleted: forty rows of URLs, the
  // most-linked and the least-linked indistinguishable.
  it("throws on merged lists with no tag, and on a tag no column prints", () => {
    expect(() =>
      defineRule({
        ...validMetricRule,
        table: expandList(
          [{ field: "top" }, { field: "bottom" }],
          [{ key: "url", label: "Address" }],
        ),
      } as never),
    ).toThrow(/carries no tag/);
    expect(() =>
      defineRule({
        ...validMetricRule,
        table: expandList(
          [
            { field: "top", tag: { key: "list", value: "Most linked" } },
            { field: "bottom", tag: { key: "list", value: "Least linked" } },
          ],
          [{ key: "url", label: "Address" }],
        ),
      } as never),
    ).toThrow(/not one of this table's columns/);
  });

  it("throws on a perScopeMeasure with no measures, or two measures under one label", () => {
    expect(() =>
      defineRule({
        ...validMetricRule,
        table: perScopeMeasure("Template", [], [{ key: "count", label: "Pages" }]),
      } as never),
    ).toThrow(/needs at least one measure/);
    expect(() =>
      defineRule({
        ...validMetricRule,
        table: perScopeMeasure(
          "Template",
          [
            { key: "wordCount", label: "Words" },
            { key: "renderableWordCount", label: "words" },
          ],
          [{ key: "count", label: "Pages" }],
        ),
      } as never),
    ).toThrow(/repeats the label/);
  });

  it("RuleDefinitionError is recognizable by name", () => {
    try {
      defineRule({ ...validPageRule, id: "BAD ID" });
      throw new Error("no throw");
    } catch (e) {
      expect((e as Error).name).toBe("RuleDefinitionError");
    }
  });
});

describe("Registry", () => {
  it("loads zero rules without error and reports full unclaimed list", () => {
    const r = new Registry();
    expect(r.all()).toEqual([]);
    expect(r.unclaimedChecks(["CHECK-35", "CHECK-38"], ["CHECK-38"]))
      .toEqual(["CHECK-35"]);
  });
  it("rejects duplicate rule ids", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(() => r.register(validPageRule)).toThrow(RuleDefinitionError);
  });
  it("claims checks through registered rules", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(r.unclaimedChecks(["CHECK-35"], [])).toEqual([]);
  });
  it("byKind narrows and filters", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(r.byKind("page").map((x) => x.id)).toEqual(["title.missing"]);
    expect(r.byKind("query")).toEqual([]);
  });
});

describe("check universe", () => {
  it("exports the crawl-derived check universe and agent list", () => {
    expect(CRAWL_CHECK_IDS).toHaveLength(47);
    expect(CRAWL_CHECK_IDS).toContain("CHECK-33b");
    expect(AGENT_CHECKS).toEqual(["CHECK-38", "CHECK-41", "CHECK-42"]);
    // 0.13.0: Phase 17, on THREE grounds. The 5xx re-verification pass
    // (docs/superpowers/specs/2026-09-08-5xx-recheck-design.md) takes a SECOND
    // look at every `server_error` page at crawl end, and the ruleset reads it:
    // (1) `http.server-error-transient` (warning) is a verdict no page could
    // receive before — a 5xx whose second look got a non-5xx answer from the
    // site; (2) `http.server-error` no longer fires on those pages, which is the
    // one verdict MOVE in the bump, from `critical` to `warning` and only where
    // a recheck actually cleared the row; (3) `http.server-error`'s copy, which
    // now names the second observation. The pair is mutually exclusive and
    // jointly exhaustive over `fetch_class = 'server_error'`, so no 5xx page
    // goes silent (hard rule 1). Totals move to 27/24/45 over 96.
    //
    // NOTHING IS BACKFILLED, and that is the property that makes the move safe:
    // the recheck columns are null on every row written before migration 0016,
    // a null class never clears, so an older crawl re-judged at 0.13.0 reports
    // exactly what it reported at 0.12.0 — every Error still an Error — with
    // `recheck: "not run"` added to the evidence saying it was never re-verified.
    //
    // 0.12.0: Phase 16, on ONE ground — a severity recalibration and nothing
    // else. 29 of the 95 rules move band (23 warning→critical, 5 info→warning,
    // crawl.blocked warning→info as the tenth marker), leaving 27 critical / 23
    // warning / 45 info. The ids and the rubric behind them are
    // docs/superpowers/specs/2026-09-08-severity-recalibration-design.md §1–3.
    // It is ADDITIVE of nothing and SUBTRACTIVE of nothing: the same crawl
    // re-judged at 0.12.0 yields the identical finding set — same ids, same
    // scopes, same evidence, same copy — with only those 29 rules' `severity`
    // moved. It is still a bump because the version stamps what the ruleset SAYS
    // about a site, and severity is part of that: findings across the
    // 0.11.0/0.12.0 boundary are not row-comparable on severity, and neither is
    // anything rolled up from it (`site.health`'s `urlsCritical` above all).
    //
    // 0.11.0: Phase 14 Task 1, on ONE ground. `resources.partial-unknown` (T1),
    // the fourth and last resource marker: a crawl whose census is a MIX — some
    // rows null, the rest a decided unknown class, and not one `ok` or broken
    // row — met NO finding at all (the three existing markers each exclude it by
    // construction), and a re-judge at 0.11.0 gives it one. ADDITIVE like all
    // three siblings — a new verdict, no existing one moves — and it closes the
    // window phase-13.md §8 pointer 1 named, one layer in from §10.1's. No
    // existing copy changed.
    //
    // 0.10.0: Phase 13 Task 2, on ONE ground. `resources.all-unknown` (T2), the
    // third and last resource marker: a crawl whose every row landed in an
    // unknown class (`refused`, `robots_denied`, `robots_unreachable`,
    // `fetch_error`, and not one `ok`, broken or unasked row) met NO finding at
    // all, and a re-judge at 0.10.0 gives it one. ADDITIVE like both siblings —
    // a new verdict, no existing one moves — and it closes the window Phase 12
    // stated and left open (docs/gates/phase-12.md §10.1), whose closure was
    // defined as "another marker, another rule, another bump". No existing copy
    // changed.
    //
    // 0.9.0: Phase 12, on TWO grounds and both of them are the contract's own —
    // the version stamps what the ruleset SAYS, and `rules_catalog` serves the
    // copy stamped with this constant (registry.ts's own paragraph).
    //
    //  1. `resources.not-fetched` (T2), a marker a crawl could not receive
    //     before: a crawl that recorded its files and asked about none of them
    //     used to meet no finding at all, and a re-judge at 0.9.0 gives it one.
    //     It is ADDITIVE — the sibling the Phase 11 gate ruled on (§10.3) rather
    //     than a widened `resources.not-recorded`, whose condition would have
    //     been a verdict change on an existing rule.
    //  2. `resources.broken` and `resources.uncached`'s EXPLANATIONS (T1), which
    //     now name the `robots_unreachable` class the fetch pass writes. Copy is
    //     part of what a stored finding was produced by, and this constant is
    //     what a consumer traces it back to.
    //
    // ONE BUMP PER PHASE, as below: T1 shipped the class and the counter and
    // changed no verdict, so the bump lands here with the new rule, and the
    // phase's remaining tasks verify rather than bump again.
    //
    // 0.8.0: Phase 11. Five verdicts no page and no site could receive before —
    // `resources.broken`, `images.oversized`, `images.legacy-format`,
    // `resources.uncached` and the `resources.not-recorded` marker — plus the
    // `page.weight` table beside them. They read `resources` and
    // `page_resources`, which migration 0013 created and the resource fetch pass
    // fills, so this is a change in what the ruleset SAYS about a site: a crawl
    // re-judged at 0.8.0 gains findings it did not have, and a crawl from before
    // 0013 gains the marker that says why it cannot. ONE BUMP PER PHASE, as
    // below: T1 and T2 shipped the tables and the pass and changed no verdict,
    // so the bump is T3's and the phase's other tasks verify rather than bump
    // again.
    //
    // 0.7.0: Phase 9. `structure.deep-page` reads `pages.click_depth` — clicks
    // from the home page along internal links — where it used to read discovery
    // depth, which records where the CRAWLER found a URL and puts every sitemap
    // entry at the top. On a sitemapped site the old reading kept the rule
    // silent through two real audits (docs/gates/phase-8.md §15 item 1), so a
    // crawl re-judged under 0.7.0 can gain CHECK-31 findings it did not have,
    // and their evidence key moved with the column: `{clickDepth, threshold}`
    // where 0.6.0 wrote `{depth, threshold}`.
    //
    // 0.6.0: Phase 8. `content.csr-dependent` compares two readings by ONE
    // instrument — the analyzer's `renderable_word_count` against the same
    // function's count over the serialised post-JavaScript DOM — where it used
    // to compare the analyzer against the browser's `innerText`. The Phase 7
    // gate measured that older comparison as unable to fire at all on a
    // chrome-heavy theme (docs/gates/phase-7.md §4.2, §4.9), so this is a
    // change in what the ruleset SAYS about a site and not only in how it says
    // it: a stored CHECK-01 verdict from 0.5.0 is not row-comparable with one
    // from 0.6.0, and its evidence keys differ too.
    //
    // 0.5.0: Phase 7. `content.thin` now judges a page on the words its markup
    // does not hide rather than on every word in the HTML,
    // `content.csr-dependent` subtracts the same corrected column, and
    // `content.thin-skipped` is a new verdict a page can receive (T1) — and
    // four more verdicts arrive with the field-level duplicates (T2:
    // `title.duplicate`, `meta-description.duplicate`, `h1.duplicate-text` and
    // its skip). All of them change what the ruleset says about a site, which is
    // exactly what this version exists to let a stored finding be traced to.
    //
    // ONE BUMP PER PHASE, not one per task: a version identifies the ruleset a
    // stored finding was produced by, and two numbers inside one phase would
    // claim a difference between rules that shipped together. Phase 9's bump is
    // T2's, above; the phase's other tasks verify rather than bump again.
    //
    // 0.14.0: Phase 19, the audit accuracy pass — verdicts moved (duplicates
    // and hreflang respect the canonical), a measurement changed (near-
    // duplicate on the main-content fingerprint), four rules added, copy on 26
    // rules; registry.ts's entry carries the grounds.
    //
    // 0.15.0: Phase 20 — copy rewritten by hand in SEO-tool register, report
    // columns declared on every finding rule and served with every listing,
    // crawl.blocked gains fetchReason; registry.ts carries the grounds.
    //
    // 0.16.0: Phase 21 — every metric rule declares its table (shaper + a label
    // over every column and summary scalar); labels are client-facing and the
    // catalog serves them, so what the ruleset says changed; no value moves.
    //
    // 0.17.0: Phase 22 — the judged cohort (indexable, self-canonical) on 26
    // page-defect rules and the metrics; hreflang alternates count as one page
    // in the duplicate rules; sitemap.non-indexable gains the canonicalised
    // case; site.health gains the two set-aside counts. Verdicts move.
    //
    // 0.18.0: Phase 23 — timeout, network_error, too_large and
    // unsupported_encoding rows, judged by no rule before, gain four rules
    // (http.no-response pair, page.html-too-large, the crawl.unreadable-encoding
    // marker); the recheck pass also re-asks the no-response rows; registry.ts
    // carries the grounds.
    //
    // 0.23.0: Phase 27a — every rule that finds gains an issue type and a
    // priority from src/rules/registry/triage.ts; client-facing judgement
    // changed, no verdict moved; registry.ts carries the grounds.
    expect(RULESET_VERSION).toBe("0.23.0");
  });
  it("every listed check id is a well-formed CHECK-NN and unique", () => {
    expect(new Set(CRAWL_CHECK_IDS).size).toBe(CRAWL_CHECK_IDS.length);
    for (const c of CRAWL_CHECK_IDS) expect(c).toMatch(/^CHECK-\d{2}[a-z]?$/);
  });
  it("every agent check is part of the crawl-derived universe", () => {
    for (const c of AGENT_CHECKS) expect(CRAWL_CHECK_IDS).toContain(c);
  });
});

/**
 * The annotations that said WHY a check had no rule behind it, so the coverage
 * pin's entries were explained rather than merely counted. There are none left:
 * `METRIC_PENDING_CHECKS` went with Phase 4's metric rules and `RENDER_CHECKS`
 * with Phase 5's render diff rules, each deleted by the phase that claimed its
 * ids — an annotation with nothing to annotate is a reason nobody needs.
 *
 * What survives is the property those lists were checked FOR, asserted against
 * the one list still standing. `AGENT_CHECKS` is not an annotation of the same
 * kind: those three are judgement and will never have a finding rule, so they
 * are excluded from the pin permanently rather than pending a phase.
 */
describe("check annotations", () => {
  it("the agent list is well-formed and inside the crawl-derived universe", () => {
    expect(new Set(AGENT_CHECKS).size, "AGENT_CHECKS repeats an id").toBe(AGENT_CHECKS.length);
    for (const c of AGENT_CHECKS) expect(CRAWL_CHECK_IDS, c).toContain(c);
  });
});


/**
 * The severity shape of the whole ruleset, pinned.
 *
 * Severity is the axis every downstream consumer bands on — the demo page's
 * Errors / Warnings / Notices, `site.health`'s per-page rollup, and whatever
 * gauge Talos eventually draws from it — and nothing computes it at runtime:
 * each rule's severity is a literal at definition time. That makes the totals
 * below a fact about the ruleset rather than about any crawl, and it makes an
 * accidental one-character edit invisible everywhere except here.
 *
 * **A change to either assertion in this block is a RULESET BUMP and must be
 * deliberate.** Moving a rule between bands changes what the engine SAYS about
 * a site: the same crawl re-judged reports the same findings at a different
 * severity, and every rollup taken from severity moves with it. Update these
 * literals only alongside `RULESET_VERSION`, a written rationale in the comment
 * block above it, and the matching parenthetical in
 * `skills/ariadne-audit/checklist.md` — never to make a red test green.
 *
 * The current shape is Phase 16's recalibration (ruleset 0.12.0), classified
 * against the rubric in
 * `docs/superpowers/specs/2026-09-08-severity-recalibration-design.md` §1, whose
 * §2 table carries the per-rule reasoning, plus Phase 17's one addition at
 * 0.13.0: `http.server-error-transient` (warning), the 5xx a second observation
 * cleared, and Phase 19's four at 0.14.0: `links.to-server-error` (critical,
 * the one addition to the list below), `hreflang.missing-self-reference`
 * (warning) and two markers. The critical list was UNCHANGED by the 0.13.0 bump —
 * `http.server-error` is still critical and still fires on every 5xx the
 * recheck did not clear — which is the whole of the "no old crawl silently
 * loses an Error" claim, read off the severity shape. Phase 23 (0.18.0) adds
 * four, all over fetch outcomes no rule judged before: `http.no-response` and
 * `page.html-too-large` (critical, both added to the list below),
 * `http.no-response-transient` (warning) and the `crawl.unreadable-encoding`
 * marker (info). Task 3 adds one warning, `robots.blocks-internal-urls` (a
 * Disallow on a linked URL may be intended, so the site is asked to confirm
 * it). Task 5 adds one critical, `head.directives-outside-head` (a canonical,
 * robots or hreflang the head no longer holds may be ignored, which decides
 * indexing), and one warning, `head.tags-outside-head`. Task 6 adds two
 * critical, `render.noindex-changed` and `render.canonical-changed` (a script
 * that changes the directive makes the page's indexing depend on which reader
 * sees it), and three warnings, `render.title-changed`,
 * `render.meta-description-changed` and `render.h1-changed`. Two classes are fixed by
 * construction rather than by judgement and can never appear in the critical
 * list: metric rules (`metricRule` takes no severity and hard-codes `info`) and
 * the sixteen markers (26a added `security.headers-not-recorded`, 26b `extraction.not-recorded`, the PR #24 review `hreflang.declarations-incomplete`), which report a hole in OUR evidence and never a fault of
 * the site.
 *
 * Owner calls 2026-11-07 (0.21.0, unreleased, so no bump under ruling R20; the
 * rationale is in the registry's 0.21.0 note): `links.no-anchor-text` moves
 * info to warning, since it now fires only on a link nothing names (no text, no
 * alt, no aria-label), and `links.aria-label-only` (info) takes the links named
 * only by aria-label. `html.head-closed-early-harmless` (info) takes the early
 * head close that loses no head tag, and `html.head-closed-early` stays a
 * warning for the one that does. The critical list does not move.
 *
 * Phase 26c (0.22.0) Task 2 adds `url.reference-too-long` (warning): 64
 * warnings. The critical list does not move.
 *
 * Phase 26c (0.22.0) Task 4 adds `social.image-insecure` (info): 87 info.
 *
 * Phase 26c (0.22.0) Task 9 adds `sitemap.oversized` (warning) and
 * `sitemap.url-in-multiple` (info): 65 warnings, 88 info.
 *
 * Phase 26c (0.22.0) Task 10 adds `hreflang.source-conflict` (warning): 66
 * warnings.
 *
 * The PR #24 review (0.22.0, no bump) adds the marker
 * `hreflang.declarations-incomplete` (info): 89 info, sixteen markers.
 */
describe("severity shape of the ruleset", () => {
  const all = buildRegistry().all();

  it("holds 33 critical, 66 warning and 89 info rules", () => {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const r of all) counts[r.severity] += 1;
    expect(counts).toEqual({ critical: 33, warning: 66, info: 89 });
    expect(all).toHaveLength(188);
  });

  it("names exactly the rules that are critical", () => {
    expect(all.filter((r) => r.severity === "critical").map((r) => r.id).sort()).toEqual([
      "canonical.html-header-conflict",
      "canonical.multiple",
      "canonical.non-200-target",
      "canonical.non-indexable-target",
      "content.csr-dependent",
      "content.exact-duplicate",
      "content.placeholder",
      "content.soft-404",
      "directive.canonical-noindex-conflict",
      "head.directives-outside-head",
      "host.duplicate-host-200",
      "host.http-serves-200",
      "hreflang.invalid-code",
      "hreflang.missing-return-link",
      "hreflang.non-indexable-target",
      "http.no-response",
      "http.server-error",
      "indexability.meta-header-conflict",
      "links.broken-internal",
      "links.to-server-error",
      "mobile.viewport-missing",
      "nav.js-only",
      "page.html-too-large",
      "redirect.js",
      "redirect.loop",
      "render.canonical-changed",
      "render.noindex-changed",
      "robots.blocks-sitemap-urls",
      "sitemap.invalid",
      "sitemap.non-200",
      "sitemap.non-indexable",
      "title.missing",
      "url.normalisation-variants",
    ]);
  });

  it("no metric rule and no marker is above info", () => {
    for (const r of all) {
      if (r.kind === "metric") expect(r.severity, r.id).toBe("info");
      if (r.marker) expect(r.severity, r.id).toBe("info");
    }
  });
});

/**
 * THE RESERVED HEADINGS, PINNED TO THE SURFACES THAT PRINT THEM.
 *
 * `RESERVED_COLUMN_LABELS` (src/rules/registry/registry.ts) is a copy: the
 * registry cannot import `STANDARD_ISSUE_COLUMNS` from src/api/service.ts or
 * `TRUNCATED_LABEL` from src/api/csv.ts, because both of those depend on the
 * registry and not the other way round. A copy that nothing compares is a copy
 * that drifts, and the drift here is silent in the worst way — a heading stops
 * being reserved and a rule is free to collide with it.
 */
describe("the reserved headings are exactly the ones the surface prints itself", () => {
  it("refuses every standard heading and the cap column, and nothing else", () => {
    const surface = [...STANDARD_ISSUE_COLUMNS.map((c) => c.label), TRUNCATED_LABEL];
    for (const label of surface) {
      expect(
        () => defineRule({ ...validPageRule, columns: [{ key: "mine", label }] }),
        label,
      ).toThrow(/which the surface prints itself/);
    }
    // And the reservation is no WIDER than the surface: a heading nobody prints
    // is a rule's to use, and a set that quietly grew would forbid a legitimate
    // column with no error a reader could trace.
    for (const label of ["Inlinks", "Meta Robots", "Fetch Class", "Source", "Word Count"]) {
      expect(
        defineRule({ ...validPageRule, columns: [{ key: "mine", label }] }),
        label,
      ).toBeDefined();
    }
  });
});

/**
 * EVERY DECLARED COLUMN NAMES A KEY ITS OWN RULE WRITES — STATICALLY, OVER ALL
 * 86 RULES THAT FIND.
 *
 * The harness (test/fixtures/harness.test.ts, "declares a column for every
 * evidence key it writes…") is the strong form of this claim and the one that
 * catches a wrong VALUE, but it can only speak for the rules the fixture site
 * actually trips. This is the cheap form that speaks for ALL of them: read the
 * source file that defines the rule and require every declared key to appear in
 * it as an identifier.
 *
 * ## What it proves, and exactly what it does not
 *
 * The column declaration is stripped before the search (`key: "…"` is removed),
 * so a key satisfies this test only by appearing SOMEWHERE ELSE in the file —
 * which, for every rule in this repository, is the evidence object it is
 * written into. A key misspelled in the declaration and spelled correctly in
 * the evidence fails here on the day the rule is written rather than on the day
 * a fixture happens to trip it.
 *
 * What it cannot see: that the key appears in the RIGHT place (a key mentioned
 * only in a comment satisfies it), and it is weak for short common names —
 * `url`, `title` — which appear in almost any rule file for other reasons. It
 * is a spelling guard, not the evidence check; the harness remains that.
 *
 * The owning file is DERIVED, not listed: exactly one file under `src/rules`
 * (outside `registry/`, where the copy map is keyed by rule id) contains each
 * rule's id as a string literal, and the test asserts that uniqueness first —
 * a rule split across two files would make the search ambiguous rather than
 * wrong, and this is where that would be noticed.
 */
describe("every declared column names a key its own rule's source writes", () => {
  const RULES_DIR = fileURLToPath(new URL("../../src/rules", import.meta.url));

  const sources = (): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        // `registry/` holds the copy map, which is keyed by every rule id and
        // would make every rule's owner ambiguous. It declares no columns.
        if (entry.isDirectory()) {
          if (entry.name !== "registry") walk(path);
        } else if (entry.name.endsWith(".ts")) {
          out.set(path, readFileSync(path, "utf8"));
        }
      }
    };
    walk(RULES_DIR);
    return out;
  };

  it("finds one defining file per rule, and the key spelled inside it", () => {
    const files = sources();
    expect(files.size, "no rule sources were read at all").toBeGreaterThan(20);

    const ambiguous: string[] = [];
    const missing: string[] = [];
    let checked = 0;
    for (const rule of buildRegistry().all()) {
      const columns = rule.columns ?? [];
      if (columns.length === 0) continue;
      const owners = [...files].filter(([, text]) => text.includes(`"${rule.id}"`));
      if (owners.length !== 1) {
        ambiguous.push(`${rule.id} (${owners.length} files)`);
        continue;
      }
      // The declaration itself must not be what satisfies the search.
      const body = owners[0]![1].replace(/key:\s*"[^"]*"/g, "");
      for (const column of columns) {
        checked += 1;
        if (!new RegExp(`\\b${column.key}\\b`).test(body)) {
          missing.push(`${rule.id}.${column.key}`);
        }
      }
    }

    expect(
      ambiguous.sort(),
      "a rule id that is not a string literal in exactly one source file — this " +
        "test cannot tell which file declares its evidence",
    ).toEqual([]);
    expect(
      missing.sort(),
      "these declared column keys are spelled nowhere else in the file that " +
        "defines the rule — the heading names an evidence field the rule does " +
        "not write",
    ).toEqual([]);
    // The sweep is over the WHOLE ruleset, not the fixture's share of it: 231
    // columns over the 86 rules that find. A number that falls is a rule that
    // stopped declaring, which is the thing this file exists to notice.
    expect(checked, "the column sweep saw far fewer columns than the ruleset has")
      .toBeGreaterThanOrEqual(200);
  });
});

/**
 * `table.order` — the metric's place in the metric section, and the only field
 * on a declaration that is about the SET of tables rather than about one.
 *
 * A separate block from the `defineRule` suite above because the property has
 * two halves that live in two places: what a DEFINITION may say (here) and what
 * the served catalog does with it (test/api/query.test.ts, over the wire).
 */
describe("a metric table's declared order", () => {
  const withOrder = (order: unknown): unknown => ({
    ...validMetricRule,
    table: { ...perScope("Scope", [{ key: "urlsTotal", label: "Pages Judged" }]), order },
  });

  it("accepts a non-negative integer, and no order at all", () => {
    expect(() => defineRule(withOrder(0) as never)).not.toThrow();
    expect(() => defineRule(withOrder(13) as never)).not.toThrow();
    // Absent is a position too — after every table that declares one.
    expect(() => defineRule(validMetricRule)).not.toThrow();
  });

  // A position in a list is an index. A fraction, a negative and a NaN are each
  // a value that looks declared and cannot be ordered, so each is refused by
  // name rather than sorted somewhere arbitrary.
  it("refuses anything that is not a position in a list", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
      expect(() => defineRule(withOrder(bad) as never), String(bad)).toThrow(
        /must be a non-negative integer/,
      );
    }
  });

  // THE RULESET'S OWN FOURTEEN, as a set: every metric declares a position, and
  // no two declare the same one. A duplicate would leave two tables ordered by
  // the id tiebreak — silently, and only for that pair.
  it("gives every metric rule a distinct position", () => {
    const metrics = buildRegistry().byKind("metric");
    const orders = metrics.map((rule) => rule.table.order);
    expect(orders.every((order) => typeof order === "number")).toBe(true);
    expect(new Set(orders).size, "two metric tables declare the same position").toBe(
      metrics.length,
    );
  });
});
