# Ariadne Phase 2: Page Rules, Copy, Fixture Harness & CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The deterministic page-rule layer — 28 rules wired to the registry with absorbed client-facing copy, a minimal rule runner writing `issues` rows, an HTTP fixture harness proving every rule fires (and none fires on a clean page), and a CI workflow that makes the Phase 2 gate mean what it says.

**Architecture:** Rules are pure functions over `PageRecord` (page kind) or SQL over the crawl's tables (query kind) — never fetching, never building a DOM. A single `buildRegistry()` registers everything; `runRules(db, crawlId, registry)` streams pages in batches and batch-inserts findings with the existing `(crawl_id, rule_id, dedupe_key)` dedupe index absorbing re-runs. The fixture harness crawls a local fixture app with the real `runCrawl`, runs the real runner, and asserts from the `issues` table — the full chain, not synthetic records.

**Tech Stack:** Existing Phase 1 stack (TypeScript strict/ESM, drizzle, vitest, undici). No new runtime dependencies. GitHub Actions with a Postgres 16 service container.

**Spec:** `docs/crawl-audit-engine-spec.md` (§3 rule contract, §4 rule map) and `docs/crawl-audit-build-plan.md` (§2 lift manifest, §4 Phase 2 tasks P2-T1…P2-T5, §6 guardrails, §7 known gaps). This plan implements Phase 2 with four owner-approved amendments from the 2026-08-25 planning session: (1) a **minimal rule runner is in scope** (build plan never assigned one); (2) a **GitHub Actions workflow is in scope** (the gate references CI; none existed); (3) **`pages.in_sitemap` and `pages.redirect_hops` are dropped** (never written — `sitemap_urls` joins and Phase 3's chain queries are the sources of truth; a never-written column is a rule-that-always-passes trap); (4) **bonus rules without a checklist id are deferred** — hard rule 10 requires `checkIds` tracing to the sf-audit checklist, and security-headers / forms / duplicate-ids / metas-in-body have no CHECK id to claim. The bonus rules that DO trace land now: viewport→CHECK-52, image dimensions & alt→CHECK-49, slow response→CHECK-50, deep page→CHECK-31.

## Global Constraints

- Node 22, ESM, TypeScript `strict: true` + `isolatedModules`. `npx tsc --noEmit` and `npm test` green at every commit. `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` for DB tests (throw if unset — no skip-fallback).
- **Never write a rule that always passes.** Every rule must fire on at least one fixture and stay silent on the clean control page — the harness asserts both.
- **Never fetch inside a rule. Never build a DOM.** Page rules see only `PageRecord`; query rules see only `(db, crawlId)`.
- Every rule carries `checkIds` matching `/^CHECK-\d{2}[a-z]?$/` tracing to `~/.claude/skills/sf-audit/checklist.md`, plus non-empty client-facing `title`/`explanation`/`howToFix` (registry validation already rejects violations at load time).
- Lifted text/code carries a provenance header (repo, path, sha, changes). Pinned shas: OpenSEO `c469a48ae90ab58413b198fe3d1ac1aa90a9b070`, SEOnaut `880b312c28fab8b0bf7fe4f9449dc4746dbb82ff`. `THIRD_PARTY_NOTICES.md` already names both.
- Migrations via drizzle-kit only (`npm run db:generate`), committed; never hand-edited SQL.
- No silent fallbacks: a rule that throws mid-run aborts the runner loudly naming the rule; missing copy for a rule id throws at load time.
- Ruleset version: single constant `RULESET_VERSION = "0.2.0"` exported from the registry (Task 1); `loop.ts`'s hard-coded `"0.1.0"` is replaced by the import.
- Commit after each green cycle. Conventional messages ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Registry hardening + ruleset version + schema tidy (carried Phase 1 obligations)

**Files:**
- Modify: `src/rules/registry/registry.ts`, `src/rules/registry/types.ts`
- Modify: `src/db/schema.ts`, `src/crawl/loop.ts` (one line), `src/crawl/persist.ts` (two lines)
- Generated: `drizzle/0002_*.sql` (committed)
- Test: `test/rules/registry.test.ts` (extend), `test/db/schema.test.ts` (extend)

**Interfaces:**
- Consumes: existing registry + schema.
- Produces: `RULESET_VERSION = "0.2.0"` and `CRAWL_CHECK_IDS: readonly string[]` and `AGENT_CHECKS: readonly string[]` exported from `src/rules/registry/registry.ts`. `defineRule` additionally rejects unknown `kind`. `RuleDefinitionError` has `name = "RuleDefinitionError"`. Schema: `pages` loses `in_sitemap` and `redirect_hops`, gains `canonical_count integer notnull default 0`, `has_viewport boolean notnull default false`, `images_missing_dimensions integer notnull default 0`, `has_lorem_ipsum boolean notnull default false`. All later tasks read these exact column/property names (`canonicalCount`, `hasViewport`, `imagesMissingDimensions`, `hasLoremIpsum` on the drizzle objects).

- [ ] **Step 1: Write the failing registry tests** (append to `test/rules/registry.test.ts`)

```ts
it("throws on an unknown kind", () => {
  expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
    .toThrow(RuleDefinitionError);
});
it("byKind narrows and filters", () => {
  const r = new Registry();
  r.register(validPageRule);
  expect(r.byKind("page").map((x) => x.id)).toEqual(["title.missing"]);
  expect(r.byKind("query")).toEqual([]);
});
it("RuleDefinitionError is recognizable by name", () => {
  try { defineRule({ ...validPageRule, id: "BAD ID" }); throw new Error("no throw"); }
  catch (e) { expect((e as Error).name).toBe("RuleDefinitionError"); }
});
it("exports the crawl-derived check universe and agent list", () => {
  expect(CRAWL_CHECK_IDS).toHaveLength(47);
  expect(CRAWL_CHECK_IDS).toContain("CHECK-33b");
  expect(AGENT_CHECKS).toEqual(["CHECK-38", "CHECK-41", "CHECK-42"]);
  expect(RULESET_VERSION).toBe("0.2.0");
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- test/rules/registry.test.ts` → FAIL (missing exports / no kind guard).

- [ ] **Step 3: Implement registry changes** in `src/rules/registry/registry.ts`:

```ts
export class RuleDefinitionError extends Error {
  override name = "RuleDefinitionError";
}

export const RULESET_VERSION = "0.2.0";

/** The 47 crawl-derived checks (sf-audit checklist, Pre-Crawl + sections 1–11). */
export const CRAWL_CHECK_IDS: readonly string[] = [
  "CHECK-01","CHECK-02","CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07",
  "CHECK-08","CHECK-09","CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14",
  "CHECK-15","CHECK-16","CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21",
  "CHECK-22","CHECK-23","CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28",
  "CHECK-29","CHECK-30","CHECK-31","CHECK-32","CHECK-33","CHECK-33b","CHECK-34",
  "CHECK-35","CHECK-36","CHECK-37","CHECK-38","CHECK-39","CHECK-40","CHECK-41",
  "CHECK-42","CHECK-43","CHECK-44","CHECK-45","CHECK-46",
];

/** Judgement checks — never rules (build plan §6: no rule that always passes). */
export const AGENT_CHECKS: readonly string[] = ["CHECK-38", "CHECK-41", "CHECK-42"];
```

In `defineRule`, after the severity check add:

```ts
if (!["page", "query", "metric"].includes(rule.kind)) fail(`bad kind '${(rule as { kind: string }).kind}'`);
```

- [ ] **Step 4: Schema tidy.** In `src/db/schema.ts` `pages`: delete the `inSitemap` and `redirectHops` lines; add:

```ts
canonicalCount: integer("canonical_count").notNull().default(0),
hasViewport: boolean("has_viewport").notNull().default(false),
imagesMissingDimensions: integer("images_missing_dimensions").notNull().default(0),
hasLoremIpsum: boolean("has_lorem_ipsum").notNull().default(false),
```

Fix the two writers that referenced the dropped columns: in `src/crawl/persist.ts`, remove the `inSitemap`/`redirectHops` mappings from `pageRow()` (grep for them); the new columns get real values in Task 2 — until then drizzle defaults apply (do NOT map them yet). In `src/crawl/loop.ts` replace `rulesetVersion: "0.1.0"` with `rulesetVersion: RULESET_VERSION` imported from `../rules/registry/registry.js`.

Extend `test/db/schema.test.ts`'s column assertion: replace `"in_sitemap"` in the expected-columns list (if present) with `"canonical_count"`, `"has_viewport"`, `"images_missing_dimensions"`, `"has_lorem_ipsum"`, and assert `in_sitemap` and `redirect_hops` are ABSENT:

```ts
for (const gone of ["in_sitemap", "redirect_hops"]) {
  expect(cols, `${gone} should be dropped`).not.toContain(gone);
}
```

- [ ] **Step 5: Generate + apply migration, run tests**

Run: `npm run db:generate` (produces `drizzle/0002_*.sql` with ALTER TABLE drops + adds; commit it), then `DATABASE_URL=… npm run db:migrate`, then `DATABASE_URL=… npm test && npx tsc --noEmit` → all green (the full suite catches any missed reference to the dropped columns).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: registry hardening, RULESET_VERSION, drop dead pages columns, add rule-signal columns (P2 groundwork)"
```

---

### Task 2: Analyzer + persistence extensions — viewport, image dimensions, lorem, canonical count

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts` (inside existing tokenizer callbacks — no second parse pass)
- Modify: `src/crawl/persist.ts` (map four fields)
- Test: `test/crawl/analyzer-extensions.test.ts` (extend), `test/crawl/persist.test.ts` (extend)

**Interfaces:**
- Consumes: existing `PageAnalysis` / `RawPageAnalysis` two-layer design (read the file's provenance header before editing — attribute matching is trim+lowercase folded).
- Produces: `PageAnalysis` gains `hasViewport: boolean`, `imagesMissingDimensions: number`, `hasLoremIpsum: boolean` (`canonicalCount` already exists on the interface — it now gets persisted). `PageWriter` maps all four onto the Task 1 columns.

- [ ] **Step 1: Write the failing analyzer tests** (append to `test/crawl/analyzer-extensions.test.ts`)

```ts
describe("bonus signals", () => {
  it("detects the viewport meta", () => {
    const withVp = analyzePage(`<html><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><p>x</p></body></html>`, "https://ex.com/");
    const without = analyzePage(`<html><head><title>t</title></head><body><p>x</p></body></html>`, "https://ex.com/");
    expect(withVp.hasViewport).toBe(true);
    expect(without.hasViewport).toBe(false);
  });
  it("counts images missing width/height", () => {
    const a = analyzePage(`<html><body><img src="a.png" width="10" height="10"><img src="b.png" width="10"><img src="c.png"></body></html>`, "https://ex.com/");
    expect(a.imagesMissingDimensions).toBe(2); // b (no height) and c (neither)
  });
  it("flags lorem ipsum placeholder text", () => {
    const a = analyzePage(`<html><body><p>Lorem ipsum dolor sit amet, consectetur.</p></body></html>`, "https://ex.com/");
    const b = analyzePage(`<html><body><p>Real product copy about widgets.</p></body></html>`, "https://ex.com/");
    expect(a.hasLoremIpsum).toBe(true);
    expect(b.hasLoremIpsum).toBe(false);
  });
  it("does not flag lorem inside script/style", () => {
    const a = analyzePage(`<html><body><script>var x="lorem ipsum dolor";</script><p>clean</p></body></html>`, "https://ex.com/");
    expect(a.hasLoremIpsum).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement inside the existing callbacks:
  - `onopentag` for `meta`: when the folded `name` is `"viewport"`, set `hasViewport = true`.
  - `onopentag` for `img` (where `imagesTotal`/`imagesMissingAlt` are already counted): if `!("width" in attribs) || !("height" in attribs)` increment `imagesMissingDimensions`.
  - `hasLoremIpsum`: computed once at the end from the SAME visible-text accumulator that feeds `wordCount` (script/style already excluded there): `/lorem ipsum/i.test(bodyText)`. Do not scan raw HTML.
  - Thread the three fields through `RawPageAnalysis` → `analyzePage` facade. Update the cheerio parity oracle for viewport and image dimensions the same way the existing folded-attribute helpers do (see `fold()`/`byAttr()` in the upstream test).

- [ ] **Step 3: Persist the four fields.** In `src/crawl/persist.ts` `pageRow()` add, next to the existing analysis mappings:

```ts
canonicalCount: analysis?.canonicalCount ?? 0,
hasViewport: analysis?.hasViewport ?? false,
imagesMissingDimensions: analysis?.imagesMissingDimensions ?? 0,
hasLoremIpsum: analysis?.hasLoremIpsum ?? false,
```

Extend `test/crawl/persist.test.ts`: one addPage with an analysis carrying `canonicalCount: 2, hasViewport: true, imagesMissingDimensions: 3, hasLoremIpsum: true`, flush, select the row, assert all four round-trip.

- [ ] **Step 4: Run everything** — `DATABASE_URL=… npm test && npx tsc --noEmit` → green (parity suite included).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: analyzer + persist bonus signals — viewport, image dimensions, lorem, canonical count (P2-T3 prep)"
```

---

### Task 3: Absorb issue copy — SEOnaut translations + OpenSEO descriptors (P2-T2)

**Files:**
- Create: `src/rules/registry/copy/issue-copy.ts`, `src/rules/registry/copy/index.ts`
- Test: `test/rules/copy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `copyFor(ruleId: string): { title: string; explanation: string; howToFix: string }` — **throws** `Error(\`no copy for rule '${ruleId}'\`)` on a miss (load-time failure, not a fallback). Every Task 4–6 rule calls it. Also `ISSUE_COPY: Record<string, IssueCopy>` for the test.

- [ ] **Step 1: Fetch upstream at the pinned shas**

```bash
mkdir -p .tmp/upstream
curl -fsSL https://raw.githubusercontent.com/StJudeWasHere/seonaut/880b312c28fab8b0bf7fe4f9449dc4746dbb82ff/translations/translation.en.yaml -o .tmp/upstream/translation.en.yaml
curl -fsSL https://raw.githubusercontent.com/every-app/open-seo/c469a48ae90ab58413b198fe3d1ac1aa90a9b070/src/shared/audit-issues.ts -o .tmp/upstream/audit-issues.ts
```

If a path 404s, list the GitHub tree at that sha and locate by name — never substitute a different sha.

- [ ] **Step 2: Read both fully, then build the copy module.** `src/rules/registry/copy/issue-copy.ts` starts with a provenance header:

```ts
/**
 * Issue copy adapted from:
 *  - seonaut (MIT), translations/translation.en.yaml
 *    @ 880b312c28fab8b0bf7fe4f9449dc4746dbb82ff (ERROR_* titles + _DESC explanations)
 *  - open-seo (MIT), src/shared/audit-issues.ts
 *    @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070 (severity, explanation, howToFix descriptors)
 * Changes: keyed by Ariadne rule ids; overlapping issues keep the richer text
 * (per docs/crawl-audit-build-plan.md P2-T2); howToFix authored where neither
 * upstream provides one.
 */
```

Shape — one entry per Ariadne rule id from Tasks 4–6 (all 28 listed in those tasks):

```ts
export interface IssueCopy { title: string; explanation: string; howToFix: string }

export const ISSUE_COPY: Record<string, IssueCopy> = {
  "title.missing": {
    title: "Missing title tag",
    explanation: "…richer of SN ERROR_EMPTY_TITLE_DESC / OS descriptor…",
    howToFix: "…actionable, client-facing…",
  },
  // … one entry per rule id; text lifted/merged from the two sources,
  // authored fresh only where neither source covers the rule.
};
```

The plan intentionally does not transcribe the upstream text here — the lift IS the task. Rules of the merge: SN's `_DESC` texts are usually the richer explanation; OS's `howToFix` is usually the only fix text; where a rule exists in neither (e.g. `crawl.blocked`, `images.missing-dimensions`), write plain, specific copy in the same voice (2–3 sentences each, no marketing filler).

`src/rules/registry/copy/index.ts`:

```ts
import { ISSUE_COPY, type IssueCopy } from "./issue-copy.js";
export { ISSUE_COPY, type IssueCopy };

export function copyFor(ruleId: string): IssueCopy {
  const c = ISSUE_COPY[ruleId];
  if (!c) throw new Error(`no copy for rule '${ruleId}' — add it to issue-copy.ts`);
  return c;
}
```

- [ ] **Step 3: Write the tests** (`test/rules/copy.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { copyFor, ISSUE_COPY } from "../../src/rules/registry/copy/index.js";

describe("issue copy", () => {
  it("throws on an unknown rule id", () => {
    expect(() => copyFor("no.such-rule")).toThrow(/no copy/);
  });
  it("every entry has substantive, client-facing text", () => {
    for (const [id, c] of Object.entries(ISSUE_COPY)) {
      expect(c.title.length, `${id} title`).toBeGreaterThan(5);
      expect(c.explanation.length, `${id} explanation`).toBeGreaterThan(40);
      expect(c.howToFix.length, `${id} howToFix`).toBeGreaterThan(30);
    }
  });
});
```

- [ ] **Step 4: Run, delete `.tmp/upstream`, commit**

```bash
npm test -- test/rules/copy.test.ts && npx tsc --noEmit
rm -rf .tmp/upstream
git add -A
git commit -m "feat: absorb issue copy — SEOnaut translation.en.yaml + OpenSEO audit-issues (P2-T2)"
```

---

### Task 4: On-page rules — titles, metas, headings, content, status (P2-T1)

**Files:**
- Create: `src/rules/page/on-page.ts`, `src/rules/page/status.ts`, `src/rules/helpers.ts`
- Test: `test/rules/on-page.test.ts`, `test/rules/status.test.ts`

**Interfaces:**
- Consumes: `defineRule`, `RULESET_VERSION`, `PageRecord`, `Finding` from the registry; `copyFor` from Task 3.
- Produces: exported arrays `onPageRules: PageRule[]` and `statusRules: PageRule[]`; `src/rules/helpers.ts` exports `isAuditable(page: PageRecord): boolean` and `finding(rule: {id: string; severity: Severity}, page: PageRecord, evidence: Record<string, unknown>): Finding`. Task 7's `buildRegistry` imports the arrays.

- [ ] **Step 1: Write the shared helpers** (`src/rules/helpers.ts`)

```ts
import type { Finding, PageRecord, Severity } from "./registry/types.js";

/** A page whose on-page signals are meaningful: fetched OK as HTML with a 200. */
export function isAuditable(page: PageRecord): boolean {
  return page.fetchClass === "ok" && page.statusCode === 200;
}

export function finding(
  rule: { id: string; severity: Severity },
  page: PageRecord,
  evidence: Record<string, unknown>,
): Finding {
  return {
    ruleId: rule.id,
    pageId: page.id,
    pageUrl: page.url,
    severity: rule.severity,
    evidence,
    dedupeKey: page.url,
  };
}
```

- [ ] **Step 2: Write the failing rule tests.** Test pattern (used for every page rule in this plan): build a `PageRecord` literal via a local `mkPage(overrides)` helper that fills every column with clean-page defaults (`fetchClass: "ok"`, `statusCode: 200`, `isIndexable: true`, `title: "A perfectly reasonable page title here"` (38 chars), `metaDescription: <100-char string>`, `h1Count: 1`, `headingOrder: [1,2,3]`, `wordCount: 400`, `hasViewport: true`, `imagesMissingDimensions: 0`, `imagesMissingAlt: 0`, `hasLoremIpsum: false`, `responseTimeMs: 200`, `depth: 2`, `canonicalCount: 1`, `canonicalHtml: <own url>`, …), then override one signal per test. Every rule gets: one firing case asserting `ruleId`, `severity`, and the load-bearing evidence key; one non-firing case on the clean default; boundary cases where a threshold exists.

`test/rules/on-page.test.ts` (representative — write the analogous pair/triple for every rule in the table below):

```ts
import { describe, expect, it } from "vitest";
import { onPageRules } from "../../src/rules/page/on-page.js";

const byId = Object.fromEntries(onPageRules.map((r) => [r.id, r]));
// mkPage(overrides) as described above — build it in this file, ~40 lines.

describe("title rules", () => {
  it("title.missing fires on a null title", () => {
    const f = byId["title.missing"]!.run(mkPage({ title: null }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ title: null });
  });
  it("title.missing is silent on the clean page and on non-ok fetches", () => {
    expect(byId["title.missing"]!.run(mkPage({}))).toHaveLength(0);
    expect(byId["title.missing"]!.run(mkPage({ title: null, fetchClass: "redirect", statusCode: 301 }))).toHaveLength(0);
  });
  it("title.too-short boundary: 9 fires, 10 does not", () => {
    expect(byId["title.too-short"]!.run(mkPage({ title: "x".repeat(9) }))).toHaveLength(1);
    expect(byId["title.too-short"]!.run(mkPage({ title: "x".repeat(10) }))).toHaveLength(0);
  });
  it("title.too-long boundary: 61 fires, 60 does not", () => {
    expect(byId["title.too-long"]!.run(mkPage({ title: "x".repeat(61) }))).toHaveLength(1);
    expect(byId["title.too-long"]!.run(mkPage({ title: "x".repeat(60) }))).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement.** `src/rules/page/on-page.ts` — the definition pattern, applied to every row of the table:

```ts
import { defineRule, RULESET_VERSION, type PageRule } from "../registry/registry.js";
import { copyFor } from "../registry/copy/index.js";
import { finding, isAuditable } from "../helpers.js";

const TITLE_MIN = 10, TITLE_MAX = 60;
const META_MIN = 70, META_MAX = 160;
const THIN_WORDS = 150;

function pageRule(
  id: string, checkIds: string[], category: string,
  severity: "critical" | "warning" | "info",
  run: PageRule["run"],
): PageRule {
  return defineRule({ kind: "page", id, checkIds, category, severity, ...copyFor(id), rulesetVersion: RULESET_VERSION, run });
}

export const onPageRules: PageRule[] = [
  pageRule("title.missing", ["CHECK-35"], "on-page", "warning", (p) =>
    isAuditable(p) && (!p.title || p.title.trim() === "")
      ? [finding({ id: "title.missing", severity: "warning" }, p, { title: p.title })] : []),
  pageRule("title.too-short", ["CHECK-35"], "on-page", "info", (p) =>
    isAuditable(p) && p.title && p.title.trim() !== "" && p.title.length < TITLE_MIN
      ? [finding({ id: "title.too-short", severity: "info" }, p, { title: p.title, length: p.title.length, min: TITLE_MIN })] : []),
  // … same shape for every remaining row of the table.
];
```

**The on-page rule table (implement every row exactly):**

| id | checkIds | severity | fires when (in addition to `isAuditable` unless noted) | evidence keys |
|---|---|---|---|---|
| `title.missing` | CHECK-35 | warning | title null/empty | title |
| `title.too-short` | CHECK-35 | info | 0 < len < 10 | title, length, min |
| `title.too-long` | CHECK-35 | info | len > 60 | title, length, max |
| `meta-description.missing` | CHECK-36 | warning | metaDescription null/empty | metaDescription |
| `meta-description.too-short` | CHECK-36 | info | 0 < len < 70 | metaDescription, length, min |
| `meta-description.too-long` | CHECK-36 | info | len > 160 | metaDescription, length, max |
| `headings.h1-missing` | CHECK-37 | warning | h1Count === 0 | h1Count |
| `headings.h1-multiple` | CHECK-37 | info | h1Count > 1 | h1Count |
| `headings.level-skip` | CHECK-37 | info | headingOrder has adjacent step > 1 downward (e.g. 1→3) | headingOrder, skipAt |
| `content.thin` | CHECK-40, CHECK-13 | warning | isIndexable && wordCount !== null && wordCount < 150 | wordCount, threshold |
| `content.placeholder` | CHECK-40 | warning | hasLoremIpsum | wordCount |

Boundary semantics are inclusive-of-threshold-passing: 10 and 60 chars are fine, 150 words is fine.

`src/rules/page/status.ts` (same `pageRule` helper — import it from on-page.ts or duplicate the 5-liner, your call, note it):

| id | checkIds | severity | fires when (no isAuditable guard — these ARE the non-ok rows) | evidence keys |
|---|---|---|---|---|
| `http.server-error` | CHECK-12 | critical | fetchClass === "server_error" | statusCode |
| `crawl.blocked` | CHECK-05 | warning | fetchClass === "blocked" | statusCode |

- [ ] **Step 4: Run tests** — `npm test -- test/rules/ && npx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: on-page + status page rules — titles, metas, headings, content, 5xx, blocked (P2-T1)"
```

---

### Task 5: Canonical + indexability rules (P2-T3 priority set)

**Files:**
- Create: `src/rules/page/canonical.ts`, `src/rules/page/indexability.ts`
- Test: `test/rules/canonical.test.ts`, `test/rules/indexability.test.ts`

**Interfaces:**
- Consumes: `pageRule` pattern, `finding`, `isAuditable`, `copyFor` (extend `ISSUE_COPY` with these ids in the same commit — `copyFor` throws otherwise, which is the intended forcing function).
- Produces: `canonicalRules: PageRule[]`, `indexabilityRules: PageRule[]`.

Canonical comparison rule used throughout: normalize both sides with `normalizeUrl` from `src/crawl/parse/url-utils.js` before comparing; a canonical that fails `new URL(...)` (absolute or relative to page URL) fires `canonical.points-elsewhere` with `evidence.unparseable: true`. "Effective canonical" = `canonicalHtml ?? canonicalHeader`.

- [ ] **Step 1: Write the failing tests** — same mkPage pattern. Cover per rule: fire, clean-silent, and the specific edge named in its row.

**Canonical table (`src/rules/page/canonical.ts`):**

| id | checkIds | severity | fires when (all under `isAuditable`) | evidence keys | edge case to test |
|---|---|---|---|---|---|
| `canonical.missing` | CHECK-16 | warning | isIndexable && canonicalHtml null && canonicalHeader null | — | non-indexable page: silent |
| `canonical.points-elsewhere` | CHECK-17 | info | effective canonical present && normalized(canonical) !== normalized(page url) | canonical, resolvedTo | relative canonical `/x` resolves against page URL |
| `canonical.multiple` | CHECK-18 | warning | canonicalCount > 1 | canonicalCount, kept | — |
| `canonical.html-header-conflict` | CHECK-18 | warning | both present && normalized values differ | htmlCanonical, headerCanonical | equal-after-normalization: silent |
| `canonical.cross-domain` | CHECK-20 | info | effective canonical parses && its host !== page host | canonicalHost, pageHost | www vs apex ARE different hosts here — fires (agent judges) |
| `directive.canonical-noindex-conflict` | CHECK-21 | warning | effective canonical points elsewhere && page has noindex (robotsMeta or xRobotsTag) | canonical, robotsMeta, xRobotsTag | self-canonical + noindex: silent |

**Indexability table (`src/rules/page/indexability.ts`):**

| id | checkIds | severity | fires when (under `isAuditable`) | evidence keys | edge case |
|---|---|---|---|---|---|
| `indexability.noindex` | CHECK-04 | info | `/noindex/i` in robotsMeta or xRobotsTag | robotsMeta, xRobotsTag, source: "meta"\|"header"\|"both" | fact rule — severity info; the agent decides if it's a problem |
| `indexability.meta-header-conflict` | CHECK-04 | warning | exactly one of {robotsMeta, xRobotsTag} says noindex while the other is present and does NOT | robotsMeta, xRobotsTag | both noindex: silent (that's `indexability.noindex`'s job, source "both") |

- [ ] **Step 2: Run to verify failure, implement both files + their `ISSUE_COPY` entries, run to pass**

Run: `npm test -- test/rules/ && npx tsc --noEmit` → green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: canonical + indexability page rules (P2-T3: canonical, indexability)"
```

---

### Task 6: Hreflang query rules + traceable bonus rules (P2-T3 remainder)

**Files:**
- Create: `src/rules/query/hreflang.ts`, `src/rules/page/technical.ts`
- Test: `test/rules/hreflang-query.test.ts` (DB test), `test/rules/technical.test.ts`

**Interfaces:**
- Consumes: `Db`, `hreflang` table (query rules); `pageRule` pattern (page rules). Extend `ISSUE_COPY` with these ids.
- Produces: `hreflangRules: QueryRule[]`, `technicalRules: PageRule[]`.

- [ ] **Step 1: Hreflang query rules.** These are `kind: "query"` because hreflang declarations live in the `hreflang` table, not on `PageRecord`. `src/rules/query/hreflang.ts`:

```ts
import { sql } from "drizzle-orm";
import { defineRule, RULESET_VERSION, type QueryRule, type Finding } from "../registry/registry.js";
import { copyFor } from "../registry/copy/index.js";

/** BCP-47-lite: language 2–3 alpha, optional region 2 alpha or 3 digit, or x-default. */
const HREFLANG_CODE = /^[a-z]{2,3}(-(?:[a-z]{2}|\d{3}))?$/i;

export const hreflangRules: QueryRule[] = [
  defineRule({
    kind: "query", id: "hreflang.invalid-code", checkIds: ["CHECK-25"],
    category: "hreflang", severity: "warning",
    ...copyFor("hreflang.invalid-code"), rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const res = await db.execute(sql`
        select h.page_id, h.hreflang_code, h.target_url, p.url as page_url
        from hreflang h join pages p on p.id = h.page_id
        where h.crawl_id = ${crawlId}`);
      return res.rows
        .filter((r) => {
          const code = String(r.hreflang_code);
          return code.toLowerCase() !== "x-default" && !HREFLANG_CODE.test(code);
        })
        .map((r) => ({
          ruleId: "hreflang.invalid-code", pageId: String(r.page_id),
          pageUrl: String(r.page_url), severity: "warning" as const,
          evidence: { code: r.hreflang_code, targetUrl: r.target_url },
          dedupeKey: `${r.page_url}#${r.hreflang_code}`,
        }));
    },
  }),
  defineRule({
    kind: "query", id: "hreflang.missing-x-default", checkIds: ["CHECK-25"],
    category: "hreflang", severity: "info",
    ...copyFor("hreflang.missing-x-default"), rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      const counts = await db.execute(sql`
        select count(*) filter (where lower(hreflang_code) = 'x-default') as xd,
               count(*) as total
        from hreflang where crawl_id = ${crawlId}`);
      const row = counts.rows[0]!;
      if (Number(row.total) === 0 || Number(row.xd) > 0) return [];
      return [{
        ruleId: "hreflang.missing-x-default", pageId: null, pageUrl: null,
        severity: "info", evidence: { declarations: Number(row.total) },
        dedupeKey: "site",
      }];
    },
  }),
];
```

Note the filter-in-JS for code validity: the regex runs over at most the crawl's hreflang rows streamed once — acceptable; if a later phase meets a site with millions of declarations, move the pattern into SQL.

- [ ] **Step 2: DB tests for the query rules** (`test/rules/hreflang-query.test.ts`): create a crawl + pages rows + hreflang rows directly via drizzle inserts (valid codes `en-gb`, `de`, `en-150`? no — `en-150` is a 3-digit region and VALID; use `english-uk` and `zz-qqqq` as invalid), assert `hreflang.invalid-code` returns exactly the invalid ones with dedupe keys, `hreflang.missing-x-default` fires only when declarations exist without x-default, and neither fires on an empty crawl. `DATABASE_URL` required, throw if unset (copy the guard from `test/db/schema.test.ts`).

- [ ] **Step 3: Technical page rules** (`src/rules/page/technical.ts`) — same `pageRule` pattern:

| id | checkIds | severity | fires when (under `isAuditable`) | evidence keys |
|---|---|---|---|---|
| `mobile.viewport-missing` | CHECK-52 | warning | !hasViewport | — |
| `images.missing-dimensions` | CHECK-49 | info | imagesMissingDimensions > 0 | imagesMissingDimensions, imagesTotal |
| `images.missing-alt` | CHECK-49 | info | imagesMissingAlt > 0 | imagesMissingAlt, imagesTotal |
| `performance.slow-response` | CHECK-50 | info | responseTimeMs !== null && responseTimeMs > 1500 | responseTimeMs, threshold |
| `structure.deep-page` | CHECK-31 | info | depth > 5 | depth, threshold |

Tests: fire + clean-silent per rule; boundary 1500/1501 and depth 5/6.

- [ ] **Step 4: Run everything** — `DATABASE_URL=… npm test -- test/rules/ && npx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: hreflang query rules + traceable technical rules — viewport, images, TTFB, depth (P2-T3)"
```

---

### Task 7: buildRegistry + the rule runner

**Files:**
- Create: `src/rules/index.ts`, `src/rules/run.ts`
- Test: `test/rules/run.test.ts` (DB test)

**Interfaces:**
- Consumes: every rule array from Tasks 4–6; `Registry`, `issues` table, `Db`.
- Produces: `buildRegistry(): Registry` (registers all 28 rules; throws at build time on any malformed rule or missing copy) and `runRules(db: Db, crawlId: string, registry: Registry): Promise<RunSummary>` where `RunSummary = { pagesScanned: number; findings: number; byRule: Record<string, number> }`. The fixture harness (Task 8) and Phase 3 both build on these names.

- [ ] **Step 1: Write the failing runner test** (`test/rules/run.test.ts`, DB test): create a crawl; insert pages rows directly via drizzle — one clean page (all mkPage-style defaults), one with `title: null`, one with `fetchClass: "server_error", statusCode: 503`, plus two hreflang rows with an invalid code. Then:

```ts
const registry = buildRegistry();
const summary = await runRules(db, crawlId, registry);
const rows = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
const byRule = new Map<string, number>();
for (const r of rows) byRule.set(r.ruleId, (byRule.get(r.ruleId) ?? 0) + 1);

