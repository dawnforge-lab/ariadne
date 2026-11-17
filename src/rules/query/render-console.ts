/**
 * The render console rules: what the page's own scripts said and what its
 * requests did while a real browser ran it (CHECK-51).
 *
 *  - `render.js-exception`    an uncaught exception or unhandled rejection (warning)
 *  - `render.console-error`   a message the page logged at the error level (info)
 *  - `render.failed-request`  a request the page made that failed (warning)
 *
 * All three read `pages.render_console`, the capture the render pass writes
 * (`RenderConsole`, src/crawl/render/console-capture.ts). Nothing fetches
 * (hard rule 2) and nothing here re-runs a page: the browser counted once, the
 * rules read the count.
 *
 * **WHICH ROWS: every page whose `render_console` is not null, a failed render
 * included.** Unlike the diff rules (render-diff.ts), which need a finished
 * render to compare anything, these read what the page reported on the way
 * there. A render that timed out after three uncaught exceptions has those
 * three exceptions, and they are the finding. A null `render_console` means the
 * console was not captured (never rendered, an older capture, a render refused
 * before a browser page opened), which is not the same as clean, and no rule
 * here reads it as either: the row is not a candidate.
 *
 * **A VALUE THAT IS NOT A `RenderConsole` THROWS**, naming the crawl and the
 * page (`readConsole`, hard rule 7). The renderer is the only writer of the
 * column; a row in another shape is one this engine did not write, and a rule
 * that skipped it would report the page as clean.
 *
 * **WHAT `render.console-error` CAN AND CANNOT SEE.** It fires when any KEPT
 * `console[]` entry is at level `error`. The capture keeps the first
 * `RENDER_CONSOLE_MAX_ENTRIES` (20) messages of either level and one total
 * across both, with no per-level count. A page whose first 20 messages are all
 * warnings and whose errors come later is therefore NOT detected, and the rule
 * cannot tell it from a page with no errors. `consoleTotal` is in the evidence
 * so a reader sees how much the kept entries are a sample of, and the copy and
 * CHECK-51 say the verdict is "from the first 20 console messages the page
 * logged". Warnings alone never fire.
 *
 * **THE RENDERER'S OWN BLOCKING IS EVIDENCE, NOT AN EXCUSE.** The render pass
 * aborts third-party requests and the site's own images, media and fonts.
 * `blockedByRenderer` carries those counts on the two console rules, because a
 * `gtag is not defined` after the analytics script was refused is an artefact
 * of the measurement, and the copy tells the agent to confirm such an error on
 * the live page before reporting it. Third-party failures are not measured at
 * all: the renderer never sent those requests.
 *
 * The scan is a keyset cursor over `pages` in batches (`CONSOLE_BATCH`): RAM is
 * the batch, never the crawl's blobs (the memory contract).
 */
import { sql } from "drizzle-orm";

import type { RenderConsole } from "../../crawl/render/console-capture.js";
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
import { assertCrawl, capsOr, noteTruncation } from "./crawl-evidence.js";

const JS_EXCEPTION: RuleIdentity = { id: "render.js-exception", severity: "warning" };
const CONSOLE_ERROR: RuleIdentity = { id: "render.console-error", severity: "info" };
const FAILED_REQUEST: RuleIdentity = { id: "render.failed-request", severity: "warning" };

/**
 * Rows read per round trip. Exported so a test can force the cursor to iterate
 * without hardcoding the number.
 */
export const CONSOLE_BATCH = 200;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a stored `render_console` as a `RenderConsole`, or throw naming the
 * crawl, the page and what is wrong with it. Validate, don't cast (hard rule 7).
 */
function readConsole(value: unknown, ruleId: string, crawlId: string, url: string): RenderConsole {
  const refuse = (why: string): never => {
    throw new Error(
      `${ruleId}: crawl '${crawlId}', page '${url}': render_console is not a RenderConsole ` +
        `(${why}); the render pass is the only writer of this column, so the row is one this ` +
        "engine did not write, and skipping it would report the page as clean",
    );
  };
  if (!isObject(value)) return refuse("not a JSON object");

  const list = (key: string, entry: (e: Record<string, unknown>) => boolean): void => {
    const v = value[key];
    if (!Array.isArray(v)) refuse(`'${key}' is not an array`);
    for (const e of v as unknown[]) {
      if (!isObject(e) || !entry(e)) refuse(`'${key}' holds an entry of the wrong shape`);
    }
  };
  const total = (key: string): void => {
    if (!isCount(value[key])) refuse(`'${key}' is not a non-negative integer`);
  };

  list(
    "console",
    (e) =>
      (e["level"] === "error" || e["level"] === "warning") &&
      typeof e["text"] === "string" &&
      typeof e["cut"] === "boolean",
  );
  total("consoleTotal");
  list("exceptions", (e) => typeof e["text"] === "string" && typeof e["cut"] === "boolean");
  total("exceptionsTotal");
  list(
    "failedRequests",
    (e) =>
      typeof e["url"] === "string" &&
      (e["status"] === null || typeof e["status"] === "number") &&
      typeof e["reason"] === "string" &&
      typeof e["cut"] === "boolean",
  );
  total("failedRequestsTotal");
  const blocked = value["blockedByRenderer"];
  if (
    !isObject(blocked) ||
    !isCount(blocked["thirdParty"]) ||
    !isCount(blocked["sameOriginAssets"])
  ) {
    refuse("'blockedByRenderer' is not { thirdParty, sameOriginAssets } counts");
  }
  return value as unknown as RenderConsole;
}

