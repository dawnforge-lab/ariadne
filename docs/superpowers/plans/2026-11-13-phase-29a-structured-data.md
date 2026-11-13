# Phase 29a — Structured Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read microdata and RDFa Lite next to JSON-LD, validate every node against a pinned
schema.org vocabulary and against Google's rich-result requirements, and report it all as
`schema.*` findings, a `structured_data` listing and a per-node CSV view.

**Architecture:**
- **Extraction.** Two small streaming state machines (`microdata.ts`, `rdfa.ts`) are driven
  from the analyzer's existing `onopentag` / `ontext` / `onclosetag` hooks. They emit nodes in
  the JSON-LD shape into the same `structuredData` array.
- **Storage.** `structured_data` gains an id, a format and a `validation_jsonb` column.
- **Validation.** A rules-time derivation fills `validation_jsonb` from the vocabulary and the
  Google profiles, in batches. The rules are SQL reads of that column, so a vocabulary or
  profile change re-judges an old crawl on a re-run (hard rules 2 and 6).
- **Retirement.** `schema.product-incomplete`, `deriveFieldPresence` and `field_presence_jsonb`
  are retired into the Google Product profile.

**Tech Stack:** TypeScript strict ESM, htmlparser2 (streaming only), drizzle-orm / drizzle-kit,
Postgres 16, vitest, zod, cheerio as the test oracle only.

**Spec:** `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md` (§29a, Gates 29a,
Calls 3, 7, 8, 9, 13). Owner approved it on 2026-11-13 ("Go ahead").

## Global Constraints

- **Hard rule 4:** no DOM on the hot path. Microdata and RDFa are read by the streaming
  tokenizer, and cheerio appears only in tests.
- **Hard rule 6:** RAM is O(concurrency), never O(URLs). The derivation streams by id cursor.
  The vocabulary and the profiles are static and bounded.
- **The 50k gate:** local peak at most **290.2 MB**. CI follows the weekly gate.yml series.
- **Hard rules 1 and 7:** every family has a not-measured state.
  - A crawl below extraction version 4 is named by `extraction.not-recorded`.
  - A rule whose answer depends on microdata or RDFa refuses a crawl that is not wholly v4.
  - A null `validation_jsonb` on a judged row throws "re-run the rules". It never reads as
    clean.
- **Hard rule 8:**
  - The vocabulary file carries a provenance header: release, sha256 of the source file,
    release date, changes.
  - It also gets a `THIRD_PARTY_NOTICES.md` entry, licence **CC BY-SA 3.0**, attribution
    "schema.org".
  - Never read GPL/AGPL validators for guidance.
- **Hard rule 10:** every new rule carries `checkIds`.
  - CHECK-43 for all of them.
  - The two Google rules also claim CHECK-44.
  - `test/rules/coverage.test.ts` stays green.
- **Severities** are only `critical | warning | info`. No `schema.*` rule is critical.
- **Migrations** come only from `npm run db:generate`, or from `npx drizzle-kit generate --custom
  --name <name>` for data-only SQL, and are applied with `npm run db:migrate`. Never hand-apply
  SQL to any database. The next free number is 0051.
- **`EXTRACTION_VERSION` becomes 4.** `RENDER_CAPTURE_VERSION` is unchanged.
- **`RULESET_VERSION` goes `0.25.1` → `0.26.0`,** with a dated entry in the comment block above
  it in `src/rules/registry/registry.ts`.
- **Tests run on the dev DB:**
  `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test`. `npx tsc --noEmit`
  stays clean.
- **Commit trailer:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2`.
  Update the Serena memory `phase-28b-status` after each commit, under the Phase 29 heading.
- **No fallbacks.**
  - A row this engine could not have written throws, naming the crawl and the row.
  - A value outside a closed vocabulary is refused, never coerced.
- **Thresholds:**
  - `SCHEMA_TEMPLATE_SHARE`: percent, range 50–100, default **70**.
  - `SCHEMA_TEMPLATE_MIN_PAGES`: range 2–100000, default **10**.
  - Both are overridable per crawl.

## Rulings made while planning (my calls; the controller ledgers them as R0.x)

- **R0.1 — Pending versus superseded.** "A pending property is reported as info" needs its own
  rule id, because severity is per rule (`queryFinding`). The info half is
  `schema.property-pending-or-superseded`. Superseded properties, which are still in core, go
  there too, so the vocabulary's status flag has a reader. That makes nine new rules where the
  spec's table shows eight.
- **R0.2 — Untyped nested items.** An `itemscope` without a resolvable `itemtype` is a
  microdata error only at the top level, where nothing can type it. A nested untyped item, such
  as `itemprop="address" itemscope`, is legal microdata and is stored as an untyped nested node.
- **R0.3 — Findings are per page.** Each per-node rule writes one finding per page, with up to
  20 problems in its evidence plus the full count. The CSV view `structured_data_nodes` is the
  per-node detail. The Google rules judge each node on its own, as the Rich Results Test does,
  so a page with one complete and one incomplete Product fires. That replaces field presence's
  "union across blocks".
- **R0.4 — Which nodes the Google features match.**
  - Review and AggregateRating match at any depth, and `itemReviewed` is waived when they are
    nested.
  - Every other feature matches top-level nodes only. Under-reporting is the safe direction for
    the 0-false-positive gate.
  - Organization is skipped on a node that matches LocalBusiness.
  - The merchant-listing variant applies only when `offers` holds at least one node typed
    `Offer` (not `AggregateOffer`).
- **R0.5 — Which vocabulary a name is in.**
  - These are schema.org names: a bare name, `schema:X`, and `http(s)://(www.)schema.org/X`.
  - Any other IRI or prefix is outside the vocabulary: counted, never judged.
  - A JSON-LD block whose `@context` names a non-schema.org `@vocab` or string context is wholly
    outside.
  - `@`-keywords are never properties.
- **R0.6 — The stored type name.** `structured_data.schema_type` holds the schema.org name for
  new rows (`schemaOrgName(type) ?? type`). Old rows keep their raw spelling, and the derivation
  normalises when it reads.
- **R0.7 — Site rules gated on v4.** `schema.none-on-site`, `schema.breadcrumb-absent` and
  `schema.template-inconsistent` refuse a crawl that is not wholly v4. On such a crawl a
  microdata-only site would read as having no structured data. The per-node rules still judge
  an old crawl's JSON-LD rows.
- **R0.8 — Listing counts.** The listing's counts are `warningCount` and `infoCount`, named
  after the registry's severities. The spec says "error and warning counts", but there is no
  error severity.
- **R0.9 — Microdata text.** Microdata text values are read outside `NON_CONTENT_TAGS`, the same
  scope as the visible text. Inside `<template>` and `<noscript>` nothing is read, because those
  subtrees are inert or raw text.

## Review Focus

1. **Malformed or implied nesting.**
   - Cases: an unclosed `<div itemscope>`, a `<p>` closed implicitly by a block element, a
     document that ends inside an open item.
   - Expected: items close by the depth they opened at, never by tag name, and a document that
     ends early still emits its open items. Pinned by the T2 cheerio parity test.
2. **Every spelling of a type.**
   - Cases: an `@type` array, a full URL, `schema:` prefixes, `@graph` containers, a missing
     `@context`, `itemtype` holding two URLs.
   - Expected: the same node always gets the same verdict, whatever the spelling. Pinned in T5.
3. **Mixed formats on one page.**
   - Case: JSON-LD Product plus microdata Product plus RDFa Organization.
   - Expected: each node is judged once, and the 50-block cap is shared across formats. Pinned
     in T3 and T5.