expect(byRule.get("title.missing")).toBe(1);
expect(byRule.get("http.server-error")).toBe(1);
expect(byRule.get("hreflang.invalid-code")).toBe(1);
expect(summary.findings).toBe(rows.length);
expect(summary.pagesScanned).toBe(3);
// idempotence: run again, no duplicate rows
await runRules(db, crawlId, registry);
const again = await db.select().from(issues).where(eq(issues.crawlId, crawlId));
expect(again.length).toBe(rows.length);
// a clean page contributes nothing
expect(rows.every((r) => r.pageId !== cleanPageId)).toBe(true);
```

Also: a registry containing a rule whose `run` throws → `runRules` rejects with an error whose message names the rule id (insert a throwing rule via a locally-built Registry, not buildRegistry).

- [ ] **Step 2: Implement.** `src/rules/index.ts`:

```ts
import { Registry } from "./registry/registry.js";
import { onPageRules } from "./page/on-page.js";
import { statusRules } from "./page/status.js";
import { canonicalRules } from "./page/canonical.js";
import { indexabilityRules } from "./page/indexability.js";
import { technicalRules } from "./page/technical.js";
import { hreflangRules } from "./query/hreflang.js";

export function buildRegistry(): Registry {
  const r = new Registry();
  for (const rule of [...onPageRules, ...statusRules, ...canonicalRules,
                      ...indexabilityRules, ...technicalRules, ...hreflangRules]) {
    r.register(rule);
  }
  return r;
}
```

`src/rules/run.ts` — stream pages in batches (memory contract), batch-insert findings:

```ts
import { asc, eq, gt, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issues, pages } from "../db/schema.js";
import type { Registry } from "./registry/registry.js";
import type { Finding } from "./registry/types.js";

