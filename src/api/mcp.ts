/**
 * The MCP transport: twelve tools over the same service layer the HTTP routes
 * use.
 *
 * This is a SECOND TRANSPORT, not a second API. Every tool below is a schema, a
 * description written for an agent, and one call into `ApiService` — there is no
 * SQL in this file, no policy decision, and no copy of a rule's title. When a
 * filter's vocabulary changes in the service, it changes here for free, because
 * the refusal that names the accepted values comes from there.
 *
 * ## Trust model, stated rather than implied
 *
 * **HTTP is token-trust; MCP is process-trust.** `src/api/http.ts` authenticates
 * a network caller with a bearer token because anyone who can reach the port can
 * try. An MCP client on stdio does not reach a port: it either started this
 * process or was handed its pipes, so it is already inside the boundary the
 * token defends. Asking it for a credential this process itself printed would be
 * theatre. See `loadMcpConfig` for the boot-time half of the same argument, and
 * for what changes if this server is ever mounted on a network transport.
 *
 * **The allowlist binds BOTH transports, and it binds them in one place.**
 * `ApiService.startCrawl` checks `allowedDomains` before it spends a URL-policy
 * verdict on the seed, and `checkLegacyHosts` checks every extra host the probe
 * would reach. Neither check is re-implemented here: an agent on stdio is
 * trusted to *ask*, and is no more entitled to point a branded crawler at an
 * arbitrary host than a token holder is (Talos obligation 2). An empty allowlist
 * refuses every crawl trigger and answers every query, exactly as over HTTP.
 *
 * **`crawlDefaults` stays code-level.** `allowPrivate` is not a tool argument at
 * any value: `crawl_start`'s schema is closed, so the field is refused as an
 * unrecognised key before the handler runs, and the handler puts what survives
 * through the same `parseStartCrawlInput` the HTTP route uses — which refuses it
 * again, by name and with the reason. A tool schema is a wire like any other.
 *
 * ## What a tool answers with
 *
 * One text content block holding compact JSON, and nothing else — no prose
 * wrapper, no markdown, no "Here are your results". The consumer is a program
 * that will `JSON.parse` it.
 *
 *  - **Success:** the service's own value, verbatim (`{items, nextCursor}` for
 *    every listing, an object for everything else).
 *  - **A refusal the caller can act on:** `isError: true` and
 *    `{"error": "<the service's message>"}` — the same body the HTTP transport
 *    puts behind a 400/403/404/409, because it is the same sentence.
 *  - **A defect of ours:** `isError: true` and
 *    `{"error": "internal error", "correlationId": "<uuid>"}`. The stack goes to
 *    the log under that id and nowhere else (Talos obligation 6). This is the
 *    tenant-safe discipline `http.ts` applies to a 500, applied to a tool.
 *  - **Arguments that do not fit the tool's schema** are refused by the SDK
 *    before the handler runs, as a tool error whose text is the validator's
 *    message naming the offending field. It is not the `{error}` JSON shape —
 *    it comes from the protocol layer, not from us — and it is still an
 *    `isError` result rather than a silent coercion, which is the property that
 *    matters: an agent that misspells `severity` is told, not handed an
 *    unfiltered listing to read as "these are the critical findings".
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { FETCH_CLASSES } from "../crawl/fetch-page.js";
import { DISCOVERED_VIA } from "../crawl/frontier.js";
import { METRIC_SCOPES } from "../rules/registry/types.js";
import type { ServiceConfig } from "./config.js";
import {
  ApiService,
  EXPORT_DATASETS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  ServiceError,
  parseStartCrawlInput,
} from "./service.js";

/** The metric scopes, as a tool description says them. */
const METRIC_SCOPES_HINT = METRIC_SCOPES.join(" | ");
/** The two closed page vocabularies, from the crawl layer that writes them. */
const FETCH_CLASS_HINT = FETCH_CLASSES.join(" | ");
const DISCOVERED_VIA_HINT = DISCOVERED_VIA.join(" | ");

/**
 * The tools this server advertises, as one list.
 *
 * It exists because the names are an INTERFACE the skills quote by hand
 * (`skills/**` tells an agent to call `crawl_status`, and nothing but a reader's
 * memory connected that sentence to this file). `test/skills/identifier-guard`
 * checks the documentation against this list; a tool renamed here fails there.
 *
 * Both directions are held: `named` types each registration against this list,
 * so a tool registered under a name the list does not carry fails to compile,
 * and `createMcpServer` throws if the list names a tool nobody registered.
 */
