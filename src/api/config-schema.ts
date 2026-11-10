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
 * `resolveRenderConfig` is their one check), and — Phase 27c — whatever reads
 * two fields at once or needs the seed: `mode` and `urls` together, each listed
 * URL's site, policy and scope, a pattern's host, the seed against the scope,
 * a list crawl's `maxPages`. Those are `ApiService.checkStartBody`.
 *
 * ## The credential fields are checked on the value as sent
 *
 * `requestHeaders`, `httpAuth` and `cookies` are secrets (`CrawlField.secret`,
 * published as `x-ariadne-secret: true`). Their schema is `credentialSchema`:
 * `credentialFieldError` on the raw value, whose messages never carry one, with
 * the shape published from `CrawlField.jsonSchema`.
 */
import { z } from "zod";

import {
  credentialFieldError,
  MAX_COOKIES,
  MAX_CREDENTIAL_VALUE_BYTES,
  MAX_REQUEST_HEADERS,
  type CrawlCredentials,
} from "../crawl/credentials.js";
import {
  CRAWL_DEFAULTS,
  MAX_REDIRECT_HOPS,
  MIN_REDIRECT_HOPS,
  MIN_URL_LENGTH,
} from "../crawl/loop.js";
import { INDEXED_URL_MAX } from "../crawl/parse/url-utils.js";
import { MAX_PATTERN_LENGTH, MAX_SCOPE_PATTERNS } from "../crawl/url-scope.js";
import {
  JUDGEMENT_BLOCK_KEYS,
  JUDGEMENT_DETAIL,
  JudgementError,
  OVERRIDABLE_THRESHOLDS,
  parseJudgement,
  type ThresholdName,
} from "../rules/judgement.js";
import { THRESHOLD_NAMES } from "../rules/threshold-table.js";
import { URL_FINDING_CAP } from "../rules/query/crawl-evidence.js";
import {
  ISSUE_TYPES,
  PRIORITIES,
  RULESET_VERSION,
  type Registry,
} from "../rules/registry/registry.js";
import { positionOf, unknownKeyMessage } from "./errors.js";
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
  /**
   * A credential (27c): its value is held only in the API process's memory —
   * never stored, logged, quoted in a refusal or answered — and the published
   * schema marks it `x-ariadne-secret: true`.
   */
  secret?: true;
  /**
   * The JSON Schema the field publishes, for a field whose zod schema cannot
   * say it: the credential fields are checked by `credentialFieldError` on the
   * RAW value (`credentialSchema`), so their shape is published from here.
   */
  jsonSchema?: Record<string, unknown>;
}

/**
 * The most URLs one list crawl may name (27c). Up to about 1 MiB of JSON,
 * which is the body cap `POST /crawls` and `POST /config/validate` take
 * (`LARGE_BODY_BYTES`, src/api/http.ts). Refused past it, never trimmed: a
 * list this engine silently cut would leave the caller believing every URL
 * was fetched (hard rule 7).
 */
export const LIST_MAX_URLS = 10_000;

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
  // zod's `.int()` is bounded by Number.MAX_SAFE_INTEGER, so 1e20 is not an
  // "integer" to it — and "must be an integer ≥ 1" about 1e20 is a sentence
  // that cannot be acted on. The ceiling is checked FIRST, so it is the issue
  // reported, and it names the real range.
  const tooLarge = (issue: { input?: unknown }): string =>
    `field '${key}' must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}, got ` +
    `${typeof issue.input === "number" ? issue.input.toLocaleString("en-US", { useGrouping: false }) : String(issue.input)}`;
  return finiteNumber(key)
    .max(Number.MAX_SAFE_INTEGER, { error: tooLarge })
    .int({ error: range })
    .min(1, { error: range });
}

function booleanField(key: string) {
  return z.boolean({ error: () => `field '${key}' must be a boolean` });
}

function stringList(key: string) {
  const message = (): string => `field '${key}' must be an array of strings`;
  return z.array(z.string({ error: message }), { error: message });
}

