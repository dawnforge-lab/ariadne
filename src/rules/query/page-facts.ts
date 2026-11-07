/**
 * The v2 page-fact gate and its NOT MEASURED marker (Phase 26b).
 *
 * Extraction version 2 records page facts the crawler did not extract before
 * (social tags, `<html lang>`, anchor counts, document structure, ...). A crawl
 * written below version 2 carries none of them, and a rule cannot tell that null
 * from "the page has none". Every query rule on a v2 fact therefore opens with
 * `v2Gate` and returns nothing when the crawl is not wholly recorded; the one
 * rule in this file, `extraction.not-recorded`, speaks for all of them, so an old
 * crawl reads "not measured" and never "pass" (hard rules 1 and 7). A MIXED crawl
 * is refused whole, per `extractionCoverage`'s contract.
 *
 * Page rules cannot refuse a crawl (they see one row); they stay silent on a null
 * column and rely on this marker.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { extractionCoverage, FETCHED_OK, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import { assertCrawl } from "./crawl-evidence.js";

/** The extraction version that introduced the 26b page facts. */
const V2 = 2;

const NOT_RECORDED: RuleIdentity = { id: "extraction.not-recorded", severity: "info" };

/**
 * Whether every page of the crawl was written by extraction version 2 or later.
 * A thin wrapper over `extractionCoverage`; `recorded` is false when any page is
 * below, and the rule that called it returns `[]`.
 */
export async function v2Gate(
  db: Db,
  crawlId: string,
): Promise<{ recorded: boolean; atOrAbove: number; below: number }> {
  const { atOrAbove, below } = await extractionCoverage(db, crawlId, V2);
  return { recorded: below === 0, atOrAbove, below };
}

async function notRecordedFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  await assertCrawl(db, crawlId, self.id);
  const gate = await v2Gate(db, crawlId);
  if (gate.recorded) return [];
  const cohort = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pages p
    where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")}`);
  // A count with no `group by` always answers one row: none is a broken query
  // or driver, never an empty cohort (hard rule 7).
  const row = cohort.rows[0];
  if (row === undefined) throw new Error(`${self.id}: aggregate returned no row`);
  if (row.n === 0) return [];
  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: { pagesNotRecorded: gate.below, pagesRecorded: gate.atOrAbove },
      dedupeKey: "site",
    }),
  ];
}

export const pageFactsRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_RECORDED.id,
    checkIds: [
      "CHECK-04", "CHECK-10", "CHECK-18", "CHECK-22", "CHECK-24", "CHECK-25", "CHECK-34",
      "CHECK-35", "CHECK-36", "CHECK-37", "CHECK-49", "CHECK-85", "CHECK-86", "CHECK-87",
      "CHECK-88",
    ],
    category: "crawl",
    severity: NOT_RECORDED.severity,
    columns: [
      { key: "pagesNotRecorded", label: "Pages Without Version 2 Facts" },
      { key: "pagesRecorded", label: "Pages With Version 2 Facts" },
    ],
    ...copyFor(NOT_RECORDED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl was extracted before the page facts these checks read existed, so they were not run; re-crawl the site.",
    run: (db, crawlId) => notRecordedFindings(NOT_RECORDED, db, crawlId),
  }),
];
