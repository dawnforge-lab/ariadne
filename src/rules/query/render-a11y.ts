/**
 * The accessibility rules (CHECK-89) and the render family's NOT MEASURED
 * marker (CHECK-49, CHECK-51, CHECK-89).
 *
 *  - `a11y.<axe-id>`, one per row of `A11Y_RULES` (src/crawl/render/a11y.ts),
 *    24 in all: a rendered page whose pinned axe-core run reported that rule
 *    violated. Severity from the table (axe's declared impact: critical or
 *    serious is `warning`, moderate or minor is `info`); `issue` / `low`.
 *  - `render.not-recorded` (info): the crawl rendered pages whose console,
 *    images or accessibility were never captured (ruling R4).
 *
 * THE RULES ARE GENERATED, NEVER LISTED. `renderA11yRules` maps `A11Y_RULES`
 * through `defineRule`, so the axe subset the renderer runs and the rules that
 * read its rows are one list: a row added to the table is a rule, and a rule
 * with no copy or triage row fails registry load, by name. The copy is per rule
 * (src/rules/registry/copy/issue-copy.ts) because each describes its own
 * WCAG success criterion; the triage rows are generated from the same table.
 *
 * **WHICH ROWS: `render_a11y` rows of pages whose `render_a11y_status` is
 * `ran`.** Only a finished run says what the page violates, and only there does
 * "no row" mean "not violated". The writer replaces a page's rows on every
 * render, so a row on a page in any other status should not exist; if one does
 * it is stale, and it is never read. Nothing fetches (hard rule 2): the browser
 * ran axe once, these read what it found.
 *
 * **A ROW IN THE WRONG SHAPE THROWS**, naming the rule, the crawl and the page
 * (hard rule 7): an `axe_rule` outside `A11Y_RULES` (`assertKnownAxeRules`, which
 * every rule runs, because no rule's own query would ever select it), a
 * `node_count` below one (axe never reports a violation with no element, and
 * `shapeAxeResults` refuses one), or `targets` that are not an array of at most
 * `A11Y_TARGETS_MAX` strings. The render writer is the only writer of the table;
 * a row in another shape is one this engine did not write, and a rule that
 * skipped it would report the page as clean.
 *
 * **SQL KEYED BY `axe_rule`**, the `(crawl_id, axe_rule)` index, joined to its
 * page and keyset-paged by URL in batches of `A11Y_BATCH`: RAM is the batch,
 * never the crawl's rows (hard rule 3's spirit; the memory contract).
 *
 * **THE MARKER (`render.not-recorded`, ruling R4).** One crawl-level finding
 * when any RENDERED page (`rendered = true`) lacks a family:
 *  - `consoleNotCaptured`: `render_console` is null (a render before Phase 25);
 *  - `capturedBeforeImagesAndA11y`: `render_version` is null or below 3, so
 *    neither `render_images` nor an accessibility run exists;
 *  - `accessibilityDisabled`: the crawl's `renderAccessibility` was false;
 *  - `accessibilityIncomplete`: the run timed out, was interrupted or errored
 *    (controller ruling: `error` is incomplete too — the page made axe throw,
 *    and what it would have found is unknown);
 *  - `imageFetchOff`: the crawl was started with `fetchResources: false`, so
 *    no image was ever sized (29b final review F4);
 *  - `imagesNeverSized`: `ok` image rows in `resources` with neither a `width`
 *    nor a `dimensions_reason` — rows the resource pass asked about before it
 *    read sizes (a crawl from before 29b, rendered again) (F4).
 * THE LAST TWO ARE THE IMAGE FAMILY'S OTHER SILENCE. The renderer answers an
 * image request with a stand-in only when the resource pass stored its size;
 * every other `<img>` lands in `noDimensions` on a capture-3 page with a
 * perfectly good `render_images`, so the version count above cannot see it and
 * `images.larger-than-displayed` cannot fire (hard rule 1). A 29b crawl whose
 * image rows all carry a size or a reason, or that has none, is silent here.
 * `families` names the families those counts leave unanswered. A crawl with no
 * rendered page is SILENT: `render.coverage` already says nothing was rendered,
 * and firing here on every unrendered crawl would add no fact. A rendered
 * capture-3 page with no accessibility status or no image capture is a row the
 * render writer never writes, and throws.
 */