const PAGE_BATCH = 500;
const INSERT_BATCH = 500;

export interface RunSummary { pagesScanned: number; findings: number; byRule: Record<string, number> }

export async function runRules(db: Db, crawlId: string, registry: Registry): Promise<RunSummary> {
  const summary: RunSummary = { pagesScanned: 0, findings: 0, byRule: {} };
  const buffer: Finding[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    for (let i = 0; i < batch.length; i += INSERT_BATCH) {
      await db.insert(issues).values(batch.slice(i, i + INSERT_BATCH).map((f) => ({
        crawlId, ruleId: f.ruleId, pageId: f.pageId, severity: f.severity,
        dedupeKey: f.dedupeKey, details: { pageUrl: f.pageUrl, ...f.evidence },
      }))).onConflictDoNothing();
    }
  };

  const record = (f: Finding) => {
    buffer.push(f);
    summary.findings += 1;
    summary.byRule[f.ruleId] = (summary.byRule[f.ruleId] ?? 0) + 1;
  };

  const pageRules = registry.byKind("page");
  let cursor = "";
  for (;;) {
    const batch = await db.select().from(pages)
      .where(and(eq(pages.crawlId, crawlId), gt(pages.id, cursor)))
      .orderBy(asc(pages.id)).limit(PAGE_BATCH);
    if (batch.length === 0) break;
    for (const page of batch) {
      summary.pagesScanned += 1;
      for (const rule of pageRules) {
        try {
          for (const f of rule.run(page)) record(f);
        } catch (error) {
          await flush();
          throw new Error(`rule '${rule.id}' threw on page ${page.url}`, { cause: error });
        }
      }
    }
    if (buffer.length >= INSERT_BATCH) await flush();
    cursor = batch[batch.length - 1]!.id;
  }

  for (const rule of registry.byKind("query")) {
    try {
      for (const f of await rule.run(db, crawlId)) record(f);
    } catch (error) {
      await flush();
      throw new Error(`rule '${rule.id}' threw`, { cause: error });
    }
    await flush();
  }
  await flush();
  return summary;
}
```

- [ ] **Step 3: Run** — `DATABASE_URL=… npm test -- test/rules/run.test.ts && npx tsc --noEmit` → green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: buildRegistry + streaming rule runner writing issues rows"
```

