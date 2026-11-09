/**
 * The crawl-start body as ONE zod 4 schema (Phase 27b).
 *
 * It is three things at once, which is the point of it:
 *
 *  - **the body** both transports accept: `POST /crawls` parses with
 *    `parseStartBody`, and MCP `crawl_start` registers `startBodySchema` as its
 *    input schema, so the SDK refuses with this schema's own messages before the
 *    handler runs — and the handler then goes through `parseStartBody` too;
 *  - **the published JSON Schema** (`config_schema`, `GET /config/schema`),
 *    generated from it by `z.toJSONSchema` as draft 2020-12, with each field's
 *    description, its default and its `x-ariadne-mutable`;
 *  - **the field table** later phases build on: `CRAWL_FIELDS` says, per field,
 *    whether it can change after the crawl starts.
 *
 * It replaced a hand-rolled field table in the service and a second, separate
 * zod shape in the MCP transport. Two declarations of one vocabulary is how a
 * field the HTTP surface accepts and the agent surface cannot see appears; one
 * declaration cannot drift from itself.
 *
 * ## Defaults are annotations, never zod `.default()`
 *
 * A field the caller left out must stay ABSENT through the parse (plan
 * Deviation 13): between the engine's default and the request sit the
 * operator's `crawlDefaults`, which the service applies (`effectiveConfig`), and
 * a parser that filled the engine's value in would silently overrule the
 * operator. So `default` is `.meta` — published, never applied here.
 *
 * ## The judgement block keeps its own parser
 *
 * The schema publishes the block's SHAPE (the rule ids, the twenty thresholds
 * with their bounds), and `parseJudgement` stays the semantic check, called
 * from a `.superRefine` (plan Deviation 10): an empty override and a crossed
 * threshold pair are refusals only the whole block can make. The structural
 * refusals are written in parseJudgement's own sentences (`JUDGEMENT_DETAIL`).
 *
 * ## What this does not check
 *
 * Anything that needs the server: the allowlist, the URL policy, the crawl
 * loop's own ranges over the EFFECTIVE config (the render budgets among them —
 * `resolveRenderConfig` is their one check). Those are `ApiService.checkStartBody`.
 */
import { z } from "zod";

import { CRAWL_DEFAULTS } from "../crawl/loop.js";
import {
  JUDGEMENT_DETAIL,
  JudgementError,
  OVERRIDABLE_THRESHOLDS,
  parseJudgement,
  type JudgementBlock,
  type RuleOverride,
  type ThresholdName,
} from "../rules/judgement.js";
import { URL_FINDING_CAP } from "../rules/query/crawl-evidence.js";
import {
  ISSUE_TYPES,
  PRIORITIES,
  RULESET_VERSION,
  type Registry,
} from "../rules/registry/registry.js";
import { clip } from "./errors.js";
import type { StartCrawlInput } from "./service.js";

/**
 * The crawl budget a request that does not name one gets.
 *
 * `CRAWL_DEFAULTS` deliberately has no `maxPages` — the crawl loop refuses to
 * invent a budget, because a budget is a politeness decision (rule 9). The API
 * has to have an answer anyway, and "unbounded" is the one answer that must not
 * be it: an agent that forgets the field would otherwise crawl a 400k-page site
 * to the end. 500 is a first look at a site, and a caller who wants more says
 * so in the request.
 */
export const API_CRAWL_DEFAULTS = { maxPages: 500 } as const;