export const TOOL_NAMES = [
  "crawl_start",
  "crawl_status",
  "crawl_list",
  "crawl_mark_failed",
  "crawl_render",
  "crawl_rules",
  "robots_get",
  "issues_list",
  "issue_urls",
  "metrics_get",
  "pages_query",
  "export_crawl",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface CreateMcpServerOpts {
  db: Db;
  /**
   * The same policy an HTTP server is built with — an `ApiServerConfig` is
   * accepted here, its token simply unused (see the module header).
   */
  config: ServiceConfig;
}

export interface AriadneMcpServer {
  /** The shared query/command layer. The HTTP transport mounts the same one. */
  service: ApiService;
  server: McpServer;
  /** Attach to a transport (stdio in production, in-memory in the tests). */
  connect(transport: Transport): Promise<void>;
  /** Close the protocol, then stop the crawl queue. */
  close(): Promise<void>;
}

/**
 * How an agent is told to use this server before it reads a single tool
 * description.
 *
 * Kept short and factual: the order of operations, the one pagination shape and
 * the one thing that is a policy rather than a bug (the allowlist). Everything
 * else belongs on the tool that owns it.
 */
const INSTRUCTIONS = `Ariadne is a crawl-and-audit engine. It produces FACTS — crawled pages, rule
findings, measured metrics — and leaves the judgement to you.

The order of operations is fixed by what the evidence means:
  1. crawl_start   accepts a crawl and returns a crawl id immediately. It is
                   queued, not finished; one crawl runs at a time per server.
  2. crawl_status  polls it. Poll until status is no longer 'queued'/'running'.
  3. crawl_render  (optional) re-fetches a sample of pages in a real browser, so
                   client-side-rendered content is measured rather than guessed.
                   Run it BEFORE the rules if you want rendered evidence judged.
  4. crawl_rules   runs every rule over the finished crawl and writes the
                   findings. Refused while the crawl is still moving.
  5. issues_list / issue_urls / metrics_get / pages_query read the results.
                   robots_get reads the robots.txt the crawl obeyed.

An empty findings or metrics answer is only 'nothing found' on a crawl that was
judged. crawl_status's rulesRunAt is the check: a timestamp means a rules pass
completed, null means none is on record.

Every listing answers {items, nextCursor}. Pass nextCursor back as 'cursor',
with the SAME filters, to get the next page; nextCursor null means the listing
ended. Never assume a page is the whole answer.

Crawl targets are restricted to an operator-configured allowlist. A refused
host is policy, not a fault: ask the operator to add the domain rather than
retrying or trying a different spelling of the host.`;

/**
 * Build the MCP server. Nothing is fetched, opened or listened to until
 * `connect` is given a transport.
 */
export function createMcpServer({ db, config }: CreateMcpServerOpts): AriadneMcpServer {
  const service = new ApiService(db, config);
  const log = config.log ?? ((line: string) => console.error(line));
  const server = new McpServer(
    { name: "ariadne", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  /**
   * The one place a tool's answer is shaped, and the one place an error stops.
   *
   * Every handler is `() => service.something()`; the mapping from a thrown
   * `ServiceError` to a tool error, and from anything else to a correlation id,
   * lives here so no tool can forget it (the `http.ts` handler's catch, in the
   * shape MCP calls a result).
   */
  const run = async (tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return json(await fn());
    } catch (error) {
      if (error instanceof ServiceError) return jsonError({ error: error.message });
      const correlationId = randomUUID();
      log(`mcp: internal error ${correlationId} ${tool} — ${stackOf(error)}`);
      return jsonError({ error: "internal error", correlationId });
    }
  };

  /** A tool's name, checked against `TOOL_NAMES` and recorded as registered. */
  const registered = new Set<ToolName>();
  const named = (name: ToolName): ToolName => {
    registered.add(name);
    return name;
  };

  // ------------------------------------------------------------------- crawls

  server.registerTool(
    named("crawl_start"),
    {
      title: "Start a crawl",
      description:
        "Accept a new crawl of a site and return its id immediately. The crawl is " +
        "QUEUED, not finished: poll crawl_status until its status is no longer " +
        "'queued' or 'running'. Answers {crawlId, status, queuePosition}; " +
        "queuePosition 0 means it is starting now.\n\n" +
        "PREREQUISITE: siteUrl's host must be on this server's crawl allowlist, " +
        "which the operator configures (ARIADNE_ALLOWED_DOMAINS). A host that is " +
        "not on it is refused, and so is every legacyHosts entry that is not on " +
        "it — the host probe fetches those before it has read anybody's " +
        "robots.txt. An empty allowlist refuses every crawl while leaving the " +
        "query tools working. Retrying, or spelling the host differently, will " +
        "not help; ask the operator.\n\n" +
        "Politeness is not optional and not a tuning knob for speed: robots.txt " +
        "and its crawl-delay are honoured, the user agent is branded, and " +
        "perHostDelayMs has a floor of 250ms — below it the crawl is refused, " +
        "not slowed. Leave the pacing fields alone unless the site's owner has " +
        "asked for something specific.",
      inputSchema: z.strictObject(crawlStartShape()),
    },
    async (args) => run("crawl_start", () => service.startCrawl(parseStartCrawlInput(args))),
  );

  server.registerTool(
    named("crawl_status"),
    {
      title: "Crawl status",
      description:
        "One crawl in full: status, siteUrl, timings, pagesCrawled, the frontier " +
        "counts (queued/leased/done/failed), the ruleset version it was judged " +
        "with, queuePosition, liveLeases, blockedPages, hostSpacingMs, " +
        "legacyHosts, rulesRunAt and findingsCount.\n\n" +
        "IS THIS CRAWL JUDGED? rulesRunAt is the answer and the only one: it is " +
        "the timestamp of the last COMPLETED crawl_rules pass, and null means no " +
        "complete pass is on record — never judged, being judged right now, or " +
        "judged by a run that died part-way. Check it before you read anything " +
        "into an empty findings or metrics answer: findingsCount 0 with rulesRunAt " +
        "null is 'nobody has looked', and findingsCount 0 with a timestamp is " +
        "'looked, found nothing'. findingsCount is the live number of issue rows, " +
        "which is what issues_list's groups sum to.\n\n" +
        "legacyHosts echoes the domains this crawl was told the site used to live " +
        "on (empty when none were named) — the host-probe findings about legacy " +
        "redirects mean nothing without it: no finding on an empty list is 'the " +
        "crawl was never given a legacy domain', not 'the redirects are fine'.\n\n" +
        "This is the polling tool. status is one of queued, running, finished, " +
        "cancelled, failed — the last three are terminal. Two fields answer the " +
        "question 'is anybody actually working on this': queuePosition is a " +
        "number only while THIS server holds the crawl (null otherwise), and " +
        "liveLeases counts unexpired worker leases. A 'queued' crawl with " +
        "queuePosition null was accepted by a server process that is now gone — " +
        "nobody will run it; re-submit it, or retire it with crawl_mark_failed.\n\n" +
        "blockedPages counts pages a WAF or rate limiter answered instead of the " +
        "site (401/403/429/challenge). hostSpacingMs is how far the engine has " +
        "already backed off in response: the widest per-host gap it is enforcing, " +
        "in milliseconds, or null on a crawl that never reported one. READ THEM " +
        "TOGETHER. The engine reacts on its own — a refusal naming a rate (429, or " +
        "any Retry-After) doubles that host's spacing, a volley of refusals across " +
        "several URLs eventually does too, and each blocked URL is retried up to " +
        "three times under the widened spacing.\n\n" +
        "hostSpacingMs above the configured perHostDelayMs with blockedPages no " +
        "longer rising is the safety net having found the site's rate: the crawl " +
        "is slow BECAUSE it is working, and restarting it loses the progress and " +
        "the lesson. blockedPages still rising, or hostSpacingMs pinned at the " +
        "30000ms cap, is the engine out of room: re-crawl slower (maxConcurrency " +
        "1, perHostDelayMs 2000), or stop and talk to the site's owner. Never " +
        "faster.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("crawl_status", () => service.getCrawl(crawlId)),
  );

  server.registerTool(
    named("crawl_list"),
    {
      title: "List crawls",
      description:
        "Every crawl this engine holds, newest first: {crawlId, siteUrl, status, " +
        "startedAt, finishedAt, pagesCrawled, renderPassCount}.\n\n" +
        "Use it to find the crawl id of work someone else started, or to check " +
        "whether a site has been crawled recently before crawling it again. " +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}. Pass nextCursor back as cursor to continue.`,
      inputSchema: z.strictObject({ limit: limitField(), cursor: cursorField() }),
    },
    async (args) => run("crawl_list", () => service.listCrawls(defined(args))),
  );

  server.registerTool(
    named("crawl_render"),
    {
      title: "Run the render pass",
      description:
        "Re-fetch a budgeted sample of a finished crawl's pages in a real browser " +
        "and store what JavaScript added, so content that only exists after " +
        "rendering is measured rather than guessed at. Answers counts — " +
        "{rendered, failures, unrendered, elapsedMs, selection:{selected, budget, " +
        "suspects, sampled, truncated}} — never a page list; read the pages " +
        "themselves with pages_query (rendered=true).\n\n" +
        "Run it AFTER the crawl has stopped and BEFORE crawl_rules if you want " +
        "the rules to judge rendered evidence. It is refused on a crawl that is " +
        "still queued or running, on one another worker is rendering, and on one " +
        "with no discovery evidence (there would be no robots crawl-delay to " +
        "honour). The pass paces itself with the crawl's own delay and user " +
        "agent, so it is not a second, ruder visit.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("crawl_render", () => service.renderCrawl(crawlId)),
  );

  server.registerTool(
    named("crawl_rules"),
    {
      title: "Run the rules",
      description:
        "Judge a finished crawl: run every rule in the registry over it and write " +
        "the findings and metrics. Answers the run summary — {pagesScanned, " +
        "findings, byRule, byMetric, elapsedMs} — not the findings themselves; " +
        "read those with issues_list and metrics_get.\n\n" +
        "Refused while the crawl is 'queued' or 'running': findings about a site " +
        "that is still being fetched change under the reader (an 'orphan' page is " +
        "only orphaned because the page linking to it has not been fetched yet). " +
        "Running it a second time re-judges the crawl with the current ruleset.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("crawl_rules", () => service.runRulesForCrawl(crawlId)),
  );

  server.registerTool(
    named("crawl_mark_failed"),
    {
      title: "Retire an abandoned crawl",
      description:
        "Close a crawl whose worker is gone: 'running' or 'queued' becomes " +
        "'failed'. Answers the crawl detail, as crawl_status does.\n\n" +
        "This is for cleaning up after a crashed server, NOT for cancelling work " +
        "in progress. It is refused if the crawl is already terminal, if this " +
        "server is holding it (running it, or holding it in its queue), or if it " +
        "still holds an unexpired lease — a live crawl between batches " +
        "momentarily holds none, which is exactly the window an impatient caller " +
        "would look in. If it is refused because a lease is live, wait: a dead " +
        "worker's leases expire on their own.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("crawl_mark_failed", () => service.markCrawlFailed(crawlId)),
  );

  // -------------------------------------------------------------- the results

  server.registerTool(
    named("issues_list"),
    {
      title: "Findings, grouped by rule",
      description:
        "The triage view of a judged crawl: one row per rule that found " +
        "something — {ruleId, checkIds, severity, category, title, count, " +
        "sampleUrls}. Ordered by severity (critical, warning, info) then rule id. " +
        "sampleUrls is at most five URLs and is a SAMPLE, not the list; get the " +
        "full list from issue_urls.\n\n" +
        "COUNTS AND CAPS. Some rules stop listing at a cap, so 'count' is the " +
        "number of rows the rule wrote. A capped row carries 'truncated': true " +
        "and one magnitude field: 'total' — the exact number of cases, of which " +
        "count were listed — or 'atLeast' — how many were SEEN before the rule " +
        "stopped looking, with the real number unknown. No 'truncated' field " +
        "means count IS the total. Quote total or 'at least atLeast' as the size " +
        "of the problem, never a capped count. (With a pageType filter, count is " +
        "that cohort's rows while total/atLeast stay the whole rule's magnitude.)\n\n" +
        "Filters, each refused by name if it names nothing this ruleset defines " +
        "(so an empty page always means 'nothing found', never 'you asked wrong'):\n" +
        "  severity  — critical | warning | info\n" +
        "  checkId   — an audit checklist id, e.g. CHECK-35. This is the filter " +
        "to use when you are walking a checklist.\n" +
        "  ruleId    — a single rule, e.g. links.orphan\n" +
        "  category  — a rule group, e.g. links, on-page, indexation\n" +
        "  pageType  — a page-template cohort as this crawl typed it, e.g. " +
        "product; '(untyped)' names the pages it could not type. Site-wide " +
        "findings belong to no cohort and are excluded by this filter.\n" +
        "ruleId, checkId and category intersect; a combination that can select no " +
        "rule is refused rather than answered with an empty page.\n\n" +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}.`,
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        severity: z
          .string()
          .describe("Only findings at this severity: critical, warning or info.")
          .optional(),
        checkId: z
          .string()
          .describe(
            "Only findings from rules claiming this audit checklist id, e.g. 'CHECK-35'. " +
              "A check that only metric rules claim is refused with a pointer to metrics_get.",
          )
          .optional(),
        ruleId: z
          .string()
          .describe("Only findings from this rule, e.g. 'links.orphan'.")
          .optional(),
        category: z
          .string()
          .describe("Only findings from rules in this category, e.g. 'links'.")
          .optional(),
        pageType: z
          .string()
          .describe(
            "Only findings on pages of this template cohort, e.g. 'product'. Use " +
              "'(untyped)' for pages the crawl could not type. Validated against this " +
              "crawl's own pages.",
          )
          .optional(),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async ({ crawlId, ...rest }) => run("issues_list", () => service.listIssues(crawlId, defined(rest))),
  );

  server.registerTool(
    named("issue_urls"),
    {
      title: "One rule's findings, URL by URL",
      description:
        "Every finding one rule recorded on one crawl: {url, evidence}. This is " +
        "the action-plan feed — the list you hand a developer — and the counterpart " +
        "to issues_list's five-URL sample.\n\n" +
        "It reads findings crawl_rules wrote. On a crawl that has not been judged " +
        "every rule answers {items: []}, and so does a rule that simply found " +
        "nothing — the two are indistinguishable here, so an empty answer means NOT " +
        "MEASURED YET until you have confirmed the rules ran. Confirm it with " +
        "crawl_status: rulesRunAt is the timestamp of the last completed rules " +
        "pass, and null means no complete pass is on record. Reach this tool " +
        "through issues_list, which only names rules that actually found something.\n\n" +
        "url is null for a site-wide finding (a fact about the crawl, not about a " +
        "page). evidence is the rule's own testimony, verbatim: its shape is the " +
        "rule's, so read the fields it gives you rather than expecting a fixed " +
        "set. ruleId must name a rule that FINDS; a metric rule measures instead " +
        "and is refused with a pointer to metrics_get.\n\n" +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}. A large rule can have thousands of rows — ` +
        "follow the cursors, or use export_crawl if you want all of them at once.",
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        ruleId: z
          .string()
          .describe("The rule whose findings to list, as issues_list reported it."),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async ({ crawlId, ruleId, ...rest }) =>
      run("issue_urls", () => service.listIssueUrls(crawlId, ruleId, defined(rest))),
  );

  server.registerTool(
    named("metrics_get"),
    {
      title: "Measured numbers",
      description:
        "What the crawl MEASURED rather than what it faulted: {metricId, scope, " +
        "scopeValue, value, title, explanation, checkIds, category}. These are the " +
        "quotable numbers for a report — value crosses verbatim as the metric rule " +
        "wrote it, so its shape belongs to the metric.\n\n" +
        "A crawl nobody has judged has no metrics AT ALL: crawl_rules is what " +
        "writes them, and until it has run this tool answers {items: []}. That " +
        "empty answer means NOT MEASURED YET — never 'this site has nothing worth " +
        "measuring'. The check is one field: crawl_status's rulesRunAt is the " +
        "timestamp of the last COMPLETED rules pass, and null means none is on " +
        "record (never judged, being judged now, or a run that died part-way). " +
        "Read it before you quote a number that is not there.\n\n" +
        "Filters, each refused by name if it names nothing this crawl measured:\n" +
        `  metricId   — a single metric, e.g. redirect.volume\n` +
        `  scope      — the cohort kind: ${METRIC_SCOPES_HINT}\n` +
        "  scopeValue — the cohort itself, e.g. a page type or a sitemap URL " +
        "(empty string for site scope)\n\n" +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}.`,
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        metricId: z
          .string()
          .describe("Only this metric, e.g. 'redirect.volume'.")
          .optional(),
        scope: z
          .string()
          .describe(`Only metrics at this scope: ${METRIC_SCOPES_HINT}.`)
          .optional(),
        scopeValue: z
          .string()
          .describe(
            "Only metrics for this cohort value, e.g. the page type 'product'. Validated " +
              "against what this crawl actually measured.",
          )
          .optional(),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async ({ crawlId, ...rest }) => run("metrics_get", () => service.listMetrics(crawlId, defined(rest))),
  );

  server.registerTool(
    named("pages_query"),
    {
      title: "The crawled pages",
      description:
        "The crawl's pages, slim and filtered: {url, statusCode, fetchClass, " +
        "fetchReason, pageType, indexable, depth, clickDepth, discoveredVia, " +
        "wordCount, renderableWordCount, rendered, renderedWordCount, " +
        "renderedRenderableWordCount, renderError}. " +
        "Use it to answer questions about the site itself — how deep the blog is, " +
        "which product pages are non-indexable, which URLs only the sitemap knows " +
        "about, what a render actually added — rather than about its faults.\n\n" +
        "TWO DEPTHS, AND ONLY ONE OF THEM IS ABOUT THE SITE. depth is DISCOVERY " +
        "depth: how far into the crawl the frontier found the URL. Every sitemap " +
        "entry is enqueued as a starting point, so a page no link on the site " +
        "reaches is recorded at depth 0 — which is why a sitemapped site looks " +
        "flat here and means nothing by it. clickDepth is the shortest chain of " +
        "internal links from the home page: 0 is the home page, and NULL means no " +
        "chain of links reaches the page at all. Null is the finding — the page " +
        "exists only in the sitemap — and it is never to be read as zero. It is " +
        "also null on every page of a crawl the rules have not run over, since the " +
        "search that computes it runs with them; crawl_status's rulesRunAt is what " +
        "tells the two nulls apart.\n\n" +
        "TWO WORD COUNTS, AND THEY MEAN DIFFERENT THINGS. wordCount is every word " +
        "of visible text in the HTML. renderableWordCount is that count minus the " +
        "words the page's own markup says are not displayed (hidden attributes, " +
        "inline display:none, closed dialogs and details) — always the smaller of " +
        "the two, and the number a thin-content judgement is made on. Quote " +
        "renderableWordCount when you are asking whether a page has enough content; " +
        "the gap between them is markup that ships but does not show. It is null on " +
        "a page crawled before this measurement existed, which is 'never measured', " +
        "not zero — do not fall back to wordCount there, it counts something else.\n\n" +
        "AND TWO RENDERED WORD COUNTS, MEASURED BY DIFFERENT INSTRUMENTS. " +
        "renderedWordCount is the browser's innerText: what a reader sees, and no " +
        "rule reads it. renderedRenderableWordCount is the crawl's OWN analyzer run " +
        "over the post-JavaScript DOM — the same function that produced " +
        "renderableWordCount over the bytes the server sent — so those two are the " +
        "pair content.csr-dependent subtracts, and chrome present in both documents " +
        "cancels between them. Before recording that rule's silence as a pass, read " +
        "both on the rendered pages and satisfy yourself it had a way to fire. " +
        "renderedRenderableWordCount is null on every page of a crawl rendered " +
        "before the measurement existed, which such a crawl is REFUSED on rather " +
        "than judged.\n\n" +
        "fetchReason is why a row has no usable body, in plain words, and is null " +
        "for a page that fetched normally. On fetchClass 'blocked' it names the " +
        "status, how many attempts the URL got, and the per-host spacing the engine " +
        "had backed off to before giving up — read it before deciding whether a " +
        "blocked page means 'crawl slower' or 'this site refuses us'.\n\n" +
        "WHICH PASS WROTE WHAT, because a filter can outrun the evidence. The rows " +
        "themselves — url, statusCode, fetchClass, pageType, indexable, depth, " +
        "discoveredVia, wordCount, renderableWordCount — are written by the CRAWL, " +
        "so they are complete as soon as it finishes and crawl_rules is not needed " +
        "for them (crawl_status's rulesRunAt is what says whether the rules have " +
        "run; it says nothing about these). clickDepth is the exception among the " +
        "crawl's own columns: it is computed by crawl_rules, so it is null " +
        "everywhere until the rules have run over the crawl. rendered, " +
        "renderedWordCount, renderedRenderableWordCount and renderError are written " +
        "by crawl_render: before that " +
        "pass has run, rendered is false on every page and 'rendered: true' answers " +
        "{items: []}, which means NOT MEASURED YET rather than 'nothing was " +
        "rendered'. Check crawl_status's renderPassCount before reading anything " +
        "into a rendered filter.\n\n" +
        "Filters:\n" +
        "  pageType   — a template cohort as this crawl typed it; '(untyped)' for " +
        "the pages it could not type\n" +
        "  statusCode — an exact HTTP status, 100..599\n" +
        "  indexable  — true or false. A page whose indexability the crawl never " +
        "settled comes back with indexable null and matches NEITHER value; read " +
        "those off an unfiltered listing.\n" +
        "  rendered   — true or false: whether the render pass re-fetched it. " +
        "renderError is why an ATTEMPTED render produced nothing; null there is " +
        "not the same as 'it worked'.\n" +
        `  fetchClass — how the fetch ended: ${FETCH_CLASS_HINT}. ` +
        "'blocked' is the WAF/rate-limiter cohort crawl_status counts, listed URL " +
        "by URL.\n" +
        `  discoveredVia — how the crawler first reached the URL: ${DISCOVERED_VIA_HINT}. ` +
        "'sitemap' with no link ever found to the page is the orphan cross-check.\n\n" +
        "Ordered by URL. Paginated: {items, nextCursor}; limit defaults to " +
        `${PAGE_SIZE_DEFAULT}, maximum ${PAGE_SIZE_MAX}. This is not an export — a ` +
        "whole 50k-page crawl belongs in a file, not in your context; see " +
        "export_crawl.",
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        pageType: z
          .string()
          .describe("Only pages of this template cohort, e.g. 'product', or '(untyped)'.")
          .optional(),
        statusCode: z
          .number()
          .describe("Only pages whose HTTP status was exactly this, e.g. 404.")
          .optional(),
        indexable: z
          .boolean()
          .describe("Only pages the crawl judged indexable (true) or not (false).")
          .optional(),
        rendered: z
          .boolean()
          .describe("Only pages the render pass re-fetched (true) or did not (false).")
          .optional(),
        fetchClass: z
          .string()
          .describe(`Only pages whose fetch ended this way: ${FETCH_CLASS_HINT}.`)
          .optional(),
        discoveredVia: z
          .string()
          .describe(
            `Only pages the crawler first reached this way: ${DISCOVERED_VIA_HINT}.`,
          )
          .optional(),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async ({ crawlId, ...rest }) => run("pages_query", () => service.listPages(crawlId, defined(rest))),
  );

  server.registerTool(
    named("robots_get"),
    {
      title: "The site's robots.txt, as this crawl read it",
      description:
        "The robots.txt this crawl actually obeyed, out of its stored evidence: " +
        "{crawlId, robotsUrl, outcome, raw, truncated, crawlDelaySec, note, " +
        "sitemapSources, userAgent}. Nothing is re-fetched — this is the text the " +
        "crawler read at crawl time, which is what its findings were judged " +
        "against. A file that has changed since is a fact about the site, and " +
        "fetching the current one here would hide it.\n\n" +
        "outcome is the fact to read first, because the three are not degrees of " +
        "the same thing: 'read' means the site's rules applied; 'absent' means the " +
        "site answered 4xx and there are no rules, so the crawl was allow-all — a " +
        "normal, reportable state; 'unreachable' means the site COULD NOT TELL US " +
        "its rules (5xx, timeout, refused), which is not the same as having none, " +
        "and note says what was done about it.\n\n" +
        "raw is the file's text, or null when there was nothing to read. truncated " +
        "true means raw is a 500KB PREFIX: a rule you cannot find in it may simply " +
        "be past the cap, so do not report 'robots.txt does not disallow X' from a " +
        "truncated copy. crawlDelaySec is the delay the crawl honoured. " +
        "sitemapSources are the Sitemap: lines the walk was pointed at. userAgent " +
        "is the string the crawl identified as — the groups in the file that " +
        "governed it, which matters when the file has per-agent sections.\n\n" +
        "Refused for a crawl that never completed discovery: there is no stored " +
        "copy, and 'we have no record' must not be served as 'the site has no " +
        "robots.txt'.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("robots_get", () => service.getRobots(crawlId)),
  );

  server.registerTool(
    named("export_crawl"),
    {
      title: "Export a dataset to a file",
      description:
        "Write one dataset of a crawl to a gzipped JSONL file on the server and " +
        "answer with {dataset, path, rows, bytes} — the path and the count, never " +
        "the contents. A 50k-row findings dump is not something to read into a " +
        "context window; this is how you hand the whole thing to a human or a " +
        "pipeline instead.\n\n" +
        `dataset is one of: ${EXPORT_DATASETS.join(", ")} (default issues). The ` +
        "file is named for the (crawl, dataset) pair and a re-export replaces it " +
        "rather than piling up copies. The server chooses the directory; there is " +
        "no way to name a destination.",
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        dataset: z
          .string()
          .describe(`Which dataset to write: ${EXPORT_DATASETS.join(", ")}. Defaults to issues.`)
          .optional(),
      }),
    },
    async ({ crawlId, ...rest }) => run("export_crawl", () => service.exportCrawl(crawlId, defined(rest))),
  );

  // The other half of the list's guarantee: `named` cannot admit a name the
  // list does not carry, and this cannot let the list carry a name no tool was
  // registered under. A skill quoting such a name would be documenting a tool
  // that answers nothing (hard rule 7).
  const unregistered = TOOL_NAMES.filter((name) => !registered.has(name));
  if (unregistered.length > 0) {
    throw new Error(
      `createMcpServer: TOOL_NAMES names tools nobody registered: ${unregistered.join(", ")}`,
    );
  }

  return {
    service,
    server,
    async connect(transport: Transport) {
      await server.connect(transport);
    },
    async close() {
      // The protocol first, so no new tool call is accepted, then the queue —
      // whose close aborts the crawl in flight and waits for it to record
      // itself. The same order, and the same reason, as `ApiServer.close`.
      await server.close();
      await service.close();
    },
  };
}

// ------------------------------------------------------------------ the pieces

/**
 * `crawl_start`'s schema, one described field per accepted crawl-config field.
 *
 * Built from `START_CRAWL_FIELDS`' keys deliberately: the table in the service
 * is the wire's vocabulary, and a test asserts this shape has exactly those keys
 * — so a field added there and forgotten here fails the suite rather than
 * quietly leaving the agent surface smaller than the HTTP one.
 */
function crawlStartShape() {
  return {
    siteUrl: z
      .string()
      .describe(
        "The http(s) URL to crawl from. Its host must be on the server's crawl " +
          "allowlist. The crawl treats the apex and www spellings of this host as one " +
          "site.",
      ),
    maxPages: z
      .number()
      .describe(
        "Stop after this many pages. Defaults to 500 — a first look at a site. Raise " +
          "it deliberately: a full crawl of a large site is a real load on it.",
      )
      .optional(),
    maxDepth: z
      .number()
      .describe("Stop following links past this many hops from the seed.")
      .optional(),
    userAgent: z
      .string()
      .describe(
        "The branded user agent to identify as. Leave it alone unless the site's " +
          "owner has asked you to use a specific string; it must stay identifiable.",
      )
      .optional(),
    perHostDelayMs: z
      .number()
      .describe(
        "Politeness delay between requests to one host. The floor is 250ms — a " +
          "smaller value is refused rather than quietly raised — and robots.txt's " +
          "own crawl-delay wins when it is longer.",
      )
      .optional(),
    maxConcurrency: z
      .number()
      .describe("How many fetches may be in flight at once across the whole crawl.")
      .optional(),
    probeHosts: z
      .boolean()
      .describe(
        "Probe the apex/www and http/https spellings of the seed (and any legacyHosts) " +
          "to find where the site really lives. These are the only fetches made before " +
          "robots.txt is read.",
      )
      .optional(),
    legacyHosts: z
      .array(z.string())
      .describe(
        "Extra hosts that used to serve this site, to probe alongside the seed's own " +
          "spellings. EACH ONE must be on the allowlist in its own right — they are " +
          "different sites by every definition the engine has.",
      )
      .optional(),
    renderBudgetPct: z
      .number()
      .describe("Share of the crawl's pages the later render pass may re-fetch, as a percentage.")
      .optional(),
    renderMaxPages: z
      .number()
      .describe("Hard ceiling on pages the later render pass may re-fetch.")
      .optional(),
    renderSamplePerType: z
      .number()
      .describe("How many pages of each template cohort the render pass samples.")
      .optional(),
  };
}

function crawlIdField() {
  return z
    .string()
    .describe("The crawl id, as crawl_start returned it or crawl_list reported it.");
}

function limitField() {
  return z
    .number()
    .describe(
      `Rows in this page, 1..${PAGE_SIZE_MAX}. Defaults to ${PAGE_SIZE_DEFAULT}. It is a ` +
        "page size, not a total: a smaller limit means more pages, never fewer rows.",
    )
    .optional();
}

function cursorField() {
  return z
    .string()
    .describe(
      "The nextCursor from the previous page of THIS listing, with the SAME filters. " +
        "Omit for the first page. A cursor from a different listing is refused rather " +
        "than answered with rows from the wrong place.",
    )
    .optional();
}

/**
 * Drop the keys the schema left `undefined` before they reach the service.
 *
 * The service's option objects distinguish "absent" from "present": `severity:
 * undefined` and no `severity` key mean the same thing to it today, but spreading
 * `undefined` into a typed optional is how a filter eventually gets applied as
 * the string "undefined". The tools pass what the caller actually sent.
 */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The success shape: one text block of compact JSON, no prose. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** The refusal shape: the same `{error}` body the HTTP transport sends. */
function jsonError(body: { error: string; correlationId?: string }): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** The log's view of a thrown value: message and stack, never a caller's. */
function stackOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