---

### Task 8: Fixture app + BAD content absorb + harness core (P2-T4)

**Files:**
- Create: `test/fixtures/fixture.ts` (the ~20-line contract), `test/fixtures/app.ts` (HTTP server), `test/fixtures/pages/absorbed.ts` (BAD content), `test/fixtures/pages/control.ts`
- Test: `test/fixtures/harness.test.ts`

**Interfaces:**
- Consumes: `runCrawl` (loop), `buildRegistry`/`runRules` (Task 7), `createDb`.
- Produces: `Fixture` type + `allFixtures(): Fixture[]` + `startFixtureApp(fixtures): Promise<{ base: string; close(): Promise<void> }>`. Task 9 adds fixtures to the same collection.

- [ ] **Step 1: The fixture contract** (`test/fixtures/fixture.ts`):

```ts
export interface Fixture {
  path: string;                       // "/on-page/title-missing"
  category: string;                   // "on-page"
  name: string;
  expectedIssues: string[];           // rule ids that MUST fire for this path
  handler: (req: import("node:http").IncomingMessage,
            res: import("node:http").ServerResponse) => void;
}
```

- [ ] **Step 2: The app** (`test/fixtures/app.ts`): a `node:http` server that (a) serves `/` as a hub page linking to every fixture path plus `/control` (so the crawler reaches everything at depth 1); (b) serves `/robots.txt` (allow all, no crawl-delay) and no sitemap; (c) dispatches other paths to their fixture's `handler`; 404 otherwise. Bind `127.0.0.1`, port 0. Special-behavior routes needed by Task 9 fixtures (register as fixtures like any other): a 503 route, a 403 route, a route that sleeps 1600ms before responding, and a `/deep/1` → `/deep/2` → … `/deep/7` chain (each page links only to the next).