/**
 * The politeness floor under `perHostDelayMs` for a crawl a CLIENT asked for.
 *
 * The MCP tool descriptions have said "perHostDelayMs has a floor" since the
 * agent surface was written, and until now there was none: an agent that sent
 * `perHostDelayMs: 0` got a crawl that hit one host as fast as the concurrency
 * window allowed. A claim the engine does not keep is worse than no claim, and
 * the yellow.com.mt incident (docs/talos-integration.md) is what being wrong
 * about this costs.
 *
 * 250ms — four requests a second to one host — is not a tuned number and is not
 * meant to be a comfortable one. It is the point below which a crawler is no
 * longer plausibly reading a site and is measurably load-testing it. The
 * genuinely polite delays are ten times this (`CRAWL_DEFAULTS` is 1000ms, the
 * crawl skill recommends 2000ms on anything Cloudflare-fronted); a caller who
 * hits this floor has already ignored all of that.
 *
 * REFUSED, NOT CLAMPED. Silently raising the value to 250 would answer a
 * request nobody made and leave the caller believing their number took effect
 * (hard rule 7). The refusal names the floor, so the fix is one edit.
 *
 * ## The boundary this does NOT cross, stated because it is load-bearing
 *
 * The floor binds the start-body schema below, which is the request-field seam
 * and the ONLY seam both transports pass through (`POST /crawls` parses a body
 * with it, `crawl_start` registers it as its input schema). It deliberately
 * does NOT bind `effectiveConfig` or `validateCrawlConfig`, which is where a
 * `crawlDefaults.perHostDelayMs` supplied by the process that CONSTRUCTS the
 * server would be caught.
 *
 * That is the same process-trust seam `allowPrivate` rests on: the constructor
 * holds the database handle and the auth token, and it is how the test suite
 * crawls its own 127.0.0.1 fixture site at `perHostDelayMs: 0` without waiting
 * a second per page. A floor there would not make anything more polite — a
 * loopback fixture server has nobody to be rude to — and it would make the
 * suite unrunnable. The distinction is: a delay that arrived over the wire is
 * subject to the floor; a delay the operator compiled into the process is that
 * operator's decision.
 */
export const MIN_PER_HOST_DELAY_MS = 250;

/**
 * How many sitemap documents one crawl-start request may name.
 *
 * The walk itself is capped at 300 documents including everything a sitemap
 * INDEX points at (`MAX_SITEMAP_DOCS`, src/crawl/discovery.ts), so this is not
 * the limit that protects the origin — it is the limit on what a REQUEST may
 * carry into `config_jsonb`, which is a column every resume and every render
 * pass reads back. Fifty root documents is already a site whose sitemap has an
 * index, and supplying the index is both shorter and more faithful to what the
 * site publishes. Refused rather than trimmed: a list this engine silently cut
 * would leave the caller believing every document was walked (hard rule 7).
 */
export const MAX_SUPPLIED_SITEMAPS = 50;

/** The refusal for a `sitemapUrls` list over `MAX_SUPPLIED_SITEMAPS`, here and at resume. */
export function tooManySitemaps(count: number): string {
  return (
    `sitemapUrls names ${count} documents, above this server's limit of ` +
    `${MAX_SUPPLIED_SITEMAPS}. A site with more sitemap documents than that has a ` +
    `sitemap INDEX — supply the index and the walk follows it, three levels deep`
  );
}

/**
 * Whether a field can change after the crawl starts (`x-ariadne-mutable`):
 * `never` — the evidence of a crawl must come from one identity and one scope;
 * `whenPaused` — only while the crawl is queued or paused; `always` — the
 * judgement, which applies at read time or at the next rules run.
 */
export type Mutability = "never" | "whenPaused" | "always";

/** One wire field of the crawl part of the body. */
export interface CrawlField {
  /** The field's own schema, without `.optional()` — the body decides that. */
  schema: z.ZodType;
  mutable: Mutability;
  /** What an agent reads about the field; published as `description`. */
  description: string;
  /** The engine's value when the field is absent. Published, never applied. */
  default?: unknown;
}

/** The crawl part's field names: the body's, less the judgement block. */
export type CrawlFieldName = Exclude<keyof StartCrawlInput, "judgement">;

const SITE_URL_REQUIRED = "siteUrl is required and must be a non-empty string";

/** A JSON number — `z.number()` already refuses NaN and the infinities. */
function finiteNumber(key: string) {
  return z.number({ error: () => `field '${key}' must be a finite number` });
}