/** An integer in `[min, max]`: the 27c limits, at the wire. */
function boundedInteger(key: string, min: number, max: number) {
  const range = (issue: { input?: unknown }): string =>
    `field '${key}' must be an integer from ${min} to ${max}, got ${String(issue.input)}`;
  return finiteNumber(key).int({ error: range }).min(min, { error: range }).max(max, { error: range });
}

/** `exclude` / `include`: up to `MAX_SCOPE_PATTERNS` non-empty patterns of up to `MAX_PATTERN_LENGTH`. */
function patternList(key: "exclude" | "include") {
  const type = (): string => `field '${key}' must be an array of URL patterns (strings)`;
  return z
    .array(
      z
        .string({ error: type })
        .min(1, { error: () => `${key} holds an empty pattern, which can never match a URL` })
        .max(MAX_PATTERN_LENGTH, {
          error: (issue) =>
            `${key} holds a pattern of ${String((issue.input as string).length)} characters; ` +
            `the limit is ${MAX_PATTERN_LENGTH}`,
        }),
      { error: type },
    )
    .max(MAX_SCOPE_PATTERNS, {
      error: (issue) =>
        `${key} holds ${(issue.input as readonly unknown[]).length} patterns; the limit is ` +
        `${MAX_SCOPE_PATTERNS}`,
    });
}

/**
 * A credential field (27c): checked by `credentialFieldError` on the value AS
 * SENT, never on a zod-parsed copy. Two reasons, both about the secret:
 *
 *  - every message is one `credentialFieldError` wrote, and those name the
 *    field and the header or cookie NAME, never a value — zod's own messages
 *    are not a promise this module can keep for it;
 *  - `z.record` rebuilds the object, and a header named `__proto__` (a valid
 *    HTTP token) would be dropped from the copy without a word.
 *
 * So the zod type is `unknown` refined, and the shape the field publishes is
 * `CrawlField.jsonSchema`.
 */
function credentialSchema<T>(field: keyof CrawlCredentials): z.ZodType<T> {
  return z.unknown().superRefine((value, ctx) => {
    const error = credentialFieldError(field, value);
    if (error !== null) ctx.addIssue({ code: "custom", message: error });
  }) as unknown as z.ZodType<T>;
}