- [ ] **Step 3: Absorb BAD fixture content.** Fetch the fixture page sources at the pinned sha:

```bash
mkdir -p .tmp/upstream
curl -fsSL "https://api.github.com/repos/every-app/open-seo/git/trees/c469a48ae90ab58413b198fe3d1ac1aa90a9b070?recursive=1" -o .tmp/upstream/tree.json
# locate badseo fixture files in the tree (badseo/src/fixtures/*.ts), curl each raw
```

Take the page CONTENT (the HTML each fixture serves and its intent), not the TanStack plumbing (build plan §2). Port into `test/fixtures/pages/absorbed.ts` as `Fixture[]` entries with our handler shape and a provenance header (repo, `badseo/src/fixtures/`, sha, "content only; harness and Fixture type are ours"). Map each absorbed page's intent to OUR rule ids in `expectedIssues` (e.g. their missing-title page → `["title.missing"]`). Where an absorbed page targets a rule Ariadne does not have yet (query/metric rules of later phases), keep the page with `expectedIssues: []` and a comment naming the future phase — do NOT delete content we will need.

- [ ] **Step 4: The control page** (`test/fixtures/pages/control.ts`): one fixture at `/control` engineered to fire NOTHING — title 38 chars, meta description 110 chars, one h1 with clean 1→2→3 hierarchy, 300+ words of real text, viewport meta, every img with alt+width+height, self-referential canonical (absolute), no robots directives, fast response, no hreflang, no lorem. `expectedIssues: []`.