interface ConsoleRule {
  self: RuleIdentity;
  /** Whether this page's capture is a finding. */
  fires: (c: RenderConsole) => boolean;
  /** The rule's own evidence, beside the fields every rule carries. */
  evidence: (c: RenderConsole) => Record<string, unknown>;
}

async function consoleFindings(
  r: ConsoleRule,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  // A crawl id nothing knows scans no pages, which reads exactly like a clean
  // site (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, r.self.id);

  const findings: Finding[] = [];
  let total = 0;
  let cursor = "";
  for (;;) {
    const res = await db.execute<{
      id: string;
      url: string;
      page_type: string | null;
      rendered: boolean;
      render_console: unknown;
    }>(sql`
      select p.id, p.url, p.page_type, p.rendered, p.render_console
      from pages p
      where p.crawl_id = ${crawlId}
        and p.render_console is not null
        and p.url > ${cursor}
      order by p.url
      limit ${CONSOLE_BATCH}`);
    if (res.rows.length === 0) break;
    cursor = res.rows[res.rows.length - 1]!.url;

    for (const row of res.rows) {
      const c = readConsole(row.render_console, r.self.id, crawlId, row.url);
      if (!r.fires(c)) continue;
      total += 1;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(r.self, {
          pageId: row.id,
          pageUrl: row.url,
          evidence: {
            template: row.page_type,
            rendered: row.rendered,
            ...r.evidence(c),
          },
          dedupeKey: row.url,
        }),
      );
    }
    if (res.rows.length < CONSOLE_BATCH) break;
  }
  return noteTruncation(findings, total);
}

const first = <T>(xs: T[]): T | null => xs[0] ?? null;

const EXCEPTION_RULE: ConsoleRule = {
  self: JS_EXCEPTION,
  fires: (c) => c.exceptionsTotal > 0,
  evidence: (c) => ({
    exceptionsTotal: c.exceptionsTotal,
    exceptions: c.exceptions,
    firstException: first(c.exceptions)?.text ?? null,
    blockedByRenderer: c.blockedByRenderer,
  }),
};

const CONSOLE_ERROR_RULE: ConsoleRule = {
  self: CONSOLE_ERROR,
  fires: (c) => c.console.some((e) => e.level === "error"),
  evidence: (c) => ({
    consoleTotal: c.consoleTotal,
    console: c.console,
    firstError: first(c.console.filter((e) => e.level === "error"))?.text ?? null,
    blockedByRenderer: c.blockedByRenderer,
  }),
};

const FAILED_REQUEST_RULE: ConsoleRule = {
  self: FAILED_REQUEST,
  fires: (c) => c.failedRequestsTotal > 0,
  evidence: (c) => {
    const f = first(c.failedRequests);
    return {
      failedRequestsTotal: c.failedRequestsTotal,
      failedRequests: c.failedRequests,
      firstFailedUrl: f?.url ?? null,
      firstFailedReason: f?.reason ?? null,
    };
  },
};

export const renderConsoleRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: JS_EXCEPTION.id,
    checkIds: ["CHECK-51"],
    category: "technical",
    severity: JS_EXCEPTION.severity,
    columns: [
      { key: "template", label: "Template" },
      { key: "rendered", label: "Render Completed" },
      { key: "exceptionsTotal", label: "Exceptions" },
      { key: "firstException", label: "First Exception" },
      { key: "exceptions", label: "Exceptions Kept" },
      { key: "blockedByRenderer", label: "Blocked By Our Browser" },
    ],
    ...copyFor(JS_EXCEPTION.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => consoleFindings(EXCEPTION_RULE, db, crawlId, capsOr(caps)),
  }),
  defineRule<QueryRule>({
    kind: "query",
    id: CONSOLE_ERROR.id,
    checkIds: ["CHECK-51"],
    category: "technical",
    severity: CONSOLE_ERROR.severity,
    columns: [
      { key: "template", label: "Template" },
      { key: "rendered", label: "Render Completed" },
      { key: "consoleTotal", label: "Console Messages" },
      { key: "firstError", label: "First Error" },
      { key: "console", label: "Messages Kept" },
      { key: "blockedByRenderer", label: "Blocked By Our Browser" },
    ],
    ...copyFor(CONSOLE_ERROR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => consoleFindings(CONSOLE_ERROR_RULE, db, crawlId, capsOr(caps)),
  }),
  defineRule<QueryRule>({
    kind: "query",
    id: FAILED_REQUEST.id,
    checkIds: ["CHECK-51"],
    category: "technical",
    severity: FAILED_REQUEST.severity,
    columns: [
      { key: "template", label: "Template" },
      { key: "rendered", label: "Render Completed" },
      { key: "failedRequestsTotal", label: "Failed Requests" },
      { key: "firstFailedUrl", label: "First Failed URL" },
      { key: "firstFailedReason", label: "Reason" },
      { key: "failedRequests", label: "Requests Kept" },
    ],
    ...copyFor(FAILED_REQUEST.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => consoleFindings(FAILED_REQUEST_RULE, db, crawlId, capsOr(caps)),
  }),
];
