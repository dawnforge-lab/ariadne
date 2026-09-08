import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";
import {
  AGENT_CHECKS,
  CRAWL_CHECK_IDS,
  defineRule,
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
  run: () => [],
};

describe("defineRule", () => {
  it("accepts a well-formed rule", () => {
    expect(defineRule(validPageRule)).toBe(validPageRule);
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
    expect(defineRule(suffixed)).toBe(suffixed);
  });
  it("throws on an unknown kind", () => {
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(/bad kind 'cosmic'/);
  });
  it("accepts a marker flag carrying a reason", () => {
    const marked = { ...validPageRule, marker: "a crawl condition the check cannot judge" };
    expect(defineRule(marked)).toBe(marked);
  });
  it("throws on a present-but-empty marker flag — a flag with no reason", () => {
    expect(() => defineRule({ ...validPageRule, marker: "   " }))
      .toThrow(/marker, when present, must be a non-empty reason string/);
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
    // 0.12.0: Phase 16, on ONE ground — a severity recalibration and nothing
    // else. 29 of the 95 rules move band (24 warning→critical, 5 info→warning),
    // leaving 28 critical / 23 warning / 44 info; the ids and the rubric behind
    // them are docs/superpowers/specs/2026-09-08-severity-recalibration-design.md
    // §1–3. It is ADDITIVE of nothing and SUBTRACTIVE of nothing: the same crawl
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
    expect(RULESET_VERSION).toBe("0.12.0");
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
 * §2 table carries the per-rule reasoning. Two classes are fixed by
 * construction rather than by judgement and can never appear in the critical
 * list: metric rules (`metricRule` takes no severity and hard-codes `info`) and
 * the nine markers, which report a hole in OUR evidence and never a fault of
 * the site.
 */
describe("severity shape of the ruleset", () => {
  const all = buildRegistry().all();

  it("holds 28 critical, 23 warning and 44 info rules", () => {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const r of all) counts[r.severity] += 1;
    expect(counts).toEqual({ critical: 28, warning: 23, info: 44 });
    expect(all).toHaveLength(95);
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
      "crawl.blocked",
      "directive.canonical-noindex-conflict",
      "host.duplicate-host-200",
      "host.http-serves-200",
      "hreflang.invalid-code",
      "hreflang.missing-return-link",
      "hreflang.non-indexable-target",
      "http.server-error",
      "indexability.meta-header-conflict",
      "links.broken-internal",
      "mobile.viewport-missing",
      "nav.js-only",
      "redirect.js",
      "redirect.loop",
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