- [ ] **Step 5: The harness** (`test/fixtures/harness.test.ts`):

```ts
// beforeAll: db = createDb(databaseUrl()); app = await startFixtureApp(allFixtures());
// crawl once: summary = await runCrawl(db, { siteUrl: app.base, maxPages: 500, maxDepth: 10,
//   userAgent: "AriadneBot-fixture", perHostDelayMs: 0, maxConcurrency: 8, allowPrivate: true });
// registry = buildRegistry(); await runRules(db, summary.crawlId, registry);
// load all issues rows for the crawl into issuesByPath (Map<path, Set<ruleId>>)

it("every fixture's expected issues fire on its path", () => {
  for (const f of allFixtures()) for (const ruleId of f.expectedIssues) {
    expect(issuesByPath.get(f.path), `${f.path} should fire ${ruleId}`).toContain(ruleId);
  }
});
it("no rule fires on the control page", () => {
  expect(issuesByPath.get("/control") ?? new Set()).toEqual(new Set());
});
it("every registered rule fires on at least one fixture", () => {
  const fired = new Set([...issuesByPath.values()].flatMap((s) => [...s]));
  for (const rule of registry.all()) {
    expect(fired, `rule ${rule.id} never fired — add a fixture or delete the rule`).toContain(rule.id);
  }
});
```

