import type { NotMeasured } from "../../api/overview.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type AnyRule,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";

const LIST_MODE: RuleIdentity = { id: "crawl.list-mode", severity: "info" };

/** Why a list crawl did not measure a rule, as the read surfaces' `notMeasured` states it. */
const LIST_REASON_SPIDER = "a list crawl follows no links, so this rule's evidence was not gathered";
const LIST_REASON_SITEMAPS = "a list crawl read no sitemap, so this rule's evidence was not gathered";

/**
 * What a crawl's own row says about list mode: the crawl's mode, and whether a
 * sitemap was read. Read ONCE per run, by `runRules` (`readListScope`).
 */
export interface ListScope {
  mode: "spider" | "list";
  /** Meaningful on a list crawl only; always true on a spider crawl. */
  sitemapsRead: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `crawls.config_jsonb.mode` and `crawls.discovery_jsonb.sitemapsRead`, as the
 * crawl loop stored them (27c T6). A mode absent is `spider`; a `sitemapsRead`
 * absent is true (a crawl written before 27c always read its sitemaps). A value
 * of any other shape throws naming the crawl, rather than being read as a
 * default: read as `spider`, a list crawl would be judged by rules that need a
 * link graph it does not have (hard rule 7).
 *
 * `sitemapsRead` is read for a list crawl only — a spider crawl always reads its
 * sitemaps, and its discovery blob may legitimately be null.
 */
export function readListScope(config: unknown, discovery: unknown, crawlId: string): ListScope {
  if (!isRecord(config)) throw new Error(`crawl ${crawlId}: stored config is not an object`);
  const mode = config["mode"];
  if (mode === undefined || mode === "spider") return { mode: "spider", sitemapsRead: true };
  if (mode !== "list") {
    throw new Error(`crawl ${crawlId}: stored config.mode is not "spider" or "list"`);
  }
  if (!isRecord(discovery)) {
    throw new Error(
      `crawl ${crawlId}: a list crawl's discovery evidence is not an object, so whether a sitemap was read is unknown`,
    );
  }
  const read = discovery["sitemapsRead"];
  if (read !== undefined && typeof read !== "boolean") {
    throw new Error(`crawl ${crawlId}: stored discovery.sitemapsRead is not a boolean`);
  }
  return { mode: "list", sitemapsRead: read ?? true };
}

/**
 * The ids a list crawl does not measure, sorted: every `needsSpider` rule, and
 * every `needsSitemaps` rule when no sitemap was read.
 */
export function listModeSkips(rules: readonly AnyRule[], sitemapsRead: boolean): string[] {
  return rules.filter((r) => skipsOnList(r, sitemapsRead)).map((r) => r.id).sort();
}

/**
 * The rules a rules run of this crawl leaves out for list mode, as `{id, reason}` sorted by id: what
 * `runRules` skips and `crawl.list-mode` names, from the same two functions
 * (`readListScope` over the stored row, then `listModeSkips`), so the read
 * surfaces and the run cannot disagree. `[]` on a spider crawl. Throws, as
 * `readListScope` does, on a stored mode or `sitemapsRead` of the wrong shape.
 * The read surfaces' `notMeasured` (27c final wave M16).
 */
export function listModeNotMeasured(
  rules: readonly AnyRule[],
  config: unknown,
  discovery: unknown,
  crawlId: string,
): NotMeasured {
  const scope = readListScope(config, discovery, crawlId);
  if (scope.mode !== "list") return [];
  return rules
    .filter((r) => skipsOnList(r, scope.sitemapsRead))
    .map((r) => ({
      id: r.id,
      reason: r.needsSpider === true ? LIST_REASON_SPIDER : LIST_REASON_SITEMAPS,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The ids that run on a list crawl but judge only the targets the list fetched, sorted. */
export function listModePartials(rules: readonly AnyRule[]): string[] {
  return rules.filter((r) => r.listPartial === true).map((r) => r.id).sort();
}

/** Whether a list crawl leaves this rule out. */
export function skipsOnList(rule: AnyRule, sitemapsRead: boolean): boolean {
  return rule.needsSpider === true || (rule.needsSitemaps === true && !sitemapsRead);
}

export const listModeRules: QueryRule[] = [
  // Fires on a list crawl and nowhere else, one site-scoped finding. The skip
  // list is the run's own (`JudgementContext.listMode`, built by `runRules` from
  // the registry it is driving), so the finding names what THIS run left out.
  // A call without that context is a spider crawl's call and finds nothing.
  defineRule<QueryRule>({
    kind: "query",
    id: LIST_MODE.id,
    checkIds: ["CHECK-83"],
    category: "links",
    severity: LIST_MODE.severity,
    columns: [
      { key: "notMeasured", label: "Not Measured" },
      { key: "partiallyMeasured", label: "Partially Measured" },
      { key: "sitemapsRead", label: "Sitemaps Read" },
    ],
    ...copyFor(LIST_MODE.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This is a list crawl: it fetched only the URLs it was given and followed no link, so every check that needs the whole site, and without a sitemap read every sitemap check, was not run, and the target checks were judged only against URLs it fetched; crawl the site to measure them.",
    run: async (_db, _crawlId, _caps, ctx): Promise<Finding[]> => {
      const list = ctx?.listMode;
      if (list === undefined) return [];
      return [
        queryFinding(LIST_MODE, {
          pageId: null,
          pageUrl: null,
          evidence: {
            notMeasured: [...list.notMeasured],
            partiallyMeasured: [...list.partiallyMeasured],
            sitemapsRead: list.sitemapsRead,
          },
          dedupeKey: "site",
        }),
      ];
    },
  }),
];