import { sql } from "drizzle-orm";

import {
  A11Y_RULES,
  A11Y_TARGETS_MAX,
  type A11yRuleRow,
} from "../../crawl/render/a11y.js";
import { RESOURCE_OK_CLASS } from "../../crawl/resources/fetch-resources.js";
import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import {
  assertCrawl,
  capsOr,
  noteTruncation,
  readStoredFetchResources,
} from "./crawl-evidence.js";

const NOT_RECORDED: RuleIdentity = { id: "render.not-recorded", severity: "info" };

/** The rule id of one row of the subset. */
export const a11yRuleId = (row: A11yRuleRow): string => `a11y.${row.axeId}`;

/**
 * The first render capture with `render_images` and the accessibility run.
 * Written as a literal on purpose, as in render-images.ts: a later capture bump
 * must not silently change what the marker counts as captured.
 */
const FIRST_A11Y_CAPTURE = 3;

/** The statuses a finished-or-not accessibility run is recorded with. */
const INCOMPLETE = ["timeout", "interrupted", "error"] as const;
const KNOWN_STATUSES = ["ran", "disabled", ...INCOMPLETE] as const;

/**
 * Rows read per round trip. Exported so a test can force the cursor to iterate
 * without hardcoding the number.
 */
export const A11Y_BATCH = 200;

/** The axe ids of the subset, as SQL parameters. */
const SUBSET_SQL = sql.join(
  A11Y_RULES.map((r) => sql`${r.axeId}`),
  sql`, `,
);

/** A refusal naming the rule, the crawl and the page (hard rule 7). */
function refuse(ruleId: string, crawlId: string, url: string, why: string): never {
  throw new Error(
    `${ruleId}: crawl '${crawlId}', page '${url}': a render_a11y row ${why}; the render ` +
      "pass is the only writer of this table, so the row is one this engine did not " +
      "write, and skipping it would report the page as clean",
  );
}

/**
 * Throw on any `render_a11y` row, on a page whose run finished, whose
 * `axe_rule` is outside the subset. No rule's own query selects such a row
 * (each is keyed by its own axe id), so without this it would be read by
 * nobody — a violation the renderer stored and no rule reports.
 */
async function assertKnownAxeRules(db: Db, crawlId: string, ruleId: string): Promise<void> {
  const res = await db.execute<{ url: string; axe_rule: string }>(sql`
    select p.url, a.axe_rule
    from render_a11y a
    join pages p on p.crawl_id = a.crawl_id and p.id = a.page_id
    where a.crawl_id = ${crawlId}
      and p.render_a11y_status = 'ran'
      and a.axe_rule not in (${SUBSET_SQL})
    order by p.url, a.axe_rule
    limit 1`);
  const row = res.rows[0];
  if (row !== undefined) {
    refuse(ruleId, crawlId, row.url, `names axe rule '${row.axe_rule}', which is outside A11Y_RULES`);
  }
}

/** The validated fields of one row. */
interface A11yRowFacts {
  impact: string | null;
  nodeCount: number;
  targets: string[];
}

function readRow(
  row: { url: string; impact: unknown; node_count: unknown; targets: unknown },
  ruleId: string,
  crawlId: string,
): A11yRowFacts {
  const { node_count: nodeCount, impact, targets } = row;
  if (typeof nodeCount !== "number" || !Number.isInteger(nodeCount) || nodeCount < 1) {
    refuse(ruleId, crawlId, row.url, `has node_count ${String(nodeCount)}, not a count of one or more`);
  }
  if (impact !== null && typeof impact !== "string") {
    refuse(ruleId, crawlId, row.url, "has an impact that is neither text nor null");
  }
  if (
    !Array.isArray(targets) ||
    targets.length > A11Y_TARGETS_MAX ||
    !targets.every((t) => typeof t === "string")
  ) {
    refuse(
      ruleId,
      crawlId,
      row.url,
      `has targets that are not an array of at most ${A11Y_TARGETS_MAX} selectors`,
    );
  }
  return { impact, nodeCount, targets: targets as string[] };
}