The third test WILL fail until Task 9 authors the missing fixtures — that is the point; mark it `it.fails` is forbidden (silent-pass shape). Instead: in THIS task, scope the third assertion to the rules the absorbed+special fixtures already claim by asserting the exact currently-unclaimed list (like the coverage pattern), with a comment that Task 9 empties it:

```ts
const UNCLAIMED_UNTIL_TASK_9: string[] = [/* exact ids still missing after Step 3–4 — fill from the run */];
```

Task 9 deletes that list and enables the strict form. The hub page `/` will legitimately fire rules (it is not the control) — exclude `/` from the control assertion only.

- [ ] **Step 6: Run** — `DATABASE_URL=… npm test -- test/fixtures/harness.test.ts && npx tsc --noEmit` → green. Delete `.tmp/upstream`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: fixture app, BAD content absorb, control page, harness core (P2-T4)"
```

---

### Task 9: Author the missing fixtures — every rule claimed (P2-T5)

**Files:**
- Create: `test/fixtures/pages/authored.ts`
- Modify: `test/fixtures/harness.test.ts` (strict third assertion), `test/fixtures/app.ts` (only if a fixture needs server behavior not yet supported)

**Interfaces:**
- Consumes: `Fixture` contract, the app, the harness.
- Produces: a complete fixture set — every one of the 28 registered rules claimed by ≥1 fixture.

- [ ] **Step 1: Author one fixture per still-unclaimed rule.** From the Phase-2-relevant slice of build plan §2's new-fixture list plus this plan's rule set, the authored fixtures (each an entry in `authored.ts`; each `expectedIssues` names every rule its page fires, not just the target — the harness asserts supersets per path, and unexpected extras on a fixture are fine as long as the control stays clean):

| path | target rule(s) | page recipe |
|---|---|---|
| `/authored/title-short` | title.too-short | title "Widgets" (7 chars), rest clean |
| `/authored/title-long` | title.too-long | 80-char title |
| `/authored/meta-short` | meta-description.too-short | 40-char description |
| `/authored/meta-long` | meta-description.too-long | 200-char description |
| `/authored/h1-multiple` | headings.h1-multiple | two h1s |
| `/authored/heading-skip` | headings.level-skip | h1 then h3 |
| `/authored/thin` | content.thin | 60 words |
| `/authored/lorem` | content.placeholder | 200 words containing "Lorem ipsum dolor sit amet" |
| `/authored/server-error` | http.server-error | handler responds 503 with html |
| `/authored/blocked` | crawl.blocked | handler responds 403 |
| `/authored/canonical-none` | canonical.missing | indexable page, no canonical anywhere |
| `/authored/canonical-elsewhere` | canonical.points-elsewhere | canonical → `/control` |
| `/authored/canonical-multiple` | canonical.multiple | two `<link rel=canonical>` |
| `/authored/canonical-conflict` | canonical.html-header-conflict (+ points-elsewhere) | html canonical self, `Link:` header canonical → `/control` |
| `/authored/canonical-crossdomain` | canonical.cross-domain (+ points-elsewhere) | canonical → `https://other.example/x` |
| `/authored/canonical-noindex` | directive.canonical-noindex-conflict (+ indexability.noindex, canonical.points-elsewhere) | canonical → `/control` + `<meta name=robots content=noindex>` |
| `/authored/noindex-meta` | indexability.noindex | meta noindex only |
| `/authored/noindex-conflict` | indexability.meta-header-conflict | meta `index,follow`, `X-Robots-Tag: noindex` header |
| `/authored/hreflang-bad-code` | hreflang.invalid-code | `<link rel=alternate hreflang="english-uk" href=...>` |
| `/authored/hreflang-no-xdefault` | hreflang.missing-x-default | valid `en` + `de` pair, no x-default |
| `/authored/no-viewport` | mobile.viewport-missing | clean page minus viewport |
| `/authored/img-no-dimensions` | images.missing-dimensions | img with alt but no width/height |
| `/authored/img-no-alt` | images.missing-alt | img with dimensions, no alt |
| `/authored/slow` | performance.slow-response | handler sleeps 1600ms |
| `/deep/7` | structure.deep-page | reached only through the `/deep/1..6` chain (depth 7 > 5) |

