/**
 * The per-crawl judgement block (Phase 27a T2): the zod-validated overrides and
 * threshold overrides an agent sets on a crawl, the stamp a rules run leaves of
 * what it was judged with, and the comparison that says a judgement is stale.
 *
 * Parsing is strict at every level and every refusal names a dotted path, so an
 * API refusal can quote it. A stored block is never read as "no overrides" when
 * it cannot be parsed, and a stored block naming a rule a later ruleset removed
 * is a distinct, named error (hard rule 7).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { crawls, pages } from "../../src/db/schema.js";
import { buildRegistry } from "../../src/rules/index.js";
import {
  DEFAULT_THRESHOLDS,
  effectiveThresholds,
  JudgementError,
  judgedWithOf,
  OVERRIDABLE_THRESHOLDS,
  parseJudgement,
  readStamp,
  readStoredJudgement,
  staleReasons,
  type JudgedWith,
  type JudgementBlock,
} from "../../src/rules/judgement.js";
import { URL_FINDING_CAP } from "../../src/rules/query/crawl-evidence.js";
import { linkGraphRules } from "../../src/rules/query/link-graph.js";
import {
  Registry,
  RULESET_VERSION,
  type RuleDefinition,
  type TriageLookup,
} from "../../src/rules/registry/registry.js";
import { triageRow } from "../../src/rules/registry/triage.js";
import type { PageRule, QueryRule } from "../../src/rules/registry/types.js";
import { runRules } from "../../src/rules/run.js";
import { DEEP_DEPTH, SLOW_MS, THIN_WORDS, TITLE_MAX } from "../../src/rules/thresholds.js";
import { mkDiscovery } from "./mk-discovery.js";
import { CLEAN_META, mkPage } from "./mk-page.js";

const reg = buildRegistry();

/** The JudgementError `parseJudgement` throws for `raw`, or a failed test. */
function refusal(raw: unknown): JudgementError {
  try {
    parseJudgement(raw, reg);
  } catch (error) {
    if (error instanceof JudgementError) return error;
    throw error;
  }
  throw new Error(`parseJudgement accepted ${JSON.stringify(raw)}`);
}

describe("parseJudgement", () => {
  it("round-trips a block with an override, two thresholds at their bounds and an uncapped findingCap", () => {
    const block = {
      rules: { "title.too-long": { disabled: true, priority: "low" } },
      thresholds: { SLOW_MS: 100, THIN_WORDS: 10000 },
      findingCap: null,
    };
    expect(parseJudgement(block, reg)).toEqual(block);
  });

  it("accepts the empty block and a retype on its own", () => {
    expect(parseJudgement({}, reg)).toEqual({});
    expect(parseJudgement({ rules: { "title.too-long": { type: "issue" } } }, reg)).toEqual({
      rules: { "title.too-long": { type: "issue" } },
    });
  });

  const cases: [string, unknown, string][] = [
    ["severity", { rules: { "title.too-long": { severity: "info" } } }, "rules.title.too-long.severity"],
    ["an unknown rule id", { rules: { "nope.rule": { disabled: true } } }, "rules.nope.rule"],
    ["a metric rule id", { rules: { "site.health": { disabled: true } } }, "rules.site.health"],
    ["an empty override", { rules: { "title.too-long": {} } }, "rules.title.too-long"],
    ["disabled: false", { rules: { "title.too-long": { disabled: false } } }, "rules.title.too-long.disabled"],
    ["an unknown type", { rules: { "title.too-long": { type: "bug" } } }, "rules.title.too-long.type"],
    ["a threshold below its range", { thresholds: { SLOW_MS: 99 } }, "thresholds.SLOW_MS"],
    ["a threshold above its range", { thresholds: { THIN_WORDS: 10001 } }, "thresholds.THIN_WORDS"],
    ["a non-integer threshold", { thresholds: { SLOW_MS: 1.5 } }, "thresholds.SLOW_MS"],
    ["a threshold that is not overridable", { thresholds: { NEAR_DUPLICATE_HAMMING: 4 } }, "thresholds.NEAR_DUPLICATE_HAMMING"],
    ["a findingCap of 0", { findingCap: 0 }, "findingCap"],
    ["a non-integer findingCap", { findingCap: 2.5 }, "findingCap"],
    ["an unknown top-level key", { extra: 1 }, "extra"],
  ];
  for (const [what, raw, path] of cases) {
    it(`refuses ${what}, naming ${path}`, () => {
      const error = refusal(raw);
      expect(error.path).toBe(path);
      expect(error.message).toContain(path);
    });
  }

  it("refuses a crossed pair on effective values, naming both thresholds", () => {
    // TITLE_MIN 70 against TITLE_MAX's default of 60.
    const error = refusal({ thresholds: { TITLE_MIN: 70 } });
    expect(error.path).toBe("thresholds.TITLE_MIN");
    expect(error.message).toContain("TITLE_MIN");
    expect(error.message).toContain("TITLE_MAX");
    expect(error.reason).toBe("invalid");
    // The maximum moved under the default minimum is the same refusal, at the
    // threshold that was moved.
    expect(refusal({ thresholds: { TITLE_MAX: 30 } }).path).toBe("thresholds.TITLE_MAX");
    // Equal is crossed: the minimum must be strictly below the maximum.
    expect(refusal({ thresholds: { META_PX_MIN: 500, META_PX_MAX: 500 } }).path).toBe(
      "thresholds.META_PX_MIN",
    );
    // And moving both consistently is fine.
    expect(parseJudgement({ thresholds: { TITLE_MIN: 70, TITLE_MAX: 90 } }, reg)).toEqual({
      thresholds: { TITLE_MIN: 70, TITLE_MAX: 90 },
    });
  });

  it("refuses something that is not an object at all", () => {
    for (const bad of [null, [], "rules", 3]) {
      expect(() => parseJudgement(bad, reg), JSON.stringify(bad)).toThrow(JudgementError);
    }
  });

  it("tells an unknown rule apart from an invalid block by reason, not by message", () => {
    expect(refusal({ rules: { "nope.rule": { disabled: true } } }).reason).toBe("unknown-rule");
    expect(refusal({ rules: { "site.health": { disabled: true } } }).reason).toBe("invalid");
    expect(refusal({ thresholds: { SLOW_MS: 99 } }).reason).toBe("invalid");
  });
});