async function a11yFindings(
  row: A11yRuleRow,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const self: RuleIdentity = { id: a11yRuleId(row), severity: row.severity };
  // A crawl id nothing knows scans no rows, which reads exactly like a clean
  // site (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, self.id);
  await assertKnownAxeRules(db, crawlId, self.id);

  const findings: Finding[] = [];
  let total = 0;
  let cursor = "";
  for (;;) {
    const res = await db.execute<{
      page_id: string;
      url: string;
      page_type: string | null;
      impact: unknown;
      node_count: unknown;
      targets: unknown;
    }>(sql`
      select a.page_id, p.url, p.page_type, a.impact, a.node_count, a.targets
      from render_a11y a
      join pages p on p.crawl_id = a.crawl_id and p.id = a.page_id
      where a.crawl_id = ${crawlId}
        and a.axe_rule = ${row.axeId}
        and p.render_a11y_status = 'ran'
        and p.url > ${cursor}
      order by p.url
      limit ${A11Y_BATCH}`);
    if (res.rows.length === 0) break;
    cursor = res.rows[res.rows.length - 1]!.url;

    for (const r of res.rows) {
      const facts = readRow(r, self.id, crawlId);
      total += 1;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(self, {
          pageId: r.page_id,
          pageUrl: r.url,
          evidence: {
            template: r.page_type,
            impact: facts.impact,
            nodeCount: facts.nodeCount,
            targets: facts.targets,
            wcag: row.wcag,
          },
          dedupeKey: r.url,
        }),
      );
    }
    if (res.rows.length < A11Y_BATCH) break;
  }
  return noteTruncation(findings, total);
}

/** The families a rendered page can lack, in the order the marker names them. */
type Family = "console" | "images" | "accessibility";

