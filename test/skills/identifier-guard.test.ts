/**
 * THREE GUARDS OVER DOCUMENTATION NOTHING ELSE READS.
 *
 * The first (`the skills name only identifiers the engine has`) checks that
 * `skills/**` names identifiers the engine still has. The second (`the surface
 * document cites the test it means`) checks that `docs/talos-surface.md`'s
 * `file:line` citations name the test whose title the document quotes. The third
 * (`the surface document's src/ references name what they claim`, at the bottom
 * of this file) checks the same document's `src/` references for the different
 * property those can carry — P12-T4 took that decision and states it there. They
 * share this file because they are one discipline read three times: a document
 * nothing executes drifts silently, so something has to read it.
 *
 * ---
 *
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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  // `crawl_status.throttle`'s per-host record (Phase 24a).
  ...declaredFields(join(ROOT, "src/crawl/politeness.ts"), ["HostThrottle"]),
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

/**
 * The rule ids CHECK-83 enumerates as its NOT MEASURED family: the backticked
 * ids between the phrase that opens the enumeration and the sentence that closes
 * it. The window is bounded on both sides so the other backticked marker ids in
 * the CHECK-83 entry — the ones its prose discusses further down — are not read
 * as part of the list.
 *
 * A missing anchor is a THROW, not an empty set, on this file's own principle: a
 * family list that MOVED must not read as a family with no members, which would
 * pass the bijection against a marker set that had also somehow emptied.
 */
