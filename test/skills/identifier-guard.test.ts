/**
 * THE SKILLS CANNOT DRIFT FROM THE ENGINE SILENTLY.
 *
 * `skills/**` is documentation an agent EXECUTES: it names rule ids, MCP tools,
 * response fields, environment variables and checklist ids, and an agent that
 * reads a name the engine no longer has does not get an error — it gets an empty
 * listing, a refused filter, or a check answered from the wrong column. Nothing
 * else in this repository reads those files, so a rename in `src/` and a
 * sentence in a SKILL.md drift apart in silence.
 *
 * ## Why this exists, and exactly how much of it this test catches
 *
 * The Phase 6 gate (`docs/gates/phase-6.md`, item 14) proposed this test over
 * four of its own divergences. Being precise about which of them would actually
 * go red here matters more than the count, because the gap is where the next one
 * will live:
 *
 *  - **D-4 — CAUGHT, by the shape tests at the bottom of this file.** The audit
 *    skill's findings interface asked for an `elapsedMs` on the `crawl_rules`
 *    summary that the surface has never returned, and did not mention the
 *    `derived` and `metrics` scalars it does. A documented block compared to
 *    `RunSummary` as a whole set fails on both halves.
 *  - **D-5 — PARTLY.** `renderPassCount` is a real field, spelled correctly; what
 *    was wrong was the SENTENCE around it ("how many passes ran" — it is the last
 *    pass's rendered-page count). The identifier check cannot read that. The
 *    shape tests would only have caught it had the field been absent.
 *  - **D-10 — NOT CAUGHT.** "Two unfiltered sweeps" was advice whose arithmetic
 *    is wrong at real metric cardinality. Every identifier in it was correct.
 *  - **D-11 — NOT CAUGHT.** `limit` existing and going unmentioned is an
 *    OMISSION; nothing in a text says a field was left out.
 *
 * Phase 7's own three, on the same honest accounting: the marker claim
 * ("nothing on `crawl_status` distinguishes the two", false since `rulesRunAt`
 * and `findingsCount` shipped in P7-T3) is caught only in the half that is a
 * shape — the `crawl_status` block below now has to list both fields; the false
 * NOT-MEASURED list (duplicate titles and headings, measured since P7-T2) and
 * the checklist's hand-rebuilt reachability (measured since P7-T4) are claims
 * about what exists, and no identifier in either was misspelled.
 *
 * **So: this file catches WRONG NAMES, and the two shape tests catch a wrong or
 * missing FIELD in the two blocks documented as whole shapes. It cannot read a
 * false claim, a wrong piece of arithmetic, or an omission in prose.** Those
 * remain human review, and the fact that most of the divergences above are in
 * that class is the argument for extending the shape tests rather than for
 * trusting a green run here as "the skills are correct".
 *
 * ## How a token is checked
 *
 * Tokens come from inline code spans, from fenced blocks that document a SHAPE
 * (untagged, `json`, `markdown` — the templates the skills tell an agent to
 * fill in), and — for the two unmistakable shapes, `CHECK-NN` and `ARIADNE_*` —
 * from the whole file, because both are written in prose without backticks.
 * Fences tagged with another language (`python`, `javascript`, `bash`) are that
 * language's code and are not read.
 *
 * A token is CHECKED when it carries an engine identifier's shape: a dot
 * between segments, an underscore, or an interior capital. Everything else — a
 * bare lowercase word (`count`, `finished`), a capitalised one (`PASS`,
 * `Engine`), a hyphenated one (`crawl-delay`, `x-default`) — carries no shape
 * that separates an engine identifier from prose or from a field's VALUE, and
 * is not checked. That is a limit of the guard, stated rather than hidden: a
 * renamed single-word field (`count`, `notes`) is not caught here.
 *
 * A shaped token is then classified and looked up:
 *
 *  | shape                          | class                | source of truth                        |
 *  |--------------------------------|----------------------|----------------------------------------|
 *  | `CHECK-31`, `CHECK-33b`        | checklist id         | the checklist's own `###` headings      |
 *  | `ARIADNE_API_TOKEN`            | environment variable | the `env[...]` reads under `src/`       |
 *  | `crawl_status`                 | MCP tool / scope     | `TOOL_NAMES`, `METRIC_SCOPES`           |
 *  | `crawl_status.pagesCrawled`    | tool's field         | `TOOL_NAMES` + the field sets           |
 *  | `crawl.caveats`                | findings-file path   | the audit skill's own Phase 4 example   |
 *  | `content.thin`                 | rule / metric id     | `buildRegistry()`                       |
 *  | `renderableWordCount`          | field name           | the serializer field sets, then the     |
 *  |                                |                      | findings-file keys, then the rule source|
 *
 * A shaped token that matches no class, or fails its class's lookup, FAILS the
 * test unless it is in `ALLOWLIST` with a reason — a hostname, a filename, an
 * analytics vendor's field, an example crawl id. There are no silent skips: an
 * allowlist entry nothing uses fails too, so the list cannot rot either.
 *
 * Deterministic by construction: files and the registry, no database and no
 * network. `buildRegistry()` is pure construction — it registers rule objects
 * and validates their copy — so the whole guard runs on `npm test` anywhere.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAGE_FIELDS, START_CRAWL_FIELDS } from "../../src/api/service.js";
import { TOOL_NAMES } from "../../src/api/mcp.js";
import { METRIC_SCOPES } from "../../src/rules/registry/types.js";
import { buildRegistry } from "../../src/rules/index.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SKILLS = join(ROOT, "skills");
const CHECKLIST = join(SKILLS, "ariadne-audit", "checklist.md");
const AUDIT_SKILL = join(SKILLS, "ariadne-audit", "SKILL.md");
const CRAWL_SKILL = join(SKILLS, "ariadne-crawl", "SKILL.md");
const REPORT_SKILL = join(SKILLS, "ariadne-report", "SKILL.md");
const ACTION_PLAN_SKILL = join(SKILLS, "ariadne-action-plan", "SKILL.md");

// --------------------------------------------------------------- the sources

/** Every rule and metric id the registry holds. */
const REGISTRY_IDS = new Set(buildRegistry().all().map((rule) => rule.id));

