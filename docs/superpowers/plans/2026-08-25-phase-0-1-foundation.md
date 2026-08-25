# Ariadne Phase 0+1: Foundation & Crawl Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, resumable, polite site crawler that streams pages into Postgres under a hard memory contract, plus the rule-registry skeleton the later phases plug into — ending at the Phase 1 gate: 50k pages crawled under 512MB RSS with crash-resume demonstrated.

**Architecture:** No crawl framework. A frontier table in Postgres (lease/complete semantics with `FOR UPDATE SKIP LOCKED`), a worker pool bounded by an adaptive concurrency window and an in-flight byte budget, `undici` fetches with manual redirect handling (every hop is a row), and a streaming `htmlparser2` extractor absorbed from OpenSEO and extended. Cross-page logic is SQL in later phases; nothing in Phase 1 accumulates per-URL state in RAM.

**Tech Stack:** TypeScript strict (Node 22, ESM), `undici`, `htmlparser2`, `robots-parser`, `fast-xml-parser`, `pg` + `drizzle-orm` (+ `drizzle-kit` for migrations), `vitest` for tests, `cheerio` in devDependencies only (parity oracle).

**Spec:** `docs/crawl-audit-engine-spec.md` (design, data contract §2, rule contract §3) and `docs/crawl-audit-build-plan.md` (provenance §1–3, phase tasks §4, guardrails §6). This plan implements build-plan Phases 0 and 1 (tasks P0-T1…P0-T4, P1-T1…P1-T9) with two owner-approved amendments: **crash-resume is a Phase 1 gate** (not optional), and the politeness governor gains a **fixed per-host delay honouring robots `crawl-delay`** alongside the adaptive window.

## Global Constraints

- Node 22, ESM (`"type": "module"`), TypeScript `strict: true`. `npx tsc --noEmit` and `npm test` stay green at every commit.
- Runtime dependencies limited to: `undici`, `htmlparser2`, `robots-parser`, `fast-xml-parser`, `pg`, `drizzle-orm`. (`playwright` arrives in Phase 5, not now.) `cheerio`, `vitest`, `drizzle-kit`, `tsx`, `typescript`, `@types/*` are devDependencies. **No crawl framework** (no Crawlee etc.).
- Memory contract: RAM O(concurrency), never O(URLs). No in-RAM dedupe set, no accumulated results array, no DOM on the hot path. 1MiB body cap per response. Per-page collection caps (links 2000, images 1000, hreflang 200, structured-data blocks 50).
- Every URL the crawler is about to fetch passes url-policy first — discovered, redirected-to, or operator-supplied.
- Lifted files carry a provenance header naming repo, path, sha, and changes; `THIRD_PARTY_NOTICES.md` carries the MIT texts. Pinned shas: OpenSEO `c469a48ae90ab58413b198fe3d1ac1aa90a9b070`, SEOnaut `880b312c28fab8b0bf7fe4f9449dc4746dbb82ff`.
- No silent fallbacks: a failed fetch is a classified `pages` row; a config error throws at startup; nothing is retried into oblivion silently.
- Dev Postgres: `docker run -d --name ariadne-pg -p 5440:5432 -e POSTGRES_USER=ariadne -e POSTGRES_PASSWORD=ariadne -e POSTGRES_DB=ariadne postgres:16`; `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`. DB-touching tests read `process.env.DATABASE_URL` and **throw** if unset (no skip-fallback).
- Commit after every green test cycle. Conventional messages, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Project scaffold + THIRD_PARTY_NOTICES (P0-T1, P0-T2)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `THIRD_PARTY_NOTICES.md`
- Create: `src/index.ts` (placeholder export), `test/smoke.test.ts`
- Create empty dirs (with `.gitkeep`): `src/crawl/parse`, `src/rules/page`, `src/rules/query`, `src/rules/metric`, `src/rules/registry`, `src/db`, `src/report`, `test/fixtures`

**Interfaces:**
- Consumes: nothing.
- Produces: a compiling, testable package every later task builds in. Scripts: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run db:generate` / `npm run db:migrate` (wired in Task 2 but declared here).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "ariadne",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0",
    "fast-xml-parser": "^5.0.0",
    "htmlparser2": "^10.0.0",
    "pg": "^8.13.0",
    "robots-parser": "^3.0.1",
    "undici": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "cheerio": "^1.0.0",
    "drizzle-kit": "^0.31.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

(Install resolves the exact minors; do not pin harder than caret at this stage.)

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `.gitignore`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts"], testTimeout: 30_000 },
});
```

`.gitignore`:

```
node_modules/
drizzle/meta/_journal.json.bak
*.log
.tmp/
```

- [ ] **Step 4: Write `THIRD_PARTY_NOTICES.md`**

Content: a heading per source, the full MIT licence text once, and per-source copyright lines + pinned sha:

```markdown
# Third-party notices

Ariadne absorbs small amounts of MIT-licensed source (read fully, then owned —
see docs/crawl-audit-build-plan.md §1–3). The MIT licence requires this notice
to travel with the code. Upstream is one-time source material, never synced.

## OpenSEO — https://github.com/every-app/open-seo
Copyright (c) 2026 Ben Senescu. MIT License.
Absorbed at commit c469a48ae90ab58413b198fe3d1ac1aa90a9b070 (see provenance
headers in the affected files under src/crawl/).

## SEOnaut — https://github.com/StJudeWasHere/seonaut
MIT License. Issue copy absorbed at commit
880b312c28fab8b0bf7fe4f9449dc4746dbb82ff (Phase 2).

## MIT License text
[paste the full standard MIT licence text here verbatim]

## npm dependencies
undici, htmlparser2, robots-parser, fast-xml-parser, pg, drizzle-orm — each
under its own licence as published on npm; see node_modules/<pkg>/LICENSE.
```

Verify the OpenSEO copyright holder line against the LICENSE file at the pinned sha (`https://raw.githubusercontent.com/every-app/open-seo/c469a48ae90ab58413b198fe3d1ac1aa90a9b070/LICENSE`) and correct the name/year to exactly what it says. Do the same for SEOnaut's LICENSE.

- [ ] **Step 5: Write the smoke test**

`test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ARIADNE } from "../src/index.js";

describe("scaffold", () => {
  it("compiles and imports", () => {
    expect(ARIADNE).toBe("ariadne");
  });
});
```

`src/index.ts`:

```ts
export const ARIADNE = "ariadne";
```

- [ ] **Step 6: Install and verify**

Run: `npm install && npm run typecheck && npm test`
Expected: install clean, typecheck silent, 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project, notices file (P0-T1, P0-T2)"
```

---

### Task 2: Postgres schema + migrations (P0-T3)

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`
- Create: `test/db/schema.test.ts`
- Generated: `drizzle/0000_*.sql` (via drizzle-kit; committed)

**Interfaces:**
- Consumes: nothing.
- Produces: `createDb(databaseUrl: string): Db` and `closeDb(db: Db): Promise<void>` from `src/db/client.ts`, where `export type Db = NodePgDatabase<typeof schema> & { $pool: pg.Pool }`. Table objects exported from `src/db/schema.ts`: `crawls, pages, links, hreflang, structuredData, sitemapUrls, urlParams, issues, metrics, frontier`. All later DB tasks import these names exactly.

- [ ] **Step 1: Write the failing schema test**

`test/db/schema.test.ts`:

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, closeDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

