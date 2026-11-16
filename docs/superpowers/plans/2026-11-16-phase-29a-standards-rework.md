# Phase 29a rework: web standards, not Google, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remove every Google profile from 29a and report structured-data facts judged only
against schema.org and the JSON-LD, Microdata and RDFa specs.

**Architecture:** the validator stops matching nodes to Google features and instead records
facts in the blob:

- empty values;
- defined and referenced ids;
- each top-level node's properties.

Two per-page rules and one metric read those facts. The listing and CSV expose the property
inventory in place of Google features.

**Tech Stack:** TypeScript strict ESM, Postgres 16, drizzle, vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`, §29a and its
"29a amendment (2026-11-16)". The amendment wins wherever it differs.

## Global Constraints

- The global constraints of the 29a plan (`2026-11-13-phase-29a-structured-data.md`) still bind:
  - hard rules 1–10;
  - no silent fallbacks;
  - severities only critical, warning or info, and no `schema.*` rule is critical;
  - commits end with the two trailer lines.
- **No Google.** No code, copy, comment or doc in the structured-data path may justify a
  finding by Google, rich results or any one engine. Copy cites schema.org or the format specs.
- `RULESET_VERSION` stays `0.26.0` (unshipped). Add its dated comment line naming the rework.
  `EXTRACTION_VERSION` stays 4, since extraction is unchanged.
- No migration. `validation_jsonb` is rewritten by the next rules run. A blob in the old shape
  is refused by the strict schema with the existing "re-run the rules" message, never read.
- The tests run on the dev DB, `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`.
  Never touch `ariadne_gate29a` except in the gate task.

## Review Focus

1. **An empty value inside a nested node.** Example: `offers: {price: ""}` reports
   `offers.price`, not `offers`.
2. **A reference defined in another block on the same page**, such as a Yoast graph split over
   two scripts. It is resolved, not reported.
3. **A reference to an absolute IRI on another site.** It is reported (info) with the IRI, and
   the copy says linking out is legal.
4. **A node whose type is outside the vocabulary.** It still counts in `property-coverage`
   under its stated type name.
5. **Pages with hundreds of nodes.** The per-node property lists stay capped (`MAX_PROBLEMS_PER_LIST`
   pattern), and the truncation is recorded.

---

### Task R1: Validator facts, Google profiles removed

**Files:**
- Delete: `src/rules/schema-org/google-features.ts`, `test/rules/google-features.test.ts`
- Modify: `src/rules/schema-org/validate.ts`, `src/rules/schema-org/values.ts` (keep only what
  the new facts use), `test/rules/schema-validate.test.ts`

**Interfaces.** Produces the blob fields that replace `googleFeatures` and `deprecatedFeatures`
in `blockValidationSchema`:

- `emptyValues: {path, type, property}[]` (capped);
- `definedIds: string[]` and `references: {path, id}[]` (capped; bare references only);
- `nodes: {path, type, properties: string[]}[]` (top-level nodes only, capped).

Every list records `listsCapped` as today.

- [ ] Write the failing tests, then implement:
  - `""`, `"   "`, `[]` and `{}` (no keys, no `@id`) are empty;
  - `0`, `false`, `{"@id": "x"}` and a node with any property are not;
  - nested paths are reported in dotted form;
  - `@graph` members are each a top-level node.
- [ ] Remove `googleFeatures` and `deprecatedFeatures` and every helper only they used. Keep the
  `@context` propagation and the hierarchy helpers that other rules still use.
- [ ] Commit `refactor(schema): validator records standards facts; Google profiles removed (29a rework R1)`.

### Task R2: Rules, copy and registry

**Files:** `src/rules/query/schema-validation.ts`, `src/rules/query/structured-data.ts` (copy
of self-serving), `src/rules/registry/{registry.ts,triage.ts}`,
`src/rules/registry/copy/issue-copy.ts`, the related tests (`schema-validation-query`, `copy`,
`copy-render`, `run`, `coverage`).

- [ ] **Delete** `schema.google-required-missing`, `schema.google-recommended-missing` and
  `schema.deprecated-feature`.
- [ ] **Add** two per-page rules, both claiming CHECK-43:
  - `schema.empty-value` (warning), listing `{format, path, type, property}`;
  - `schema.unresolved-reference` (info). It is resolved per page: a reference resolves if any
    block on the same page defines its id.
- [ ] **Add** the metric `schema.property-coverage`, claiming CHECK-44. It reports one row per
  top-level type, with the node count and per-property node counts. Mirror an existing
  per-type metric's shape (`content.metrics-by-type`).
- [ ] **Reword** `schema.self-serving-reviews` copy and its comments as a fact, with no Google
  policy. Its logic is unchanged.
- [ ] **Copy:**
  - every new and changed rule cites schema.org or the format spec;
  - the copy-render snapshot deltas are spelled out (`CHANGED_SINCE_0_22` where the
    mechanism requires);
  - the registry totals are re-derived.
- [ ] Commit `feat(rules): schema.empty-value, schema.unresolved-reference, schema.property-coverage; Google rules removed (29a rework R2)`.

### Task R3: Listing and CSV

**Files:** `src/api/{service.ts,structured-data.ts,mcp.ts,http.ts,csv.ts}`, `test/api/structured-data.test.ts`, the CSV tests.

- [ ] **Listing:** the `structured_data` listing drops `googleFeatures` and the `feature` filter,
  and gains `nodes` from the blob. An unknown filter name is refused loudly, as today's unknown
  `format` is.
- [ ] **CSV:** the `structured_data_nodes` Problem vocabulary drops the Google problems and gains
  `empty-value` and `unresolved-reference`.
- [ ] Commit `feat(api): structured_data lists each page's nodes and properties (29a rework R3)`.