/** The tool vocabulary an agent may name: the MCP tools and the metric scopes. */
const TOOL_VOCABULARY = new Set<string>([...TOOL_NAMES, ...METRIC_SCOPES]);

/** `### CHECK-07: …` — the checklist is the authority on its own ids. */
const CHECK_IDS = new Set(
  [...readFileSync(CHECKLIST, "utf8").matchAll(/^###\s+(CHECK-\d+[a-z]?):/gm)].map((m) => m[1]!),
);

/**
 * The environment the engine actually reads: every `env["NAME"]` under `src/`.
 *
 * The read is the definition. A variable the skills tell an operator to set and
 * nothing reads is exactly the failure this catches.
 */
const ENV_READS = new Set(
  sourceFiles(join(ROOT, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)].map(
      (m) => m[1]!,
    ),
  ),
);

/**
 * The field names the surface publishes: the two exported projections, plus the
 * fields of the response and query shapes the transports serialise.
 *
 * Read out of the declarations rather than restated here, so a renamed field
 * changes this set on the commit that renames it.
 */
const API_FIELDS = new Set<string>([
  ...Object.keys(PAGE_FIELDS),
  ...Object.keys(START_CRAWL_FIELDS),
  ...declaredFields(join(ROOT, "src/api/service.ts"), [
    "CrawlAccepted",
    "CrawlListItem",
    "CrawlDetail",
    "RobotsEvidence",
    "Page",
    "RenderSummaryOut",
    "IssueTruncation",
    "IssueGroup",
    "IssueUrl",
    "MetricRow",
    "PageRow",
    "ExportResult",
    "IssueQuery",
    "MetricQuery",
    "PageQuery",
    "StartCrawlInput",
  ]),
  ...declaredFields(join(ROOT, "src/crawl/frontier.ts"), ["FrontierCounts"]),
  ...declaredFields(join(ROOT, "src/rules/run.ts"), ["RunSummary"]),
  ...declaredFields(join(ROOT, "src/rules/registry/types.ts"), ["Finding", "Metric"]),
]);

/** The findings file's own shape, read out of the audit skill's Phase 4 example. */
const FINDINGS = findingsExample();

/**
 * Every word in the rule sources, for the keys a rule writes into an evidence
 * blob or a metric value (`nullCount`, `urlCapBreaches`, `atLeast`).
 *
 * WEAKER THAN THE OTHER LOOKUPS, deliberately and visibly: those keys are the
 * rules' own shapes, published on no exported type — `evidence` is
 * `Record<string, unknown>` and a metric `value` is `unknown`, because the API
 * is not entitled to edit a rule's testimony. So the guard asserts the name
 * still exists in the code that writes it, which catches a rename; it cannot
 * assert it is still an evidence key.
 */
const RULE_SOURCE_WORDS = new Set(
  sourceFiles(join(ROOT, "src/rules")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\b[a-z][a-zA-Z0-9]*\b/g)].map((m) => m[0]),
  ),
);