4. **Adversarial size.**
   - Cases: 10,000 `itemprop` values, nesting 200 deep, a 1 MB text node inside an `itemprop`.
   - Expected: bounded memory, no stack overflow, and every drop counted in
     `structured_data_skips`. Pinned in T2.
5. **Old crawls.**
   - Case: a crawl written at v3 and judged by 0.25.1, so `validation_jsonb` is null.
   - Expected: the listing refuses with "re-run the rules", the per-node rules still judge its
     JSON-LD after a re-run, the site rules stay silent, and `extraction.not-recorded` speaks.
     Pinned in T8 and T9.

---

### Task 1: The schema.org vocabulary

**Files:**
- Create: `scripts/derive-schema-org.ts`
- Create: `src/rules/schema-org/vocabulary.generated.ts` (generated, committed)
- Create: `src/rules/schema-org/vocabulary.ts`
- Create: `src/crawl/parse/schema-names.ts`
- Modify: `THIRD_PARTY_NOTICES.md`
- Test: `test/rules/schema-org-vocabulary.test.ts`, `test/crawl/schema-names.test.ts`

**Interfaces:**
- Produces, in `src/crawl/parse/schema-names.ts`. It lives in the crawl layer because the
  writer needs it too.
  - `schemaOrgName(term: string): string | null`.
  - `SCHEMA_ORG_CONTEXT = "https://schema.org"`.
- Produces, in `vocabulary.generated.ts`:
  - `SCHEMA_ORG_RELEASE: string`;
  - `SCHEMA_ORG_TYPES: Readonly<Record<string, readonly string[]>>`, mapping a type to its
    direct parents;
  - `SCHEMA_ORG_DATATYPES: readonly string[]`;
  - `SCHEMA_ORG_PROPERTIES: Readonly<Record<string, { domain: readonly string[]; range: readonly string[]; status?: "pending" | "superseded"; supersededBy?: string }>>`.
- Produces, in `vocabulary.ts`:
  - `isKnownType(name: string): boolean`;
  - `ancestors(name: string): ReadonlySet<string>`, which includes the type itself, is
    memoised, and throws for an unknown type;
  - `isSubtypeOf(name: string, of: string): boolean`;
  - `descendants(name: string): readonly string[]`, which includes the type itself and is
    sorted;
  - `propertyDef(name: string)`, which returns the entry or `undefined`;
  - `propertyAppliesTo(property: string, types: readonly string[]): boolean`;
  - `rangeAccepts(property: string, nodeTypes: readonly string[]): boolean`.

- [ ] **Step 1: Write the failing tests**

`test/crawl/schema-names.test.ts`:
```ts
expect(schemaOrgName("Product")).toBe("Product");
expect(schemaOrgName(" schema:Product ")).toBe("Product");
expect(schemaOrgName("https://schema.org/Product")).toBe("Product");
expect(schemaOrgName("http://www.schema.org/Product")).toBe("Product");
expect(schemaOrgName("https://example.org/Thing")).toBeNull();
expect(schemaOrgName("og:title")).toBeNull();
expect(schemaOrgName("")).toBeNull();
```
`test/rules/schema-org-vocabulary.test.ts`:
- `isSubtypeOf("Restaurant","LocalBusiness")` and `isSubtypeOf("Restaurant","Organization")`
  are true. `isSubtypeOf("Product","Organization")` is false.
- `descendants("Organization")` contains `"Restaurant"`, `"Corporation"` and
  `"Organization"`.
- `propertyAppliesTo("name",["Product"])` is true (domain Thing, through the ancestors).
  `propertyAppliesTo("recipeIngredient",["Product"])` is false.
- `rangeAccepts("offers",["Offer"])`, `rangeAccepts("offers",["AggregateOffer"])` (a subtype)
  and `rangeAccepts("author",["Person"])` are true. `rangeAccepts("author",["Offer"])` is
  false.