### Task R4: Fixtures and harness

**Files:** `test/fixtures/pages/authored-p29a.ts`, `authored-p3.ts`, `test/fixtures/harness.test.ts`.

- [ ] **Re-point the fixture pages** whose only purpose was a Google rule:
  - `event-no-date`, `faq` and the `/authored3/` incomplete product become, for example, an
    empty-value page and an unresolved-reference page, each `exact: true`;
  - the clean pages stay clean.
- [ ] **Re-derive the harness counts** honestly:
  - the per-rule `toEqual` map;
  - `FIXTURE_COLUMN_RULES`;
  - `SKIP_HARNESS_CLAIMS` (stays 26);
  - the `property-coverage` metric rows.
- [ ] Commit `test(fixtures): 29a rework fixtures (29a rework R4)`.

### Task R5: Docs and gate

**Files:** `skills/ariadne-audit/checklist.md` (CHECK-43, 44 and 46), `docs/talos-surface.md`,
`docs/talos-integration.md`, `skills/ariadne-crawl/SKILL.md`, `docs/gates/phase-29a.md`.

- [ ] **Docs.** No Google framing remains in the structured-data docs. Run
  `grep -n -i google` over the changed sections; any hit left must be a historical gate record.
  The `test/skills` identifier guard stays green.
- [ ] **Gate:**
  - **Clause 1:** the harness.
  - **Clause 2, as restated:**
    - re-run the rules on `crawl_8b55e8e6-…` in `ariadne_gate29a`, with no fetch;
    - sample 20 pages across its page types, and compare the reported nodes and properties
      against the page source and validator.schema.org, with 0 mismatches;
    - check every empty-value and unresolved-reference finding against the source.
  - **Clause 3:** `scripts/gate-rules.ts` 50k, peak ≤ 290.2 MB.
  - **Clause 4:** coverage.
- [ ] **Gate doc.** Rewrite `docs/gates/phase-29a.md`:
  - §2 becomes the restated clause;
  - the Rich Results Test history moves to "What did not go as first written";
  - the open items lose the Google ones.
- [ ] Commit `docs: 29a rework — checklist, Talos surface, gate (29a rework R5)`.