/**
 * Shaped tokens that are not engine identifiers, each with the reason it is
 * here. An entry nothing uses is a failure of its own — a stale excuse is the
 * thing this file exists to prevent.
 */
const ALLOWLIST: Record<string, string> = {
  // Hostnames. Dotted and lowercase, like a rule id, and neither is one.
  "example.com": "the documentation's example host",
  "cdn.shopify.com": "a Shopify asset host, in the platform-detection table",
  "myshopify.com": "a Shopify host, in the platform-detection table",
  "you.com": "an AI assistant's host, in the GEO checks",
  // Filenames the skills name.
  "checklist.md": "the checklist file beside the audit skill",
  "SKILL.md": "a skill's own file",
  "ariadne-findings.json": "the findings file the audit writes",
  "findings.json": "the name the Phase 6 run used, named in the audit skill so a reader can rename it",
  "issues.jsonl.gz": "the suffix export_crawl gives a written dataset",
  "llm.txt": "the AI-crawler file CHECK-60 asks about, in its older spelling",
  "llms.txt": "the AI-crawler file CHECK-60 asks about",
  "mcp.json": "the site-level MCP manifest CHECK-64 looks for",
  "image.jpg": "an example image URL in a parameter test",
  "action-plan.xlsx": "the workbook the action-plan skill writes",
  "audit-report.md": "the markdown deliverable the report skill writes",
  "coverage.test.ts": "this repository's checklist-coverage test, named in skills/README.md",
  "store-selector.liquid": "a Shopify theme file in CHECK-37's worked example",
  "store-select__heading": "a CSS class in CHECK-37's worked example",
  "filter.v.color": "a Shopify filter parameter in the faceted-navigation examples",
  // The browser steps' own JavaScript, quoted inline rather than fenced.
  "Array.from": "JavaScript in a DevTools step",
  "JSON.parse": "JavaScript in a DevTools step",
  "JSON.stringify": "JavaScript in a DevTools step",
  "document.querySelector": "the DOM API in a DevTools step",
  "document.querySelectorAll": "the DOM API in a DevTools step",
  "s.textContent": "the DOM API in a DevTools step",
  "h.textContent.trim": "the DOM API in a DevTools step",
  "h.tagName": "the DOM API in a DevTools step",
  "a.href": "the DOM API in a DevTools step",
  // Example values, quoted so a reader can see the shape of a real one.
  crawl_0b31: "an elided example crawl id",
  "crawl_0b316718-636a-42c9-abbb-738c46b77db6": "an example crawl id",
  "filter.v.size": "a Shopify filter parameter in a robots pattern test",
  // Other vendors' surfaces. Named because the audit calls them, owned by them.
  list_properties: "a GSC MCP tool",
  get_search_analytics: "a GSC MCP tool",
  get_advanced_search_analytics: "a GSC MCP tool",
  compare_search_periods: "a GSC MCP tool",
  batch_url_inspection: "a GSC MCP tool",
  check_indexing_issues: "a GSC MCP tool",
  get_property_details: "a GSC MCP tool",
  get_account_summaries: "a GA4 MCP tool",
  get_performance_overview: "a GA4 MCP tool",
  run_report: "a GA4 MCP tool",
  run_realtime_report: "a GA4 MCP tool",
  list_console_messages: "a browser MCP tool",
  list_network_requests: "a browser MCP tool",
  add_to_cart: "a GA4 e-commerce event name",
  begin_checkout: "a GA4 e-commerce event name",
  generate_lead: "a GA4 conversion event name",
  sign_up: "a GA4 conversion event name",
  form_submit: "a GA4 engagement event name",
  file_download: "a GA4 engagement event name",
  cdn_asset: "a resource label in the CHECK-69 theme-bloat table",
  start_date: "a GSC query argument",
  end_date: "a GSC query argument",
  row_limit: "a GSC query argument",
  sort_by: "a Shopify URL parameter in the robots pattern tests",
  "mcp__a0369373-5739-4331-b4c9-ddad7f6442c0": "the Ahrefs MCP server's tool namespace",
  // GA4 and GSC dimensions and metrics, quoted in the analytics checks.
  sessionSource: "a GA4 dimension",
  sessionMedium: "a GA4 dimension",
  sessionDefaultChannelGroup: "a GA4 dimension",
  landingPage: "a GA4 dimension",
  eventName: "a GA4 dimension",
  yearMonth: "a GA4 dimension",
  totalUsers: "a GA4 metric",
  engagedSessions: "a GA4 metric",
  engagementRate: "a GA4 metric",
  bounceRate: "a GA4 metric",
  averageSessionDuration: "a GA4 metric",
  screenPageViewsPerSession: "a GA4 metric",
  eventCount: "a GA4 metric",
  addToCarts: "a GA4 metric",
  ecommercePurchases: "a GA4 metric",
  purchaseRevenue: "a GA4 metric",
  // Ours, but not on the agent surface.
  allowPrivate: "the crawl-defaults field the API refuses by name, never accepts",
  correlationId: "the internal-error envelope's field, built inline in mcp.ts and http.ts",
  // `derivePageType` was allowed here while the skills had to warn the agent
  // about the page-type heuristics on the backlog. P8-T5 closed that item and
  // the warnings became a description of what the crawl now does, written in
  // the agent's own vocabulary — no internal function named, so no exemption.
};