describe("schema", () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });
  afterAll(async () => { await closeDb(db); });

  it("creates all contract tables", async () => {
    const res = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    const names = res.rows.map((r) => r.table_name);
    for (const t of ["crawls","pages","links","hreflang","structured_data",
                     "sitemap_urls","url_params","issues","metrics","frontier"]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it("pages has the extraction columns the checklist needs", async () => {
    const res = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'pages'`);
    const cols = res.rows.map((r) => r.column_name);
    for (const c of ["url_normalised","page_type","fetch_class","simhash","text_ratio",
                     "dom_size","rel_next","rel_prev","discovered_via","rendered_word_count"]) {
      expect(cols, `missing pages.${c}`).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test -- test/db/schema.test.ts`
Expected: FAIL — `src/db/client.js` does not exist.

- [ ] **Step 3: Write the schema**

`src/db/schema.ts` — the full data contract from spec §2 plus the frontier table (owned here because the crawl loop and persistence both need it):

```ts
import {
  pgTable, text, integer, bigint, boolean, jsonb, timestamp, real,
  primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const crawls = pgTable("crawls", {
  id: text("id").primaryKey(),                 // e.g. crawl_<ulid>
  siteUrl: text("site_url").notNull(),
  config: jsonb("config_jsonb").notNull(),
  rulesetVersion: text("ruleset_version").notNull(),
  status: text("status").notNull().default("running"), // running|finished|failed|cancelled
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  pagesTotal: integer("pages_total"),
  renderPassCount: integer("render_pass_count").notNull().default(0),
});

export const pages = pgTable("pages", {
  id: text("id").primaryKey(),
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  urlNormalised: text("url_normalised").notNull(),
  pageType: text("page_type"),
  statusCode: integer("status_code"),
  fetchClass: text("fetch_class").notNull(),   // ok|redirect|client_error|server_error|blocked|timeout|network_error|non_html|too_large
  contentType: text("content_type"),
  redirectUrl: text("redirect_url"),
  redirectHops: integer("redirect_hops"),
  depth: integer("depth").notNull(),
  inSitemap: boolean("in_sitemap").notNull().default(false),
  discoveredVia: text("discovered_via").notNull(), // seed|link|sitemap|redirect
  title: text("title"),
  metaDescription: text("meta_description"),
  canonicalHtml: text("canonical_html"),
  canonicalHeader: text("canonical_header"),
  robotsMeta: text("robots_meta"),
  xRobotsTag: text("x_robots_tag"),
  isIndexable: boolean("is_indexable"),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  ogImage: text("og_image"),
  h1Count: integer("h1_count").notNull().default(0),
  h2Count: integer("h2_count").notNull().default(0),
  h3Count: integer("h3_count").notNull().default(0),
  h4Count: integer("h4_count").notNull().default(0),
  h5Count: integer("h5_count").notNull().default(0),
  h6Count: integer("h6_count").notNull().default(0),
  headingOrder: integer("heading_order").array(),
  wordCount: integer("word_count"),
  textRatio: real("text_ratio"),
  contentHash: text("content_hash"),
  simhash: bigint("simhash", { mode: "bigint" }),
  responseTimeMs: integer("response_time_ms"),
  htmlBytes: integer("html_bytes"),
  domSize: integer("dom_size"),
  imagesTotal: integer("images_total").notNull().default(0),
  imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
  hasAmp: boolean("has_amp").notNull().default(false),
  relNext: text("rel_next"),
  relPrev: text("rel_prev"),
  rendered: boolean("rendered").notNull().default(false),
  renderedWordCount: integer("rendered_word_count"),
  renderedLinkCount: integer("rendered_link_count"),
}, (t) => [
  uniqueIndex("pages_crawl_url").on(t.crawlId, t.url),
  index("pages_crawl_normalised").on(t.crawlId, t.urlNormalised),
  index("pages_crawl_type").on(t.crawlId, t.pageType),
]);

export const links = pgTable("links", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  sourcePageId: text("source_page_id").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  anchor: text("anchor"),
  rel: text("rel"),
  isInternal: boolean("is_internal").notNull(),
  isNofollow: boolean("is_nofollow").notNull().default(false),
  position: integer("position").notNull(),
}, (t) => [
  index("links_crawl_target_url").on(t.crawlId, t.targetUrl),
  index("links_crawl_target_page").on(t.crawlId, t.targetPageId),
  index("links_crawl_source").on(t.crawlId, t.sourcePageId),
]);

export const hreflang = pgTable("hreflang", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  hreflangCode: text("hreflang_code").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  source: text("source").notNull(), // html|sitemap|header
}, (t) => [index("hreflang_crawl_page").on(t.crawlId, t.pageId),
           index("hreflang_crawl_target").on(t.crawlId, t.targetUrl)]);

export const structuredData = pgTable("structured_data", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  schemaType: text("schema_type").notNull(),
  raw: jsonb("raw_jsonb").notNull(),
  fieldPresence: jsonb("field_presence_jsonb"),
}, (t) => [index("sd_crawl_type").on(t.crawlId, t.schemaType)]);

export const sitemapUrls = pgTable("sitemap_urls", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  sitemapSource: text("sitemap_source").notNull(),
  lastmod: text("lastmod"),
  pageId: text("page_id"),
}, (t) => [primaryKey({ columns: [t.crawlId, t.url] })]);

export const urlParams = pgTable("url_params", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  paramName: text("param_name").notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
  sampleUrls: text("sample_urls").array().notNull(),
  isTracking: boolean("is_tracking").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.crawlId, t.paramName] })]);

export const issues = pgTable("issues", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  pageId: text("page_id"),
  severity: text("severity").notNull(), // critical|warning|info
  dedupeKey: text("dedupe_key").notNull(),
  details: jsonb("details_jsonb").notNull(),
}, (t) => [uniqueIndex("issues_dedupe").on(t.crawlId, t.ruleId, t.dedupeKey),
           index("issues_crawl_rule").on(t.crawlId, t.ruleId)]);

export const metrics = pgTable("metrics", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  metricId: text("metric_id").notNull(),
  scope: text("scope").notNull(),       // site|page_type
  scopeValue: text("scope_value").notNull().default(""),
  value: jsonb("value_jsonb").notNull(),
}, (t) => [primaryKey({ columns: [t.crawlId, t.metricId, t.scope, t.scopeValue] })]);

export const frontier = pgTable("frontier", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  state: text("state").notNull().default("pending"), // pending|leased|done|failed
  depth: integer("depth").notNull(),
  discoveredVia: text("discovered_via").notNull(),
  attempts: integer("attempts").notNull().default(0),
  leaseId: text("lease_id"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.crawlId, t.url] }),
  index("frontier_leasable").on(t.crawlId, t.state, t.leasedUntil),
]);
```

- [ ] **Step 4: Write client, migrate runner, drizzle config**

`src/db/client.ts`:

```ts
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> & { $pool: pg.Pool };

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema }) as Db;
  db.$pool = pool;
  return db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$pool.end();
}
```

`src/db/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, closeDb, type Db } from "./client.js";

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: "drizzle" });
}

// CLI entrypoint: npm run db:migrate
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const db = createDb(url);
  await runMigrations(db);
  await closeDb(db);
  console.log("migrations applied");
}
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 5: Generate the migration and run the test**

Run: `npm run db:generate` (commits a `drizzle/0000_*.sql`), then
`DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test -- test/db/schema.test.ts`
Expected: PASS (both tests). If the container is not running, start it with the command in Global Constraints.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: postgres schema, drizzle migrations, db client (P0-T3)"
```

---

### Task 3: Rule registry with load-time validation (P0-T4)

**Files:**
- Create: `src/rules/registry/types.ts`, `src/rules/registry/registry.ts`
- Test: `test/rules/registry.test.ts`

**Interfaces:**
- Consumes: `Db` type from Task 2.
- Produces (all later rule work depends on these exact names):
  - Types `Finding`, `Metric`, `Severity`, `PageRecord` (alias for drizzle's `typeof pages.$inferSelect`), `PageRule`, `QueryRule`, `MetricRule`, `AnyRule`.
  - `defineRule<T extends AnyRule>(rule: T): T` — throws `RuleDefinitionError` on malformed rules at load time.
  - `class Registry { register(rule: AnyRule): void; all(): AnyRule[]; byKind(kind): AnyRule[]; claimedCheckIds(): Set<string>; unclaimedChecks(allCheckIds: string[], agentChecks: string[]): string[] }`.

- [ ] **Step 1: Write the failing tests**

`test/rules/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defineRule, Registry, RuleDefinitionError } from "../../src/rules/registry/registry.js";

const validPageRule = {
  kind: "page" as const,
  id: "title.missing",
  checkIds: ["CHECK-35"],
  category: "on-page",
  severity: "warning" as const,
  title: "Missing title",
  explanation: "The page has no <title> element.",
  howToFix: "Add a unique, descriptive <title>.",
  rulesetVersion: "0.1.0",
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/rules/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types and registry**

`src/rules/registry/types.ts`:

```ts
import type { Db } from "../../db/client.js";
import type { pages } from "../../db/schema.js";

export type Severity = "critical" | "warning" | "info";
export type PageRecord = typeof pages.$inferSelect;

export interface Finding {
  ruleId: string;
  pageId: string | null;
  pageUrl: string | null;
  severity: Severity;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

export interface Metric {
  metricId: string;
  scope: "site" | "page_type";
  scopeValue: string;
  value: Record<string, unknown>;
}

interface RuleMeta {
  id: string;               // 'canonical.non-200-target'
  checkIds: string[];       // ['CHECK-19'] — traces to the sf-audit checklist
  category: string;
  severity: Severity;
  title: string;
  explanation: string;      // client-facing
  howToFix: string;         // client-facing
  rulesetVersion: string;
}

export interface PageRule extends RuleMeta {
  kind: "page";
  run: (page: PageRecord) => Finding[];
}
export interface QueryRule extends RuleMeta {
  kind: "query";
  run: (db: Db, crawlId: string) => Promise<Finding[]>;
}
export interface MetricRule extends RuleMeta {
  kind: "metric";
  run: (db: Db, crawlId: string) => Promise<Metric[]>;
}
export type AnyRule = PageRule | QueryRule | MetricRule;
```

`src/rules/registry/registry.ts`:

```ts
import type { AnyRule } from "./types.js";
export * from "./types.js";

export class RuleDefinitionError extends Error {}

const RULE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CHECK_ID = /^CHECK-\d{2}[a-z]?$/;

export function defineRule<T extends AnyRule>(rule: T): T {
  const fail = (msg: string) => {
    throw new RuleDefinitionError(`rule '${rule.id ?? "<no id>"}': ${msg}`);
  };
  if (!rule.id || !RULE_ID.test(rule.id)) fail("id must be kebab/dot lowercase");
  if (!Array.isArray(rule.checkIds) || rule.checkIds.length === 0)
    fail("checkIds must claim at least one CHECK-NN");
  for (const c of rule.checkIds) if (!CHECK_ID.test(c)) fail(`bad checkId '${c}'`);
  if (!["critical", "warning", "info"].includes(rule.severity)) fail("bad severity");
  for (const field of ["category", "title", "explanation", "howToFix", "rulesetVersion"] as const)
    if (!rule[field]) fail(`${field} is required (client-facing copy is not optional)`);
  if (typeof rule.run !== "function") fail("run must be a function");
  return rule;
}

export class Registry {
  private rules = new Map<string, AnyRule>();

  register(rule: AnyRule): void {
    defineRule(rule);
    if (this.rules.has(rule.id))
      throw new RuleDefinitionError(`duplicate rule id '${rule.id}'`);
    this.rules.set(rule.id, rule);
  }
  all(): AnyRule[] { return [...this.rules.values()]; }
  byKind<K extends AnyRule["kind"]>(kind: K): Extract<AnyRule, { kind: K }>[] {
    return this.all().filter((r): r is Extract<AnyRule, { kind: K }> => r.kind === kind);
  }
  claimedCheckIds(): Set<string> {
    return new Set(this.all().flatMap((r) => r.checkIds));
  }
  unclaimedChecks(allCheckIds: string[], agentChecks: string[]): string[] {
    const claimed = this.claimedCheckIds();
    const agent = new Set(agentChecks);
    return allCheckIds.filter((c) => !claimed.has(c) && !agent.has(c));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/rules/registry.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. **Phase 0 gate is now met** (schema migrates clean, registry loads zero rules without error, notices file complete).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: rule registry types, defineRule load-time validation (P0-T4) — Phase 0 gate green"
```

---

### Task 4: Absorb url-policy from OpenSEO (P1-T1)

**Files:**
- Create: `src/crawl/url-policy.ts` (absorbed + facade), `src/crawl/url-policy.upstream.test.ts` (absorbed tests)
- Test: `test/crawl/url-policy.test.ts` (facade tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `isUrlAllowed(url: string, opts?: { allowPrivate?: boolean }): Promise<{ allowed: boolean; reason: string | null }>` — the facade every fetch path calls. Upstream's internal exports stay but are not the seam. `allowPrivate: true` exists **only** for tests against 127.0.0.1 fixture servers and must never be settable from crawl config.

- [ ] **Step 1: Fetch the upstream files at the pinned sha**

```bash
mkdir -p .tmp/upstream
curl -fsSL https://raw.githubusercontent.com/every-app/open-seo/c469a48ae90ab58413b198fe3d1ac1aa90a9b070/src/server/lib/audit/url-policy.ts -o .tmp/upstream/url-policy.ts
curl -fsSL https://raw.githubusercontent.com/every-app/open-seo/c469a48ae90ab58413b198fe3d1ac1aa90a9b070/src/server/lib/audit/url-policy.test.ts -o .tmp/upstream/url-policy.test.ts
```

If either path 404s, list the directory at that sha (GitHub tree API) and locate the file by name — do not substitute a different sha.

- [ ] **Step 2: Read both files in full**

Read every line. Note in particular (these are the cases the build plan says the file earns its keep with): IPv4-mapped IPv6 handling, DoH resolution for the start URL, per-hop revalidation. If any part is not understood well enough to debug at 2am, rewrite that part rather than carrying it.

- [ ] **Step 3: Port into `src/crawl/url-policy.ts`**

- Add the provenance header:

```ts
/**
 * Adapted from open-seo (MIT), src/server/lib/audit/url-policy.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: removed app-framework imports; added isUrlAllowed() facade;
 * private-range checks kept; test-only allowPrivate escape hatch.
 */
```

- Strip upstream app imports (logging, env helpers) — replace with plain code.
- Append the facade:

```ts
export interface UrlVerdict { allowed: boolean; reason: string | null }

export async function isUrlAllowed(
  url: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<UrlVerdict> {
  // delegate to the absorbed validation; shape errors into a verdict
  // (exact call depends on upstream's exported names — keep them)
}
```

- Port the upstream `.test.ts` alongside as `src/crawl/url-policy.upstream.test.ts`, adapted to vitest imports, with the same provenance header.

- [ ] **Step 4: Write facade tests**

`test/crawl/url-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isUrlAllowed } from "../../src/crawl/url-policy.js";

describe("isUrlAllowed", () => {
  it("refuses non-http(s) schemes", async () => {
    expect((await isUrlAllowed("file:///etc/passwd")).allowed).toBe(false);
    expect((await isUrlAllowed("gopher://x/")).allowed).toBe(false);
  });
  it("refuses loopback, private and link-local literals", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.0.0.5/", "http://169.254.169.254/",
                     "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      const v = await isUrlAllowed(u);
      expect(v.allowed, u).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });
  it("allows a public https URL", async () => {
    expect((await isUrlAllowed("https://example.com/")).allowed).toBe(true);
  });
  it("test-only allowPrivate admits loopback", async () => {
    expect((await isUrlAllowed("http://127.0.0.1/", { allowPrivate: true })).allowed).toBe(true);
  });
});
```

- [ ] **Step 5: Run all url-policy tests**

Run: `npm test -- url-policy && npm run typecheck`
Expected: upstream parity tests + facade tests PASS.

- [ ] **Step 6: Commit (and delete `.tmp/upstream`)**

```bash
rm -rf .tmp/upstream
git add -A
git commit -m "feat: absorb OpenSEO url-policy @ c469a48, isUrlAllowed facade (P1-T1)"
```

---

### Task 5: Absorb page-analyzer from OpenSEO (P1-T2)

**Files:**
- Create: `src/crawl/parse/page-analyzer.ts`, `src/crawl/parse/page-analyzer.upstream.test.ts`
- Create: `src/crawl/parse/url-utils.ts` (small absorb: `normalizeUrl`, `isSameOrigin`, `detectUrlTemplate`)
- Test: `test/crawl/page-analyzer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `analyzePage(html: string, url: string): PageAnalysis` where

```ts
export interface PageAnalysis {
  title: string | null;
  metaDescription: string | null;
  canonicalHtml: string | null;         // first <link rel=canonical>; extras counted
  canonicalCount: number;
  robotsMeta: string | null;
  ogTitle: string | null; ogDescription: string | null; ogImage: string | null;
  headingCounts: [number, number, number, number, number, number]; // h1..h6
  headingOrder: number[];               // levels in document order, capped at 500
  wordCount: number;
  imagesTotal: number; imagesMissingAlt: number;
  hasAmp: boolean;
  links: Array<{ href: string; anchor: string; rel: string | null; nofollow: boolean; position: number }>;
  // Task 6 extends this interface — the fields are listed there.
}
```

Collection caps: links 2000, images counted but not stored per-image, headingOrder 500. Task 6 extends both the type and the extractor; Task 11 maps `PageAnalysis` onto the `pages` row.

- [ ] **Step 1: Fetch upstream at the pinned sha**

```bash
mkdir -p .tmp/upstream
for f in page-analyzer.ts page-analyzer.test.ts url-utils.ts url-utils.test.ts; do
  curl -fsSL "https://raw.githubusercontent.com/every-app/open-seo/c469a48ae90ab58413b198fe3d1ac1aa90a9b070/src/server/lib/audit/$f" -o ".tmp/upstream/$f"
done
```

- [ ] **Step 2: Read all four files in full**

The subtle cases the tests encode (verify each survives the port): `<title>` inside `<svg>` ignored, `noscript` handling matching parse5, implicitly-closed nested anchors, body-vs-fallback text scoping, `alt=""` (present, empty — not missing) versus absent `alt` (missing), per-page collection caps.

- [ ] **Step 3: Port analyzer + url-utils with provenance headers; adapt tests to vitest**

Provenance header pattern as in Task 4. Add `cheerio` parity assertions exactly as upstream does (cheerio is already in devDependencies). Export the `analyzePage(html, url)` facade over whatever streaming interface upstream uses internally (htmlparser2 tokenizer — keep it; **never** swap in a DOM parse).

- [ ] **Step 4: Write our own smoke tests**

`test/crawl/page-analyzer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";

const HTML = `<!doctype html><html><head>
<title>Widget Shop</title>
<meta name="description" content="Buy widgets.">
<link rel="canonical" href="https://shop.example/widgets">
<meta property="og:title" content="Widgets">
</head><body>
<h1>Widgets</h1><h3>Skipped level</h3>
<a href="/a" rel="nofollow">A</a><a href="https://other.example/b">B</a>
<img src="x.png"><img src="y.png" alt="">
<p>${"word ".repeat(200)}</p>
</body></html>`;

describe("analyzePage", () => {
  it("extracts the head and body signals", () => {
    const a = analyzePage(HTML, "https://shop.example/widgets");
    expect(a.title).toBe("Widget Shop");
    expect(a.metaDescription).toBe("Buy widgets.");
    expect(a.canonicalHtml).toBe("https://shop.example/widgets");
    expect(a.headingCounts[0]).toBe(1);
    expect(a.headingOrder).toEqual([1, 3]);
    expect(a.imagesTotal).toBe(2);
    expect(a.imagesMissingAlt).toBe(1);    // alt="" present ≠ missing
    expect(a.links).toHaveLength(2);
    expect(a.links[0]?.nofollow).toBe(true);
    expect(a.wordCount).toBeGreaterThan(190);
  });
});
```

- [ ] **Step 5: Run everything**

Run: `npm test -- page-analyzer && npm test -- url-utils && npm run typecheck`
Expected: upstream parity suites + smoke tests PASS.

- [ ] **Step 6: Commit (delete `.tmp/upstream`)**

```bash
rm -rf .tmp/upstream
git add -A
git commit -m "feat: absorb OpenSEO page-analyzer + url-utils @ c469a48 (P1-T2)"
```

---

### Task 6: Analyzer extensions — checklist fields OpenSEO lacks (P1-T3)

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts`
- Create: `src/crawl/parse/simhash.ts`
- Test: `test/crawl/analyzer-extensions.test.ts`, `test/crawl/simhash.test.ts`

**Interfaces:**
- Consumes: `PageAnalysis` from Task 5.
- Produces: `PageAnalysis` gains exactly these fields (Task 11 persists them):

```ts
relNext: string | null; relPrev: string | null;
domSize: number;                       // count of open-tag tokenizer events
textRatio: number;                     // visible text bytes / html bytes, 0..1
hreflang: Array<{ code: string; href: string }>;      // cap 200
structuredData: Array<{ type: string; raw: unknown }>; // JSON-LD blocks, cap 50
contentHash: string;                   // sha256 hex of normalised visible text
simhash: bigint;                       // 64-bit
```

And from `src/crawl/parse/simhash.ts`: `simhash64(text: string): bigint`, `hammingDistance(a: bigint, b: bigint): number`.

- [ ] **Step 1: Write the failing simhash tests**

`test/crawl/simhash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { simhash64, hammingDistance } from "../../src/crawl/parse/simhash.js";

describe("simhash64", () => {
  const base = "the quick brown fox jumps over the lazy dog ".repeat(30);
  it("is deterministic", () => {
    expect(simhash64(base)).toBe(simhash64(base));
  });
  it("near-identical texts land within hamming distance 3", () => {
    const tweaked = base.replace("lazy dog", "lazy cat");
    expect(hammingDistance(simhash64(base), simhash64(tweaked))).toBeLessThanOrEqual(3);
  });
  it("unrelated texts are far apart", () => {
    const other = "completely different content about sitemap parsing and robots ".repeat(30);
    expect(hammingDistance(simhash64(base), simhash64(other))).toBeGreaterThan(10);
  });
  it("fits in 64 bits", () => {
    expect(simhash64(base) < (1n << 64n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement simhash**

`src/crawl/parse/simhash.ts`:

```ts
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** 64-bit simhash over 4-word shingles of whitespace-normalised, lowercased text. */
export function simhash64(text: string): bigint {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const v = new Array<number>(64).fill(0);
  const width = 4;
  const last = Math.max(1, words.length - width + 1);
  for (let i = 0; i < last; i++) {
    const h = fnv1a64(words.slice(i, i + width).join(" "));
    for (let b = 0; b < 64; b++) {
      v[b]! += (h >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
}
```

Run: `npm test -- simhash` → PASS.

- [ ] **Step 3: Write the failing extension tests**

`test/crawl/analyzer-extensions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";

const HTML = `<!doctype html><html><head>
<title>P2</title>
<link rel="next" href="/list?page=3"><link rel="prev" href="/list?page=1">
<link rel="alternate" hreflang="en-gb" href="https://ex.com/en/">
<link rel="alternate" hreflang="de" href="https://ex.com/de/">
<script type="application/ld+json">{"@type":"Product","name":"W","offers":{"price":"9"}}</script>
</head><body><p>short text body</p></body></html>`;

describe("analyzer extensions", () => {
  const a = analyzePage(HTML, "https://ex.com/list?page=2");
  it("captures rel next/prev", () => {
    expect(a.relNext).toBe("/list?page=3");
    expect(a.relPrev).toBe("/list?page=1");
  });
  it("captures hreflang pairs", () => {
    expect(a.hreflang).toEqual([
      { code: "en-gb", href: "https://ex.com/en/" },
      { code: "de", href: "https://ex.com/de/" },
    ]);
  });
  it("captures JSON-LD types with raw objects", () => {
    expect(a.structuredData).toHaveLength(1);
    expect(a.structuredData[0]?.type).toBe("Product");
  });
  it("computes dom size, text ratio, hashes", () => {
    expect(a.domSize).toBeGreaterThan(5);
    expect(a.textRatio).toBeGreaterThan(0);
    expect(a.textRatio).toBeLessThan(1);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof a.simhash).toBe("bigint");
  });
  it("tolerates malformed JSON-LD without throwing", () => {
    const bad = HTML.replace('{"@type"', '{"@type!!!');
    const b = analyzePage(bad, "https://ex.com/x");
    expect(b.structuredData).toEqual([]);   // recorded as zero blocks, not a crash
  });
});
```

- [ ] **Step 4: Implement in the analyzer**

Inside the existing tokenizer callbacks (no second parse pass):
- `onopentag`: increment `domSize`; capture `link[rel=next|prev]` hrefs; capture `link[rel=alternate][hreflang]` into `hreflang` (cap 200); note `script[type="application/ld+json"]` state so its text is buffered (cap 50 blocks, 100KB per block).
- `ontext`: append to the visible-text accumulator already used for `wordCount` (respecting the existing script/style/noscript scoping) — the same accumulator feeds `textRatio` (`visibleTextBytes / htmlBytes`), `contentHash` (`createHash("sha256")` over the normalised text), and `simhash64`.
- On close of a JSON-LD script: `JSON.parse` in try/catch; on success push `{ type: obj["@type"] ?? "unknown", raw: obj }` handling arrays and `@graph` (one entry per typed node); on failure count it (`structuredDataParseErrors`) — do not throw, do not fake a block.
- `@type` arrays: use the first entry as `type`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- analyzer-extensions && npm test -- page-analyzer && npm run typecheck`
Expected: new tests PASS, absorbed parity suite still PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: analyzer extensions — rel prev/next, hreflang, JSON-LD, simhash, text ratio (P1-T3)"
```

---

### Task 7: fetch-page over undici (P1-T4)

**Files:**
- Create: `src/crawl/fetch-page.ts`
- Test: `test/crawl/fetch-page.test.ts` (uses a local `node:http` fixture server)

**Interfaces:**
- Consumes: `isUrlAllowed` (Task 4).
- Produces:

```ts
export type FetchClass = "ok" | "redirect" | "client_error" | "server_error"
  | "blocked" | "timeout" | "network_error" | "non_html" | "too_large" | "disallowed";

export interface FetchResult {
  url: string;
  statusCode: number | null;
  fetchClass: FetchClass;
  contentType: string | null;
  redirectUrl: string | null;          // absolute, resolved against url; null unless 3xx
  body: string | null;                 // html text ≤ 1MiB, else null
  htmlBytes: number;
  responseTimeMs: number;
  canonicalHeader: string | null;      // from Link: <...>; rel="canonical"
  xRobotsTag: string | null;
}

export interface FetchOpts {
  userAgent: string;
  timeoutMs?: number;                  // default 20_000
  allowPrivate?: boolean;              // tests only
}

export async function fetchPage(url: string, opts: FetchOpts): Promise<FetchResult>;
```

**Decisions locked (from OpenSEO reference reading, spec §4/§1):** no automatic redirect following — a 3xx returns `fetchClass: "redirect"` with `redirectUrl`, and the crawl loop enqueues the target so **every hop is its own row**; streaming 1MiB body cap (`too_large` beyond it, body discarded); bot-challenge classification; non-HTML content types are classified `non_html` with body discarded.

- [ ] **Step 1: Write the failing tests with a fixture server**

`test/crawl/fetch-page.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchPage } from "../../src/crawl/fetch-page.js";

let server: Server;
let base: string;
const OPTS = { userAgent: "AriadneBot-test", allowPrivate: true };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("link", '<https://ex.com/canon>; rel="canonical"');
      res.setHeader("x-robots-tag", "noindex");
      res.end("<html><title>ok</title></html>");
    } else if (req.url === "/moved") {
      res.statusCode = 301; res.setHeader("location", "/ok"); res.end();
    } else if (req.url === "/big") {
      res.setHeader("content-type", "text/html");
      res.end("x".repeat(2 * 1024 * 1024));
    } else if (req.url === "/pdf") {
      res.setHeader("content-type", "application/pdf"); res.end("%PDF-");
    } else if (req.url === "/challenge") {
      res.statusCode = 403; res.end("<html>Attention Required! | Cloudflare</html>");
    } else if (req.url === "/boom") {
      res.statusCode = 500; res.end("err");
    } else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fetchPage", () => {
  it("classifies a 200 html page and parses headers", async () => {
    const r = await fetchPage(`${base}/ok`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<title>ok</title>");
    expect(r.canonicalHeader).toBe("https://ex.com/canon");
    expect(r.xRobotsTag).toBe("noindex");
  });
  it("does not follow redirects; resolves the target absolute", async () => {
    const r = await fetchPage(`${base}/moved`, OPTS);
    expect(r.fetchClass).toBe("redirect");
    expect(r.statusCode).toBe(301);
    expect(r.redirectUrl).toBe(`${base}/ok`);
    expect(r.body).toBeNull();
  });
  it("caps the body at 1MiB", async () => {
    const r = await fetchPage(`${base}/big`, OPTS);
    expect(r.fetchClass).toBe("too_large");
    expect(r.body).toBeNull();
  });
  it("classifies non-html", async () => {
    expect((await fetchPage(`${base}/pdf`, OPTS)).fetchClass).toBe("non_html");
  });
  it("classifies bot challenges as blocked", async () => {
    expect((await fetchPage(`${base}/challenge`, OPTS)).fetchClass).toBe("blocked");
  });
  it("classifies 4xx/5xx", async () => {
    expect((await fetchPage(`${base}/nope`, OPTS)).fetchClass).toBe("client_error");
    expect((await fetchPage(`${base}/boom`, OPTS)).fetchClass).toBe("server_error");
  });
  it("refuses a disallowed URL without fetching", async () => {
    const r = await fetchPage("http://169.254.169.254/latest/meta-data/", { userAgent: "x" });
    expect(r.fetchClass).toBe("disallowed");
    expect(r.statusCode).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- fetch-page` — FAIL, module not found.

- [ ] **Step 3: Implement `fetchPage`**

```ts
import { request } from "undici";
import { isUrlAllowed } from "./url-policy.js";

const MAX_BODY = 1024 * 1024;

// Starter classification; reconcile against OpenSEO's table in
// site-audit-workflow-helpers.ts during this task (reference reading, not a lift).
const CHALLENGE_MARKERS = [
  "attention required! | cloudflare", "cf-browser-verification", "_incapsula_",
  "request unsuccessful. incapsula", "perimeterx", "px-captcha", "datadome",
  "just a moment...", "verify you are human",
];

function classifyStatus(status: number, bodySnippet: string, headers: Record<string, unknown>): FetchClass {
  if (headers["cf-mitigated"] === "challenge") return "blocked";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status === 503 && CHALLENGE_MARKERS.some((m) => bodySnippet.toLowerCase().includes(m)))
    return "blocked";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "ok";
}

function parseCanonicalLinkHeader(value: string | null): string | null {
  if (!value) return null;
  // Link: <https://ex.com/c>; rel="canonical", <...>; rel="next"
  for (const part of value.split(",")) {
    const m = part.match(/<([^>]+)>\s*;([^]*)/);
    if (m && /rel\s*=\s*"?canonical"?/i.test(m[2] ?? "")) return m[1] ?? null;
  }
  return null;
}
```

Body handling: read the response body as a stream, accumulating up to `MAX_BODY` bytes; on overflow abort the request, return `too_large` with `body: null` but keep `htmlBytes` as the cap value. `content-type` not matching `text/html`/`application/xhtml+xml` → `non_html`, body discarded (still stream-drain up to the cap so the socket is reusable). 3xx → `redirect`, `redirectUrl = new URL(location, url).href`, body discarded. Timeouts (`headersTimeout`/`bodyTimeout` from `timeoutMs`) → `timeout`; DNS/conn errors → `network_error`. Every path returns a classified result; **nothing throws for a target-site problem** (only for programmer errors like an invalid `opts`).

- [ ] **Step 4: Run tests**

Run: `npm test -- fetch-page && npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fetch-page — manual redirects, 1MiB cap, bot-challenge classification (P1-T4)"
```

---

### Task 8: Discovery — robots.txt + sitemaps (P1-T5)

**Files:**
- Create: `src/crawl/discovery.ts`
- Test: `test/crawl/discovery.test.ts` (fixture server pattern from Task 7)

**Interfaces:**
- Consumes: `fetchPage` cannot be reused (robots/sitemaps are not HTML pages) — discovery does its own undici requests but **must** call `isUrlAllowed` first and reuse the same `userAgent`.
- Produces:

```ts
export interface RobotsInfo {
  fetched: boolean;                    // false = no robots.txt reachable
  isAllowed(url: string): boolean;     // true when no robots or no matching rule
  crawlDelaySec: number | null;
  sitemapUrls: string[];
  raw: string | null;
}
export interface SitemapEntry { url: string; source: string; lastmod: string | null }
export interface DiscoveryResult {
  robots: RobotsInfo;
  sitemapEntries: SitemapEntry[];      // deduped by url, first source wins
  truncation: { oversizedDocsSkipped: number; docsFetched: number; depthLimited: boolean };
}
export async function discover(
  siteUrl: string,
  opts: { userAgent: string; allowPrivate?: boolean; extraSitemaps?: string[] },
): Promise<DiscoveryResult>;
```

**Caps locked (OpenSEO reference / RFC 9309):** robots.txt read up to 500KB (ignore beyond, like Google); 10MB per sitemap document; sitemap-index recursion depth 3; 300 documents total; an oversized shard is skipped whole and counted in `truncation`.

- [ ] **Step 1: Write the failing tests**

Fixture server serves: `/robots.txt` (with `User-agent: *`, one `Disallow: /admin`, `Crawl-delay: 5`, `Sitemap: <base>/sitemap.xml`), `/sitemap.xml` (an index pointing at `/sitemap-1.xml` and `/sitemap-oversized.xml`), `/sitemap-1.xml` (3 `<url>` entries with `lastmod` on one), `/sitemap-oversized.xml` (11MB of padding). Assertions:

```ts
it("parses robots, crawl-delay and sitemap pointer", async () => {
  const d = await discover(base, { userAgent: "AriadneBot-test", allowPrivate: true });
  expect(d.robots.fetched).toBe(true);
  expect(d.robots.isAllowed(`${base}/admin/x`)).toBe(false);
  expect(d.robots.isAllowed(`${base}/shop`)).toBe(true);
  expect(d.robots.crawlDelaySec).toBe(5);
});
it("recurses the sitemap index and records lastmod", async () => {
  const d = await discover(base, { userAgent: "AriadneBot-test", allowPrivate: true });
  expect(d.sitemapEntries.map((e) => e.url)).toHaveLength(3);
  expect(d.sitemapEntries.some((e) => e.lastmod !== null)).toBe(true);
});
it("skips oversized shards whole and counts them", async () => {
  const d = await discover(base, { userAgent: "AriadneBot-test", allowPrivate: true });
  expect(d.truncation.oversizedDocsSkipped).toBe(1);
});
it("absent robots.txt yields fetched=false and allow-all", async () => {
  const d = await discover(baseWithoutRobots, { userAgent: "x", allowPrivate: true });
  expect(d.robots.fetched).toBe(false);
  expect(d.robots.isAllowed(`${baseWithoutRobots}/anything`)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Use `robots-parser` for rule matching (`robots.isAllowed(url, userAgent)`, `robots.getCrawlDelay(userAgent)`, `robots.getSitemaps()`); `fast-xml-parser` (`XMLParser` with `ignoreAttributes: true`) for `<sitemapindex>`/`<urlset>`. Support gzip sitemaps: if the response `content-encoding` is gzip or the URL ends `.gz`, gunzip via `node:zlib`. Enforce all four caps. `robots.txt` fetch failing with a network error is `fetched: false` **plus a `console.warn`-free structured note in the result** — never a throw (a site without robots is normal), but an unreachable *sitemap* listed in robots is counted in `truncation.docsFetched` accounting, not silently dropped.

- [ ] **Step 3: Run tests**

Run: `npm test -- discovery && npm run typecheck` — PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: discovery — robots + sitemap recursion with RFC caps (P1-T5)"
```

---

### Task 9: Frontier + crawl loop with crash-resume (P1-T6 + resume amendment)

**Files:**
- Create: `src/crawl/frontier.ts`, `src/crawl/loop.ts`
- Test: `test/crawl/frontier.test.ts`, `test/crawl/loop.test.ts`

**Interfaces:**
- Consumes: `Db`, `frontier`/`crawls`/`pages` tables (Task 2), `fetchPage` (Task 7), `analyzePage` (Tasks 5–6), `isUrlAllowed` (Task 4), `discover` (Task 8), `HostGate`/`CrawlWindow` (Task 10 — loop.ts is written against their interfaces, declared below, and Task 10 must match them), `PageWriter`/`derivePageType` (Task 11 — same arrangement).
- Produces:

```ts
// frontier.ts
export async function enqueueUrls(db: Db, crawlId: string,
  urls: Array<{ url: string; depth: number; discoveredVia: string }>): Promise<number>; // rows inserted (conflicts ignored)
export interface LeasedUrl { url: string; depth: number; discoveredVia: string; attempts: number }
export async function leaseBatch(db: Db, crawlId: string, leaseId: string,
  n: number, leaseSeconds: number): Promise<LeasedUrl[]>;
export async function completeUrl(db: Db, crawlId: string, url: string): Promise<void>;
export async function failUrl(db: Db, crawlId: string, url: string,
  opts: { requeue: boolean; maxAttempts: number }): Promise<void>;
export async function frontierCounts(db: Db, crawlId: string):
  Promise<{ pending: number; leased: number; done: number; failed: number }>;

// loop.ts
export interface CrawlConfig {
  siteUrl: string;
  maxPages: number;
  maxDepth: number;                    // default 10
  userAgent: string;                   // default "AriadneBot/0.1 (+https://github.com/…)"
  perHostDelayMs: number;              // default 1000
  maxConcurrency: number;              // default 16 (window ceiling)
  allowPrivate?: boolean;              // tests only
}
export interface CrawlSummary {
  crawlId: string; pagesCrawled: number; frontier: Awaited<ReturnType<typeof frontierCounts>>;
}
export async function runCrawl(db: Db, config: CrawlConfig,
  signal?: AbortSignal): Promise<CrawlSummary>;
```

**Semantics locked:** same-origin policy — only URLs where `isSameOrigin(url, siteUrl)` (from Task 5's url-utils) are enqueued; external link targets are recorded in `links` (Task 11) but never fetched. Every candidate URL passes `isUrlAllowed` **and** `robots.isAllowed` before enqueue. Redirect targets are enqueued with `discoveredVia: "redirect"` at the same depth. A leased URL whose lease expires (crash) becomes leasable again — that is the whole resume mechanism; `runCrawl` on an existing `crawlId`-by-site with pending rows continues rather than restarts.

- [ ] **Step 1: Write the failing frontier tests**

`test/crawl/frontier.test.ts` (DB test — `DATABASE_URL` required):

```ts
it("enqueue is idempotent per (crawl, url)", async () => {
  const n1 = await enqueueUrls(db, crawlId, [{ url: "https://s.example/a", depth: 0, discoveredVia: "seed" }]);
  const n2 = await enqueueUrls(db, crawlId, [{ url: "https://s.example/a", depth: 3, discoveredVia: "link" }]);
  expect(n1).toBe(1); expect(n2).toBe(0);
});
it("lease marks rows and a second leaser gets nothing", async () => {
  await enqueueUrls(db, crawlId, [{ url: "https://s.example/b", depth: 0, discoveredVia: "seed" }]);
  const l1 = await leaseBatch(db, crawlId, "w1", 10, 60);
  const l2 = await leaseBatch(db, crawlId, "w2", 10, 60);
  expect(l1.length).toBeGreaterThan(0);
  expect(l2).toEqual([]);
});
it("an expired lease is re-leasable (crash resume)", async () => {
  await enqueueUrls(db, crawlId, [{ url: "https://s.example/c", depth: 0, discoveredVia: "seed" }]);
  await leaseBatch(db, crawlId, "dead-worker", 10, 0);   // leaseSeconds 0 → instantly stale
  const again = await leaseBatch(db, crawlId, "w2", 10, 60);
  expect(again.map((u) => u.url)).toContain("https://s.example/c");
});
it("failUrl requeues until maxAttempts then marks failed", async () => {
  await enqueueUrls(db, crawlId, [{ url: "https://s.example/d", depth: 0, discoveredVia: "seed" }]);
  await leaseBatch(db, crawlId, "w1", 10, 60);
  await failUrl(db, crawlId, "https://s.example/d", { requeue: true, maxAttempts: 2 });
  expect((await frontierCounts(db, crawlId)).pending).toBeGreaterThan(0);   // attempt 1 → back to pending
  await leaseBatch(db, crawlId, "w1", 10, 60);
  await failUrl(db, crawlId, "https://s.example/d", { requeue: true, maxAttempts: 2 });
  expect((await frontierCounts(db, crawlId)).failed).toBeGreaterThan(0);    // attempt 2 → failed
});
```

- [ ] **Step 2: Implement the frontier**

The lease is one statement (this is the concurrency-safety core — keep it exactly this shape):

```ts
export async function leaseBatch(db, crawlId, leaseId, n, leaseSeconds) {
  const res = await db.execute(sql`
    update frontier set state = 'leased', lease_id = ${leaseId},
      leased_until = now() + make_interval(secs => ${leaseSeconds}),
      attempts = attempts + 1
    where (crawl_id, url) in (
      select crawl_id, url from frontier
      where crawl_id = ${crawlId}
        and (state = 'pending' or (state = 'leased' and leased_until < now()))
      order by depth asc, discovered_at asc
      limit ${n}
      for update skip locked)
    returning url, depth, discovered_via, attempts`);
  return res.rows.map((r) => ({ url: r.url as string, depth: Number(r.depth),
    discoveredVia: r.discovered_via as string, attempts: Number(r.attempts) }));
}
```

`enqueueUrls`: single multi-row `insert … on conflict (crawl_id, url) do nothing`, return the inserted count. `completeUrl`: `update … set state='done', lease_id=null, leased_until=null`. `failUrl`: requeue to `pending` while `attempts < maxAttempts`, else `state='failed'`.

Run: frontier tests PASS.

- [ ] **Step 3: Write the failing loop test**

`test/crawl/loop.test.ts`: fixture server hosting a tiny site — `/` links to `/a`, `/b`, `/admin/secret` (robots-disallowed), and `https://external.example/x`; `/a` links to `/c`; `/b` 301s to `/c`; `/missing` 404s and is linked from `/c`. `robots.txt` disallows `/admin`. Assertions:

```ts
it("crawls the site to completion", async () => {
  const summary = await runCrawl(db, {
    siteUrl: base, maxPages: 100, maxDepth: 10,
    userAgent: "AriadneBot-test", perHostDelayMs: 0, maxConcurrency: 4,
    allowPrivate: true,
  });
  const rows = await db.select().from(pages).where(eq(pages.crawlId, summary.crawlId));
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  expect(byUrl.get(`${base}/b`)?.fetchClass).toBe("redirect");     // hop is its own row
  expect(byUrl.get(`${base}/c`)?.fetchClass).toBe("ok");           // redirect target crawled
  expect(byUrl.get(`${base}/missing`)?.fetchClass).toBe("client_error");
  expect(byUrl.has(`${base}/admin/secret`)).toBe(false);           // robots respected
  expect([...byUrl.keys()].every((u) => u.startsWith(base))).toBe(true); // same-origin
  expect(summary.frontier.pending).toBe(0);
});
it("respects maxPages", async () => {
  const summary = await runCrawl(db, { ...cfg, maxPages: 2 });
  expect(summary.pagesCrawled).toBeLessThanOrEqual(2);
});
it("abort signal stops the loop and releases nothing into limbo", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const summary = await runCrawl(db, cfg, ac.signal);
  const counts = await frontierCounts(db, summary.crawlId);
  expect(counts.leased).toBe(0);      // graceful shutdown released leases
});
```

- [ ] **Step 4: Implement the loop**

Shape (one file, ~250 lines):

```ts
export async function runCrawl(db, config, signal) {
  //  1. create crawls row (id: `crawl_${randomUUID()}`), status running
  //  2. discovery = await discover(config.siteUrl, {...})
  //  3. enqueue: seed URL (depth 0, 'seed') + sitemap entries (depth 0, 'sitemap',
  //     capped at maxPages) — each gated on isUrlAllowed + robots.isAllowed + same-origin
  //  4. persist sitemap entries to sitemap_urls (batched)
  //  5. window = new CrawlWindow(config); gate = new HostGate(config, discovery.robots.crawlDelaySec)
  //     writer = new PageWriter(db, crawlId)
  //  6. main loop:
  //       while not aborted and pagesCrawled < maxPages:
  //         batch = await leaseBatch(db, crawlId, workerId, window.size(), LEASE_SECONDS=180)
  //         if batch empty and frontierCounts.leased === 0 → break (done)
  //         if batch empty → sleep 500ms, continue (another worker's leases pending)
  //         await Promise.all(batch.map(item => handleOne(item)))
  //         window.onBatchSettled(results)
  //  7. handleOne(item):
  //       await gate.acquire(host(item.url))
  //       result = await fetchPage(item.url, {...})
  //       if result.fetchClass === 'ok' and result.body:
  //         analysis = analyzePage(result.body, item.url)
  //         await writer.addPage(item, result, analysis)     // Task 11
  //         if item.depth < maxDepth:
  //           enqueue same-origin, policy-allowed, robots-allowed hrefs
  //           (depth+1, 'link') — batched, cap maxPages minus done
  //       else:
  //         await writer.addPage(item, result, null)
  //         if result.fetchClass === 'redirect' and result.redirectUrl:
  //           enqueue redirect target (same depth, 'redirect') under the same gates
  //       await completeUrl(...)  — or failUrl({requeue: fetchClass in
  //           ['timeout','network_error'], maxAttempts: 3}) for transient classes
  //  8. finally: await writer.flush(); release this worker's live leases
  //     (update frontier set state='pending', lease_id=null where lease_id = workerId
  //      and state='leased'); crawls.status = aborted ? 'cancelled' : 'finished',
  //      finishedAt, pagesCrawled
}
```

The comment block above is the specification; write it as real code. No results accumulate in RAM: `handleOne` writes through `PageWriter` and drops everything. `pagesCrawled` increments on each persisted page (a `frontier` `done` count query at the end double-checks it).

- [ ] **Step 5: Run loop tests**

Run: `DATABASE_URL=… npm test -- test/crawl/loop.test.ts && npm run typecheck` — PASS. (Tasks 10 and 11 must land before this test runs green if executing strictly in order — see the note at Step 6.)

- [ ] **Step 6: Ordering note + commit**

Tasks 9, 10, 11 are one dependency cluster: loop.ts imports HostGate/CrawlWindow (Task 10) and PageWriter (Task 11). Implement 10 and 11 (they have no dependency on 9), then finish 9's loop test. Commit order: frontier first (self-contained), then the loop commit after 10+11.

```bash
git add src/crawl/frontier.ts test/crawl/frontier.test.ts
git commit -m "feat: postgres frontier — idempotent enqueue, SKIP LOCKED leases, crash-resume (P1-T6)"
# …after Tasks 10+11:
git add -A
git commit -m "feat: crawl loop — same-origin, robots, every-hop rows, graceful shutdown (P1-T6)"
```

---

### Task 10: Politeness governor — adaptive window + per-host delay (P1-T7 + amendment)

**Files:**
- Create: `src/crawl/politeness.ts`
- Test: `test/crawl/politeness.test.ts`

**Interfaces:**
- Consumes: nothing (pure logic; loop wires it).
- Produces (loop.ts imports these exact names):

```ts
export interface BatchOutcome { fetchClass: FetchClass; responseTimeMs: number; htmlBytes: number }
export class CrawlWindow {
  constructor(opts: { initial?: number; max: number; slowMs?: number; byteBudget?: number });
  size(): number;                                  // current concurrent batch size
  onBatchSettled(outcomes: BatchOutcome[]): void;  // adapt
  admitBytes(bytes: number): boolean;              // in-flight byte budget check
  releaseBytes(bytes: number): void;
}
export class HostGate {
  constructor(opts: { perHostDelayMs: number; robotsCrawlDelaySec: number | null; maxDelayMs?: number });
  effectiveDelayMs(): number;                      // max(config, robots), capped
  acquire(host: string): Promise<void>;            // resolves when this host may be hit
}
```

**Policy locked (OpenSEO `crawl-window.ts` reference + Talos incident history):**
- Window: start 4; **shrink** to `max(1, floor(size/2))` when any outcome in the batch is `blocked`, `server_error`, or `timeout`; **grow** by 1 (to at most `max`) only when the batch was full-size, error-free, and p95 `responseTimeMs < slowMs` (default 1500). Never grows on a partial batch.
- Byte budget: default 64MiB in-flight; `admitBytes` false → the caller waits. This is the OOM guard.
- HostGate: `effectiveDelayMs = min(maxDelayMs=30_000, max(perHostDelayMs, (robotsCrawlDelaySec ?? 0) * 1000))`; per-host timestamps, elapsed-time credit (a host not hit for longer than the delay admits immediately). This is the yellow.com.mt lesson: WAF token buckets need fixed spacing, which adaptive concurrency alone does not give.

- [ ] **Step 1: Write the failing tests**

```ts
describe("CrawlWindow", () => {
  const ok = (ms = 100): BatchOutcome => ({ fetchClass: "ok", responseTimeMs: ms, htmlBytes: 1000 });
  it("halves on a blocked outcome", () => {
    const w = new CrawlWindow({ initial: 8, max: 16 });
    w.onBatchSettled([ok(), { ...ok(), fetchClass: "blocked" }]);
    expect(w.size()).toBe(4);
  });
  it("never shrinks below 1", () => {
    const w = new CrawlWindow({ initial: 1, max: 16 });
    w.onBatchSettled([{ ...ok(), fetchClass: "timeout" }]);
    expect(w.size()).toBe(1);
  });
  it("grows only on a clean, full, fast batch", () => {
    const w = new CrawlWindow({ initial: 4, max: 16 });
    w.onBatchSettled([ok(), ok(), ok()]);            // partial batch → no growth
    expect(w.size()).toBe(4);
    w.onBatchSettled([ok(), ok(), ok(), ok()]);      // full & fast → +1
    expect(w.size()).toBe(5);
    w.onBatchSettled([ok(3000), ok(), ok(), ok(), ok()]); // slow p95 → no growth
    expect(w.size()).toBe(5);
  });
  it("byte budget admits and releases", () => {
    const w = new CrawlWindow({ initial: 4, max: 16, byteBudget: 1000 });
    expect(w.admitBytes(800)).toBe(true);
    expect(w.admitBytes(300)).toBe(false);
    w.releaseBytes(800);
    expect(w.admitBytes(300)).toBe(true);
  });
});

describe("HostGate", () => {
  it("takes the max of config and robots delay, capped", () => {
    expect(new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: 5 }).effectiveDelayMs()).toBe(5000);
    expect(new HostGate({ perHostDelayMs: 8000, robotsCrawlDelaySec: 2 }).effectiveDelayMs()).toBe(8000);
    expect(new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: 900 }).effectiveDelayMs()).toBe(30000);
  });
  it("spaces two acquisitions of the same host by the delay", async () => {
    const g = new HostGate({ perHostDelayMs: 120, robotsCrawlDelaySec: null });
    const t0 = Date.now();
    await g.acquire("a.example");
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });
  it("different hosts do not wait on each other", async () => {
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    const t0 = Date.now();
    await g.acquire("a.example");
    await g.acquire("b.example");
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run to verify failure, implement, run to pass**

Implementation is ~120 lines directly from the policy block above; `HostGate.acquire` keeps a `Map<string, number>` of `nextAllowedAt` per host and awaits `setTimeout` for the shortfall, updating the slot **before** sleeping so concurrent acquirers chain correctly (same pattern as Talos's `utils/crawl_throttle.py`).

Run: `npm test -- politeness && npm run typecheck` — PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: politeness — adaptive window, byte budget, per-host delay honouring crawl-delay (P1-T7)"
```

---

### Task 11: Batched persistence + page_type (P1-T8, P1-T9)

**Files:**
- Create: `src/crawl/persist.ts`, `src/crawl/page-type.ts`
- Test: `test/crawl/persist.test.ts`, `test/crawl/page-type.test.ts`

**Interfaces:**
- Consumes: `Db` + tables (Task 2), `PageAnalysis` (Tasks 5–6), `FetchResult`/`LeasedUrl` shapes (Tasks 7, 9), `detectUrlTemplate` + `normalizeUrl` (Task 5's url-utils).
- Produces:

```ts
// persist.ts
export class PageWriter {
  constructor(db: Db, crawlId: string, opts?: { batchSize?: number });  // default 100
  addPage(item: { url: string; depth: number; discoveredVia: string },
          fetch: FetchResult, analysis: PageAnalysis | null): Promise<string>; // returns pageId
  flush(): Promise<void>;   // must be called in the loop's finally
}
// page-type.ts
export function derivePageType(url: string,
  clientPatterns?: Array<{ pattern: string; pageType: string }>): string;
// e.g. '/products/{slug}' → 'product' via client patterns; else the
// detectUrlTemplate template string itself (e.g. '/blog/{n}') as the type
```

`addPage` buffers `pages`, `links`, `hreflang`, `structured_data` rows and flushes each buffer independently when it reaches `batchSize` (multi-row inserts). `is_indexable` is computed here: `statusCode === 200 && fetchClass === 'ok' && !/noindex/i.test(robotsMeta ?? '') && !/noindex/i.test(xRobotsTag ?? '')`. `url_normalised` = `normalizeUrl` lowercased with trailing slash stripped. Buffers never exceed `batchSize` — that is the memory contract at the persistence layer.

- [ ] **Step 1: Write the failing tests**

`test/crawl/page-type.test.ts`:

```ts
it("client patterns win", () => {
  expect(derivePageType("https://s.example/products/blue-widget",
    [{ pattern: "/products/", pageType: "product" }])).toBe("product");
});
it("falls back to the detected URL template", () => {
  const t = derivePageType("https://s.example/blog/2024/my-post");
  expect(t).toBeTruthy();
  expect(t).toBe(derivePageType("https://s.example/blog/2025/other-post")); // stable per template
});
```

`test/crawl/persist.test.ts` (DB test): create a crawl row, `addPage` 250 synthetic pages (each with 3 links, 2 hreflang, 1 structured-data block) through a `PageWriter` with `batchSize: 100`, then `flush()`; assert `pages` count 250, `links` 750, `hreflang` 500, `structured_data` 250, and that `is_indexable` is false for a page given `robotsMeta: "noindex,follow"`.

- [ ] **Step 2: Run to verify failure, implement, run to pass**

`derivePageType`: client patterns are substring matches against the pathname (first match wins); fallback is `detectUrlTemplate(pathname)` from the absorbed url-utils (numeric segments → `{n}`, slug segments → `{slug}` — whatever upstream's convention is, keep it). `PageWriter`: arrays per table + `drizzle.insert(table).values(batch)` on flush; `pages` insert uses `onConflictDoNothing` on `(crawl_id, url)` (a redirect target may already have been crawled); pageId is `page_${randomUUID()}` minted in `addPage` so links/hreflang/structured rows can reference it without a read-back.

Run: `DATABASE_URL=… npm test -- test/crawl/persist.test.ts test/crawl/page-type.test.ts` — PASS.
Then complete Task 9 Step 5 (the loop test) and its final commit.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: batched persistence + page_type derivation (P1-T8, P1-T9)"
```

---

### Task 12: Phase 1 gate — 50k pages under 512MB, resume demonstrated

**Files:**
- Create: `test/gate/site-server.ts` (synthetic site generator), `scripts/gate-crawl.ts`, `scripts/gate-resume.ts`
- Create: `docs/gates/phase-1.md` (the recorded result)

**Interfaces:**
- Consumes: `runCrawl`, `frontierCounts`, `createDb`.
- Produces: the recorded gate evidence. No later task consumes code from here.

- [ ] **Step 1: Write the synthetic site server**

`test/gate/site-server.ts` — a deterministic `node:http` server generating a 50k-page site from the URL alone (no state): `/`, `/products/p{0..39999}`, `/blog/{0..9999}` (IDs derived by hashing the path). Each page ~15KB HTML: title, meta description, one JSON-LD Product block on product pages, 20 internal links computed from the page id (`(id*7+k) % 50000` style so the graph is connected from `/`), 2 hreflang links, a few images. Plus `/robots.txt` (allow all, `Crawl-delay: 0`) and a 3-shard sitemap index covering all URLs. Export `startSiteServer(pages: number): Promise<{ base: string; close(): Promise<void> }>`.

- [ ] **Step 2: Write the gate crawl script**

`scripts/gate-crawl.ts`:

```ts
// Starts the site server, runs runCrawl({ maxPages: 50_000, perHostDelayMs: 0,
// maxConcurrency: 16, allowPrivate: true }), samples process.memoryUsage().rss
// every 2s, prints: pages crawled, links row count, elapsed, PEAK RSS in MB.
// Exits non-zero if peak RSS > 512MB or pages crawled < 50_000.
```

Write it as real code (~60 lines). `allowPrivate: true` is the one legitimate non-test use: the fixture site is loopback. Run with `node --max-old-space-size=512` so an unbounded structure fails hard rather than paging.

- [ ] **Step 3: Write the resume gate script**

`scripts/gate-resume.ts`: same setup, but `AbortController.abort()` at ~20k pages (poll `frontierCounts`), then call `runCrawl` again against the **same crawlId's frontier** (expose a `resumeCrawl(db, crawlId, config, signal)` in loop.ts if `runCrawl` cannot already continue — it should: it re-leases pending + expired-lease rows). Assert at the end: `done === 50_000` frontier rows, `pages` table has exactly 50,000 rows for the crawl (idempotent enqueue + `onConflictDoNothing` guarantee no dupes), and print both run's page counts.

- [ ] **Step 4: Run both gates**

Run:
`DATABASE_URL=… node --max-old-space-size=512 --import tsx scripts/gate-crawl.ts`
`DATABASE_URL=… node --import tsx scripts/gate-resume.ts`
Expected: both exit 0. **Record the actual peak RSS figure** — the build plan demands the number, not the pass/fail.

- [ ] **Step 5: Record the gate**

`docs/gates/phase-1.md`: date, commit sha, peak RSS (MB), pages/sec, links row count, resume kill point and final counts, machine specs. One page.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: phase 1 gate — 50k-page crawl under 512MB with crash-resume, recorded"
```

---

## Self-Review (performed at authoring time)

- **Spec coverage:** P0-T1→Task 1, P0-T2→Task 1, P0-T3→Task 2, P0-T4→Task 3, P1-T1→Task 4, P1-T2→Task 5, P1-T3→Task 6, P1-T4→Task 7, P1-T5→Task 8, P1-T6→Task 9, P1-T7→Task 10, P1-T8/T9→Task 11, Phase 1 gate (+ resume amendment)→Task 12. Rendering (P5), rules (P2–P4), MCP (P6), reports (P7) are explicitly out of scope of this plan and get their own plans at their phase boundaries.
- **Known intentional deviations:** frontier table added to the Phase 0 schema (spec lists it under P1-T6; migrating once is cleaner). `fetchClass` gains `disallowed`/`non_html`/`too_large` beyond the spec's prose list — they are classifications the spec's decisions imply. `derivePageType` falls back to the template string itself as the type; client patterns name the friendly types.
- **Type consistency check:** `Db`, `PageAnalysis`, `FetchResult`, `LeasedUrl`, `CrawlWindow`/`HostGate`, `PageWriter` names and signatures are declared once in their producing task's Interfaces block and used identically in Tasks 9–12. Task 9/10/11 form a dependency cluster; the ordering note in Task 9 Step 6 governs.
- **Absorption caveat:** Tasks 4–5 adapt upstream code whose exact internal names are known only at execution time; their facades (`isUrlAllowed`, `analyzePage`) are the fixed seams and everything downstream depends only on those.