describe("thresholds", () => {
  it("defaults to the constants in thresholds.ts", () => {
    expect(effectiveThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(DEFAULT_THRESHOLDS.SLOW_MS).toBe(SLOW_MS);
    expect(DEFAULT_THRESHOLDS.THIN_WORDS).toBe(THIN_WORDS);
    expect(DEFAULT_THRESHOLDS.DEEP_DEPTH).toBe(DEEP_DEPTH);
    expect(DEFAULT_THRESHOLDS.TITLE_MAX).toBe(TITLE_MAX);
  });

  it("lists every overridable threshold with its default inside its own range", () => {
    expect(Object.keys(OVERRIDABLE_THRESHOLDS).sort()).toEqual(
      [
        "TITLE_MIN", "TITLE_MAX", "META_MIN", "META_MAX", "H1_MAX", "H2_MAX", "URL_MAX",
        "SLOW_MS", "TITLE_PX_MIN", "TITLE_PX_MAX", "META_PX_MIN", "META_PX_MAX",
        "DEEP_DEPTH", "THIN_WORDS", "SOFT_404_WORDS", "IMAGE_WEIGHT_WARN", "CHAIN_HOPS",
        "HIGH_INTERNAL_OUTLINKS", "HIGH_EXTERNAL_OUTLINKS", "UNAVAILABLE_AFTER_WARN_DAYS",
      ].sort(),
    );
    for (const [name, row] of Object.entries(OVERRIDABLE_THRESHOLDS)) {
      expect(row.default, name).toBeGreaterThanOrEqual(row.min);
      expect(row.default, name).toBeLessThanOrEqual(row.max);
      expect(Number.isInteger(row.default), name).toBe(true);
    }
  });

  it("merges an override over the defaults", () => {
    const eff = effectiveThresholds({ thresholds: { SLOW_MS: 3000 } });
    expect(eff.SLOW_MS).toBe(3000);
    expect(eff.THIN_WORDS).toBe(THIN_WORDS);
  });
});

describe("judgedWithOf", () => {
  it("records the sorted disabled set, the threshold overrides and the cap", () => {
    const block: JudgementBlock = {
      rules: {
        "title.too-short": { disabled: true },
        "title.too-long": { disabled: true, priority: "low" },
        "meta.missing": { type: "issue" },
      },
      thresholds: { SLOW_MS: 2000 },
    };
    expect(judgedWithOf(block, 50)).toEqual({
      disabledRules: ["title.too-long", "title.too-short"],
      thresholds: { SLOW_MS: 2000 },
      findingCap: 50,
    });
  });

  it("leaves findingCap absent when the engine default applies, and keeps null", () => {
    expect("findingCap" in judgedWithOf(null, undefined)).toBe(false);
    expect(judgedWithOf(null, undefined)).toEqual({ disabledRules: [], thresholds: {} });
    expect(judgedWithOf(null, null)).toEqual({ disabledRules: [], thresholds: {}, findingCap: null });
  });
});

describe("staleReasons", () => {
  const base: JudgedWith = { disabledRules: ["a.rule"], thresholds: { SLOW_MS: 2000 }, findingCap: 50 };

  it("is empty when nothing differs", () => {
    expect(staleReasons(base, { ...base })).toEqual([]);
  });

  it("names overrides when the disabled set changed", () => {
    expect(staleReasons({ ...base, disabledRules: ["a.rule", "b.rule"] }, base)).toEqual(["overrides"]);
  });

  it("names thresholds and findingCap, sorted, when both changed", () => {
    expect(staleReasons({ ...base, thresholds: { SLOW_MS: 2500 }, findingCap: 60 }, base)).toEqual([
      "findingCap",
      "thresholds",
    ]);
  });

  it("tells an absent findingCap (the default) from null (uncapped)", () => {
    const { findingCap: _, ...absent } = base;
    expect(staleReasons(absent, { ...base, findingCap: null })).toEqual(["findingCap"]);
  });

  it("compares what the run would judge with, not how it was spelled", () => {
    // An override naming the default is the default, and naming the engine's
    // default cap is the same budget as omitting it (resolveRuleCaps).
    expect(
      staleReasons(
        { disabledRules: [], thresholds: { SLOW_MS }, findingCap: URL_FINDING_CAP },
        { disabledRules: [], thresholds: {} },
      ),
    ).toEqual([]);
  });
});

describe("readStoredJudgement", () => {
  it("keeps null as null and parses anything else", () => {
    expect(readStoredJudgement(null, "crawl_x", reg)).toBeNull();
    expect(readStoredJudgement({ thresholds: { SLOW_MS: 2000 } }, "crawl_x", reg)).toEqual({
      thresholds: { SLOW_MS: 2000 },
    });
  });

  it("throws naming the crawl and the removed rule, keeping the reason and path", () => {
    let caught: unknown;
    try {
      readStoredJudgement({ rules: { "gone.rule": { disabled: true } } }, "crawl_x", reg);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JudgementError);
    const error = caught as JudgementError;
    expect(error.message).toContain("crawl_x");
    expect(error.message).toContain("gone.rule");
    expect(error.reason).toBe("unknown-rule");
    expect(error.path).toBe("rules.gone.rule");
  });

  it("throws naming the crawl on a malformed block, never reading it as no overrides", () => {
    for (const bad of ["", [], { rules: "all" }]) {
      expect(() => readStoredJudgement(bad, "crawl_y", reg), JSON.stringify(bad)).toThrow(/crawl_y/);
    }
  });

  it("refuses a stored findingCap, which lives in config_jsonb.findingCap", () => {
    expect(() => readStoredJudgement({ findingCap: 5 }, "crawl_z", reg)).toThrow(/crawl_z.*findingCap/);
  });
});

describe("readStamp", () => {
  it("reads a stamp back", () => {
    const stamp = { disabledRules: ["a.rule"], thresholds: { SLOW_MS: 2000 }, findingCap: null };
    expect(readStamp(stamp, "crawl_x")).toEqual(stamp);
    expect(readStamp({ disabledRules: [], thresholds: {} }, "crawl_x")).toEqual({
      disabledRules: [],
      thresholds: {},
    });
  });

  it("throws naming the crawl on a missing or malformed stamp", () => {
    for (const bad of [
      null,
      {},
      { disabledRules: [], thresholds: {}, extra: 1 },
      { disabledRules: [], thresholds: { NOT_A_THRESHOLD: 1 } },
      { disabledRules: [], thresholds: {}, findingCap: 0 },
    ]) {
      expect(() => readStamp(bad, "crawl_s"), JSON.stringify(bad)).toThrow(/crawl_s/);
    }
  });
});

/**
 * The triage a synthetic rule is registered with (the run.test.ts pattern): the
 * real table has no row for a rule that never ships.
 */
const syntheticTriage =
  (id: string): TriageLookup =>
  (ruleId) =>
    ruleId === id ? { type: "warning", priority: "low" } : triageRow(ruleId);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  return url;
}