const allowlistUsed = new Set<string>();

// -------------------------------------------------------------- the extraction

interface Token {
  file: string;
  line: number;
  text: string;
}

/** Fences whose contents are another language's code, not a shape we document. */
const CODE_FENCES = new Set(["python", "javascript", "js", "ts", "typescript", "bash", "sh"]);

/**
 * Every candidate token in one skill file, with the line it sits on.
 *
 * Three passes, because the skills name identifiers in three ways: inside
 * inline code spans, inside the fenced blocks that document a shape, and — for
 * check ids and environment variables — in bare prose.
 */
function tokensOf(file: string): Token[] {
  const out: Token[] = [];
  const push = (line: number, text: string): void => {
    // A span may end a sentence; a trailing stop is punctuation, never an id.
    out.push({ file, line, text: text.replace(/[.,:;)]+$/, "") });
  };
  let fence: string | null = null;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const lineNo = index + 1;
      for (const m of line.matchAll(/\bCHECK-\d+[a-z]?\b/g)) push(lineNo, m[0]);
      for (const m of line.matchAll(/\bARIADNE_[A-Z0-9_]+\b/g)) push(lineNo, m[0]);

      const fenceMark = /^\s*```(\S*)/.exec(line);
      if (fenceMark) {
        fence = fence === null ? (fenceMark[1] ?? "") : null;
        return;
      }
      if (fence !== null) {
        if (CODE_FENCES.has(fence)) return;
        for (const m of line.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/g)) push(lineNo, m[0]);
        return;
      }
      for (const span of line.matchAll(/`([^`]+)`/g)) {
        for (const m of span[1]!.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/g)) push(lineNo, m[0]);
      }
    });
  return out;
}