/** `maxPages`, `maxDepth`, `maxConcurrency`: the crawl loop's own range, at the wire. */
function positiveInteger(key: string) {
  const range = (issue: { input?: unknown }): string =>
    `field '${key}' must be an integer ≥ 1, got ${String(issue.input)}`;
  return finiteNumber(key).int({ error: range }).min(1, { error: range });
}

function booleanField(key: string) {
  return z.boolean({ error: () => `field '${key}' must be a boolean` });
}

function stringList(key: string) {
  const message = (): string => `field '${key}' must be an array of strings`;
  return z.array(z.string({ error: message }), { error: message });
}

/**
 * The wire's whole crawl vocabulary, in the order an unknown-field refusal
 * lists it. Descriptions are the ones `crawl_start` has always shown an agent.
 */
export const CRAWL_FIELDS = {
  siteUrl: {
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined ? SITE_URL_REQUIRED : "field 'siteUrl' must be a string",
      })
      .refine((value) => value.trim() !== "", { error: SITE_URL_REQUIRED }),
    mutable: "never",
    description:
      "The http(s) URL to crawl from. Its host must be on the server's crawl " +
      "allowlist. The crawl treats the apex and www spellings of this host as one " +
      "site.",
  },
  maxPages: {
    schema: positiveInteger("maxPages"),
    mutable: "whenPaused",
    description:
      "Stop after this many pages. Defaults to 500 — a first look at a site. Raise " +
      "it deliberately: a full crawl of a large site is a real load on it.",
    default: API_CRAWL_DEFAULTS.maxPages,
  },
  maxDepth: {
    schema: positiveInteger("maxDepth"),
    mutable: "whenPaused",
    description: "Stop following links past this many hops from the seed.",
    default: CRAWL_DEFAULTS.maxDepth,
  },
  userAgent: {
    schema: z.string({ error: () => "field 'userAgent' must be a string" }),
    mutable: "never",
    description:
      "The branded user agent to identify as. Leave it alone unless the site's " +
      "owner has asked you to use a specific string; it must stay identifiable.",
    default: CRAWL_DEFAULTS.userAgent,
  },
  perHostDelayMs: {
    schema: finiteNumber("perHostDelayMs").min(MIN_PER_HOST_DELAY_MS, {
      error: (issue) =>
        `perHostDelayMs ${String(issue.input)} is below this server's politeness floor of ` +
        `${MIN_PER_HOST_DELAY_MS}ms: the per-host delay is not a throughput knob, and a ` +
        `crawl faster than four requests a second to one host is load-testing it. ` +
        `robots.txt's own crawl-delay still wins when it is longer`,
    }),
    mutable: "whenPaused",
    description:
      "Politeness delay between requests to one host. The floor is 250ms — a " +
      "smaller value is refused rather than quietly raised — and robots.txt's " +
      "own crawl-delay wins when it is longer.",
    default: CRAWL_DEFAULTS.perHostDelayMs,
  },
  maxConcurrency: {
    schema: positiveInteger("maxConcurrency"),
    mutable: "whenPaused",
    description: "How many fetches may be in flight at once across the whole crawl.",
    default: CRAWL_DEFAULTS.maxConcurrency,
  },
  probeHosts: {
    schema: booleanField("probeHosts"),
    mutable: "never",
    description:
      "Probe the apex/www and http/https spellings of the seed (and any legacyHosts) " +
      "to find where the site really lives. These are the only fetches made before " +
      "robots.txt is read.",
    default: true,
  },
  legacyHosts: {
    schema: stringList("legacyHosts"),
    mutable: "never",
    description:
      "Extra hosts that used to serve this site, to probe alongside the seed's own " +
      "spellings. EACH ONE must be on the allowlist in its own right — they are " +
      "different sites by every definition the engine has.",
  },
  sitemapUrls: {
    schema: stringList("sitemapUrls").max(MAX_SUPPLIED_SITEMAPS, {
      error: (issue) => tooManySitemaps((issue.input as readonly unknown[]).length),
    }),
    mutable: "never",
    description:
      "Sitemap documents to walk in addition to the ones robots.txt declares — the " +
      "way to crawl a sitemap the site publishes but never points at. The engine " +
      "does NOT probe /sitemap.xml on spec, so an undeclared sitemap is only read " +
      "if you name it here. Full http(s) URLs; a host outside this site's own " +
      "spellings must be on the allowlist in its own right. Supplying one does not " +
      "hide the finding: robots.txt still declares no sitemap, and the audit still " +
      "says so.",
  },
  renderBudgetPct: {
    schema: finiteNumber("renderBudgetPct"),
    mutable: "whenPaused",
    description: "Share of the crawl's pages the later render pass may re-fetch, as a percentage.",
    default: CRAWL_DEFAULTS.renderBudgetPct,
  },
  renderMaxPages: {
    schema: finiteNumber("renderMaxPages"),
    mutable: "whenPaused",
    description: "Hard ceiling on pages the later render pass may re-fetch.",
    default: CRAWL_DEFAULTS.renderMaxPages,
  },
  renderSamplePerType: {
    schema: finiteNumber("renderSamplePerType"),
    mutable: "whenPaused",
    description: "How many pages of each template cohort the render pass samples.",
    default: CRAWL_DEFAULTS.renderSamplePerType,
  },
  findingCap: {
    schema: findingCapSchema("field 'findingCap' must be"),
    // The judgement's: its bytes live in `config_jsonb` (plan Deviation 1), and
    // it changes the way every judgement field does.
    mutable: "always",
    description:
      "How many findings each listing rule may report when this crawl is judged. " +
      "Defaults to 200 — a bounded first look. Pass " +
      "null for a BILLED AUDIT: every orphan, every duplicate group, every blocked " +
      "sitemap entry, listed in full. It costs wall time on a large site and it is " +
      "the whole picture rather than a snapshot. It is read when the RULES run, not " +
      "while crawling, so it must be set here — crawl_rules has no cap argument of " +
      "its own. Uncapped listings carry no 'and N more' note, but keep " +
      "reading the note rather than the setting: a note means the list is " +
      "incomplete and its absence means complete.",
    default: URL_FINDING_CAP,
  },
  fetchResources: {
    schema: booleanField("fetchResources"),
    mutable: "never",
    description:
      "Whether the crawl asks the site about the files its pages point at — the " +
      "images, stylesheets and scripts. Defaults to true, and true is what an " +
      "audit wants: it is the only source of image weight, broken-resource and " +
      "page-weight evidence. Pass false to crawl the pages and ask about no file " +
      "at all — a client who asked us not to touch their CDN, or a re-crawl that " +
      "only needs the page census. It does NOT stop the references being " +
      "recorded: crawl_status still reports resources.seen, because reading " +
      "markup costs the site nothing. What it stops is the asking, and every " +
      "unasked row says the operator chose so, so a silent images.oversized on " +
      "such a crawl reads as 'nothing was weighed' rather than 'nothing is " +
      "heavy'. The pass runs under the same politeness the page crawl earned; " +
      "turning it off is a decision about somebody's servers, not a speed knob.",
    default: true,
  },
} satisfies Record<CrawlFieldName, CrawlField>;

