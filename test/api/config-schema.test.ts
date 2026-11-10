/**
 * The one config schema (Phase 27b T6): `src/api/config-schema.ts` is the
 * crawl-start body, the JSON Schema `config_schema` publishes, and the parser
 * both transports use.
 *
 * Two halves, no database and no network:
 *
 *  - THE PUBLISHED SCHEMA: draft 2020-12, every field's mutability, the
 *    defaults as annotations, the 20 overridable thresholds with their bounds,
 *    and the rule ids a judgement may name.
 *  - THE REFUSALS that used to be pinned through `POST /crawls` and
 *    `crawl_start` (test/api/http.test.ts, test/api/mcp.test.ts), asserted here
 *    against `parseStartBody` by code and by the phrase the old test pinned.
 *    The transports themselves are held to the same answers by
 *    test/api/transport-parity.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  CRAWL_FIELDS,
  LIST_MAX_URLS,
  parseStartBody,
  publishedSchema,
  type ConfigError,
} from "../../src/api/config-schema.js";
import { MAX_SUPPLIED_SITEMAPS, MIN_PER_HOST_DELAY_MS } from "../../src/api/service.js";
import { buildRegistry } from "../../src/rules/index.js";
import { OVERRIDABLE_THRESHOLDS } from "../../src/rules/judgement.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";

const registry = buildRegistry();
const SITE = "https://config-schema.example/";

interface JsonSchema {
  $schema?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  propertyNames?: { enum?: string[] };
  required?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  "x-ariadne-mutable"?: string;
}

const published = publishedSchema(registry);
const schema = published.schema as JsonSchema;
const props = schema.properties ?? {};

/** The refusals `parseStartBody` answers for `raw`; fails if it accepted. */
function refused(raw: unknown): ConfigError[] {
  const result = parseStartBody(raw, registry);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(raw)}`);
  return result.errors;
}

/** The first refusal, which is what `crawl_start` answers with. */
function first(raw: unknown): ConfigError {
  const error = refused(raw)[0];
  if (error === undefined) throw new Error(`refused ${JSON.stringify(raw)} with no error`);
  return error;
}

describe("the published schema", () => {
  it("is JSON Schema draft 2020-12, and names the ruleset it checks judgements against", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(published.rulesetVersion).toBe(RULESET_VERSION);
    expect(schema.required).toEqual(["siteUrl"]);
  });

  it("marks every field with whether it can change after the crawl starts", () => {
    const expected: Record<string, string> = {
      siteUrl: "never",
      userAgent: "never",
      probeHosts: "never",
      legacyHosts: "never",
      sitemapUrls: "never",
      fetchResources: "never",
      maxPages: "whenPaused",
      maxDepth: "whenPaused",
      perHostDelayMs: "whenPaused",
      maxConcurrency: "whenPaused",
      renderBudgetPct: "whenPaused",
      renderMaxPages: "whenPaused",
      renderSamplePerType: "whenPaused",
      findingCap: "always",
      judgement: "always",
      // Phase 27c.
      mode: "never",
      urls: "never",
      maxUrlLength: "never",
      exclude: "whenPaused",
      include: "whenPaused",
      maxRedirectHops: "whenPaused",
      requestHeaders: "whenPaused",
      httpAuth: "whenPaused",
      cookies: "whenPaused",
    };
    expect(Object.keys(props).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(CRAWL_FIELDS).sort()).toEqual(
      Object.keys(expected).filter((k) => k !== "judgement").sort(),
    );
    for (const [field, mutable] of Object.entries(expected)) {
      expect(props[field]?.["x-ariadne-mutable"], field).toBe(mutable);
      expect(props[field]?.description ?? "", `${field} is undescribed`).not.toBe("");
    }
  });

  it("publishes the API's maxPages default and the politeness floor", () => {
    expect(props["maxPages"]?.default).toBe(500);
    expect(props["perHostDelayMs"]?.minimum).toBe(MIN_PER_HOST_DELAY_MS);
    expect(MIN_PER_HOST_DELAY_MS).toBe(250);
  });

  it("publishes every overridable threshold with its bounds and default", () => {
    const thresholds =
      props["judgement"]?.properties?.["thresholds"]?.properties ?? {};
    expect(Object.keys(thresholds).sort()).toEqual(Object.keys(OVERRIDABLE_THRESHOLDS).sort());
    expect(Object.keys(thresholds)).toHaveLength(20);
    for (const [name, row] of Object.entries(OVERRIDABLE_THRESHOLDS)) {
      expect(thresholds[name]?.minimum, `${name}.minimum`).toBe(row.min);
      expect(thresholds[name]?.maximum, `${name}.maximum`).toBe(row.max);
      expect(thresholds[name]?.default, `${name}.default`).toBe(row.default);
    }
  });

  // zod 4 emits a `z.partialRecord` over a `z.enum` key as `propertyNames.enum`.
  it("names every page and query rule a judgement may override, and no metric", () => {
    const names = props["judgement"]?.properties?.["rules"]?.propertyNames?.enum ?? [];
    const findingRules = registry
      .all()
      .filter((rule) => rule.kind !== "metric")
      .map((rule) => rule.id);
    expect([...names].sort()).toEqual([...findingRules].sort());
    expect(names).toHaveLength(175);
    for (const metric of registry.byKind("metric")) {
      expect(names, metric.id).not.toContain(metric.id);
    }
  });
});

describe("parseStartBody: accepted", () => {
  it("accepts the smallest body and a perHostDelayMs at the floor", () => {
    expect(parseStartBody({ siteUrl: SITE }, registry)).toEqual({
      ok: true,
      value: { siteUrl: SITE },
    });
    const atFloor = parseStartBody({ siteUrl: SITE, perHostDelayMs: MIN_PER_HOST_DELAY_MS }, registry);
    expect(atFloor.ok).toBe(true);
  });

  it("accepts findingCap null — a value, not an omission — and a judgement block", () => {
    const result = parseStartBody(
      {
        siteUrl: SITE,
        findingCap: null,
        judgement: { rules: { "title.too-long": { priority: "low" } }, thresholds: { SLOW_MS: 800 } },
      },
      registry,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        siteUrl: SITE,
        findingCap: null,
        judgement: { rules: { "title.too-long": { priority: "low" } }, thresholds: { SLOW_MS: 800 } },
      },
    });
  });
});

/**
 * The start-body refusals that moved here from the transport suites. Each row
 * names where it came from and keeps the phrase that test pinned.
 */
describe("parseStartBody: the refusals the transport suites used to pin", () => {
  // http.test.ts "refuses allowPrivate at any value, saying why";
  // mcp.test.ts "refuses allowPrivate as an argument at any value".
  it("refuses allowPrivate at any value, saying why", () => {
    for (const value of [true, false]) {
      const error = first({ siteUrl: SITE, allowPrivate: value });
      expect(error.code).toBe("forbidden_field");
      expect(error.path).toBe("allowPrivate");
      expect(error.message).toContain("allowPrivate is not accepted over the API");
    }
  });

  // query.test.ts's sibling, pinned here too: the second test-only field.
  it("refuses recheckMinGapMs at any value, saying why", () => {
    for (const value of [0, 60_000]) {
      const error = first({ siteUrl: SITE, recheckMinGapMs: value });
      expect(error.code).toBe("forbidden_field");
      expect(error.message).toContain("recheckMinGapMs is not accepted over the API");
      expect(error.message).toContain("test-only");
    }
  });

  // http.test.ts "refuses an unknown field by name rather than ignoring it".
  it("refuses an unknown field by position, never quoting it, listing the accepted ones", () => {
    const error = first({ siteUrl: SITE, maxpages: 3 });
    expect(error.code).toBe("unknown_field");
    expect(error.path).toBe("");
    expect(error.message).toContain("body has an unknown field (key 2 in the order sent); did you mean 'maxPages'?");
    expect(error.message).toContain("Accepted: siteUrl, maxPages,");
  });

  it("names every unknown field, one error each", () => {
    expect(refused({ siteUrl: SITE, a: 1, b: 2 }).map((e) => /key (\d+) in the order sent/.exec(e.message)?.[1])).toEqual(["2", "3"]);
  });

  // http.test.ts "refuses a field of the wrong type".
  it("refuses a field of the wrong type", () => {
    const error = first({ siteUrl: SITE, maxPages: "5" });
    expect(error.code).toBe("invalid_type");
    expect(error.path).toBe("maxPages");
    expect(error.message).toBe("field 'maxPages' must be a finite number");
  });

  // http.test.ts "requires siteUrl".
  it("requires siteUrl", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ maxPages: 5 }, "invalid_type"],
      [{ siteUrl: "" }, "invalid"],
      [{ siteUrl: "   " }, "invalid"],
    ];
    for (const [body, code] of cases) {
      const error = first(body);
      expect(error.path, JSON.stringify(body)).toBe("siteUrl");
      expect(error.code, JSON.stringify(body)).toBe(code);
      expect(error.message).toContain("siteUrl is required");
    }
    const wrong = first({ siteUrl: 7 });
    expect(wrong.code).toBe("invalid_type");
    expect(wrong.message).toBe("field 'siteUrl' must be a string");
  });

  // http.test.ts "refuses a perHostDelayMs under the politeness floor rather
  // than raising it"; mcp.test.ts "refuses a perHostDelayMs under the
  // politeness floor, naming the floor".
  it("refuses a perHostDelayMs under the politeness floor rather than raising it", () => {
    for (const value of [0, 10, MIN_PER_HOST_DELAY_MS - 1]) {
      const error = first({ siteUrl: SITE, perHostDelayMs: value });
      expect(error.code, `perHostDelayMs ${value}`).toBe("out_of_range");
      expect(error.path).toBe("perHostDelayMs");
      expect(error.message).toContain(`${MIN_PER_HOST_DELAY_MS}ms`);
      expect(error.message).toContain(`perHostDelayMs ${value} is below`);
    }
  });

  // http.test.ts "surfaces the crawl loop's own range checks as a 400" — the
  // range is the schema's now, with the same sentence shape.
  it("refuses maxPages, maxDepth and maxConcurrency below 1, or fractional", () => {
    for (const field of ["maxPages", "maxDepth", "maxConcurrency"]) {
      const zero = first({ siteUrl: SITE, [field]: 0 });
      expect(zero.code, field).toBe("out_of_range");
      expect(zero.message).toBe(`field '${field}' must be an integer ≥ 1, got 0`);
      expect(first({ siteUrl: SITE, [field]: 1.5 }).message).toContain(field);
    }
  });

  // http.test.ts "400s a sitemapUrls list longer than the server's limit
  // rather than trimming it".
  it("refuses a sitemapUrls list longer than the server's limit rather than trimming it", () => {
    const many = Array.from({ length: MAX_SUPPLIED_SITEMAPS + 1 }, (_u, i) => `${SITE}s-${i}.xml`);
    const error = first({ siteUrl: SITE, sitemapUrls: many });
    expect(error.code).toBe("out_of_range");
    expect(error.path).toBe("sitemapUrls");
    expect(error.message).toContain(String(MAX_SUPPLIED_SITEMAPS));
    expect(error.message).toContain(`names ${MAX_SUPPLIED_SITEMAPS + 1} documents`);
    const atLimit = many.slice(0, MAX_SUPPLIED_SITEMAPS);
    expect(parseStartBody({ siteUrl: SITE, sitemapUrls: atLimit }, registry).ok).toBe(true);
  });

  it("refuses a list field that is not a list of strings", () => {
    for (const field of ["legacyHosts", "sitemapUrls"]) {
      for (const bad of ["x", [1], null]) {
        const error = first({ siteUrl: SITE, [field]: bad });
        expect(error.code, `${field} ${JSON.stringify(bad)}`).toBe("invalid_type");
        expect(error.message).toBe(`field '${field}' must be an array of strings`);
      }
    }
  });

  // http.test.ts "400s a findingCap that is neither a positive integer nor
  // null"; mcp.test.ts "refuses a findingCap that is neither a positive integer
  // nor null".
  it("refuses a findingCap that is neither a positive integer nor null", () => {
    const codes: [unknown, string][] = [
      [0, "out_of_range"],
      [-1, "out_of_range"],
      [1.5, "invalid_type"],
      ["none", "invalid_type"],
    ];
    for (const [bad, code] of codes) {
      const error = first({ siteUrl: SITE, findingCap: bad });
      expect(error.path, JSON.stringify(bad)).toBe("findingCap");
      expect(error.code, JSON.stringify(bad)).toBe(code);
      expect(error.message).toContain("findingCap");
      expect(error.message).toContain("or null for uncapped");
    }
  });

  // http.test.ts "400s a fetchResources that is not a boolean"; mcp.test.ts
  // "refuses a fetchResources that is not a boolean".
  it("refuses a fetchResources that is not a boolean, null included", () => {
    for (const bad of ["false", 0, null]) {
      const error = first({ siteUrl: SITE, fetchResources: bad });
      expect(error.code, JSON.stringify(bad)).toBe("invalid_type");
      expect(error.path).toBe("fetchResources");
      expect(error.message).toBe("field 'fetchResources' must be a boolean");
    }
  });

  it("refuses a body that is not a JSON object", () => {
    for (const bad of [null, [], "x", 3, undefined]) {
      const error = first(bad);
      expect(error.code, JSON.stringify(bad)).toBe("invalid");
      expect(error.path).toBe("");
      expect(error.message).toBe("request body must be a JSON object");
    }
  });
});

describe("parseStartBody: the judgement block", () => {
  it("refuses a judgement that is not an object", () => {
    for (const bad of [null, ["rules"], "none"]) {
      const error = first({ siteUrl: SITE, judgement: bad });
      expect(error.code, JSON.stringify(bad)).toBe("invalid_type");
      expect(error.path).toBe("judgement");
      expect(error.message).toBe("field 'judgement' must be a JSON object");
    }
  });

  it("refuses a rule id the ruleset does not have, and a metric id, in parseJudgement's words", () => {
    const unknown = first({ siteUrl: SITE, judgement: { rules: { "no.such-rule": { disabled: true } } } });
    expect(unknown.path).toBe("judgement.rules");
    expect(unknown.message).toBe(
      `judgement.rules: key 1 in the order sent names no rule in ruleset ${RULESET_VERSION}`,
    );
    const metricId = registry.byKind("metric")[0]!.id;
    const metric = first({ siteUrl: SITE, judgement: { rules: { [metricId]: { disabled: true } } } });
    expect(metric.message).toContain(`'${metricId}' is a metric rule`);
  });

  it("refuses severity, an unknown threshold and an unknown block key", () => {
    const severity = first({
      siteUrl: SITE,
      judgement: { rules: { "title.too-long": { severity: "info" } } },
    });
    expect(severity.code).toBe("unknown_field");
    expect(severity.path).toBe("judgement.rules.title.too-long.severity");
    expect(severity.message).toContain("severity cannot be overridden");

    const threshold = first({ siteUrl: SITE, judgement: { thresholds: { NOPE: 3 } } });
    expect(threshold.path).toBe("judgement.thresholds");
    expect(threshold.message).toContain("judgement.thresholds: unknown field (key 1 in the order sent)");

    const key = first({ siteUrl: SITE, judgement: { bogus: 1 } });
    expect(key.path).toBe("judgement");
    expect(key.message).toBe("judgement: unknown field (key 1 in the order sent). Accepted: rules, thresholds, findingCap");
  });

  it("refuses a threshold out of its range, naming the range", () => {
    const row = OVERRIDABLE_THRESHOLDS.SLOW_MS;
    for (const bad of [row.min - 1, row.max + 1]) {
      const error = first({ siteUrl: SITE, judgement: { thresholds: { SLOW_MS: bad } } });
      expect(error.code).toBe("out_of_range");
      expect(error.path).toBe("judgement.thresholds.SLOW_MS");
      expect(error.message).toContain(`[${row.min}, ${row.max}]`);
    }
  });

  // The two refusals only `parseJudgement` can make — a value on its own is
  // fine, the block is not — reached through the schema's `.superRefine`.
  it("refuses an empty override and a crossed threshold pair through parseJudgement", () => {
    const empty = first({ siteUrl: SITE, judgement: { rules: { "title.too-long": {} } } });
    expect(empty.code).toBe("invalid");
    expect(empty.path).toBe("judgement.rules.title.too-long");
    expect(empty.message).toContain("an empty override changes nothing");

    const crossed = first({
      siteUrl: SITE,
      judgement: { thresholds: { TITLE_MIN: OVERRIDABLE_THRESHOLDS.TITLE_MAX.default } },
    });
    expect(crossed.path).toBe("judgement.thresholds.TITLE_MIN");
    expect(crossed.message).toContain("must be strictly below");
  });
});

describe("a positive integer too large to be one (27b final M11)", () => {
  it("names the real ceiling for maxPages, maxDepth and maxConcurrency instead of '≥ 1'", () => {
    for (const field of ["maxPages", "maxDepth", "maxConcurrency"]) {
      const error = first({ siteUrl: SITE, [field]: 1e20 });
      expect(error.code, field).toBe("out_of_range");
      expect(error.message).toBe(
        `field '${field}' must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}, got 100000000000000000000`,
      );
      expect(error.message).not.toContain("≥ 1");
      // The ceiling itself is accepted.
      expect(parseStartBody({ siteUrl: SITE, [field]: Number.MAX_SAFE_INTEGER }, registry).ok, field).toBe(true);
    }
  });
});

interface WideSchema extends JsonSchema {
  "x-ariadne-secret"?: boolean;
  enum?: string[];
  maxItems?: number;
  items?: JsonSchema & { maxLength?: number };
}

describe("the 27c fields (list mode, scope, credentials, limits)", () => {
  const wide = props as Record<string, WideSchema>;

  it("publishes the nine fields with their x-ariadne-mutable, and exactly the three credential fields as secret", () => {
    const nine: Record<string, string> = {
      mode: "never",
      urls: "never",
      maxUrlLength: "never",
      exclude: "whenPaused",
      include: "whenPaused",
      maxRedirectHops: "whenPaused",
      requestHeaders: "whenPaused",
      httpAuth: "whenPaused",
      cookies: "whenPaused",
    };
    for (const [field, mutable] of Object.entries(nine)) {
      expect(wide[field]?.["x-ariadne-mutable"], field).toBe(mutable);
      expect(wide[field]?.description ?? "", `${field} is undescribed`).not.toBe("");
    }
    const secret = Object.entries(wide)
      .filter(([, spec]) => spec["x-ariadne-secret"] === true)
      .map(([field]) => field)
      .sort();
    expect(secret).toEqual(["cookies", "httpAuth", "requestHeaders"]);
    const fields = CRAWL_FIELDS as Record<string, { secret?: true }>;
    expect(Object.keys(fields).filter((f) => fields[f]?.secret === true).sort()).toEqual([
      "cookies",
      "httpAuth",
      "requestHeaders",
    ]);
  });

  it("publishes the limits' ranges and defaults, the list cap and the pattern bounds", () => {
    expect(wide["mode"]?.enum).toEqual(["spider", "list"]);
    expect(wide["mode"]?.default).toBe("spider");
    expect(wide["urls"]?.maxItems).toBe(LIST_MAX_URLS);
    expect(LIST_MAX_URLS).toBe(10_000);
    expect(wide["maxRedirectHops"]).toMatchObject({ minimum: 1, maximum: 20, default: 10 });
    expect(wide["maxUrlLength"]).toMatchObject({ minimum: 256, maximum: 2500, default: 2500 });
    for (const field of ["exclude", "include"]) {
      expect(wide[field]?.maxItems, field).toBe(100);
      expect(wide[field]?.items?.maxLength, field).toBe(512);
    }
    expect(wide["cookies"]?.maxItems).toBe(50);
  });

  it("refuses a credential field's value without ever quoting it", () => {
    const secret = "v-s3cret-value";
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ requestHeaders: { "X-Tenant": `${secret}\r\nX-Injected: 1` } }, "requestHeaders"],
      [{ requestHeaders: { "User-Agent": secret } }, "requestHeaders"],
      [{ requestHeaders: { "x-a": 7 } }, "requestHeaders"],
      [{ httpAuth: { username: `${secret}:x`, password: secret } }, "httpAuth"],
      [{ httpAuth: { username: secret } }, "httpAuth"],
      [{ cookies: [{ name: "sid", value: `${secret};x` }] }, "cookies"],
      [{ cookies: secret }, "cookies"],
    ];
    for (const [extra, path] of cases) {
      const errors = refused({ siteUrl: SITE, ...extra });
      expect(errors[0]?.path, JSON.stringify(extra)).toBe(path);
      expect(JSON.stringify(errors), path).not.toContain("s3cret");
    }
  });

  it("keeps a header named __proto__ as a header rather than dropping it", () => {
    const raw = JSON.parse(
      `{"siteUrl": "${SITE}", "requestHeaders": {"__proto__": "v", "x-a": "b"}}`,
    ) as unknown;
    const result = parseStartBody(raw, registry);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(Object.getOwnPropertyNames(result.value.requestHeaders).sort()).toEqual(["__proto__", "x-a"]);
  });

  it("refuses an empty, an over-long and a 101st pattern, a list over LIST_MAX_URLS and an unknown mode", () => {
    expect(first({ siteUrl: SITE, exclude: [""] }).path).toBe("exclude.0");
    expect(first({ siteUrl: SITE, include: ["x".repeat(513)] }).code).toBe("out_of_range");
    const many = first({ siteUrl: SITE, exclude: Array.from({ length: 101 }, (_u, i) => `*/p${i}/*`) });
    expect(many).toMatchObject({ path: "exclude", code: "out_of_range" });
    expect(many.message).toContain("100");
    const urls = Array.from({ length: LIST_MAX_URLS + 1 }, (_u, i) => `${SITE}p/${i}`);
    const list = first({ siteUrl: SITE, mode: "list", urls });
    expect(list).toMatchObject({ path: "urls", code: "out_of_range" });
    expect(list.message).toContain("10000");
    expect(first({ siteUrl: SITE, mode: "crawl" })).toMatchObject({ path: "mode", code: "invalid" });
  });
});