/** Does this token carry an engine identifier's shape? See the header. */
function isShaped(token: string): boolean {
  return (
    /^CHECK-\d+[a-z]?$/.test(token) ||
    /[a-zA-Z0-9]\.[a-zA-Z0-9]/.test(token) ||
    token.includes("_") ||
    /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/.test(token)
  );
}

// ---------------------------------------------------------- the classification

type Verdict = { kind: string; ok: true } | { kind: string; ok: false; why: string };

const found = (kind: string): Verdict => ({ kind, ok: true });
const missing = (kind: string, why: string): Verdict => ({ kind, ok: false, why });

/**
 * Classify a shaped token by its shape, then look it up in that class's source.
 *
 * The order matters where two shapes overlap: `crawl.caveats` is a path into
 * the findings file AND has a rule id's shape, so the findings file is asked
 * first and the registry only sees what it did not answer.
 */
function classify(token: string): Verdict {
  if (token in ALLOWLIST) {
    allowlistUsed.add(token);
    return found("allowlisted");
  }
  if (/^CHECK-\d+[a-z]?$/.test(token)) {
    return CHECK_IDS.has(token)
      ? found("checklist id")
      : missing("checklist id", "no such check in checklist.md");
  }
  if (/^(ARIADNE_[A-Z0-9_]+|DATABASE_URL)$/.test(token)) {
    return ENV_READS.has(token)
      ? found("environment variable")
      : missing("environment variable", "nothing under src/ reads this variable");
  }
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)) {
    return TOOL_VOCABULARY.has(token)
      ? found("tool or scope")
      : missing("tool or scope", "not an MCP tool name and not a metric scope");
  }
  if (token.includes(".")) {
    const [head, ...rest] = token.split(".");
    if (head !== undefined && rest.length === 1 && TOOL_VOCABULARY.has(head)) {
      return fieldExists(rest[0]!)
        ? found("a tool's field")
        : missing("a tool's field", `${head} answers no field called '${rest[0]}'`);
    }
    if (FINDINGS.paths.has(token)) return found("findings-file path");
    if (REGISTRY_IDS.has(token)) return found("rule or metric id");
    return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(token)
      ? missing("rule or metric id", "no rule or metric of that id is registered")
      : missing("findings-file path", "no such path in the audit skill's Phase 4 shape");
  }
  return fieldExists(token)
    ? found("field name")
    : missing("field name", "no response field, findings-file key or rule source writes it");
}

function fieldExists(name: string): boolean {
  return API_FIELDS.has(name) || FINDINGS.keys.has(name) || RULE_SOURCE_WORDS.has(name);
}

// --------------------------------------------------------------- the readers

/** Every `.ts` file under a directory, recursively and in a stable order. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** Every `.md` under `skills/`, in a stable order. */
function skillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) out.push(full);
    }
  };
  walk(SKILLS);
  return out.sort();
}

/**
 * The field names of the named declarations in one source file.
 *
 * A declaration this asks for and does not find is a THROW, not an empty set:
 * a renamed response type would otherwise quietly shrink the field vocabulary
 * and let a stale skill through.
 */
function declaredFields(file: string, names: readonly string[]): string[] {
  const source = readFileSync(file, "utf8");
  const fields: string[] = [];
  for (const name of names) {
    const declaration = new RegExp(`\\b(?:interface|type)\\s+${name}\\b`).exec(source);
    if (declaration === null) {
      throw new Error(`identifier-guard: ${relative(ROOT, file)} declares no '${name}'`);
    }
    const open = source.indexOf("{", declaration.index);
    if (open === -1) throw new Error(`identifier-guard: '${name}' has no body`);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    for (const m of source.slice(open, end).matchAll(/^\s*([a-z][a-zA-Z0-9]*)\??\s*:/gm)) {
      fields.push(m[1]!);
    }
  }
  return fields;
}