- `rangeAccepts(p, ["Role"])` and `rangeAccepts(p, ["OrganizationRole"])` are true for every
  property `p` (schema.org's Role pattern).
- At least one property has `status: "pending"` and at least one has `"superseded"` with a
  `supersededBy` that is itself a property.
- The header of the generated file names the release, a 64-hex sha256 and a date.
- No attic term appears: pick one known attic term from the release file and assert
  `isKnownType` or `propertyDef` misses it.

- [ ] **Step 2: Run the tests and see them fail.** Run
  `npx vitest run test/crawl/schema-names.test.ts test/rules/schema-org-vocabulary.test.ts`.
  Expected: FAIL, modules not found.

- [ ] **Step 3: Write `scripts/derive-schema-org.ts`.**
  - Usage: `npx tsx scripts/derive-schema-org.ts <schemaorg-all-https.jsonld> <release> <release-date>`.
  - Source: take the newest numbered release directory under
    `https://github.com/schemaorg/schemaorg/tree/main/data/releases/` at implementation time, and
    download `schemaorg-all-https.jsonld` from it into the scratchpad.
  - Keep core and pending terms. Drop terms whose `schema:isPartOf` is the attic. Record
    pending status from `schema:isPartOf` `https://pending.schema.org` and superseded from
    `schema:supersededBy`.
  - Types are `rdfs:Class` entries. DataTypes are classes typed `schema:DataType`, or
    subclasses of one.
  - The output is sorted by key, so a re-run is byte-identical.
  - The header follows `serp-glyphs.generated.ts`'s form: "GENERATED by
    scripts/derive-schema-org.ts. Do not edit by hand", the release, the source sha256, the
    release date, and the changes ("attic terms dropped; enumeration members dropped;
    comments/labels dropped"), plus the CC BY-SA 3.0 attribution line.
  - The header also says that a re-derivation is a deliberate commit that bumps
    `RULESET_VERSION`. It is never synced automatically (spec §29a).

- [ ] **Step 4: Write `schema-names.ts` and `vocabulary.ts`.** `rangeAccepts` is true when any
  `ancestors(nodeType)` member is in the range, when the range includes `Thing`, or when the
  node type is `Role` or a subtype of it.

- [ ] **Step 5: Add `THIRD_PARTY_NOTICES.md` entry:** "schema.org vocabulary — derived data in
  src/rules/schema-org/vocabulary.generated.ts; release <r>; CC BY-SA 3.0; © schema.org
  contributors; changes as in the file header". Keep the existing entries' layout.

- [ ] **Step 6: Run the tests and see them pass.** Run the same command. Expected: PASS.

- [ ] **Step 7: Commit:** `feat(schema): pinned schema.org vocabulary and name normaliser (29a T1)`

### Task 2: Microdata extraction

**Files:**
- Create: `src/crawl/parse/microdata.ts`
- Modify: `src/crawl/parse/page-analyzer.ts`:
  - `StructuredDataBlock` (around line 639);
  - the `PageAnalysis` / `RawPageAnalysis` fields;
  - the `onopentag`, `ontext` and `onclosetag` hooks;
  - the end of document;
  - `analyzePage`.
- Test: `test/crawl/microdata.test.ts`, `test/crawl/microdata-parity.test.ts`

**Interfaces:**
- Produces:
  - `type StructuredDataFormat = "jsonld" | "microdata" | "rdfa"`;
  - `StructuredDataBlock` gains `format: StructuredDataFormat`, and JSON-LD blocks say
    `"jsonld"`;
  - `interface StructuredDataSkips { microdataItemrefSkipped: number; rdfaUnsupported: number; valuesCapped: number }`;
  - `PageAnalysis` and `RawPageAnalysis` gain `structuredDataMicrodataErrors: number` and
    `structuredDataSkips: StructuredDataSkips`.
- Produces, in `microdata.ts`:
  `createMicrodataMachine(pageUrl: string, sink: BlockSink, counts: { errors: number; skips: StructuredDataSkips }): ItemMachine`.
  - `ItemMachine` is `{ open(name: string, attribs: Record<string,string>, depth: number): void; text(t: string): void; close(depth: number): void; end(): void }`.
  - `BlockSink` is `(block: StructuredDataBlock) => void`.
  - The analyzer owns the shared 50-block cap: its sink drops a block past
    `MAX_STRUCTURED_DATA_BLOCKS`.
- Constants (exported):
  - `MICRODATA_TEXT_MAX = 500` characters per text value, applied with `storableCap`;
  - `MAX_ITEM_VALUES = 1000` property values per page across microdata and RDFa;
  - `MAX_ITEM_DEPTH = 32` nested item levels.

**Node shape.**
- `{"@context":"https://schema.org","@type": T, "@id"?: itemid, <prop>: value | value[]}`.
- `@context` appears on top-level nodes only.
- `T` is `schemaOrgName(firstItemtype) ?? firstItemtype`. An `itemtype` holding several URLs
  takes the first one.
- A property seen once has a scalar value. A property seen again becomes an array, in document
  order.
- `itemprop="a b"` assigns the value to both names.

**Values** follow the spec §29a list exactly:
- `content` on `meta`;
- `href` / `src` on `a`, `link`, `img`, `audio`, `video`, `source`, `iframe`, `embed` and
  `track`, resolved against `pageUrl` with `new URL(v, pageUrl).href`, or the raw string when it
  does not parse;
- `datetime` on `time`;
- `value` on `data` and `meter`;
- otherwise the collected text, with whitespace collapsed, trimmed and capped.

An element with both `itemprop` and `itemscope` gives a nested node as the value.

**Counts.**
- `errors += 1` for an `itemprop` with no open item scope, and for a top-level `itemscope`
  without a usable `itemtype` (R0.2).
- `skips.microdataItemrefSkipped += 1` per element carrying `itemref`.
- `skips.valuesCapped += 1` per value dropped by `MAX_ITEM_VALUES`.
- An item deeper than `MAX_ITEM_DEPTH` is not opened, and `errors += 1`. Its `itemprop`
  children attach to nothing and are not counted again.

**Placement.**
- `open` and `close` run below the `noscript` early return and only when `templateDepth === 0`
  (R0.9).
- Text is fed from `ontext` after the `suppressDepth` return.
- Items are popped by the `elementDepth` they opened at, the `hiddenOpenedAt` idiom.
- `end()` runs after `parser.end()` and closes every open item, outermost last.

- [ ] **Step 1: Write the failing unit tests** in `test/crawl/microdata.test.ts`, calling
  `analyzeHtml`:
  - `product with nested offer`: `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Mug</span><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="14.00"><link itemprop="availability" href="https://schema.org/InStock"></div></div>`
    gives `structuredData` equal to
    `[{type:"Product",format:"microdata",raw:{"@context":"https://schema.org","@type":"Product",name:"Mug",offers:{"@type":"Offer",price:"14.00",availability:"https://schema.org/InStock"}}}]`.
  - `repeated property becomes an array`: two `itemprop="image"` `<img src>` values give
    `image: [absUrl1, absUrl2]`, resolved against the page URL.
  - `itemprop outside scope is an error`: `<span itemprop="name">x</span>` gives
    `structuredDataMicrodataErrors === 1` and no block.
  - `top-level untyped scope is an error, nested untyped is a node`.
  - `itemref counted, not followed`: gives `structuredDataSkips.microdataItemrefSkipped === 1`
    and none of the referenced properties.
  - `template and noscript are inert`: microdata inside both gives no block and no error.
  - `JSON-LD blocks say format jsonld`.
  - `shared block cap`: 30 JSON-LD nodes plus 30 microdata items give exactly 50 blocks.
  - Review Focus 4:
    - 10,000 `<meta itemprop="x" content="y">` in one item give 1,000 values and
      `valuesCapped === 9000`;
    - nesting 200 deep returns, with `errors` counting the levels past 32;
    - a 1 MB text inside `itemprop` gives a 500-character value.

- [ ] **Step 2: Write the failing parity test** `test/crawl/microdata-parity.test.ts`.
  - Write a small cheerio oracle in the test file that implements the same spec subset over a
    DOM.
  - Compare `analyzeHtml(...).structuredData.filter(b => b.format === "microdata")` with the
    oracle over:
    - every fixture page whose HTML contains `itemscope` (served by `startFixtureApp`);
    - six malformed snippets (Review Focus 1): an unclosed `div` item, an item inside an
      implicitly closed `<p>`, the document ending inside an item, an `itemprop` on a void
      element, an item inside `<table>` foster-parenting, and an `itemscope` on `<html>`.

- [ ] **Step 3: Run the tests and see them fail.** Run
  `npx vitest run test/crawl/microdata.test.ts test/crawl/microdata-parity.test.ts`.
  Expected: FAIL.

- [ ] **Step 4: Implement `microdata.ts` and wire it into the analyzer.** Also give every
  JSON-LD block `format: "jsonld"`, and add both new fields to the raw result and to the
  `analyzePage` facade.

- [ ] **Step 5: Run the tests and see them pass.** Then run the existing analyzer suites:
  `npx vitest run test/crawl/page-analyzer.test.ts src/crawl/parse/page-analyzer.upstream.test.ts test/crawl/analyzer-extensions.test.ts`.
  Expected: PASS. Update any snapshot that gained `format` only.

- [ ] **Step 6: Commit:** `feat(parse): streaming microdata extraction into the JSON-LD node shape (29a T2)`

### Task 3: RDFa Lite extraction

**Files:**
- Create: `src/crawl/parse/rdfa.ts`
- Modify: `src/crawl/parse/page-analyzer.ts` (the same hook points as T2)
- Test: `test/crawl/rdfa.test.ts`

**Interfaces:**
- Consumes: T2's `ItemMachine`, `BlockSink`, `StructuredDataSkips`, `MAX_ITEM_VALUES`,
  `MAX_ITEM_DEPTH`, `MICRODATA_TEXT_MAX` and `schemaOrgName`.
- Produces:
  `createRdfaMachine(pageUrl: string, sink: BlockSink, counts: { errors: number; skips: StructuredDataSkips }): ItemMachine`.
  `errors` is shared with microdata and is the same page counter.

**Semantics. RDFa Lite 1.1, schema.org only.**
- `vocab` sets the vocabulary for its subtree. It counts only when it is `https://schema.org/`
  or the `http` form, with or without the trailing slash.
- `prefix` may bind `schema:` to schema.org. `schema:` is understood without a binding (the
  RDFa initial context).
- `typeof` opens a node of that type. On an element that also has `property`, the node is the
  property's value in the enclosing node.
- `resource` on a `typeof` element becomes `@id`.
- `property` without `typeof` takes a value:
  - `content`;
  - else `resource`;
  - else `href` / `src` (resolved);
  - else `datetime` on `time`;
  - else the text, capped.
- The output is the T2 node shape with `format: "rdfa"`.
- **Unsupported:** `skips.rdfaUnsupported += 1` per element that carries any of these, and the
  element contributes nothing:
  - `rel`, `rev` or `about` alongside an RDFa attribute;
  - a `vocab` that is not schema.org;
  - a `typeof` or `property` term whose prefix is not `schema:`, or whose IRI is not
    schema.org.
- A `rel` on a plain `<a>` or `<link>` with no RDFa attribute is ordinary HTML and is not
  counted.
- A `property` with no enclosing `typeof` node is `errors += 1`.

- [ ] **Step 1: Write the failing tests.**
  - `organization via vocab`: `<div vocab="https://schema.org/" typeof="Organization"><span property="name">Estuary</span><a property="url" href="/">home</a></div>`
    gives `{type:"Organization",format:"rdfa",raw:{"@context":"https://schema.org","@type":"Organization",name:"Estuary",url:"<abs>/"}}`.
  - `schema prefix without vocab`: `typeof="schema:Product" property="schema:name"` is read.
  - `nested typeof is a property value`.
  - `full RDFa is counted, not misread`: `about=`, `rel=` on an RDFa element, and
    `vocab="http://xmlns.com/foaf/0.1/"` each give `rdfaUnsupported` incremented and no block.
  - `plain rel on a link is not RDFa`: `<link rel="canonical">` leaves `rdfaUnsupported === 0`.
  - `mixed formats on one page` (Review Focus 3): one JSON-LD, one microdata and one RDFa node
    give three blocks in document order with three formats.

- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run test/crawl/rdfa.test.ts`.
  Expected: FAIL.

- [ ] **Step 3: Implement and wire it, under the same placement rules as T2.**

- [ ] **Step 4: Run the tests and see them pass,** together with the T2 suites.

- [ ] **Step 5: Commit:** `feat(parse): RDFa Lite extraction, schema.org only, unsupported RDFa counted (29a T3)`

### Task 4: Storage, extraction version 4, and the marker

**Files:**
- Modify: `src/db/schema.ts`:
  - `structuredData`: add `id`, `format` and the `(crawl_id, id)` index;
  - `pages`: add `structured_data_microdata_errors` and `structured_data_skips`.
- Create: drizzle migrations 0051 and 0052, both generated.
- Modify: `src/crawl/persist.ts`, the structured-data rows (around line 340) and the page row
  (around line 934).
- Modify: `src/crawl/versions.ts` (`EXTRACTION_VERSION = 4`, docblock).
- Modify: `src/rules/query/page-facts.ts` (`V4`, `v4Gate`, the marker's bar).
- Test: `test/crawl/persist.test.ts`, `test/crawl/versions.test.ts`,
  `test/rules/page-facts-query.test.ts`, `test/rules/extraction-coverage.test.ts`

**Interfaces:**
- Produces:
  - `structured_data.id`: `bigserial("id", { mode: "number" }).primaryKey()`.
  - `structured_data.format`: `text("format").notNull()`, which is `StructuredDataFormat`.
  - `index("sd_crawl_id").on(t.crawlId, t.id)`.
  - `pages.structuredDataMicrodataErrors`: `integer("structured_data_microdata_errors")`,
    nullable. Null means a row written below v4, never zero.
  - `pages.structuredDataSkips`: `jsonb("structured_data_skips").$type<StructuredDataSkips>()`,
    nullable on the same terms.
  - `v4Gate(db, crawlId)`, with the same return shape as `v3Gate`.
- The writer stores `schemaType: schemaOrgName(block.type) ?? block.type` (R0.6) and
  `format: block.format`.

- [ ] **Step 1: Write the failing tests.**
  - persist: a page with one JSON-LD, one microdata and one RDFa block writes three rows with
    formats `jsonld` / `microdata` / `rdfa`. A JSON-LD `@type:"https://schema.org/Product"` is
    stored as `schema_type = 'Product'`. The page row has `extraction_version = 4`,
    `structured_data_microdata_errors = 0` and
    `structured_data_skips = {microdataItemrefSkipped:0, rdfaUnsupported:0, valuesCapped:0}`.
  - versions: `EXTRACTION_VERSION === 4`.
  - page-facts: a crawl whose pages are all v3 fires `extraction.not-recorded` with
    `requiredVersion: 4`. An all-v4 crawl with sitemap facts fires nothing.
    `v4Gate(...).recorded` is false on a mixed crawl.

- [ ] **Step 2: Run the tests and see them fail.**

- [ ] **Step 3: Generate the migrations.**
  1. Declare `format` as `text("format").notNull().default("jsonld")`, add the other columns,
     then run `npm run db:generate`. That gives 0051 with `ADD COLUMN "id" bigserial PRIMARY KEY`,
     the format column with its default, which backfills old rows, the index and the two pages
     columns.
  2. Remove `.default("jsonld")` and run `npm run db:generate` again. That gives 0052,
     `ALTER COLUMN "format" DROP DEFAULT`. From then on the writer must name the format, and no
     default can mislabel a microdata row.
  3. Apply with `npm run db:migrate` against the dev DB.

- [ ] **Step 4: Update the writer, the version and the marker.** In `notRecordedFindings`, raise
  the bar from `v3Gate` / `V3` to `v4Gate` / `V4`. Update the versions.ts docblock: "Version 4
  (Phase 29a, migrations 0051–0052) adds microdata and RDFa Lite nodes, `structured_data.format`,
  and the pages' microdata error and skip counts".

- [ ] **Step 5: Run the tests and see them pass.** Then run the full suite. Fix any test that
  hard-codes extraction version 3 as "current", and change only that.

- [ ] **Step 6: Commit:** `feat(db): structured_data id + format, page microdata counts, extraction v4 (29a T4)`

### Task 5: Google profiles and the node validator

**Files:**
- Create: `src/rules/schema-org/google-features.ts`
- Create: `src/rules/schema-org/validate.ts`
- Move: `hasValue`, `offersCarry` and `GTIN_FIELDS` from `src/rules/derive/field-presence.ts`
  into `src/rules/schema-org/values.ts`. `field-presence.ts` re-imports them until T6 deletes
  it.
- Test: `test/rules/schema-validate.test.ts`, `test/rules/google-features.test.ts`

**Interfaces:**
- Produces, in `google-features.ts`:
  - `GOOGLE_DOCS_READ = "<YYYY-MM-DD>"`, the date the implementer read the pages;
  - `interface Requirement { label: string; met(node: Record<string, unknown>, ctx: { nested: boolean }): boolean }`;
  - the helpers `has(path: string): Requirement`, `anyOf(label: string, ...reqs: Requirement[]): Requirement`
    and `unlessNested(req: Requirement): Requirement`;
  - `interface GoogleFeature { id: string; name: string; docUrl: string; appliesTo: readonly string[]; depth: "top" | "any"; applies?(node: Record<string, unknown>): boolean; skipWhen?: readonly string[]; required: readonly Requirement[]; recommended: readonly Requirement[] }`;
  - `GOOGLE_FEATURES: readonly GoogleFeature[]`;
  - `DEPRECATED_FEATURES: readonly { id: string; type: string; restriction: string }[]`.
- `has("offers.price")` reads "some member of `offers` (object or array) carries `price`", and
  that is how every dotted path reads. One is enough, as with `offersCarry`.
- Produces, in `validate.ts`:
  - `MAX_PROBLEMS_PER_LIST = 50`;
  - `validateBlock(raw: unknown): BlockValidation`;
  - `blockValidationSchema` (zod, strict), which readers parse stored blobs with;
  - `BlockValidation` = `{ topType: string | null; unknownTypes: {path,type}[]; unknownProperties: {path,type,property}[]; propertyStatus: {path,property,status:"pending"|"superseded",supersededBy:string|null}[]; typeMismatches: {path,property,type,expected:string[]}[]; googleFeatures: {feature,path,type,missingRequired:string[],missingRecommended:string[]}[]; deprecatedFeatures: {feature,path,type}[]; outsideVocabulary: number; listsCapped: boolean }`.
- Paths: `$` for the block, then `.prop` and `[i]`, for example `$.offers[0].seller`.

**Baseline profiles.** The implementer re-reads each Google Search Central page on the day,
sets `GOOGLE_DOCS_READ`, and makes the file match the page. Where a page now differs from this
table, the page wins and the difference goes in the task report.

| id | appliesTo (and subtypes) | depth | required | recommended |
|---|---|---|---|---|
| `article` | Article, NewsArticle, BlogPosting | top | none | author, author.name, author.url, dateModified, datePublished, headline, image |
| `breadcrumb` | BreadcrumbList | top | itemListElement; every ListItem: position, name; every ListItem but the last: item | — |
| `product-snippet` | Product | top | name; anyOf(review, aggregateRating, offers) | aggregateRating, review, offers |
| `merchant-listing` | Product, `applies` = offers holds an `Offer`-typed node (R0.4) | top | name, image, offers.price or offers.priceSpecification.price, offers.priceCurrency or offers.priceSpecification.priceCurrency | brand, description, sku, gtin (any `GTIN_FIELDS` spelling), mpn, offers.availability, offers.itemCondition, offers.shippingDetails, hasMerchantReturnPolicy or offers.hasMerchantReturnPolicy, aggregateRating, review, color, material, size, pattern |
| `review` | Review | any | author, unlessNested(itemReviewed), reviewRating, reviewRating.ratingValue | datePublished, reviewRating.bestRating, reviewRating.worstRating |
| `aggregate-rating` | AggregateRating | any | unlessNested(itemReviewed), ratingValue, anyOf(ratingCount, reviewCount) | bestRating, worstRating |
| `organization` | Organization, `skipWhen` = [`local-business`] | top | none | name, url, logo, sameAs, address, contactPoint, telephone, email, description |
| `local-business` | LocalBusiness | top | name, address | telephone, url, geo, openingHoursSpecification, priceRange, aggregateRating, review |
| `event` | Event | top | name, startDate, location; location.address when location is a Place | description, endDate, eventAttendanceMode, eventStatus, image, offers, organizer, performer |
| `recipe` | Recipe | top | name, image | aggregateRating, author, cookTime, datePublished, description, keywords, nutrition.calories, prepTime, recipeCategory, recipeCuisine, recipeIngredient, recipeInstructions, recipeYield, totalTime, video |
| `video` | VideoObject | top | name, thumbnailUrl, uploadDate | contentUrl, description, duration, embedUrl, expires, interactionStatistic, regionsAllowed |
| `job-posting` | JobPosting | top | title, description, datePosted, hiringOrganization, anyOf(jobLocation, applicantLocationRequirements) | baseSalary, employmentType, validThrough, directApply, identifier, jobLocationType |
| `software-app` | SoftwareApplication | top | name, offers.price, anyOf(aggregateRating, review) | applicationCategory, operatingSystem |

Deprecated features:
- `faq`, type FAQPage: "Google shows FAQ rich results only for well-known government and health
  sites (since August 2023)".
- `how-to`, type HowTo: "Google no longer shows HowTo rich results (since September 2023)".

**The walk, per node.**
- Resolve the node's types, from `@type` as a string or an array, through `schemaOrgName`
  (R0.5).
- No `@type` means an untyped node. Nothing is judged on it except its properties' nested
  nodes.
- A schema.org-looking name not in the vocabulary goes to `unknownTypes`.
- For each property key that is not an `@`-keyword:
  - Resolve it with `schemaOrgName`; null counts as `outsideVocabulary`.
  - Unknown, or not `propertyAppliesTo` the node's known types: `unknownProperties`. Skip this
    check when the node has no known type.
  - A `status`: `propertyStatus`.
  - For each nested node value with a known type, `rangeAccepts` false gives `typeMismatches`.
    String and number values are never judged against the range.
- Google features: a node matches when any resolved type `isSubtypeOf` an `appliesTo` entry,
  and `depth` and `applies` allow it. `skipWhen` drops a feature when a named feature also
  matched. Every match is recorded, even with empty missing lists, because the listing names
  matched features.
- Lists stop at `MAX_PROBLEMS_PER_LIST`, which sets `listsCapped`. Recursion stops at depth 64,
  which `MAX_LD_JSON_NESTING` already guarantees.

- [ ] **Step 1: Write the failing tests** in `test/rules/schema-validate.test.ts`:
  - `a valid product with offer has no problems and matches product-snippet and merchant-listing with empty missingRequired`.
  - `merchant listing missing image`: `missingRequired` contains `"image"` for `merchant-listing`,
    and `product-snippet` is satisfied.
  - `aggregate offer is not a merchant listing` (R0.4).
  - `Restaurant matches local-business and not organization` (hierarchy, `skipWhen`).
  - `nested review waives itemReviewed; top-level review requires it`.
  - `unknown type`: `@type:"Prodcut"` gives `unknownTypes [{path:"$",type:"Prodcut"}]`.
  - `unknown property`: `{"@type":"Product","colour":"red"}` gives `unknownProperties` with
    `colour`.
  - `pending property goes to propertyStatus, not unknownProperties`. Pick one pending property
    from the vocabulary.
  - `range mismatch`: `{"@type":"Product","offers":{"@type":"Person"}}` gives `typeMismatches`
    `[{path:"$.offers",property:"offers",type:"Person",expected:[...includes "Offer"]}]`.
  - `text where a type is expected is not a mismatch`: `author:"Jane"` gives none.
  - `FAQPage gives deprecatedFeatures faq`.
  - Spellings (Review Focus 2): `@type:["Product","Thing"]`, `"schema:Product"`,
    `"https://schema.org/Product"`, an `@graph` member, and a block without `@context` all give
    identical `googleFeatures`. A block with `@context: {"@vocab":"https://example.org/"}`
    gives `outsideVocabulary > 0` and no other lists.
  - `lists cap at 50 with listsCapped`.
  - `blockValidationSchema.parse(validateBlock(x))` round-trips for every case above.

  In `test/rules/google-features.test.ts`, every `appliesTo` entry and every type named in
  `DEPRECATED_FEATURES` must be `isKnownType`. Every top-level name in every requirement path
  must be a vocabulary property.

- [ ] **Step 2: Run the tests and see them fail.** Run
  `npx vitest run test/rules/schema-validate.test.ts test/rules/google-features.test.ts`.

- [ ] **Step 3: Implement the files.**

- [ ] **Step 4: Run the tests and see them pass.**

- [ ] **Step 5: Commit:** `feat(schema): Google rich-result profiles and the node validator (29a T5)`

### Task 6: The validation derivation; retire field presence and product-incomplete

**Files:**
- Create: `src/rules/derive/schema-validation.ts`
- Delete: `src/rules/derive/field-presence.ts` and `test/rules/derive-field-presence.test.ts`
- Modify: `src/db/schema.ts` (`structuredData`: drop `fieldPresence`, add `validation`), and
  generate a migration.
- Modify: `src/rules/run.ts` (the `derivations` list, the docblocks that name
  `deriveFieldPresence`, and the second ANALYZE comment).
- Modify: `src/rules/query/structured-data.ts` (remove the Product rule, `missingFields`,
  `PRODUCT_TYPE` and the profile load-check).
- Modify: `src/rules/registry/triage.ts` and `src/rules/registry/copy/issue-copy.ts` (remove
  the row and the copy).
- Modify: `src/crawl/persist.ts` (drop `fieldPresence: null`).
- Test: `test/rules/derive-schema-validation.test.ts`; adjust
  `test/rules/structured-data-query.test.ts` and `test/rules/run.test.ts`.

**Interfaces:**
- Produces:
  - `structured_data.validation`: `jsonb("validation_jsonb").$type<BlockValidation>()`,
    nullable; null means not yet derived.
  - `deriveSchemaValidation(db: Db, crawlId: string): Promise<{ blocks: number }>`.
  - `SCHEMA_VALIDATION_BATCH = 500` rows.
- Behaviour:
  - Ask `crawls` first, and throw for an unknown id.
  - Then loop: `select id, raw_jsonb from structured_data where crawl_id=$1 and id > $cursor order by id limit 500`.
  - `validateBlock` each row.
  - Write the batch back in one `update structured_data sd set validation_jsonb = v.val from (values …) v(id,val) where sd.crawl_id=$1 and sd.id=v.id`.
  - All of it inside one transaction, as `deriveFieldPresence` did.
  - Idempotent by recomputation.
  - It replaces `deriveFieldPresence` at the same position in `derivations`.
  - `ANALYZE … structured_data` after the derivations stays, and its comment now names
    `deriveSchemaValidation`.

- [ ] **Step 1: Write the failing tests.**
  - `writes a blob for every row`: three rows give `blocks === 3`, and every
    `validation_jsonb` parses with `blockValidationSchema`.
  - `idempotent`: a second run leaves identical blobs.
  - `unknown crawl throws`.
  - `batches`: 1,201 rows over 3 batches all get blobs.
  - run.test: the run summary's derivations name `deriveSchemaValidation`, not
    `deriveFieldPresence`.
  - `rules_catalog` no longer lists `schema.product-incomplete`.

- [ ] **Step 2: Run the tests and see them fail.**

- [ ] **Step 3: Implement the derivation, then retire the old pieces.**
  - Remove `fieldPresence` and add `validation` in the schema, then run `npm run db:generate`,
    which drops `field_presence_jsonb` and adds `validation_jsonb`. Apply it with
    `npm run db:migrate`.
  - Remove the Product rule, its triage row and its copy.
  - Set the fixture `/authored3/product-incomplete`'s `expectedIssues` to `[]`. It keeps
    `exact: true`, and nothing fires it between T6 and T7. Remove `schema.product-incomplete`
    from the harness claim and expectation lists. T7 sets the fixture to
    `["schema.google-required-missing", "schema.google-recommended-missing"]`, because the page
    lacks `image`.

- [ ] **Step 4: Run the full suite and see it pass.** Run `npx tsc --noEmit`.

- [ ] **Step 5: Commit:** `feat(rules): schema validation derivation; retire field presence and schema.product-incomplete (29a T6)`

### Task 7: The per-node schema rules

**Files:**
- Create: `src/rules/query/schema-validation.ts`
- Modify: `src/rules/index.ts` (register), `src/rules/registry/triage.ts`,
  `src/rules/registry/copy/issue-copy.ts`
- Test: `test/rules/schema-validation-query.test.ts`

**Interfaces:**
- Consumes: `structured_data.validation_jsonb`, `blockValidationSchema`,
  `pages.structured_data_parse_errors`, `pages.structured_data_microdata_errors` and
  `JUDGED("p")`.
- Produces: `schemaValidationRules: QueryRule[]` with eight rules.

| id | severity | checkIds | fires when (JUDGED pages) | evidence |
|---|---|---|---|---|
| `schema.parse-error` | warning | CHECK-43 | `structured_data_parse_errors > 0`, or `structured_data_microdata_errors > 0` (null on v3 rows, so v3 is read as JSON-LD only) | `jsonLdParseErrors`, `microdataErrors` (number or null) |
| `schema.unknown-type` | warning | CHECK-43 | any block's `unknownTypes` is non-empty | `problems` (≤20 `{format,path,type}`), `problemCount` |
| `schema.unknown-property` | warning | CHECK-43 | `unknownProperties` | `problems` (≤20 `{format,path,type,property}`), `problemCount` |
| `schema.property-pending-or-superseded` | info | CHECK-43 | `propertyStatus` | `problems` (≤20 `{format,path,property,status,supersededBy}`), `problemCount` |
| `schema.embedded-type-mismatch` | warning | CHECK-43 | `typeMismatches` | `problems` (≤20 `{format,path,property,type,expected}`), `problemCount` |
| `schema.google-required-missing` | warning | CHECK-43, CHECK-44 | a `googleFeatures` entry with non-empty `missingRequired` | `features` (distinct ids), `problems` (≤20 `{format,feature,path,type,missing}`), `problemCount` |
| `schema.google-recommended-missing` | info | CHECK-43, CHECK-44 | a `googleFeatures` entry with non-empty `missingRecommended` | as above, `missing` = recommended |
| `schema.deprecated-feature` | info | CHECK-43 | `deprecatedFeatures` | `features`, `restriction` (the `DEPRECATED_FEATURES` sentence per feature), `problemCount` |

- Each rule writes one finding per page (R0.3), with `dedupeKey` = page URL. It is ordered by
  URL and capped by `caps.listing` with `noteTruncation`.
- The SQL pre-filters with `jsonb_array_length(sd.validation_jsonb -> '<list>') > 0`.
- The JS side parses each blob with `blockValidationSchema`. A null blob on a selected row
  throws: "`<rule>`: `<url>` structured data has no validation — re-run the rules". A
  malformed blob throws naming the row's id.
- `columns` per rule: `Problems`, plus `Features` for the Google rules.
- The copy in `issue-copy.ts` is written in the existing entries' voice, and copy-render covers
  it.
- Triage rows:
  - parse-error: issue / medium, SF "Structured Data: Parse Errors";
  - unknown-type: issue / medium, SF "Structured Data: Validation Errors";
  - unknown-property: warning / low, SF "Structured Data: Validation Errors";
  - pending-or-superseded: warning / low, SF "Structured Data: Validation Warnings";
  - embedded-type-mismatch: issue / medium, SF "Structured Data: Validation Errors";
  - google-required-missing: issue / medium, SF "Structured Data: Rich Result Validation Errors";
  - google-recommended-missing: opportunity / low, SF "Structured Data: Rich Result Validation Warnings";
  - deprecated-feature: warning / low.

  The controller cross-checks these against `scripts/triage-vs-sf.ts` if the SF export is
  available. If it isn't, it ledgers that.

- [ ] **Step 1: Write the failing tests.** Seed pages and blocks with `test/rules/mk-page.ts`,
  then run `deriveSchemaValidation`, then the rule.
  - One test per rule that it fires on a seeded page and is silent on a clean one.
  - `google-required-missing judges per node`: one complete and one image-less Product on a
    page gives one finding, with `problemCount: 1`.
  - `non-JUDGED pages are silent` (noindex).
  - `null validation throws`: seed a row, skip the derivation, run the rule, expect a rejection
    matching `/re-run the rules/`.
  - `v3 page with JSON-LD parse error fires parse-error with microdataErrors null`.
  - `truncation at caps.listing`.

- [ ] **Step 2: Run the tests and see them fail.**

- [ ] **Step 3: Implement the rules, triage and copy, and register them.** Set
  `/authored3/product-incomplete`'s `expectedIssues` to
  `["schema.google-required-missing", "schema.google-recommended-missing"]`. Run the other
  `exact` structured-data fixtures, such as `/authored3/reviews`, through the harness too, and
  add whatever the new rules now fire there. Run
  `test/rules/registry.test.ts test/rules/triage.test.ts test/rules/copy.test.ts test/rules/copy-render.test.ts test/rules/coverage.test.ts`
  and update the copy snapshot fixture the way the copy test documents for a ruleset change.

- [ ] **Step 4: Run the full suite and see it pass.**

- [ ] **Step 5: Commit:** `feat(rules): schema validation and Google eligibility rules (29a T7)`

### Task 8: Template inconsistency, thresholds, v4 site gates, self-serving hierarchy, ruleset 0.26.0

**Files:**
- Modify: `src/rules/thresholds.ts`, `src/rules/threshold-table.ts` (two rows),
  `src/rules/query/schema-validation.ts` (the template rule), and
  `src/rules/query/structured-data.ts` (v4 gates on none-on-site and breadcrumb-absent;
  self-serving through `descendants`).
- Modify: `src/rules/registry/registry.ts` (`RULESET_VERSION = "0.26.0"` and its entry).
- Create: a custom migration, `npx drizzle-kit generate --custom --name schema_template_thresholds`.
- Test: `test/rules/schema-validation-query.test.ts`, `test/rules/structured-data-query.test.ts`,
  `test/rules/threshold-table.test.ts`, `test/rules/judgement.test.ts`

**Interfaces:**
- Produces:
  - `SCHEMA_TEMPLATE_SHARE = 70` and `SCHEMA_TEMPLATE_MIN_PAGES = 10` in `thresholds.ts`.
  - `THRESHOLD_ROWS.SCHEMA_TEMPLATE_SHARE = {min:50,max:100,default:SCHEMA_TEMPLATE_SHARE}`.
  - `THRESHOLD_ROWS.SCHEMA_TEMPLATE_MIN_PAGES = {min:2,max:100000,default:SCHEMA_TEMPLATE_MIN_PAGES}`.
- `schema.template-inconsistent` (warning, CHECK-43):
  - Opens with `v4Gate`, and returns `[]` when the crawl is not wholly v4 (R0.7).
  - Over JUDGED pages with a non-null, non-empty `page_type`, per page type with
    `n ≥ SCHEMA_TEMPLATE_MIN_PAGES` judged pages, per top-level `schema_type` (excluding
    `unknown`) carried by `c` of them where `c * 100 ≥ SCHEMA_TEMPLATE_SHARE * n` and `c < n`:
    one finding per page lacking that type.
  - `dedupeKey` is `${url}#${schemaType}`. Evidence is
    `{pageType, schemaType, pagesWith: c, pagesInType: n}`.
  - Columns: Page Type, Schema Type, Pages With, Pages In Type.
  - The copy uses `{SCHEMA_TEMPLATE_SHARE}` and `{SCHEMA_TEMPLATE_MIN_PAGES}`. It is one SQL
    statement grouped by page type and type, bounded by those, never by pages, plus the listing
    cap.
  - Triage: issue / medium.
- `schema.self-serving-reviews`:
  - `SELF_SERVING_TYPES` becomes `descendants("Organization")`, which includes LocalBusiness and
    all their subtypes.
  - Delete the docblock paragraph about the subtype gap.
  - The copy's "typed exactly Organization or LocalBusiness" becomes "typed Organization or any
    of its subtypes (LocalBusiness, Restaurant, …)".
- `schema.none-on-site` and `schema.breadcrumb-absent` open with `v4Gate` (R0.7).
- The custom migration's SQL, in the 0033 style, idempotent:
  ```sql
  UPDATE crawls SET rules_judged_with_jsonb = jsonb_set(rules_judged_with_jsonb, '{thresholds}',
    '{"SCHEMA_TEMPLATE_SHARE": 70, "SCHEMA_TEMPLATE_MIN_PAGES": 10}'::jsonb
    || (rules_judged_with_jsonb -> 'thresholds'))
  WHERE rules_judged_with_jsonb IS NOT NULL
    AND jsonb_typeof(rules_judged_with_jsonb -> 'thresholds') = 'object';
  ```
  Head it with a comment that says why: the stamp must name every threshold (27a Ruling 15),
  and the defaults are written out as historical fact.
- The 0.26.0 registry entry names:
  - the nine new rules;
  - the retirement of `schema.product-incomplete` into `schema.google-*`;
  - microdata and RDFa read since extraction 4;
  - self-serving reviews now walking the hierarchy;
  - the three site rules silent below v4;
  - the two thresholds;
  - the final rule count, as the earlier entries give it ("N rules: a page / b query / c metric").

- [ ] **Step 1: Write the failing tests.**
  - `template-inconsistent fires on the 3 of 12 product pages lacking Product`: n=12, c=9, 75%.
  - `silent at 8 of 12`: 66.7%.
  - `silent below 10 pages`.
  - `silent on a v3 crawl`.
  - An override of `SCHEMA_TEMPLATE_SHARE: 60` makes the 8-of-12 case fire.
  - `self-serving fires on Restaurant with aggregateRating`.
  - `none-on-site and breadcrumb-absent are silent on a v3 crawl` and still fire on v4.
  - threshold-table: the two rows and their ranges.
  - judgement: a stamp written before the migration, run through the migration SQL, passes
    `readStamp`. Test the SQL through a migrated dev DB row: insert an old-shaped stamp, run
    `npm run db:migrate` in a fresh schema, or assert on a crawl inserted before migrating, the
    way 0033's test did. Find that test with
    `grep -rn "0033\|rules_judged_with_effective" test` and follow it.

- [ ] **Step 2: Run the tests and see them fail.**

- [ ] **Step 3: Implement, generate and apply the custom migration, and bump the ruleset.**

- [ ] **Step 4: Run the full suite and see it pass,** including `coverage.test.ts` and
  `checklist-severity.test.ts`.

- [ ] **Step 5: Commit:** `feat(rules): schema.template-inconsistent, v4 site gates, hierarchy-aware self-serving reviews; ruleset 0.26.0 (29a T8)`

### Task 9: Surface — the `structured_data` listing and the `structured_data_nodes` CSV view

**Files:**
- Modify: `src/api/service.ts` (`listStructuredData`), `src/api/mcp.ts` (tool
  `structured_data`, and the tool-name list near line 133), `src/api/http.ts`
  (`GET /crawls/:id/structured-data`, plus the route list in the header), and `src/api/csv.ts`
  (view `structured_data_nodes` in `CSV_VIEWS` and `CSV_VIEW_DEFS`).
- Test: `test/api/structured-data.test.ts`; extend `test/api/tenant-isolation.test.ts`,
  `test/api/mcp.test.ts` (tool list), `test/api/transport-parity.test.ts` and
  `test/api/csv.test.ts`.

**Interfaces:**
- Produces:
  `listStructuredData(tenant: TenantId, crawlId: string, opts: { limit?: number; cursor?: string; pageType?: string; format?: string; feature?: string }): Promise<Page<StructuredDataPageRow>>`.
- `StructuredDataPageRow` = `{ url: string; pageType: string | null; indexable: boolean | null; formats: StructuredDataFormat[]; types: string[]; googleFeatures: string[]; warningCount: number; infoCount: number; jsonLdParseErrors: number; microdataErrors: number | null; skips: StructuredDataSkips | null }`.
- Rows:
  - Pages with at least one `structured_data` row, or with a parse or microdata error count
    above 0.
  - Ordered by `pages.url`, with the one-column cursor `listPages` uses. `pageType` goes
    through `pageTypeCondition`.
  - `format` is validated against the three values, and `feature` against `GOOGLE_FEATURES`
    ids. A wrong value gets a `VALIDATION` ServiceError naming the accepted values.
- Counts (R0.8):
  - `warningCount` is the sum of the lengths of `unknownTypes`, `unknownProperties` and
    `typeMismatches`, plus the `googleFeatures` entries with non-empty `missingRequired`, plus
    parse and microdata errors.
  - `infoCount` is `propertyStatus`, plus entries with non-empty `missingRecommended`, plus
    `deprecatedFeatures`.
  - All are summed in SQL with `jsonb_array_length` and `jsonb_path_query` over the page's
    rows, never in JS over all rows.
- Refusals (Review Focus 5):
  - A crawl whose rules have not run gets the same error `issues_list` gives an unjudged crawl.
    Find it in `listIssues` and reuse its code and wording pattern.
  - A judged crawl with any `structured_data` row whose `validation_jsonb` is null gets a
    `CONFLICT`-class error: "crawl `<id>` was judged before structured data validation existed
    — re-run the rules (crawl_rules)". It is never an empty page.
- `structured_data_nodes` CSV view:
  - One row per (block, problem), plus one row for a block with no problem.
  - Keyset `(sd.id, ord)` over `jsonb_array_elements … with ordinality`, with `ord = 0` for a
    clean block.
  - Header: `URL, Format, Schema Type, Path, Node Type, Problem, Detail`.
  - Problem vocabulary: `unknown-type | unknown-property | property-status | type-mismatch | google-required | google-recommended | deprecated-feature`.
  - It refuses as above.
- Tenancy: the listing and the view go through `assertCrawl(tenant, crawlId)`. The isolation
  test gets a row for each.

- [ ] **Step 1: Write the failing tests.**
  - The listing over a seeded, judged crawl: field values on a page with a JSON-LD Product
    missing an image, plus a microdata Organization.
  - Filters: `format`, `feature`, `pageType`.
  - Cursor paging.
  - `VALIDATION` on `format: "xml"`.
  - The unjudged refusal, and the pre-29a refusal (null blob).
  - Another tenant's crawl answers not-found.
  - MCP and HTTP parity.
  - The CSV view's header, rows and keyset continuation across a 2-row limit.

- [ ] **Step 2: Run the tests and see them fail.**

- [ ] **Step 3: Implement the listing, the tool, the route and the view.** Every response
  field is named in a projection, never spread (Talos obligation 6).

- [ ] **Step 4: Run the tests and see them pass,** including `surface-unchanged.test.ts` (update
  its expected surface for the new tool, route and view only) and `no-key-echo.test.ts`.

- [ ] **Step 5: Commit:** `feat(api): structured_data listing and structured_data_nodes CSV view (29a T9)`

### Task 10: Fixture site

**Files:**
- Create: `test/fixtures/pages/authored-p29a.ts`
- Modify: `test/fixtures/pages/authored-p3.ts` (product-incomplete becomes the merchant-listing
  case), `test/fixtures/app.ts` or wherever the fixture lists are concatenated, and
  `test/fixtures/harness.test.ts` (claims, exact sets, `SKIP_HARNESS_CLAIMS` notes).

**Fixtures.** Each one is `exact: true` and built from the control recipe (`healthyBody`). Each
new rule fires exactly once across the new pages (Gate 29a clause 1).

| path | carries | expectedIssues |
|---|---|---|
| `/authored29a/parse-error` | one JSON-LD block of invalid JSON | `schema.parse-error` |
| `/authored29a/unknown-type` | JSON-LD `@type: "Prodcut"` with a name | `schema.unknown-type` |
| `/authored29a/unknown-property` | complete microdata Product plus `itemprop="colour"` | `schema.unknown-property` |
| `/authored29a/pending-property` | complete Organization JSON-LD plus one pending property | `schema.property-pending-or-superseded` |
| `/authored29a/type-mismatch` | complete Recipe whose `author` is `{"@type":"Offer"}` | `schema.embedded-type-mismatch` |
| `/authored29a/event-no-date` | Event JSON-LD without `startDate`, every recommended field present | `schema.google-required-missing` |
| `/authored29a/faq` | a valid FAQPage | `schema.deprecated-feature` |
| `/authored29a/tpl/1` … `/tpl/10` | ten pages of one template (the same path shape), nine with a complete Product, one without | the one without: `schema.template-inconsistent` |
| `/authored29a/clean-microdata-product` | a valid microdata Product, complete on required and recommended | none |
| `/authored29a/clean-rdfa-organization` | a valid RDFa Organization, complete | none |

- `google-recommended-missing` fires on `/authored3/product-incomplete`, beside
  `google-required-missing`, which is its claim. Re-count so the claim list says which fixture
  is each rule's proof.
- Every page that adds markup must not create a new finding elsewhere. The nine template pages
  are `exact` too: complete Products fire nothing.
- `schema.none-on-site` stays unclaimable on this site, as today.
- Check the template group really collapses into one `page_type` with `inferPageTemplates`. If
  ten pages are not enough for its collapse rule, use the smallest count that is, keep exactly
  one page missing Product, and keep the share at or above 70%.

- [ ] **Step 1: Add the fixtures and the harness expectations,** then run
  `npx vitest run test/fixtures/harness.test.ts`. Expected: FAIL first only where an
  expectation is wrong. Fix the page, never the rule, unless the rule is wrong. A rule fix goes
  back to its task's file with a test.

- [ ] **Step 2: Assert on each new rule's evidence once in the harness**
  (`detailsByPath`, as for `/authored3/reviews`): problems, paths and features.

- [ ] **Step 3: Run the whole suite and see it pass.**

- [ ] **Step 4: Commit:** `test(fixtures): 29a structured-data fixtures, each new rule fires exactly once (29a T10)`

### Task 11: Docs, checklist, gate

**Files:**
- Modify: `skills/ariadne-audit/checklist.md`:
  - CHECK-43's Engine block lists all `schema.*` rules and the three formats, and drops "the
    engine extracts JSON-LD … no validation case" in favour of the vocabulary and Google
    sentences;
  - CHECK-44 now reads `schema.google-required-missing` / `-recommended-missing` with
    `feature: merchant-listing | product-snippet`, and the "cannot answer today" paragraph is
    updated to point at the `structured_data` listing;
  - CHECK-46 drops "exact type".
- Modify: `docs/talos-surface.md`: §4 gets a new `structured_data` subsection, §12 the new CSV
  view, §11 the 0.26.0 note and extraction v4.
- Modify: `docs/talos-integration.md`, for any obligation the new tool touches.
- Modify: `skills/` agent skills that name `schema.product-incomplete`. Find them with
  `grep -rn "product-incomplete" skills docs/talos-*.md`.
- Create: `docs/gates/phase-29a.md`
- Test: `test/rules/checklist-severity.test.ts` and `coverage.test.ts` stay green.

- [ ] **Step 1: Update the checklist and the docs.** Commit:
  `docs: 29a structured data in the checklist and the Talos surface (29a T11)`.

- [ ] **Step 2: Run Gate clauses 1, 3 and 4 on a dedicated gate DB, `ariadne_gate29a`.** The
  controller creates it through `npm run db:migrate` against the new URL, as the 28c gate did.
  - **Clause 1:** the fixture harness, already green in T10. Record the per-rule counts.
  - **Clause 3:** run `scripts/gate-crawl.ts` at 50k on `ariadne_gate29a` and record the local
    peak RSS, which must be ≤ 290.2 MB, along with the rules-run time and the derivation's
    share of it.
  - **Clause 4:** `test/rules/coverage.test.ts` green.

- [ ] **Step 3: Gate clause 2 — the live crawl. This is a stop point.** The controller asks
  the owner to name the client site and give their OK, then runs the crawl and the rules. For
  every `schema.google-required-missing` finding, check the page in Google's Rich Results Test
  by hand, and record the URL, the feature, the engine's missing list and the test's verdict in
  the gate doc.
  - The clause passes at **0 false positives**.
  - For a false positive, fix the profile in `google-features.ts` with a test, then re-run.
  - When the live findings exceed 30, check all the distinct (feature, missing-set)
    combinations, plus 30 sampled findings, and record the sampling.

- [ ] **Step 4: Write `docs/gates/phase-29a.md`:** each clause with its evidence and verdict,
  the rulings R0.1–R0.9 plus the execution ledger's, and the open items. Commit:
  `docs: Phase 29a gate`.