/**
 * `findingCap`, at the top level and inside the judgement block: a positive
 * integer, or NULL — which is a value here, "list everything", not an omission.
 */
function findingCapSchema(prefix: string) {
  const type = (): string => `${prefix} an integer ≥ 1, or null for uncapped`;
  const range = (issue: { input?: unknown }): string => `${type()}, got ${String(issue.input)}`;
  return z.number({ error: type }).int({ error: range }).min(1, { error: range }).nullable();
}

const JUDGEMENT_DESCRIPTION =
  "How this crawl will be judged: {rules?: {[ruleId]: {disabled?: true, type?, " +
  "priority?}}, thresholds?: {[name]: number}, findingCap?: number | null} — " +
  "the block crawl_config_set changes later. findingCap may be given here " +
  "instead of at the top level; given in both places, the two must agree.";

const BODY_NOT_OBJECT = "request body must be a JSON object";

/**
 * The two TEST-ONLY crawl-config fields, refused by name and at any value.
 * Named before the schema runs so the refusal says WHY rather than "unknown
 * field": a caller sending one has read about it somewhere and needs to be told
 * it is not an API field at all.
 */
const FORBIDDEN_FIELDS: Readonly<Record<string, string>> = {
  allowPrivate:
    "allowPrivate is not accepted over the API at any value: it is a test-only " +
    "escape hatch that admits loopback and private targets, it is never persisted " +
    "on a crawl row, and it can only be set by the process that constructs the " +
    "server",
  // The 60-second floor between a page's two observations is the CLAIM the
  // evidence makes — "still broken a minute later" — not a tuning knob: a caller
  // who could shrink it could make every transient 5xx clear and turn a
  // `critical` into a `warning` on demand (P17).
  recheckMinGapMs:
    "recheckMinGapMs is not accepted over the API at any value: it is a test-only " +
    "crawl-config field that shortens the minimum gap between a page's two fetch " +
    "observations, it is never persisted on a crawl row, and it can only be set by " +
    "the process that constructs the server",
};