/**
 * The identifiers of the first fenced block in `file` that mentions `marker`,
 * sorted and de-duplicated — a documented response shape, as a set.
 *
 * A marker that matches no block THROWS: this reads one specific block, so
 * "the block moved" must not read as "the block agrees".
 */
function fenceTokens(file: string, marker: string): string[] {
  for (const block of readFileSync(file, "utf8").matchAll(/```\S*\n([\s\S]*?)```/g)) {
    const body = block[1]!;
    if (!body.includes(marker)) continue;
    return unique([...body.matchAll(/[a-z][a-zA-Z0-9]*/g)].map((m) => m[0]));
  }
  throw new Error(`identifier-guard: ${relative(ROOT, file)} has no fenced block naming ${marker}`);
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * The `{a, b, c}` shape the checklist's tool table documents for one tool.
 *
 * The table is where an auditor learns what a listing answers with, so the row
 * is a response shape written by hand — the same class of statement as the
 * fenced blocks above, in a table cell. Absent is a THROW for the same reason.
 */
function toolTableShape(tool: string): string[] {
  const row = new RegExp(`^\\|\\s*\`${tool}\`\\s*\\|.*$`, "m").exec(readFileSync(CHECKLIST, "utf8"));
  if (row === null) {
    throw new Error(`identifier-guard: the checklist's tool table has no '${tool}' row`);
  }
  const shape = /`\{([^`]*)\}`/.exec(row[0]);
  if (shape === null) {
    throw new Error(`identifier-guard: the checklist's '${tool}' row documents no {…} shape`);
  }
  return unique([...shape[1]!.matchAll(/[a-z][a-zA-Z0-9]*/g)].map((m) => m[0]));
}

/**
 * Every backticked `{…}` shape in one file whose body names `marker`, with the
 * line each sits on — a shape documented in more than one place has to agree
 * with the engine in all of them, and this is how both copies are read.
 */
function bracedShapes(file: string, marker: string): { line: number; names: string[] }[] {
  const text = readFileSync(file, "utf8");
  const out: { line: number; names: string[] }[] = [];
  for (const match of text.matchAll(/`\{([^`]*)\}`/g)) {
    if (!match[1]!.includes(marker)) continue;
    out.push({
      line: text.slice(0, match.index).split("\n").length,
      names: unique([...match[1]!.matchAll(/[a-z][a-zA-Z0-9]*/g)].map((m) => m[0])),
    });
  }
  if (out.length === 0) {
    throw new Error(`identifier-guard: ${relative(ROOT, file)} documents no shape naming ${marker}`);
  }
  return out;
}

/**
 * The findings file's shape, parsed out of the audit skill's own `json` block.
 *
 * INTERNAL CONSISTENCY, like the check ids: the audit skill defines this file
 * and the report and action-plan skills read it, so a path one of them names
 * and the example does not carry is a broken deliverable hand-off.
 */
function findingsExample(): { keys: Set<string>; paths: Set<string> } {
  const block = /```json\n([\s\S]*?)```/.exec(readFileSync(AUDIT_SKILL, "utf8"));
  if (block === null) {
    throw new Error("identifier-guard: the audit skill carries no json findings example");
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  const walk = (value: unknown, trail: string[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, trail);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      // Every suffix of the path, so a skill may write `frontier.pending` for
      // what the example carries at `crawl.frontier.pending`.
      const here = [...trail, key];
      for (let i = 0; i < here.length; i += 1) paths.add(here.slice(i).join("."));
      walk(child, here);
    }
  };
  walk(JSON.parse(block[1]!), []);
  return { keys, paths };
}

// ------------------------------------------------------------------ the guard

const TOKENS = skillFiles().flatMap(tokensOf);
const SHAPED = TOKENS.filter((token) => isShaped(token.text));

/** `skills/ariadne-audit/SKILL.md:40 `rulesRunAt`` — where a reader has to go. */
function at(token: Token): string {
  return `${relative(ROOT, token.file)}:${token.line} \`${token.text}\``;
}