function notMeasuredFamily(): Set<string> {
  const text = readFileSync(CHECKLIST, "utf8");
  const open = text.indexOf("NOT MEASURED family:");
  if (open === -1) {
    throw new Error("identifier-guard: CHECK-83 opens no 'NOT MEASURED family:' enumeration");
  }
  const rest = text.slice(open);
  const close = rest.indexOf("Each one");
  if (close === -1) {
    throw new Error("identifier-guard: the NOT MEASURED family enumeration has no closing sentence");
  }
  // A rule id inside backticks: lowercase segments joined by `.` or `-`, so a
  // marker id is read and a bare word in the prose is not.
  return new Set(
    [...rest.slice(0, close).matchAll(/`([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)`/g)].map((m) => m[1]!),
  );
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
  // the silence would otherwise mislead them — AND in CHECK-83's NOT MEASURED
  // family list, the one place an auditor is told to go looking for the whole
  // set at once.
  //
  // The guard exists because P11-T3 shipped a marker that claimed four checks
  // and appeared in none of their entries; every older marker did, and this is
  // what keeps that from being luck.
  //
  // **WHICH RULES ARE MARKERS IS NOW DERIVED, not hand-listed (P13-T4).** The
  // `marker` flag on the rule definition is the single source of truth: this
  // block reads `buildRegistry()` and takes every rule whose `marker` is set.
  // The hand-written map three phases paid a three-edit toll into — the rule, an
  // entry in this map, and CHECK-83's family list — is gone, and only the first
  // of those survives as an edit. Adding a marker is ONE edit, the flag on its
  // definition, and the two assertions below turn the other two former edits
  // from silent bookkeeping into enforced obligations: a flagged rule the
  // checklist forgot fails the first, and an id CHECK-83 names that nobody
  // flagged — a marker somebody documented and forgot to declare — fails the
  // second. "Which rules are markers" was a judgement about intent no naming
  // convention settled (`host.probe-skipped` reports a crawl OPTION, not missing
  // data — its silence is still not a pass); the flag is now where that
  // judgement is recorded, once, beside the rule it is about.
  const MARKERS = buildRegistry()
    .all()
    .filter((rule) => rule.marker !== undefined);

  it("every NOT MEASURED marker is named in the checklist entry of each check it claims", () => {
    const text = readFileSync(CHECKLIST, "utf8");
    // `### CHECK-NN: …` to the next `### `, which is one check's whole entry.
    const sections = new Map<string, string>();
    const headings = [...text.matchAll(/^###\s+(CHECK-\d+[a-z]?):/gm)];
    headings.forEach((heading, i) => {
      const start = heading.index ?? 0;
      const end = i + 1 < headings.length ? (headings[i + 1]!.index ?? text.length) : text.length;
      sections.set(heading[1]!, text.slice(start, end));
    });

    const missing: string[] = [];
    for (const rule of MARKERS) {
      for (const checkId of rule.checkIds) {
        const section = sections.get(checkId);
        if (section === undefined) throw new Error(`identifier-guard: no ${checkId} entry`);
        if (!section.includes(rule.id)) missing.push(`${checkId} does not name ${rule.id}`);
      }
    }
    expect(
      missing,
      "a marker an auditor never meets is a silence they will read as a pass — name it " +
        "in the entry of every check it claims, or drop the claim",
    ).toEqual([]);
  });

  // The SECOND former edit, now enforced: CHECK-83 is the one check that tells an
  // auditor to scan the whole NOT MEASURED family at once, so its enumeration and
  // the flagged set must be the same set in both directions. An id the family
  // list omits is a marker the auditor scanning CHECK-83 never meets; an id it
  // names that nobody flagged is a marker documented but never declared, whose
  // rule this guard is not checking at all. Either is the divergence the derived
  // flag exists to end.
  it("CHECK-83's NOT MEASURED family list names exactly the flagged markers", () => {
    const family = notMeasuredFamily();
    const flagged = new Set(MARKERS.map((rule) => rule.id));
    expect(
      [...family].filter((id) => !flagged.has(id)).sort(),
      "CHECK-83 names these in its NOT MEASURED family, but no rule carries the marker flag",
    ).toEqual([]);
    expect(
      [...flagged].filter((id) => !family.has(id)).sort(),
      "these rules carry the marker flag, but CHECK-83's NOT MEASURED family list omits them",
    ).toEqual([]);
    // Insurance, on this file's own model: a family enumeration a regex change
    // stopped reading would turn the bijection above into `[] === []`.
    expect(family.size, "the NOT MEASURED family enumeration read empty").toBeGreaterThanOrEqual(8);
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

// ============================================================================
// THE SECOND GUARD: A CITATION MUST NAME THE TEST IT MEANS
// ============================================================================

/**
 * `docs/talos-surface.md` is the contract Talos codes against, and its whole
 * claim to be trusted is the line under its own heading: *"Each section names
 * the tests that hold it. A shape claim in this file with no test beside it is
 * a claim nobody is defending."* Eighty-five `file:line` citations carry that
 * weight. Nothing executed them, so they rotted: every commit that inserts a
 * test above one moves it, silently, and the document keeps pointing
 * confidently at whatever now occupies the line.
 *
 * ## Why line-resolution is not the property to check
 *
 * P11-T4 repaired 46 stale citations by hand and re-reviewed them twice. Four
 * survived — and then a fifth was found by a controller checking a sibling.
 * Every one of them *resolved*: the file existed, the line existed, real test
 * code sat on it. One landed on the closing lines of an `issues_list` cursor
 * walk while the sentence beside it described a description pin. A checker that
 * asks "does this line exist" passes all five, because existing is the one
 * property a wrong line number also has.
 *
 * ## The property this checks instead
 *
 * A citation must name a TEST, and the document must say which test, in the
 * test's own words:
 *
 *  1. **Anchored.** The cited line is the opening line of an `it` / `test` /
 *     `describe` call. A citation is then the identity of a named test rather
 *     than a byte offset into a file. This costs precision — a pin that meant
 *     one assertion deep inside a long test now names the whole test — and that
 *     is the trade: line-granular precision is exactly what rotted, and a
 *     reader who lands on a title can tell in one second whether they are in
 *     the right place.
 *  2. **Attested.** Immediately after the citation the document carries a
 *     VERBATIM fragment of that test's title in double quotes (`…` elides).
 *     Verbatim and case-sensitive: no stemming, no synonyms, no prose matching.
 *  3. **Identifying.** That fragment matches exactly ONE title in the cited
 *     file. A fragment so generic that two tests answer to it is not a
 *     citation, it is a hint.
 *
 * (2) and (3) are what catch the T4 failure mode. Moving a citation to another
 * real test now fails: the fragment is not in the new test's title (2), and if
 * it somehow were, it would be in two titles and fail (3). The fragment cannot
 * be repaired without retyping the other test's words, which puts the wrongness
 * in the sentence where a reader sees it instead of in a number where nobody
 * does.
 *
 * ## What it still cannot do, stated rather than hidden
 *
 * **It cannot read the sentence.** It checks that the document and the test
 * agree about WHICH TEST IS BEING CITED; it cannot check that the test proves
 * the claim in the prose. A citation with a correctly quoted title beside a
 * sentence that test does not support passes here, and stays human review.
 * What it removes is the whole class of failure where the document is honest
 * and the number is wrong — the class that survived two dedicated fix passes.
 *
 * ## Scope: this document only
 *
 * `docs/gates/*.md` and the plan documents carry citations too and are
 * DELIBERATELY EXCLUDED. A gate document is a historical record: it describes
 * the tree at the commit it was written against, and it is never edited
 * afterwards. Its citations are correct about a past tree, and dragging their
 * line numbers forward to today's would falsify the record this repository
 * keeps its evidence in. `talos-surface.md` is the opposite kind of document —
 * a living contract, rewritten every phase, read by somebody about to code
 * against it.
 *
 * ## Scope: `test/` citations only — `src/` is the third guard's
 *
 * This block reads `test/…` and nothing else, because the anchor-and-attest
 * property it checks is a property of test files: only they carry declarations
 * whose titles a document can quote. The same document's `src/` references are
 * checked at the bottom of this file, for what a source reference CAN carry.
 * That split is the decision, not an omission — the argument is in the third
 * guard's own header.
 */

const SURFACE_DOC = join(ROOT, "docs/talos-surface.md");

interface Block {
  line: number;
  kind: "it" | "test" | "describe";
  title: string;
  indent: number;
}

/** `it("…"`, `test.skip('…'`, `describe(\`…\`` — with the title's own text. */
const BLOCK_OPENER = /^(\s*)(it|test|describe)(?:\.\w+)?\(\s*(["'`])/;

/**
 * Every test declaration in one file, with the title it declares.
 *
 * A title that does not close on its own line is recorded with an EMPTY title
 * rather than skipped, so a citation to it fails the attestation loudly instead
 * of quietly finding no anchor at all.
 */
function blocksOf(file: string): Block[] {
  const out: Block[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      const opener = BLOCK_OPENER.exec(text);
      if (opener === null) return;
      const quote = opener[3]!;
      let title = "";
      let closed = false;
      for (let i = opener[0].length; i < text.length; i += 1) {
        const ch = text[i]!;
        if (ch === "\\") {
          title += text[i + 1] ?? "";
          i += 1;
          continue;
        }
        if (ch === quote) {
          closed = true;
          break;
        }
        title += ch;
      }
      out.push({
        line: index + 1,
        kind: opener[2] as Block["kind"],
        title: closed ? title : "",
        indent: opener[1]!.length,
      });
    });
  return out;
}

const BLOCKS = new Map<string, Block[]>();

function blocksFor(file: string): Block[] {
  const cached = BLOCKS.get(file);
  if (cached !== undefined) return cached;
  const blocks = blocksOf(join(ROOT, file));
  BLOCKS.set(file, blocks);
  return blocks;
}

/**
 * The tests a `describe` holds, by indentation: everything under it until a
 * declaration at its own indentation or shallower. Nested `describe`s are not
 * counted as tests; the `it`s inside them are.
 */
function testsUnder(blocks: readonly Block[], describeLine: number): number {
  const start = blocks.findIndex((block) => block.line === describeLine);
  const self = blocks[start]!;
  let count = 0;
  for (let i = start + 1; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.indent <= self.indent) break;
    if (block.kind !== "describe") count += 1;
  }
  return count;
}

/**
 * One space for any run of whitespace.
 *
 * The document is wrapped at 80 columns and a quoted title wraps with it, so a
 * fragment carries whatever line break fell inside it. Verbatim is a claim
 * about the WORDS; making it a claim about the wrapping too would tax the
 * writer for a newline neither file chose.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The pieces of an attestation: `a … b` is "a", then "b", in that order. */
function piecesOf(fragment: string): string[] {
  return fragment
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map(flat)
    .filter((piece) => piece !== "");
}

/** Does `fragment` read out of `title` verbatim, in order? Case-sensitive. */
function attests(fragment: string, title: string): boolean {
  const flattened = flat(title);
  let at = 0;
  for (const piece of piecesOf(fragment)) {
    const found = flattened.indexOf(piece, at);
    if (found === -1) return false;
    at = found + piece.length;
  }
  return true;
}

/** How much of the title the fragment actually quotes. Short is not identifying. */
function attestedLength(fragment: string): number {
  return piecesOf(fragment).reduce((sum, piece) => sum + piece.length, 0);
}

/** A fragment shorter than this could match half the file by accident. */
const MIN_ATTESTATION = 16;

interface Citation {
  /** Line in the document, for the failure message. */
  docLine: number;
  file: string;
  /** Absent for a bare file reference (`test/api/csv.test.ts` with no line). */
  line: number | null;
  /** The quoted title fragment that follows, if the document carries one. */
  fragment: string | null;
  /** An `(N tests …)` claim that follows, if the document makes one. */
  claimedTests: number | null;
  /** Was the citation written as a code span? A bare one has no readable form. */
  spanned: boolean;
}

/** Whitespace that may wrap a line but never crosses a blank one. */
const GAP = "(?:[ \\t]|\\n(?!\\n))*";

/**
 * Every reference to a test file in the surface document.
 *
 * Read out of the raw text rather than out of code spans, so a citation that
 * FORGOT its backticks is found and refused rather than invisible.
 */
function citationsOf(text: string): Citation[] {
  const out: Citation[] = [];
  for (const match of text.matchAll(/(test\/[A-Za-z0-9/_.-]+\.ts)(?::(\d+))?/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const rest = text.slice(end);
    // ADJACENT, not merely "somewhere after": the whitespace between the
    // citation and its attestation may wrap a line but may never cross a blank
    // one, so a quotation in the NEXT PARAGRAPH cannot be read as this
    // citation's attestation.
    const attestation = new RegExp(`^\`?${GAP}\\(?${GAP}"([^"]+)"`).exec(rest);
    const afterAttestation = rest.slice(attestation?.[0].length ?? 0);
    const claim = new RegExp(`^\`?${GAP}\\((\\d+) (?:unit )?tests?\\b`).exec(afterAttestation);
    out.push({
      docLine: text.slice(0, start).split("\n").length,
      file: match[1]!,
      line: match[2] === undefined ? null : Number(match[2]),
      fragment: attestation?.[1] ?? null,
      claimedTests: claim === null ? null : Number(claim[1]!),
      spanned: text[start - 1] === "`" && text[end] === "`",
    });
  }
  return out;
}

const CITATIONS = citationsOf(readFileSync(SURFACE_DOC, "utf8"));

/** `docs/talos-surface.md:249 → test/api/query.test.ts:1378` — where to go. */
function where(citation: Citation): string {
  const target = citation.line === null ? citation.file : `${citation.file}:${citation.line}`;
  return `docs/talos-surface.md:${citation.docLine} → ${target}`;
}

/** The block the citation's line opens, or null if the line opens none. */
function anchorOf(citation: Citation): Block | null {
  // The same existence guard its two callers carry: a citation to a file that is
  // not there has already failed the first test loudly and by name, and reading
  // it here would replace that message with an ENOENT stack from a helper.
  if (citation.line === null || !existsSync(join(ROOT, citation.file))) return null;
  return blocksFor(citation.file).find((block) => block.line === citation.line) ?? null;
}

describe("the surface document cites the test it means", () => {
  it("names a test file that exists, in a code span the guard can read", () => {
    const broken: string[] = [];
    for (const citation of CITATIONS) {
      if (!existsSync(join(ROOT, citation.file))) {
        broken.push(`${where(citation)} — no such file`);
        continue;
      }
      if (citation.line !== null && !citation.spanned) {
        broken.push(`${where(citation)} — a citation must be written as \`code\``);
      }
    }
    expect(broken).toEqual([]);
  });

  it("anchors every citation to a test declaration, not to a line number", () => {
    const broken: string[] = [];
    for (const citation of CITATIONS) {
      if (citation.line === null || !existsSync(join(ROOT, citation.file))) continue;
      const blocks = blocksFor(citation.file);
      if (anchorOf(citation) !== null) continue;
      // Say where the enclosing test starts: that is almost always the fix.
      const enclosing = [...blocks].reverse().find((block) => block.line <= citation.line!);
      broken.push(
        `${where(citation)} — that line opens no it()/describe()` +
          (enclosing === undefined
            ? ""
            : `; the declaration above it is :${enclosing.line} "${enclosing.title}"`),
      );
    }
    expect(
      broken,
      "a line number is not an identity — cite the it()/describe() line, whose title a reader can check",
    ).toEqual([]);
  });

  it("attests every citation with a verbatim fragment of that test's own title", () => {
    const broken: string[] = [];
    for (const citation of CITATIONS) {
      const anchor = anchorOf(citation);
      if (anchor === null) continue;
      if (citation.fragment === null) {
        broken.push(`${where(citation)} — no attestation; the title is "${anchor.title}"`);
        continue;
      }
      if (!attests(citation.fragment, anchor.title)) {
        // Where DOES it read? Almost always the citation, not the fragment, is
        // the thing that moved — so name the line that would make it true.
        const elsewhere = blocksFor(citation.file).filter((block) =>
          attests(citation.fragment!, block.title),
        );
        broken.push(
          `${where(citation)} — "${citation.fragment}" is not in "${anchor.title}"` +
            (elsewhere.length === 1 ? `; it reads out of :${elsewhere[0]!.line}` : ""),
        );
        continue;
      }
      if (attestedLength(citation.fragment) < MIN_ATTESTATION) {
        broken.push(
          `${where(citation)} — "${citation.fragment}" quotes ` +
            `${attestedLength(citation.fragment)} characters, under the ${MIN_ATTESTATION} minimum`,
        );
      }
    }
    expect(
      broken,
      "the document must carry the cited test's own words, so moving the citation breaks the sentence",
    ).toEqual([]);
  });

  it("quotes a fragment that identifies exactly one test in the file", () => {
    const broken: string[] = [];
    for (const citation of CITATIONS) {
      const anchor = anchorOf(citation);
      if (anchor === null || citation.fragment === null) continue;
      const matches = blocksFor(citation.file).filter((block) =>
        attests(citation.fragment!, block.title),
      );
      if (matches.length > 1) {
        broken.push(
          `${where(citation)} — "${citation.fragment}" also reads out of ` +
            matches
              .filter((block) => block.line !== anchor.line)
              .map((block) => `:${block.line}`)
              .join(", "),
        );
      }
    }
    expect(
      broken,
      "a fragment two tests answer to cannot say which one moved — quote more of the title",
    ).toEqual([]);
  });

  it("counts the tests it claims a file or a block holds", () => {
    const broken: string[] = [];
    for (const citation of CITATIONS) {
      if (citation.claimedTests === null) continue;
      const blocks = blocksFor(citation.file);
      const anchor = anchorOf(citation);
      const actual =
        citation.line === null
          ? blocks.filter((block) => block.kind !== "describe").length
          : anchor !== null && anchor.kind === "describe"
            ? testsUnder(blocks, anchor.line)
            : null;
      if (actual === null) {
        broken.push(`${where(citation)} — a test count belongs on a file or a describe`);
      } else if (actual !== citation.claimedTests) {
        broken.push(`${where(citation)} — claims ${citation.claimedTests} tests, holds ${actual}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("reads something: the citation extraction is not silently empty", () => {
    // The same insurance the guard above carries: a regex that stopped matching
    // would turn every assertion in this block green.
    expect(CITATIONS.length).toBeGreaterThan(60);
    expect(CITATIONS.filter((citation) => citation.line !== null).length).toBeGreaterThan(60);
    expect(blocksFor("test/api/query.test.ts").length).toBeGreaterThan(80);
  });
});

// ============================================================================
// THE THIRD GUARD: A `src/` REFERENCE IS CHECKED FOR WHAT IT CAN CARRY
// ============================================================================

/**
 * THE DECISION P11-M-9 LEFT OPEN, taken here (P12-T4): the surface document
 * cites `src/` as well as `test/`, and the guard above reads only `test/`.
 * Widen it — but NOT to the same property, because `src/` cannot carry it.
 *
 * ## Why the anchor rule cannot simply be extended
 *
 * The test guard's whole design rests on one fact about test files: a citation
 * can name a DECLARATION whose title the document quotes back. `src/` has no
 * such thing. A line of `service.ts` opens no named block, its neighbours are
 * indistinguishable from it, and the nearest equivalent — quoting the line's own
 * text — would pin the document to code formatting, so a rewrapped argument
 * list or a renamed local would fail a guard that is supposed to catch
 * documents drifting from behaviour.
 *
 * ## What this document's `src/` references actually are
 *
 * They are FILE references without line numbers, of two kinds — and the kinds
 * are what matters, not the count, which moves every time the document gains a
 * sentence (it was four when this guard was written and five before the same
 * commit landed). The floor is asserted at the bottom of this block rather than
 * restated here.
 *
 *  - ARCHITECTURAL ("`src/api/service.ts` holds every query, refusal and
 *    vocabulary") — claims no grep can settle, and human review either way;
 *  - PINS, in a fixed form: "Pinned: `src/db/schema.ts`'s
 *    `resources.fetch_class` comment". That form names a file AND an identifier
 *    inside it, which is a checkable claim.
 *
 * ## So the three properties checked here
 *
 *  1. **Existence.** The file is there. A renamed or deleted module is the whole
 *     rot mode a line-less reference has, and it is the one the test guard's
 *     first assertion catches too.
 *  2. **No line numbers.** A `src/file.ts:120` citation is REFUSED outright,
 *     because nothing here can check it: it would resolve forever, drift
 *     silently, and carry the confident look of a pin. Cite the file and name
 *     the artefact in words — which is what the document already does, and this
 *     is what keeps it that way.
 *  3. **Attestation, where the document makes one.** An identifier quoted
 *     immediately after the reference must appear in the file. The last dotted
 *     segment is what is looked for (`crawls.resource_refs_capped_pages` →
 *     `resource_refs_capped_pages`), because the document names columns the way
 *     a reader thinks of them and the file spells them the way Postgres does.
 *
 * ## What it still cannot do, stated rather than hidden
 *
 * **It cannot read the sentence** — the same limit the test guard states, one
 * step weaker. A pin naming a real identifier in a real file, beside a claim
 * that comment does not make, passes here. And a reference with no identifier
 * beside it is checked for existence only: the architectural claims are in that
 * class deliberately, because inventing an attestation for them would mean
 * quoting prose out of a source comment and pinning the document to somebody's
 * line wrapping.
 *
 * Two smaller limits of the checker itself, so nobody reads a green run as more
 * than it is:
 *
 *  - **A reference that is both missing and line-numbered reports ONE problem,
 *    not two.** The existence check `continue`s, because a line number on a file
 *    that is not there is not the reader's next question — and the guard is
 *    re-run after the first fix anyway.
 *  - **A line number in PROSE passes.** "line 120 of `src/db/schema.ts`" carries
 *    no colon, so the extractor does not see it as a citation. The rule this
 *    enforces is about the citation FORM the document uses; a sentence that
 *    spells a line number out in words is beyond what any regex here settles,
 *    and is human review like every other prose claim.
 */

interface SourceRef {
  docLine: number;
  file: string;
  /** Present only where the document wrote one — which it must not. */
  line: number | null;
  /** The identifier quoted immediately after, if the document quotes one. */
  identifier: string | null;
}

/**
 * Every reference to a source file in the surface document.
 *
 * The attestation window is the same ADJACENT one the test citations use: the
 * `'s` possessive and the backticked identifier that follows it, with no blank
 * line in between, so an identifier in the next paragraph cannot be read as this
 * reference's pin.
 */
function sourceRefsOf(text: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const match of text.matchAll(/(src\/[A-Za-z0-9/_.-]+\.ts)(?::(\d+))?/g)) {
    const end = match.index + match[0].length;
    const attestation = new RegExp(`^\`?${GAP}'s${GAP}\`([^\`]+)\``).exec(text.slice(end));
    out.push({
      docLine: text.slice(0, match.index).split("\n").length,
      file: match[1]!,
      line: match[2] === undefined ? null : Number(match[2]),
      identifier: attestation?.[1] ?? null,
    });
  }
  return out;
}

/** The three properties, as a list of failures a reader can act on. */
function sourceRefProblems(refs: readonly SourceRef[]): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    const where = `docs/talos-surface.md:${ref.docLine} → ${ref.file}`;
    if (!existsSync(join(ROOT, ref.file))) {
      problems.push(`${where} — no such file`);
      continue;
    }
    if (ref.line !== null) {
      problems.push(
        `${where}:${ref.line} — a src/ reference may not carry a line number: no line of ` +
          `source declares its own identity, so nothing can check that this one still means ` +
          `what the sentence says. Cite the file and name the artefact.`,
      );
    }
    if (ref.identifier === null) continue;
    const needle = ref.identifier.split(".").at(-1)!;
    if (!readFileSync(join(ROOT, ref.file), "utf8").includes(needle)) {
      problems.push(`${where} — nothing in that file is called '${needle}'`);
    }
  }
  return problems;
}

describe("the surface document's src/ references name what they claim", () => {
  const REFS = sourceRefsOf(readFileSync(SURFACE_DOC, "utf8"));

  it("names source files that exist, without line numbers, attesting what it pins", () => {
    expect(
      sourceRefProblems(REFS),
      "a src/ reference is checked for existence and for the identifier it quotes — " +
        "it cannot be anchored to a test's title, so it may not be anchored to a line",
    ).toEqual([]);
  });

  it("fails a missing file, a line number and an identifier the file does not carry", () => {
    // The guard tested on input of its own, because every assertion above is
    // over a document that PASSES: without this, a broken extractor and a clean
    // document look identical.
    const problems = sourceRefProblems(
      sourceRefsOf(
        "Pinned: `src/db/nosuch.ts`'s `whatever` comment.\n" +
          "See `src/db/schema.ts:120` for the column.\n" +
          "Pinned: `src/db/schema.ts`'s `crawls.no_such_column` comment.\n",
      ),
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("no such file");
    expect(problems[1]).toContain("may not carry a line number");
    expect(problems[2]).toContain("no_such_column");
  });

  it("accepts the pin form the document actually uses", () => {
    // The other half of the same insurance: a checker that failed everything
    // would also make the assertion above pass.
    expect(
      sourceRefProblems(
        sourceRefsOf("Pinned: `src/db/schema.ts`'s `crawls.resource_refs_capped_pages` comment."),
      ),
    ).toEqual([]);
  });

  it("reads something: the source-reference extraction is not silently empty", () => {
    // The floor the header refuses to restate as a count. Both kinds have to be
    // found, or a regex that stopped matching one of them turns the assertions
    // above green over a document nobody checked.
    const pins = REFS.filter((ref) => ref.identifier !== null);
    expect(REFS.length).toBeGreaterThanOrEqual(5);
    expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(REFS.length - pins.length, "the architectural references").toBeGreaterThanOrEqual(2);
  });
});