const ACCEPTED_FIELDS = [...Object.keys(CRAWL_FIELDS), "judgement"].join(", ");

/**
 * The crawl-config keys the stored row carries that no request can name: the
 * operator's budgets and profile switch, set through `crawlDefaults` by the
 * process that constructs the server. `never` in `crawl_config_get`'s
 * `mutability`, and refused by name when a patch sends one.
 */
export const OPERATOR_ONLY_FIELDS: readonly string[] = [
  "maxResources",
  "maxResourceHosts",
  "maxBlockedUrls",
  "platformProfiles",
];

export function unknownField(key: string): string {
  return FORBIDDEN_FIELDS[key] ?? `unknown field '${clip(key)}' (accepted: ${ACCEPTED_FIELDS})`;
}

/** A field's schema as the body carries it: described, defaulted, marked. */
function onTheWire<S extends z.ZodType>(field: { schema: S } & CrawlField): S {
  return field.schema.meta({
    description: field.description,
    ...(field.default === undefined ? {} : { default: field.default }),
    "x-ariadne-mutable": field.mutable,
  });
}

/**
 * A `JudgementError`'s dotted path as zod segments. The first segment is a
 * block key; everything after it is ONE segment, because a rule id has dots in
 * it (`rules.title.too-long` is `["rules", "title.too-long"]`).
 */
function judgementSegments(path: string): string[] {
  if (path === "") return [];
  const dot = path.indexOf(".");
  return dot === -1 ? [path] : [path.slice(0, dot), path.slice(dot + 1)];
}

/** The detail of a `JudgementError` — its message less the `<path>: ` it leads with. */
function judgementDetail(error: JudgementError): string {
  const lead = `${error.path === "" ? "(the block)" : error.path}: `;
  if (!error.message.startsWith(lead)) {
    throw new Error(
      `config schema: a JudgementError at '${error.path}' does not lead with its path: ${error.message}`,
    );
  }
  return error.message.slice(lead.length);
}

/**
 * The judgement block's schema: the shape it publishes (the rule ids a block
 * may name, the twenty thresholds with their bounds and defaults), with
 * `parseJudgement` as the semantic check (module header).
 */