Every authored page starts from the control recipe and breaks exactly its target signals, so `expectedIssues` stays short and intentional.

- [ ] **Step 2: Flip the harness strict.** Delete `UNCLAIMED_UNTIL_TASK_9`; the third assertion now iterates `registry.all()` unconditionally. Also assert per-fixture set EQUALITY for the authored fixtures (they declare complete expectations): `expect(issuesByPath.get(f.path)).toEqual(new Set(f.expectedIssues))` for fixtures under `/authored/` and `/deep/7`; absorbed fixtures keep the superset assertion (their pages may trip rules their upstream authors didn't target).

- [ ] **Step 3: Run** — `DATABASE_URL=… npm test -- test/fixtures/harness.test.ts` → green; then the full suite + typecheck.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: authored fixtures — every page rule claimed, control clean (P2-T5)"
```

---

### Task 10: Coverage pin, CI workflow, gate record

**Files:**
- Create: `test/rules/coverage.test.ts`, `.github/workflows/ci.yml`, `docs/gates/phase-2.md`

**Interfaces:**
- Consumes: `buildRegistry`, `CRAWL_CHECK_IDS`, `AGENT_CHECKS`.
- Produces: the recorded Phase 2 gate. Phase 3 will tighten the coverage pin to empty.

- [ ] **Step 1: The coverage pin** (`test/rules/coverage.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/rules/index.js";
import { AGENT_CHECKS, CRAWL_CHECK_IDS } from "../../src/rules/registry/registry.js";

describe("checklist coverage", () => {
  it("pins exactly which crawl-derived checks remain unclaimed (Phase 3 empties this)", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    expect(unclaimed.sort()).toEqual([
      "CHECK-01","CHECK-02","CHECK-03","CHECK-06","CHECK-07","CHECK-08","CHECK-09",
      "CHECK-10","CHECK-11","CHECK-14","CHECK-15","CHECK-19","CHECK-22","CHECK-23",
      "CHECK-24","CHECK-26","CHECK-27","CHECK-28","CHECK-29","CHECK-30","CHECK-32",
      "CHECK-33","CHECK-33b","CHECK-34","CHECK-39","CHECK-43","CHECK-44","CHECK-45","CHECK-46",
    ]);
  });
});
```

(The list = 47 crawl-derived, minus the 3 AGENT checks, minus the 15 claimed by Phase 2 rules: 04, 05, 12, 13, 16, 17, 18, 20, 21, 25, 31, 35, 36, 37, 40. Adjust the literal to whatever the first run reports — but only after verifying by hand that every delta is a rule genuinely claiming a check, then commit the exact list. Drift in either direction fails CI from then on.)

- [ ] **Step 2: The CI workflow** (`.github/workflows/ci.yml`):

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: ariadne
          POSTGRES_PASSWORD: ariadne
          POSTGRES_DB: ariadne
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U ariadne" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://ariadne:ariadne@localhost:5432/ariadne
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run db:migrate
      - run: npm test
```

- [ ] **Step 3: Record the gate** (`docs/gates/phase-2.md`, one page): date, commit sha, rule count (28) with the kind split, fixture count, the three harness assertions and their result, the coverage pin state (claimed / agent / unclaimed counts), CI run link once the branch is pushed. State plainly that full 47-check coverage is the PHASE 3 gate; Phase 2's gate is fixture-harness green + CI enforcing it.

- [ ] **Step 4: Run the full suite + typecheck locally** → green. Verify the coverage literal matches reality.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: phase 2 gate — coverage pin, GitHub Actions CI, gate recorded"
```

---

## Self-Review (performed at authoring time)

- **Spec coverage:** P2-T1 → Tasks 4–5 (the OpenSEO-taxonomy rules); P2-T2 → Task 3; P2-T3 → Tasks 5–6 (priority order: canonical, indexability, hreflang, then traceable bonus; pagination/url-hygiene checks are query-kind and belong to Phase 3 per spec §4's kind column); P2-T4 → Task 8; P2-T5 → Task 9; gate → Tasks 9–10. Owner amendments: runner → Task 7, CI → Task 10, schema tidy → Task 1, untraceable-bonus deferral recorded in the header.
- **Known intentional deviations:** hreflang code rules are `query` kind (spec §4 lists CHECK-25 as "page"), because declarations live in the `hreflang` table, not on `PageRecord` — same evidence, honest kind. `content.thin` claims CHECK-13 alongside CHECK-40 (thin-content signal feeds soft-404 detection; the full CHECK-13 rule is Phase 3's). Security-headers/forms/duplicate-ids/metas-in-body rules deferred for lack of checklist ids (hard rule 10) — revisit if the checklist grows ids for them.
- **Type consistency:** `pageRule` helper, `finding`, `isAuditable`, `buildRegistry`, `runRules`, `Fixture`, `allFixtures`, `startFixtureApp` are each defined once in their producing task and used by name in consuming tasks. Column names in Task 1 match the drizzle property names Tasks 2/4–6 read (`canonicalCount`, `hasViewport`, `imagesMissingDimensions`, `hasLoremIpsum`).
- **Placeholder scan:** the two deliberate at-execution-time blanks are the Task 3 copy text (the lift IS the task; transcribing ~100 issue texts into the plan would duplicate the upstream files) and the two pinned lists (Task 8's `UNCLAIMED_UNTIL_TASK_9`, Task 10's coverage literal), which must be filled from real runs and verified by hand — both are pin-the-truth steps, not TBDs.