const SITE = "https://judgement.example";

function queryRule(id: string): QueryRule {
  const found = linkGraphRules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule '${id}'`);
  return found;
}

describe("runRules stamps what it judged with", () => {
  let db: Db;
  const created: string[] = [];

  async function newCrawl(config: Record<string, unknown>, judgement: unknown): Promise<string> {
    const id = `crawl_${randomUUID()}`;
    await db.insert(crawls).values({
      id,
      siteUrl: SITE,
      config: { maxPages: 100, userAgent: "AriadneBot-test", ...config },
      judgement,
      discovery: mkDiscovery(),
      rulesetVersion: "test",
      status: "finished",
      pagesCrawled: 3,
    });
    created.push(id);
    await db.insert(pages).values([
      mkPage({
        id: `page_${randomUUID()}`,
        crawlId: id,
        url: `${SITE}/`,
        urlNormalised: SITE,
        depth: 0,
        discoveredVia: "seed",
      }),
      ...[1, 2, 3].map((i) => {
        const url = `${SITE}/o/${String(i)}`;
        return mkPage({
          id: `page_${randomUUID()}`,
          crawlId: id,
          url,
          urlNormalised: url,
          canonicalHtml: url,
          title: `An orphan page about ${String(i)}`,
          metaDescription: `${CLEAN_META} About ${String(i)}.`,
        });
      }),
    ]);
    return id;
  }

  async function stampOf(crawlId: string) {
    const [row] = await db
      .select({ at: crawls.rulesRunAt, stamp: crawls.rulesJudgedWith })
      .from(crawls)
      .where(eq(crawls.id, crawlId));
    if (row === undefined) throw new Error(`no crawl row for ${crawlId}`);
    return row;
  }

  function orphanRegistry(): Registry {
    const r = new Registry();
    r.register(queryRule("links.orphan"));
    return r;
  }

  beforeAll(async () => {
    db = createDb(databaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of created) await db.delete(crawls).where(eq(crawls.id, id));
    await closeDb(db);
  });

  it("writes judgedWithOf(block, the cap it used) beside rules_run_at", async () => {
    const block: JudgementBlock = {
      rules: { "links.orphan": { disabled: true } },
      thresholds: { SLOW_MS: 2000 },
    };
    const crawlId = await newCrawl({ findingCap: 2 }, block);

    const summary = await runRules(db, crawlId, orphanRegistry());
    // A disabled rule still runs and stores its findings (read-time filter).
    expect(summary.byRule["links.orphan"]).toBe(2);

    const { at, stamp } = await stampOf(crawlId);
    expect(at).not.toBeNull();
    expect(stamp).toEqual(judgedWithOf(block, 2));
    expect(stamp).toEqual({ disabledRules: ["links.orphan"], thresholds: { SLOW_MS: 2000 }, findingCap: 2 });
  });

  it("stamps the cap this call stated over the crawl's own, and no cap when neither chose", async () => {
    const stated = await newCrawl({ findingCap: 2 }, null);
    await runRules(db, stated, orphanRegistry(), { findingCap: null });
    expect((await stampOf(stated)).stamp).toEqual({ disabledRules: [], thresholds: {}, findingCap: null });

    const defaulted = await newCrawl({}, null);
    await runRules(db, defaulted, orphanRegistry());
    const { stamp } = await stampOf(defaulted);
    expect(stamp).toEqual({ disabledRules: [], thresholds: {} });
    expect(stamp !== null && typeof stamp === "object" && "findingCap" in stamp).toBe(false);
  });

  it("refuses to judge a crawl whose stored block cannot be read, before touching its judgement", async () => {
    const crawlId = await newCrawl({}, null);
    // A complete earlier judgement.
    await runRules(db, crawlId, orphanRegistry());
    const before = await stampOf(crawlId);
    expect(before.at).not.toBeNull();

    // `title.too-long` is not in this registry: to the run it is a removed rule.
    await db
      .update(crawls)
      .set({ judgement: { rules: { "title.too-long": { disabled: true } } } })
      .where(eq(crawls.id, crawlId));
    await expect(runRules(db, crawlId, orphanRegistry())).rejects.toThrow(
      new RegExp(`${crawlId}.*title\\.too-long`),
    );
    // Refused up front: the previous judgement and its stamp are untouched.
    expect(await stampOf(crawlId)).toEqual(before);
  });

  it("nulls the stamp with rules_run_at when a run dies part-way", async () => {
    const crawlId = await newCrawl({ findingCap: 2 }, null);
    await runRules(db, crawlId, orphanRegistry());
    expect((await stampOf(crawlId)).stamp).not.toBeNull();

    const exploding: RuleDefinition<PageRule> = {
      kind: "page",
      id: "test.exploding-judgement",
      checkIds: ["CHECK-01"],
      category: "technical",
      severity: "info",
      title: "Exploding test rule",
      explanation: "A rule that throws, so the stamp's failure path can be observed.",
      howToFix: "Do not ship it.",
      rulesetVersion: RULESET_VERSION,
      columns: [],
      run: () => {
        throw new Error("boom");
      },
    };
    const registry = new Registry(syntheticTriage(exploding.id));
    registry.register(exploding);

    await expect(runRules(db, crawlId, registry)).rejects.toThrow(/test\.exploding-judgement/);
    expect(await stampOf(crawlId)).toEqual({ at: null, stamp: null });
  });
});