export function judgementSchema(registry: Registry) {
  const kinds = new Map(registry.all().map((rule) => [rule.id, rule.kind]));
  const [firstId, ...restIds] = registry
    .all()
    .filter((rule) => rule.kind !== "metric")
    .map((rule) => rule.id);
  if (firstId === undefined) throw new Error("config schema: the ruleset has no finding rule");

  const override = z.strictObject(
    {
      disabled: z.literal(true, { error: JUDGEMENT_DETAIL.disabledNotTrue }).optional(),
      type: z.enum(ISSUE_TYPES).optional(),
      priority: z.enum(PRIORITIES).optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys[0] === "severity"
            ? JUDGEMENT_DETAIL.severity
            : JUDGEMENT_DETAIL.unknownKey
          : "must be a JSON object",
    },
  );

  const rules = z.partialRecord(z.enum([firstId, ...restIds]), override, {
    error: (issue) => {
      if (issue.code !== "invalid_key") return "must be a JSON object";
      const id = String(issue.input);
      return kinds.get(id) === "metric"
        ? JUDGEMENT_DETAIL.metricRule(id)
        : JUDGEMENT_DETAIL.unknownRule(id);
    },
  });

  const thresholdShape = Object.fromEntries(
    (Object.keys(OVERRIDABLE_THRESHOLDS) as ThresholdName[]).map((name) => {
      const row = OVERRIDABLE_THRESHOLDS[name];
      const range = (): string => `must be an integer in [${row.min}, ${row.max}]`;
      return [
        name,
        z
          .number({ error: range })
          .int({ error: range })
          .min(row.min, { error: range })
          .max(row.max, { error: range })
          .meta({ default: row.default })
          .optional(),
      ];
    }),
  ) as Record<ThresholdName, z.ZodOptional<z.ZodNumber>>;
  const thresholds = z.strictObject(thresholdShape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? JUDGEMENT_DETAIL.notOverridableThreshold
        : "must be a JSON object",
  });

  return z
    .strictObject(
      {
        rules: rules.optional(),
        thresholds: thresholds.optional(),
        findingCap: findingCapSchema("must be").optional(),
      },
      {
        error: (issue) =>
          issue.code === "unrecognized_keys"
            ? JUDGEMENT_DETAIL.unknownKey
            : "field 'judgement' must be a JSON object",
      },
    )
    .superRefine((block, ctx) => {
      try {
        parseJudgement(block, registry);
      } catch (error) {
        if (!(error instanceof JudgementError)) throw error;
        ctx.addIssue({
          code: "custom",
          path: judgementSegments(error.path),
          message: judgementDetail(error),
        });
      }
    });
}

/**
 * The start body. Built once per registry — the rule-id enum is the ruleset's
 * — and shared by the service's parser and the MCP tool registration.
 */
const BODY_SCHEMAS = new WeakMap<Registry, ReturnType<typeof buildStartBodySchema>>();

export function startBodySchema(registry: Registry) {
  const cached = BODY_SCHEMAS.get(registry);
  if (cached !== undefined) return cached;
  const built = buildStartBodySchema(registry);
  BODY_SCHEMAS.set(registry, built);
  return built;
}

function buildStartBodySchema(registry: Registry) {
  const f = CRAWL_FIELDS;
  return z.strictObject(
    {
      siteUrl: onTheWire(f.siteUrl),
      maxPages: onTheWire(f.maxPages).optional(),
      maxDepth: onTheWire(f.maxDepth).optional(),
      userAgent: onTheWire(f.userAgent).optional(),
      perHostDelayMs: onTheWire(f.perHostDelayMs).optional(),
      maxConcurrency: onTheWire(f.maxConcurrency).optional(),
      probeHosts: onTheWire(f.probeHosts).optional(),
      legacyHosts: onTheWire(f.legacyHosts).optional(),
      sitemapUrls: onTheWire(f.sitemapUrls).optional(),
      renderBudgetPct: onTheWire(f.renderBudgetPct).optional(),
      renderMaxPages: onTheWire(f.renderMaxPages).optional(),
      renderSamplePerType: onTheWire(f.renderSamplePerType).optional(),
      findingCap: onTheWire(f.findingCap).optional(),
      fetchResources: onTheWire(f.fetchResources).optional(),
      judgement: judgementSchema(registry)
        .meta({ description: JUDGEMENT_DESCRIPTION, "x-ariadne-mutable": "always" })
        .optional(),
    },
    {
      // What the MCP SDK shows for a body this schema refuses at the top level.
      // `parseStartBody` answers these two itself, before the schema runs.
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.map(unknownField).join("; ")
          : BODY_NOT_OBJECT,
    },
  );
}