const SECRET_NOTE =
  "SECRET: held only in this server's memory for the crawl — never stored, logged or " +
  "answered; crawl_config_get shows which were supplied and the names, never a value. " +
  "Sent only to the site's own hosts (its www/apex and http→https spellings), including " +
  "robots.txt and sitemaps, never to another host. After a server restart they must be " +
  "supplied again (CREDENTIALS_REQUIRED).";

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
      "it deliberately: a full crawl of a large site is a real load on it. A list " +
      "crawl (mode 'list') defaults instead to twice its distinct URLs — room for one " +
      "redirect target each — and refuses a value below its distinct URLs, so every " +
      "listed URL ends in a classified row.",
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
  mode: {
    schema: z.enum(["spider", "list"], {
      error: () => `field 'mode' must be "spider" or "list"`,
    }),
    mutable: "never",
    description:
      "'spider' (the default) follows links from siteUrl. 'list' fetches exactly the " +
      "URLs in urls, at depth 0: redirects are followed to their target (within " +
      "maxRedirectHops) so every listed URL ends in a classified row, links are " +
      "recorded but not followed, and no sitemap is read unless sitemapUrls is given. " +
      "robots.txt is always read and obeyed. The host probe (probeHosts: false turns it " +
      "off), the known-404 probe, and the recheck, resource and render passes as " +
      "configured run too. Rules that need the whole site (the link " +
      "graph, click depth, sitemap coverage, orphans) do not run on a list crawl; the " +
      "crawl.list-mode finding names them.",
    default: "spider",
  },
  urls: {
    schema: stringList("urls")
      .min(1, { error: () => "urls is empty: a list crawl needs at least one URL" })
      .max(LIST_MAX_URLS, {
        error: (issue) =>
          `urls names ${(issue.input as readonly unknown[]).length} URLs, above this ` +
          `server's limit of ${LIST_MAX_URLS} for one list crawl. The list is not ` +
          `trimmed: split it across crawls`,
      }),
    mutable: "never",
    description:
      `A list crawl's URLs (mode 'list' only, and required there): 1 to ${LIST_MAX_URLS} ` +
      "full http(s) URLs, all on siteUrl's own site — its host or the www/apex twin, " +
      "the same scheme or the http→https upgrade. A list that spans sites is refused, " +
      "not split. Each must pass the URL policy and exclude/include. Two spellings of " +
      "one URL (after normalisation) are collapsed and counted: the answer carries " +
      "listUrlCount (distinct) and listDuplicates. The URLs are not echoed back by " +
      "config_validate or crawl_config_get.",
  },
  exclude: {
    schema: patternList("exclude"),
    mutable: "whenPaused",
    description:
      `Up to ${MAX_SCOPE_PATTERNS} URL patterns of up to ${MAX_PATTERN_LENGTH} characters ` +
      "the crawl must not fetch. A pattern matches the whole normalised URL; '*' matches " +
      "any run of characters and nothing else is special, so '*/blog/*' is a path rule " +
      "and 'https://shop.example.com/*' a host rule. The match starts at the URL's " +
      "first character, so a path rule needs a leading '*': '/blog/*' can never match " +
      "and is refused. Exclude wins over include. A " +
      "refused URL is recorded as a row with fetch class 'excluded' naming the pattern, " +
      "never fetched. The seed (spider) and every listed URL (list) are checked at " +
      "start: one these patterns refuse is a validation error. A pattern that could " +
      "never match is refused: one with no leading '*' that does not start http:// or " +
      "https://, and one naming a scheme and host the crawl never admits (another " +
      "host, or http:// on an https site).",
    default: [],
  },
  include: {
    schema: patternList("include"),
    mutable: "whenPaused",
    description:
      "When non-empty, only URLs matching at least one of these patterns are fetched " +
      "(exclude still wins). Same pattern language and limits as exclude.",
    default: [],
  },
  requestHeaders: {
    schema: credentialSchema<Record<string, string>>("requestHeaders"),
    mutable: "whenPaused",
    secret: true,
    jsonSchema: {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "string" },
      maxProperties: MAX_REQUEST_HEADERS,
    },
    description:
      `Up to ${MAX_REQUEST_HEADERS} custom request headers, {name: value}. A name is an ` +
      `HTTP token; a value is at most ${MAX_CREDENTIAL_VALUE_BYTES} bytes with no CR or ` +
      "LF. Refused names: host, user-agent, accept, accept-encoding, content-length, " +
      "connection, transfer-encoding, te, upgrade, expect, keep-alive, cookie (use " +
      "cookies), authorization (use httpAuth), and any name starting proxy- or sec- " +
      "(the browser owns sec-*). " +
      SECRET_NOTE,
  },
  httpAuth: {
    schema: credentialSchema<{ username: string; password: string }>("httpAuth"),
    mutable: "whenPaused",
    secret: true,
    jsonSchema: {
      type: "object",
      properties: { username: { type: "string" }, password: { type: "string" } },
      required: ["username", "password"],
      additionalProperties: false,
    },
    description:
      `HTTP Basic credentials, {username, password}, each at most ` +
      `${MAX_CREDENTIAL_VALUE_BYTES} bytes; the username may not contain ':'. ` +
      SECRET_NOTE,
  },
  cookies: {
    schema: credentialSchema<Array<{ name: string; value: string }>>("cookies"),
    mutable: "whenPaused",
    secret: true,
    jsonSchema: {
      type: "array",
      maxItems: MAX_COOKIES,
      items: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
        additionalProperties: false,
      },
    },
    description:
      `Up to ${MAX_COOKIES} cookies, [{name, value}], sent as one Cookie header. A value ` +
      `is at most ${MAX_CREDENTIAL_VALUE_BYTES} bytes of cookie-octets (no ';', ',' or ` +
      "whitespace). Set-Cookie from the site is ignored: the crawl stays stateless. " +
      SECRET_NOTE,
  },
  maxRedirectHops: {
    schema: boundedInteger("maxRedirectHops", MIN_REDIRECT_HOPS, MAX_REDIRECT_HOPS),
    mutable: "whenPaused",
    description:
      "The longest redirect chain the page crawl follows. A chain over it ends in a " +
      "classified row whose reason names the cap; its next target is not fetched.",
    default: CRAWL_DEFAULTS.maxRedirectHops,
  },
  maxUrlLength: {
    schema: boundedInteger("maxUrlLength", MIN_URL_LENGTH, INDEXED_URL_MAX),
    mutable: "never",
    description:
      "The longest URL the crawl admits, in characters. A longer one is refused at " +
      "admission and recorded, never fetched. The default is the maximum: the index's " +
      "own limit.",
    default: CRAWL_DEFAULTS.maxUrlLength,
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

/** The start body's keys, in the order an unknown-field refusal lists them. */
const ACCEPTED_FIELDS: readonly string[] = [...Object.keys(CRAWL_FIELDS), "judgement"];

/** The keys `crawl_config_set`'s `crawl` object may name. */
export const CRAWL_PATCH_FIELDS: readonly string[] = Object.keys(CRAWL_FIELDS);

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

/**
 * Why `key`, sent at `position` (1-based, in the order sent) in the object at
 * `path`, is refused: one of the two test-only fields or an operator-only
 * field by name (an exact match of our own vocabulary, not the caller's
 * text), or an unknown field by its POSITION. An unknown key is never
 * repeated (27d spec §4): a key can be a secret pasted into the wrong place.
 */
export function unknownField(
  key: string,
  position: number,
  path = "body",
  accepted: readonly string[] = ACCEPTED_FIELDS,
): string {
  if (Object.hasOwn(FORBIDDEN_FIELDS, key)) return FORBIDDEN_FIELDS[key] as string;
  if (OPERATOR_ONLY_FIELDS.includes(key)) return `field '${key}' is set by the operator, not over the API`;
  return unknownKeyMessage(path, position, key, accepted);
}

/**
 * The first of `keys` — the unknown keys a strict object found in `input` —
 * as `JUDGEMENT_DETAIL.unknownKey` names it inside the judgement block.
 */
function unknownKeysDetail(input: unknown, keys: readonly string[], accepted: readonly string[]): string {
  const first = keys[0];
  if (first === undefined) throw new Error("config schema: unrecognized keys with no key");
  return JUDGEMENT_DETAIL.unknownKey(input, first, accepted, keys.length - 1);
}

/** A field's schema as the body carries it: described, defaulted, marked. */
function onTheWire<S extends z.ZodType>(field: { schema: S } & CrawlField): S {
  return field.schema.meta({
    ...(field.jsonSchema ?? {}),
    description: field.description,
    ...(field.default === undefined ? {} : { default: field.default }),
    "x-ariadne-mutable": field.mutable,
    ...(field.secret === true ? { "x-ariadne-secret": true } : {}),
  });
}

/**
 * The three credential fields as `crawl_resume` and `crawl_render` take them
 * (27c T9): `crawl_start`'s own schemas (`credentialSchema`, so the refusals
 * are the same names-only sentences) and published shapes, marked
 * `x-ariadne-secret`. No mutability marker: on these tools they re-supply the
 * crawl's credentials for one call, they do not change a setting.
 */
export function credentialInputSchemas() {
  const secret = <S extends z.ZodType>(field: { schema: S } & CrawlField): S =>
    field.schema.meta({
      ...(field.jsonSchema ?? {}),
      description: field.description,
      "x-ariadne-secret": true,
    });
  return {
    requestHeaders: secret(CRAWL_FIELDS.requestHeaders).optional(),
    httpAuth: secret(CRAWL_FIELDS.httpAuth).optional(),
    cookies: secret(CRAWL_FIELDS.cookies).optional(),
  };
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
  const [firstId, ...restIds] = registry
    .all()
    .filter((rule) => rule.kind !== "metric")
    .map((rule) => rule.id);
  if (firstId === undefined) throw new Error("config schema: the ruleset has no finding rule");

  // `rules` is checked by `parseJudgement` alone (the `.superRefine` below),
  // never by zod: a zod issue inside a record carries the entry's KEY in its
  // path, and the MCP SDK appends that path to its refusal — an id the
  // ruleset lacks is a key the caller sent, never to be repeated (27d spec
  // §4). So the zod type is `unknown`, and the shape it publishes is the
  // partial record over the rule ids this zod schema describes.
  const override = z.strictObject({
    disabled: z.literal(true).optional(),
    type: z.enum(ISSUE_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
  });
  const { $schema: _dialect, ...rulesShape } = z.toJSONSchema(
    z.partialRecord(z.enum([firstId, ...restIds]), override),
    { target: "draft-2020-12" },
  );
  const rules = z.unknown().meta(rulesShape);

  const thresholdShape = Object.fromEntries(
    (Object.keys(OVERRIDABLE_THRESHOLDS) as ThresholdName[]).map((name) => {
      const row = OVERRIDABLE_THRESHOLDS[name];
      const range = (): string => JUDGEMENT_DETAIL.thresholdRange(row.min, row.max);
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
        ? unknownKeysDetail(issue.input, issue.keys, THRESHOLD_NAMES)
        : JUDGEMENT_DETAIL.notObject,
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
            ? unknownKeysDetail(issue.input, issue.keys, JUDGEMENT_BLOCK_KEYS)
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
          params: { unknownKey: error.reason === "unknown-key" },
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
      mode: onTheWire(f.mode).optional(),
      urls: onTheWire(f.urls).optional(),
      exclude: onTheWire(f.exclude).optional(),
      include: onTheWire(f.include).optional(),
      requestHeaders: onTheWire(f.requestHeaders).optional(),
      httpAuth: onTheWire(f.httpAuth).optional(),
      cookies: onTheWire(f.cookies).optional(),
      maxRedirectHops: onTheWire(f.maxRedirectHops).optional(),
      maxUrlLength: onTheWire(f.maxUrlLength).optional(),
      judgement: judgementSchema(registry)
        .meta({ description: JUDGEMENT_DESCRIPTION, "x-ariadne-mutable": "always" })
        .optional(),
    },
    {
      // What the MCP SDK shows for a body this schema refuses at the top level.
      // `parseStartBody` answers these two itself, before the schema runs.
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => unknownField(key, positionOf(issue.input, key))).join("; ")
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
    case "custom":
      // `parseJudgement`'s refusals, raised from the block's `.superRefine`:
      // an unknown key (`severity` among them) is still an unknown field.
      return issue.params?.["unknownKey"] === true ? "unknown_field" : "invalid";
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
 *
 * An unknown key is named by its position in `raw`, the body as sent, and its
 * `path` is the object it was found in ("" for the body): neither the path nor
 * the message repeats the key (27d spec §4).
 */
function configErrorsOf(issue: z.core.$ZodIssue, raw: object): ConfigError[] {
  const segments = issue.path.map(String);
  if (issue.code === "unrecognized_keys") {
    if (segments.length === 0) {
      return issue.keys.map((key) => ({
        path: "",
        code: "unknown_field",
        message: unknownField(key, positionOf(raw, key)),
      }));
    }
    // The block's own sentence is about its first unknown key, as
    // `parseJudgement` reports the first issue (the schema's error map).
    const path = segments.join(".");
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
    .map((key): ConfigError => ({ path: key, code: "forbidden_field", message: FORBIDDEN_FIELDS[key] as string }));
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const parsed = startBodySchema(registry).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.flatMap((issue) => configErrorsOf(issue, raw)) };
  }
  const { judgement, ...crawl } = parsed.data;
  // The schema's `.superRefine` accepted the block; this is the same parse,
  // for its typed result (the schema's `rules` is `unknown`, see there).
  return {
    ok: true,
    value: judgement === undefined ? crawl : { ...crawl, judgement: parseJudgement(judgement, registry) },
  };
}