async function notRecordedFindings(db: Db, crawlId: string): Promise<Finding[]> {
  const self = NOT_RECORDED;
  // The existence gate, and whether the crawl asked about its files at all.
  const fetchResources = await readStoredFetchResources(db, crawlId, self.id);

  const known = sql.join(
    KNOWN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const incomplete = sql.join(
    INCOMPLETE.map((s) => sql`${s}`),
    sql`, `,
  );
  // One aggregate over the crawl's rendered pages; `pages_crawl_url` leads on
  // `crawl_id`, and nothing per page reaches memory.
  const res = await db.execute<{
    rendered_pages: number;
    console_not_captured: number;
    before_capture: number;
    disabled: number;
    incomplete: number;
    unwritten_url: string | null;
  }>(sql`
    select
      count(*)::int as rendered_pages,
      count(*) filter (where p.render_console is null)::int as console_not_captured,
      count(*) filter (
        where p.render_version is null or p.render_version < ${FIRST_A11Y_CAPTURE}
      )::int as before_capture,
      count(*) filter (where p.render_a11y_status = 'disabled')::int as disabled,
      count(*) filter (where p.render_a11y_status in (${incomplete}))::int as incomplete,
      min(p.url) filter (
        where p.render_version >= ${FIRST_A11Y_CAPTURE}
          and (p.render_a11y_status is null
               or p.render_a11y_status not in (${known})
               or p.render_images is null)
      ) as unwritten_url
    from pages p
    where p.crawl_id = ${crawlId} and p.rendered = true`);
  // An aggregate with no `group by` always answers one row: none is a broken
  // query or driver, never an empty crawl (hard rule 7).
  const row = res.rows[0];
  if (row === undefined) throw new Error(`${self.id}: aggregate returned no row`);
  if (row.unwritten_url !== null) {
    throw new Error(
      `${self.id}: crawl '${crawlId}', page '${row.unwritten_url}': a rendered page of capture ` +
        `${FIRST_A11Y_CAPTURE} or later has no image capture or no known accessibility status; ` +
        "the render writer always writes both, so the row is one this engine did not write",
    );
  }

  // R4: a crawl with no rendered page is `render.coverage`'s subject.
  if (row.rendered_pages === 0) return [];

  // F4: image rows the pass asked about and never sized. `width` and
  // `dimensions_reason` are written together on every `ok` image row since
  // 29b (`imageDimensions`, fetch-resources.ts), so both null is a row asked
  // before sizing existed. One aggregate over the crawl's rows.
  const sizing = await db.execute<{ never_sized: number }>(sql`
    select count(*)::int as never_sized
    from resources r
    where r.crawl_id = ${crawlId}
      and r.kind = 'image'
      and r.fetch_class = ${RESOURCE_OK_CLASS}
      and r.width is null
      and r.dimensions_reason is null`);
  const neverSized = sizing.rows[0]?.never_sized;
  if (neverSized === undefined) throw new Error(`${self.id}: image sizing aggregate returned no row`);
  const imageFetchOff = !fetchResources;

  const families: Family[] = [];
  if (row.console_not_captured > 0) families.push("console");
  if (row.before_capture > 0 || imageFetchOff || neverSized > 0) families.push("images");
  if (row.before_capture > 0 || row.disabled > 0 || row.incomplete > 0) {
    families.push("accessibility");
  }
  if (families.length === 0) return [];

  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: {
        renderedPages: row.rendered_pages,
        consoleNotCaptured: row.console_not_captured,
        capturedBeforeImagesAndA11y: row.before_capture,
        accessibilityDisabled: row.disabled,
        accessibilityIncomplete: row.incomplete,
        imageFetchOff,
        imagesNeverSized: neverSized,
        families,
      },
      dedupeKey: "site",
    }),
  ];
}

export const renderA11yRules: QueryRule[] = [
  ...A11Y_RULES.map((row) =>
    defineRule<QueryRule>({
      kind: "query",
      id: a11yRuleId(row),
      checkIds: ["CHECK-89"],
      category: "accessibility",
      severity: row.severity,
      columns: [
        { key: "template", label: "Template" },
        { key: "impact", label: "Impact" },
        { key: "nodeCount", label: "Elements" },
        { key: "targets", label: "Selectors" },
        { key: "wcag", label: "WCAG Level" },
      ],
      ...copyFor(a11yRuleId(row)),
      rulesetVersion: RULESET_VERSION,
      run: (db, crawlId, caps) => a11yFindings(row, db, crawlId, capsOr(caps)),
    }),
  ),
  defineRule<QueryRule>({
    kind: "query",
    id: NOT_RECORDED.id,
    checkIds: ["CHECK-49", "CHECK-51", "CHECK-89"],
    category: "crawl",
    severity: NOT_RECORDED.severity,
    columns: [
      { key: "renderedPages", label: "Rendered Pages" },
      { key: "consoleNotCaptured", label: "Console Not Recorded" },
      { key: "capturedBeforeImagesAndA11y", label: "Images and Accessibility Not Recorded" },
      { key: "accessibilityDisabled", label: "Accessibility Turned Off" },
      { key: "accessibilityIncomplete", label: "Accessibility Unfinished" },
      { key: "imageFetchOff", label: "Image Files Not Fetched" },
      { key: "imagesNeverSized", label: "Images Never Sized" },
      { key: "families", label: "Checks Not Run" },
    ],
    ...copyFor(NOT_RECORDED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "Some rendered pages were captured before the console, image or accessibility checks were recorded, with the accessibility check turned off or unfinished, or on a crawl whose image files were never sized (file fetching turned off, or fetched before sizes were read), so those checks were not run on them; re-crawl the site with file fetching and accessibility checking turned on.",
    run: (db, crawlId) => notRecordedFindings(db, crawlId),
  }),
];