/** `config_schema`: the JSON Schema, and the ruleset its rule ids come from. */
export function publishedSchema(registry: Registry): { schema: object; rulesetVersion: string } {
  return {
    schema: z.toJSONSchema(startBodySchema(registry), { target: "draft-2020-12" }),
    rulesetVersion: RULESET_VERSION,
  };
}

/**
 * Why a body is refused. `not_allowed` (the allowlist) and `url_policy` are
 * FORBIDDEN; every other code is VALIDATION.
 */
export type ConfigErrorCode =
  | "unknown_field"
  | "forbidden_field"
  | "invalid_type"
  | "out_of_range"
  | "invalid"
  | "not_allowed"
  | "url_policy";

export interface ConfigError {
  /** Dotted, from the body's root: `maxPages`, `judgement.thresholds.SLOW_MS`. "" is the body. */
  path: string;
  code: ConfigErrorCode;
  message: string;
}

/** Which `ServiceError` code a refusal is sent as. */
export function serviceCodeOf(code: ConfigErrorCode): "FORBIDDEN" | "VALIDATION" {
  return code === "not_allowed" || code === "url_policy" ? "FORBIDDEN" : "VALIDATION";
}

function codeOf(issue: z.core.$ZodIssue): ConfigErrorCode {
  switch (issue.code) {
    case "unrecognized_keys":
      return "unknown_field";
    case "invalid_type":
      return "invalid_type";
    case "too_small":
    case "too_big":
      return "out_of_range";
    default:
      return "invalid";
  }
}

/**
 * One zod issue as the refusals it stands for. A top-level field's message
 * names the field itself (`field 'maxPages' must be …`); inside the judgement
 * block the message leads with its dotted path, as `parseJudgement`'s do.
 */
function configErrorsOf(issue: z.core.$ZodIssue): ConfigError[] {
  const segments = issue.path.map(String);
  if (issue.code === "unrecognized_keys") {
    if (segments.length === 0) {
      return issue.keys.map((key) => ({ path: key, code: "unknown_field", message: unknownField(key) }));
    }
    // The block's own sentence is about its first unknown key, as
    // `parseJudgement` reports the first issue.
    const path = [...segments, issue.keys[0] ?? ""].join(".");
    return [{ path, code: "unknown_field", message: `${path}: ${issue.message}` }];
  }
  const path = segments.join(".");
  const inBlock = segments[0] === "judgement" && segments.length > 1;
  return [{ path, code: codeOf(issue), message: inBlock ? `${path}: ${issue.message}` : issue.message }];
}

/**
 * Parse a crawl-start body: not an object, then the two test-only fields by
 * name, then the schema. Every refusal is returned, in that order; the first
 * is the one `crawl_start` answers with.
 */
export function parseStartBody(
  raw: unknown,
  registry: Registry,
): { ok: true; value: StartCrawlInput } | { ok: false; errors: ConfigError[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: "", code: "invalid", message: BODY_NOT_OBJECT }] };
  }
  const forbidden = Object.keys(FORBIDDEN_FIELDS)
    .filter((key) => key in raw)
    .map((key): ConfigError => ({ path: key, code: "forbidden_field", message: unknownField(key) }));
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const parsed = startBodySchema(registry).safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.flatMap(configErrorsOf) };
  const { judgement, ...crawl } = parsed.data;
  return {
    ok: true,
    value: judgement === undefined ? crawl : { ...crawl, judgement: judgementBlockOf(judgement) },
  };
}

/**
 * The parsed block as a `JudgementBlock`. `z.partialRecord` types every rule's
 * entry as possibly undefined; the override schema refuses an undefined entry,
 * so one here is a defect in this module, and it throws.
 */
function judgementBlockOf(
  block: z.output<ReturnType<typeof judgementSchema>>,
): JudgementBlock {
  const { rules, ...rest } = block;
  if (rules === undefined) return rest;
  const overrides: Record<string, RuleOverride> = {};
  for (const [id, override] of Object.entries(rules)) {
    if (override === undefined) {
      throw new Error(`config schema: rule '${id}' parsed to no override`);
    }
    overrides[id] = override;
  }
  return { ...rest, rules: overrides };
}