function failures(kind: string): string[] {
  const out = new Set<string>();
  for (const token of SHAPED) {
    const verdict = classify(token.text);
    if (verdict.kind === kind && !verdict.ok) out.add(`${at(token)} — ${verdict.why}`);
  }
  return [...out].sort();
}

describe("the skills name only identifiers the engine has", () => {
  it("names rules and metrics that are in the registry", () => {
    expect(failures("rule or metric id")).toEqual([]);
  });

  it("names MCP tools and metric scopes that exist", () => {
    expect(failures("tool or scope")).toEqual([]);
    expect(failures("a tool's field")).toEqual([]);
  });

  it("names response fields the surface actually publishes", () => {
    expect(failures("field name")).toEqual([]);
  });

  it("names environment variables something under src/ reads", () => {
    expect(failures("environment variable")).toEqual([]);
  });

  it("names check ids the checklist defines", () => {
    expect(failures("checklist id")).toEqual([]);
  });

  // THE OTHER DIRECTION, for the one class of rule whose whole purpose is to be
  // read: a NOT MEASURED marker reports that a check COULD NOT BE ANSWERED on
  // this crawl, and an agent that never meets it reads the silence of the rules
  // it stands in for as a clean site. So a marker must be named in the checklist
  // entry of every check it claims — which is where the auditor is looking when
  // the silence would otherwise mislead them.
  //
  // The guard exists because P11-T3 shipped a marker that claimed four checks
  // and appeared in none of their entries; the three older markers all did, and
  // this is what keeps that from being luck. The list is explicit, with the
  // reason each id is on it, on the `AGENT_CHECK_EVIDENCE` precedent: "which
  // rules are markers" is a judgement about intent that no naming convention
  // settles (`host.probe-skipped` reports a crawl OPTION, not missing data, and
  // is on the list for the same reason as the rest — its silence is not a pass).
  it("every NOT MEASURED marker is named in the checklist entry of each check it claims", () => {
    const MARKERS: Record<string, string> = {
      "content.thin-skipped": "the page the corrected thin-content floor cannot judge",
      "h1.duplicate-skipped": "a crawl that stored no heading text",
      "links.orphan-skipped": "an incomplete crawl, whose orphans cannot be trusted",
      "robots.check-skipped": "a robots.txt the crawl could not read",
      "host.probe-skipped": "a crawl started with host probing off",
      "resources.not-recorded": "a crawl that recorded no resources (P11-T3)",
    };
    const text = readFileSync(CHECKLIST, "utf8");
    // `### CHECK-NN: …` to the next `### `, which is one check's whole entry.
    const sections = new Map<string, string>();
    const headings = [...text.matchAll(/^###\s+(CHECK-\d+[a-z]?):/gm)];
    headings.forEach((heading, i) => {
      const start = heading.index ?? 0;
      const end = i + 1 < headings.length ? (headings[i + 1]!.index ?? text.length) : text.length;
      sections.set(heading[1]!, text.slice(start, end));
    });

    const byId = new Map(buildRegistry().all().map((rule) => [rule.id, rule]));
    const missing: string[] = [];
    for (const [ruleId, why] of Object.entries(MARKERS)) {
      const rule = byId.get(ruleId);
      if (rule === undefined) throw new Error(`identifier-guard: no rule '${ruleId}' — ${why}`);
      for (const checkId of rule.checkIds) {
        const section = sections.get(checkId);
        if (section === undefined) throw new Error(`identifier-guard: no ${checkId} entry`);
        if (!section.includes(ruleId)) missing.push(`${checkId} does not name ${ruleId}`);
      }
    }
    expect(
      missing,
      "a marker an auditor never meets is a silence they will read as a pass — name it " +
        "in the entry of every check it claims, or drop the claim",
    ).toEqual([]);
  });

  it("names findings-file paths the audit skill's own shape carries", () => {
    expect(failures("findings-file path")).toEqual([]);
  });

  it("classifies every shaped token — an unclassifiable one needs a reason", () => {
    // The classes above cover every shape; this is the assertion that the
    // ALLOWLIST is where an exception goes, rather than a silent `continue`.
    const unclassified = SHAPED.filter((token) => {
      const verdict = classify(token.text);
      return !verdict.ok && !["rule or metric id", "tool or scope", "a tool's field",
        "field name", "environment variable", "checklist id", "findings-file path",
      ].includes(verdict.kind);
    });
    expect(unclassified.map(at)).toEqual([]);
  });

  it("carries no allowlist entry the skills have stopped using", () => {
    for (const token of SHAPED) classify(token.text);
    expect([...Object.keys(ALLOWLIST)].filter((t) => !allowlistUsed.has(t)).sort()).toEqual([]);
  });

  // A wrong name fails above; a MISSING one cannot, because nothing in a
  // sentence says a field was left out. These two blocks are documented as
  // whole shapes, so they can be compared as whole shapes — which is exactly
  // what gate divergence D-4 was (a summary documented with a field it does not
  // return and without two it does).
  it("documents `crawl_status`'s answer as the answer it gives", () => {
    expect(fenceTokens(CRAWL_SKILL, "hostSpacingMs")).toEqual(
      unique([
        ...declaredFields(join(ROOT, "src/api/service.ts"), ["CrawlListItem", "CrawlDetail"]),
        ...declaredFields(join(ROOT, "src/crawl/frontier.ts"), ["FrontierCounts"]),
      ]),
    );
  });

  it("documents the `crawl_rules` summary as the summary it returns", () => {
    expect(fenceTokens(CRAWL_SKILL, "byMetric")).toEqual(
      unique(declaredFields(join(ROOT, "src/rules/run.ts"), ["RunSummary"])),
    );
  });

  it("documents `robots_get`'s answer as the answer it gives, in both places", () => {
    const evidence = unique(declaredFields(join(ROOT, "src/api/service.ts"), ["RobotsEvidence"]));
    // CHECK-03's Engine step and the tool table both write the shape out. Two
    // copies of one statement is how one of them eventually stops being true.
    for (const shape of bracedShapes(CHECKLIST, "robotsUrl")) {
      expect(shape.names, `checklist.md:${shape.line}`).toEqual(evidence);
    }
    expect(toolTableShape("robots_get")).toEqual(evidence);
  });

  it("documents the query tools' rows as the rows they return", () => {
    const service = join(ROOT, "src/api/service.ts");
    // `IssueGroup`'s own fields; the truncation note is a separate type,
    // documented separately in the audit skill because it is sometimes absent.
    expect(toolTableShape("issues_list")).toEqual(unique(declaredFields(service, ["IssueGroup"])));
    expect(toolTableShape("issue_urls")).toEqual(unique(declaredFields(service, ["IssueUrl"])));
    expect(toolTableShape("metrics_get")).toEqual(unique(declaredFields(service, ["MetricRow"])));
    // The same three shapes are quoted outside the table — the report skill's
    // metrics sweep, the action plan's intake — and must not drift apart.
    for (const shape of bracedShapes(REPORT_SKILL, "metricId")) {
      expect(shape.names, `ariadne-report/SKILL.md:${shape.line}`).toEqual(
        unique(declaredFields(service, ["MetricRow"])),
      );
    }
    for (const shape of bracedShapes(ACTION_PLAN_SKILL, "sampleUrls")) {
      expect(shape.names, `ariadne-action-plan/SKILL.md:${shape.line}`).toEqual(
        unique(declaredFields(service, ["IssueGroup"])),
      );
    }
  });

  it("reads something: the extraction is not silently empty", () => {
    // A regex that stops matching would otherwise turn this whole file green.
    expect(skillFiles().length).toBeGreaterThanOrEqual(5);
    expect(SHAPED.length).toBeGreaterThan(500);
    expect(REGISTRY_IDS.size).toBeGreaterThan(50);
    // 83 since P11-T4 added CHECK-83, the engine-coverage check. (The count is
    // one more than the highest id: CHECK-33b is a check in its own right.)
    expect(CHECK_IDS.size).toBe(83);
    expect(TOOL_VOCABULARY.size).toBe(TOOL_NAMES.length + METRIC_SCOPES.length);
  });
});
