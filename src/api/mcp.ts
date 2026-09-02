/**
 * The MCP transport: sixteen tools over the same service layer the HTTP routes
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
import { CSV_VIEWS, EXPORT_FORMATS } from "./csv.js";
import {
  ApiService,
  COMPARE_SETS,
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
  "crawl_resume",
  "crawl_render",
  "crawl_rules",
  "robots_get",
  "issues_list",
  "issue_urls",
  "metrics_get",
  "pages_query",
  "export_crawl",
  "rules_catalog",
  "crawl_compare",
  "compare_urls",
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
                   A crawl that stopped with work still owed — a server shut
                   down mid-run, a cancel somebody regrets — is continued with
                   crawl_resume, which is the same crawl and not a new one.
  3. crawl_render  (optional) re-fetches some pages in a real browser, so
                   client-side-rendered content is measured rather than guessed.
                   Either the engine picks them or you name them with 'urls'.
                   Run it BEFORE the rules if you want rendered evidence judged.
  4. crawl_rules   runs every rule over the finished crawl and writes the
                   findings. Refused while the crawl is still moving.
  5. issues_list / issue_urls / metrics_get / pages_query read the results.
                   robots_get reads the robots.txt the crawl obeyed.
                   rules_catalog reads the checklist itself — every rule and,
                   with a crawlId, whether it fired on that crawl (including the
                   ones that found nothing, which no findings listing can name).
  6. crawl_compare compares two judged crawls of ONE site and says what appeared,
                   what went away and what is still there; compare_urls lists the
                   URLs behind any of those counts. crawl_list with a siteUrl is
                   how you find the pair. Read the comparison's 'comparable' flag
                   and its caveats before quoting a change: two crawls judged by
                   different rulesets, or under different finding caps, produce
                   different counts for reasons that are not the site.

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
        "legacyHosts, sitemapUrls, findingCap, rulesRunAt, findingsCount, " +
        "pagesScanned, fetchResources and resources.\n\n" +
        "IS THIS CRAWL JUDGED? rulesRunAt is the answer and the only one: it is " +
        "the timestamp of the last COMPLETED crawl_rules pass, and null means no " +
        "complete pass is on record — never judged, being judged right now, or " +
        "judged by a run that died part-way. Check it before you read anything " +
        "into an empty findings or metrics answer: findingsCount 0 with rulesRunAt " +
        "null is 'nobody has looked', and findingsCount 0 with a timestamp is " +
        "'looked, found nothing'. findingsCount is the live number of issue rows, " +
        "which is what issues_list's groups sum to.\n\n" +
        "pagesScanned is how many pages a rules run over this crawl reads — the " +
        "crawl's page rows, which is exactly what crawl_rules counts as its own " +
        "pagesScanned. It describes the CRAWL, so it is answered on a crawl " +
        "nobody has judged too, and it is the denominator a finding count is " +
        "written against ('1,326 findings over 551 pages'). Read it from here " +
        "rather than re-running crawl_rules on a crawl somebody else judged: " +
        "re-judging shared state to learn a number is the wrong trade.\n\n" +
        "legacyHosts echoes the domains this crawl was told the site used to live " +
        "on (empty when none were named) — the host-probe findings about legacy " +
        "redirects mean nothing without it: no finding on an empty list is 'the " +
        "crawl was never given a legacy domain', not 'the redirects are fine'. " +
        "sitemapUrls echoes the sitemap documents the crawl was handed at start, " +
        "and reads the same way: this engine never probes for an undeclared " +
        "sitemap, so 'no sitemap declared' beside an empty sitemapUrls is a crawl " +
        "to re-run with the document, not yet a report to write.\n\n" +
        "findingCap is what this crawl's listing rules will be cut at when the rules " +
        "run: 200 when nobody chose (the default), null when the crawl was started " +
        "uncapped for a billed audit, or the number that was set. It is here so a " +
        "caller that passed findingCap to crawl_start can confirm it took — the cap " +
        "lives on the crawl row and crawl_rules has no argument to restate it.\n\n" +
        "resources is what this crawl knows about the images, stylesheets and " +
        "scripts its pages reference, COUNTED OFF THE DATABASE rather than off any " +
        "one pass's report — which matters because a resumed crawl's pass asks only " +
        "the rows still unfetched and would honestly report fetching nothing. seen " +
        "is every distinct file the pages point at; fetched is the files a server " +
        "answered about; failed is the files it could not answer for (a 4xx or 5xx, " +
        "a request that failed, a URL our own policy refused, a file robots.txt put " +
        "out of reach) — a count of files that could not be WEIGHED, not a count of " +
        "broken files, which is what the resources.broken finding judges. skipped is " +
        "SEEN BUT NOT ASKED: the pass has not run, was interrupted, hit a cap, or was " +
        "turned off. fetched + failed + skipped = seen, always.\n\n" +
        "Three fields beside them say what a bare number would hide. robotsDenied " +
        "and robotsUnreachable are both parts of failed that robots.txt put out of " +
        "reach, and they are two counts because they are two facts: robotsDenied is " +
        "'they said no' — the file's host served its rules and they forbid us — " +
        "while robotsUnreachable is 'we could not ask' — the host answered 5xx, timed " +
        "out or failed at the network, which RFC 9309 makes a complete disallow all " +
        "the same. An unreachable robots.txt is a complete disallow, so the BEHAVIOUR " +
        "is identical (no request was made either way) and the report is not: " +
        "robotsUnreachable is usually a transient condition on somebody's CDN, not a " +
        "policy the client chose. Each row's fetchReason names the host and the " +
        "reason, on the resources CSV view (export_crawl, format=csv, " +
        "view=resources). A crawl run before this split has every robots refusal in " +
        "robotsDenied — nothing was rewritten. capped is true when a resource cap " +
        "stopped the pass short of at least one file — one flag for both caps, " +
        "because the row records one reason whichever cap it was. Those caps are " +
        "budgets per RUN, not per crawl: crawl_resume grants the whole budget " +
        "again, so a crawl's lifetime total can exceed maxResources.\n\n" +
        "resourceRefsCappedPages sits OUTSIDE that block because it counts PAGES, " +
        "not files: how many of this crawl's pages carried more resource REFERENCES " +
        "than the analyzer's cap keeps (2,000 per page, the rest turned away). " +
        "References, not files — past the cap the analyzer stops resolving, so a " +
        "page whose 2,001st reference repeats its first is counted here and lost no " +
        "file at all. On those pages resources.seen MAY BE a floor: some of the " +
        "turned-away references would have been files nobody recorded, so counts " +
        "over the census may be counts over a sample of that page's references. " +
        "Which page it is true of is not knowable from any surface. null is not " +
        "zero: null means nobody counted (a crawl older than the counter, one still " +
        "running, or one whose process died before its first close — that null is " +
        "permanent, a later resume cannot recover the pages the dead run read), " +
        "while 0 means every page was read and none of them lost a reference. Do not " +
        "render the two the same way, and do not divide this by pagesCrawled: the " +
        "two are counted off different sources (analyses handed to the writer versus " +
        "the frontier's settled rows) and a ratio above 1 is legitimate on a crawl " +
        "that analysed one URL twice.\n\n" +
        "fetchResources says whether this crawl asked at all: true is the default and " +
        "false is an operator's decision, echoed here so it can be confirmed. false " +
        "beside fetched 0 is 'nobody asked'; true beside fetched 0 is a pass that has " +
        "not run, was capped before its first request, or could not finish. The " +
        "resources.not-fetched finding covers only the crawls where NOT ONE file was " +
        "decided (skipped equal to seen), and its evidence names which of those three " +
        "it was. A pass that asked and got only non-ok answers — fetched 0 with " +
        "failed above 0 — carries NO marker: rows were decided, so nothing fires, and " +
        "this block is the only discriminator for the silence of the resource rules. " +
        "On a crawl older than the resource " +
        "tables every number here is 0, which is not 'this site references no files' " +
        "— the resources.not-recorded finding is what says so.\n\n" +
        "This is the polling tool. status is one of queued, running, finished, " +
        "cancelled, failed — the last three are terminal. Two fields answer the " +
        "question 'is anybody actually working on this': queuePosition is a " +
        "number only while THIS server holds the crawl (null otherwise), and " +
        "liveLeases counts unexpired worker leases. A 'queued' crawl with " +
        "queuePosition null was accepted by a server process that is now gone — " +
        "nobody will run it; hand it to crawl_resume, which continues the same " +
        "crawl, or retire it with crawl_mark_failed. The same pair answers a " +
        "'running' row with liveLeases 0 long after its server died, and a " +
        "terminal crawl that stopped with work owed: crawl_resume finishes it, " +
        "crawl_mark_failed closes it.\n\n" +
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
        "whether a site has been crawled recently before crawling it again.\n\n" +
        "siteUrl narrows it to ONE SITE — this is the history of a site, which is " +
        "what you need before crawl_compare. The match is on the HOST and treats " +
        "the apex and www spellings as one site, ignoring the scheme and the port, " +
        "exactly as a crawl does: siteUrl 'https://example.com/' finds a crawl " +
        "seeded as 'http://www.example.com/'. The path is ignored — any URL on the " +
        "site will do. A siteUrl that is not an http(s) URL is refused by name " +
        "rather than treated as no filter.\n\n" +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}. Pass nextCursor back as cursor to continue.`,
      inputSchema: z.strictObject({
        siteUrl: z
          .string()
          .describe(
            "Only crawls of this site. Any http(s) URL on it; the host's apex and www " +
              "spellings, and both schemes, all count as the same site.",
          )
          .optional(),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async (args) => run("crawl_list", () => service.listCrawls(defined(args))),
  );

  server.registerTool(
    named("crawl_resume"),
    {
      title: "Resume an interrupted crawl",
      description:
        "Continue a crawl that stopped with work still owed — a server that was " +
        "shut down mid-crawl, a worker that died, or a crawl somebody cancelled " +
        "and now wants finished. It is THE SAME CRAWL: same crawlId, same row, " +
        "same frontier, and pages already on record are never fetched again. " +
        "Answers {crawlId, status, queuePosition} exactly as crawl_start does, " +
        "with status 'queued' — the work is accepted here and runs later.\n\n" +
        "POLL crawl_status FOR WHAT IT FOUND. This tool reports nothing about the " +
        "resumed run, and that is deliberate: a resumed pass's own summary counts " +
        "what THAT run did, while crawl_status counts what the CRAWL holds. On the " +
        "Phase 11 gate crawl the two read 784 and 1,995 resources — both true, and " +
        "only the second one describes the site. The database is the truth.\n\n" +
        "WHAT IT COSTS THE SITE. Before it picks up where it left off a resume " +
        "re-reads robots.txt, re-walks the sitemap and re-runs the host probe, " +
        "because a crawl resumed hours later must honour the rules as they are " +
        "NOW — roughly a dozen paced requests. Then it does the owed work, and on " +
        "a crawl that hit its resource cap that is MORE than 'the remainder': the " +
        "engine's resource-fetch caps are budgets per RUN, not per crawl, so a " +
        "resume grants the whole budget again and may weigh a budget's worth of " +
        "further files. That is legitimate work on files the crawl saw and never " +
        "asked about — but it is a second round of requests to somebody's " +
        "servers, and crawl_status's resources block reports capped true on " +
        "exactly the crawls where it applies.\n\n" +
        "It also keeps the politeness the crawl earned: a host that pushed the " +
        "spacing to 8s is still crawled at 8s, never back at the configured " +
        "floor. Read that as a CRAWL-wide number, because that is what it is — " +
        "hostSpacingMs is the widest spacing any one host reached, so a resume " +
        "applies it to every host it touches, including ones that never pushed " +
        "back. A resumed crawl is therefore never faster than the one it " +
        "continues, and can be slower; the 30000ms cap still bounds it.\n\n" +
        "IT UNJUDGES THE CRAWL. rulesRunAt is cleared, because the crawl is about " +
        "to grow and a timestamp left standing would say a completed rules pass " +
        "describes pages that did not exist when it ran. Re-run crawl_rules after " +
        "the resumed crawl finishes; until you do, crawl_status reads " +
        "rulesRunAt null and any findings still in the table are a pass nobody " +
        "completed.\n\n" +
        "REFUSED, and each refusal says which: no such crawl; this server is " +
        "already holding it; the crawl still holds an unexpired lease (a worker is " +
        "on it — wait, a dead worker's leases expire on their own); a terminal " +
        "crawl with nothing owed, naming what was counted (pending frontier rows, " +
        "expired leases, unasked resource rows); the site's host is no longer on " +
        "this server's crawl allowlist, which is policy and not a fault; or the " +
        "crawl's state changed while the call was checking it, in which case " +
        "nothing was queued and crawl_status says what it is now. Pages waiting on " +
        "the render pass are NOT resumable work — that is crawl_render.",
      inputSchema: z.strictObject({ crawlId: crawlIdField() }),
    },
    async ({ crawlId }) => run("crawl_resume", () => service.resumeCrawl(crawlId)),
  );

  server.registerTool(
    named("crawl_render"),
    {
      title: "Run the render pass",
      description:
        "Re-fetch some of a finished crawl's pages in a real browser and store " +
        "what JavaScript added, so content that only exists after rendering is " +
        "measured rather than guessed at. Answers counts — " +
        "{rendered, failures, unrendered, elapsedMs, selection:{mode, selected, " +
        "budget, suspects, sampled, truncated}} — never a page list; read the pages " +
        "themselves with pages_query (rendered=true).\n\n" +
        "WHICH PAGES. Without urls the engine selects for itself: pages whose HTML " +
        "looks incomplete, plus a few of every page type, cut to a budget — " +
        "selection.mode is 'auto' and the four numbers beside it describe that " +
        "decision. With urls you name the pages, which is what to do once you know " +
        "the site's templates: the home page and two or three representatives of " +
        "each real template beats a budget spent on whatever tripped a heuristic. " +
        "A named list REPLACES the automatic selection for that pass, " +
        "selection.mode is 'explicit', and budget/suspects/sampled/truncated come " +
        "back null because no automatic decision was made — not zero.\n\n" +
        "Every named URL must already be a page of this crawl that answered 200: " +
        "this pass re-visits pages, it never fetches a URL for the first time, and " +
        "one that is not there is refused by name. The list is capped at the " +
        "crawl's renderMaxPages and a longer one is refused rather than trimmed.\n\n" +
        "Run it AFTER the crawl has stopped and BEFORE crawl_rules if you want " +
        "the rules to judge rendered evidence. It is refused on a crawl that is " +
        "still queued or running, on one another worker is rendering, and on one " +
        "with no discovery evidence (there would be no robots crawl-delay to " +
        "honour). The pass paces itself with the crawl's own delay and user " +
        "agent, so it is not a second, ruder visit — a named list is no faster " +
        "per page, only better spent.",
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        urls: z
          .array(z.string())
          .describe(
            "Pages to render, in place of the automatic selection. Each must be a URL " +
              "this crawl already fetched with a 200. Omit to let the engine select.",
          )
          .optional(),
      }),
    },
    async ({ crawlId, urls }) =>
      run("crawl_render", () =>
        service.renderCrawl(crawlId, urls === undefined ? {} : { urls }),
      ),
  );

  server.registerTool(
    named("crawl_rules"),
    {
      title: "Run the rules",
      description:
        "Judge a finished crawl: run every rule in the registry over it and write " +
        "the findings and metrics. Answers the run summary — {pagesScanned, " +
        "findings, byRule, derived, metrics, byMetric} — not the findings " +
        "themselves; read those with issues_list and metrics_get. Those six are " +
        "the whole summary; it carries no timing field, so time the call " +
        "yourself if you want the duration.\n\n" +
        "pagesScanned here is the crawl's page count, and crawl_status answers " +
        "the same number without judging anything — so a crawl somebody else " +
        "judged does not need a second pass to be described.\n\n" +
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
        "worker's leases expire on their own.\n\n" +
        "It is also not the only move on an abandoned crawl. crawl_resume takes " +
        "the same rows and CONTINUES them instead of retiring them, and it is the " +
        "better answer whenever the pages already fetched are worth keeping.",
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
        "rendered'. Check whether a pass ran before reading anything into a " +
        "rendered filter: render.coverage's renderPassEvidence answers it " +
        "('none' means no pass left a trace), while crawl_status's " +
        "renderPassCount is only the LAST pass's rendered-page count — its 0 is " +
        "also what a crawl nobody rendered reports.\n\n" +
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
        "sitemapSources, suppliedSitemaps, userAgent}. Nothing is re-fetched — this is the text the " +
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
        "sitemapSources are the Sitemap: lines THIS FILE declared; suppliedSitemaps " +
        "are the documents the crawl was handed at start (crawl_start's sitemapUrls), " +
        "which the walk read as well. The two are separate because the difference is " +
        "the finding: a sitemap that only appears in suppliedSitemaps is one the site " +
        "publishes and does not declare, and a document in both was declared and " +
        "re-supplied — the walk fetched it once. userAgent " +
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
    named("rules_catalog"),
    {
      title: "Every rule this engine can apply",
      description:
        "The whole ruleset, with the client-facing copy each rule would report " +
        "with: {rulesetVersion, rules: [{id, kind, severity, category, checkIds, " +
        "title, explanation, howToFix}]}. kind is page | query | metric, severity " +
        "is critical | warning | info, and checkIds trace each rule to the audit " +
        "checklist. Ordered by severity then rule id — the order issues_list " +
        "returns its groups in.\n\n" +
        "This is the CHECKLIST: what the engine looks for, including the checks a " +
        "site passed and the checks nobody has run yet. issues_list can only name " +
        "the rules that found something, so it cannot answer 'what else was " +
        "examined'. Use this to render or walk the full list; use issues_list for " +
        "the findings themselves.\n\n" +
        "WITH crawlId, every rule additionally carries `fired`, and it has THREE " +
        "states that mean three different things:\n" +
        "  fired absent      — no crawlId was given. Nobody has looked; this is " +
        "the bare checklist.\n" +
        "  fired: null       — the crawl exists and has never been judged: no rules " +
        "pass has completed over it (crawl_status's rulesRunAt is null). Nothing " +
        "is known about this rule on this site. Run crawl_rules first.\n" +
        "  fired: {count: N} — a rules pass completed, and this rule wrote N " +
        "findings. count: 0 is a real measurement: the rule ran and found nothing " +
        "on this site.\n" +
        "NEVER READ A NULL AS A ZERO. One is a clean check; the other is a " +
        "question nobody has asked yet.\n\n" +
        "fired.atLeast: true beside the count means the rule CAPPED its listing, " +
        "so count is a floor rather than the number of cases — report it as 'N or " +
        "more' and read the exact magnitude (truncated + total | atLeast) off " +
        "issues_list, which owns it. No atLeast means count is the whole number.\n\n" +
        "fired.measuresOnly: true marks a rule with kind 'metric', which measures " +
        "rather than finds: it writes no issues, so its count is 0 on EVERY judged " +
        "crawl whatever the site is like. That zero is structural and is not a " +
        "check the site passed — the flag is on the payload so it cannot be missed. " +
        "Its numbers are in metrics_get (which is also what issue_urls tells you " +
        "when you name a metric rule there).\n\n" +
        "The copy is always the CURRENT ruleset's (rulesetVersion says which), " +
        "including when the named crawl was judged by an older one. A crawl " +
        "holding findings for a rule this ruleset no longer defines is refused " +
        "rather than answered with a count missing from the list — re-run " +
        "crawl_rules over it.\n\n" +
        "Not paginated: the ruleset is a fixed list that does not grow with the " +
        "size of a crawl — but it is not small, and there is no cursor to take it " +
        "in pieces. Every rule's full copy is tens of kilobytes in one answer " +
        "(about 80KB, roughly 20k tokens, at this ruleset), so spend the context " +
        "deliberately: if you only need the rules that FOUND something, " +
        "issues_list is a fraction of the size.",
      inputSchema: z.strictObject({
        crawlId: z
          .string()
          .describe(
            "Join this crawl's fired state onto every rule. Omit for the bare " +
              "checklist — the rules and their copy, with no `fired` field at all.",
          )
          .optional(),
      }),
    },
    async (args) => run("rules_catalog", () => service.rulesCatalog(defined(args))),
  );

  server.registerTool(
    named("crawl_compare"),
    {
      title: "What changed between two crawls of one site",
      description:
        "Two crawls of the SAME site, rule by rule: what appeared, what went away, " +
        "and what is still there. Answers {base, head, comparable, caveats, rules}.\n\n" +
        "base and head each carry {crawlId, siteUrl, rulesRunAt, rulesetVersions, " +
        "findingCap, findingsCount}. rulesetVersions is read off the FINDINGS' own " +
        "stamp, not off the crawl row — a crawl made under one ruleset and judged " +
        "later under another is stamped with the one that judged it — and it is a " +
        "list because a crawl can hold rows from more than one. It is empty for a " +
        "judged crawl that wrote no findings.\n\n" +
        "Each row of rules is {ruleId, severity, category, checkIds, title, " +
        "baseCount, headCount, baseUrls, headUrls, new, resolved, persisting, " +
        "baseTruncated, headTruncated}, ordered by severity then rule id — the " +
        "order issues_list uses. Every rule with findings in EITHER crawl appears; " +
        "there is no cursor, because the list is bounded by the ruleset rather than " +
        "by the site.\n\n" +
        "WHERE A ROW'S FIELDS COME FROM, because the two halves differ. severity is " +
        "read off the ROWS — the head crawl's, which is the current reading, or the " +
        "base's for a rule that fired only there — so it is a fact about what was " +
        "recorded. category, checkIds and title are the CURRENT ruleset's copy, " +
        "joined at read time, exactly as issues_list and rules_catalog join it. On a " +
        "comparison across two rulesets that asymmetry is visible: both sides are " +
        "labelled with today's copy even where the older side's rule was titled or " +
        "filed differently when it ran. The counts are each crawl's own; the words " +
        "beside them are today's.\n\n" +
        "WHAT COUNTS AS THE SAME FINDING IN TWO CRAWLS: the pair (rule, page URL). " +
        "Nothing else survives a re-crawl — a finding's internal key is often a hash " +
        "of the CONTENT it found, which changes the moment the site edits a word, so " +
        "diffing on it would report an unchanged problem as one fixed and one new. " +
        "The consequence is that a rule which can fire more than once on a page " +
        "COLLAPSES TO PER-URL PRESENCE here: on the reference site " +
        "content.near-duplicate wrote 16,789 findings across 281 URLs, and this tool " +
        "sees 281 things. That is why every row carries both numbers — baseCount and " +
        "headCount are the finding ROWS (the numbers issues_list reports), baseUrls " +
        "and headUrls are the distinct URLs the diff is actually over — and why the " +
        "arithmetic that always holds is stated in URLs: headUrls = new + " +
        "persisting, and baseUrls = resolved + persisting. A site-wide finding has " +
        "no page URL and compares by rule presence alone; it appears in the " +
        "drill-down as url null.\n\n" +
        "READ comparable BEFORE READING A CHANGE. It is false when the engine can " +
        "see that the two sides' numbers were produced under different conditions, " +
        "and every reason is in caveats as {code, message}:\n" +
        "  ruleset-mismatch    — the two were judged by different rulesets. A rule " +
        "can change what it looks for and how severely it reports it, so a count " +
        "that moved may be the ruleset moving rather than the site.\n" +
        "  ruleset-unrecorded  — a side records no ruleset at all: it wrote no " +
        "findings, or its findings predate the version stamp and carry an empty one. " +
        "Nothing says which rules ran, so there is nothing to check — never read " +
        "this as agreement.\n" +
        "  ruleset-mixed       — a side holds findings from more than one ruleset " +
        "version, so no single version describes it.\n" +
        "  finding-cap-differs — the two ran under different finding caps. A listing " +
        "rule stops writing rows at its cap, so a count that moved may be the cap " +
        "moving rather than the site; baseTruncated / headTruncated say which rules " +
        "were actually cut on which side.\n" +
        "  severity-changed    — a rule is recorded at different severities on the " +
        "two sides. The row reports the HEAD severity, which is the current reading.\n" +
        "This is a STATEMENT, NOT A REFUSAL: the counts are returned either way, and " +
        "it is for you to decide whether to quote a change. comparable true is the " +
        "weaker claim it sounds — it says the stamps agree, not that the numbers " +
        "mean the same thing; engine behaviour has changed under one version before.\n\n" +
        "REFUSED, each by name: two crawls of different sites (never a cross-site " +
        "diff); the same crawl given twice; and a crawl that has never been judged " +
        "(rulesRunAt null) — findings sitting in an unjudged crawl belong to a pass " +
        "that did not complete, and diffing them would report the other crawl's " +
        "whole findings list as new.\n\n" +
        "The URLs are NOT here. Use compare_urls for the list behind any count.",
      inputSchema: z.strictObject({
        baseCrawlId: compareIdField("base", "the earlier crawl — what the site was"),
        headCrawlId: compareIdField("head", "the later crawl — what the site is now"),
      }),
    },
    async ({ baseCrawlId, headCrawlId }) =>
      run("crawl_compare", () => service.compareCrawls(baseCrawlId, headCrawlId)),
  );

  server.registerTool(
    named("compare_urls"),
    {
      title: "The URLs behind one comparison count",
      description:
        "One rule's URLs in one of crawl_compare's three sets: {url}. This is the " +
        "drill-down — crawl_compare gives you 'links.orphan: 43 new' in one small " +
        "object, and this gives you the 43 URLs when you want them.\n\n" +
        `set is one of: ${COMPARE_SETS.join(", ")}. new is URLs the head crawl has ` +
        "and the base did not; resolved is URLs the base had and the head does not; " +
        "persisting is URLs both carry. The counts come from crawl_compare and the " +
        "sets here are the same sets, so a set walked to its end has exactly as many " +
        "URLs as the count said.\n\n" +
        "url is null for a site-wide finding — a fact about the crawl rather than " +
        "about a page, which compares by whether the rule fired at all.\n\n" +
        "A rule that fires more than once on a page appears ONCE per URL here, for " +
        "the reason crawl_compare's description sets out: the page URL is the only " +
        "identity a finding keeps across two crawls.\n\n" +
        "The same refusals as crawl_compare, in the same order — different sites, " +
        "the same crawl twice, a crawl nobody judged — plus a ruleId this ruleset " +
        "does not define, and a metric rule (which measures rather than finds and " +
        "writes no findings to compare).\n\n" +
        `Paginated: {items, nextCursor}; limit defaults to ${PAGE_SIZE_DEFAULT}, ` +
        `maximum ${PAGE_SIZE_MAX}. Pass nextCursor back as cursor, with the SAME ` +
        "baseCrawlId, headCrawlId, ruleId and set, until nextCursor is null.",
      inputSchema: z.strictObject({
        baseCrawlId: compareIdField("base", "the earlier crawl — what the site was"),
        headCrawlId: compareIdField("head", "the later crawl — what the site is now"),
        ruleId: z
          .string()
          .describe("The rule whose URLs you want, e.g. 'links.orphan'. It must be a rule that finds."),
        set: z
          .string()
          .describe(
            // THE SEPARATOR IS A PLAIN COMMA, and it is load-bearing. It used to
            // be " (head only), ", which pasted that parenthetical after EVERY
            // set name — rendering "resolved (head only)", which is backwards in
            // the one field where swapping base and head inverts the answer. The
            // list of names and the gloss of what each means are two different
            // sentences and are written as two.
            `Which set: ${COMPARE_SETS.join(", ")}. new is URLs only the HEAD crawl has, ` +
              "resolved is URLs only the BASE crawl had, persisting is URLs both carry.",
          ),
        limit: limitField(),
        cursor: cursorField(),
      }),
    },
    async ({ baseCrawlId, headCrawlId, ruleId, set, ...rest }) =>
      run("compare_urls", () =>
        service.listCompareUrls(baseCrawlId, headCrawlId, ruleId, set, defined(rest)),
      ),
  );

  server.registerTool(
    named("export_crawl"),
    {
      title: "Export a dataset or a spreadsheet view to a file",
      description:
        "Write one view of a crawl to a FILE on the server and answer with the path " +
        "and the row count — never the contents. A 50k-row findings dump is not " +
        "something to read into a context window; this is how you hand the whole " +
        "thing to a human or a pipeline instead.\n\n" +
        "TWO FORMATS, TWO VOCABULARIES.\n" +
        `  format=jsonl.gz (the default) writes a gzipped JSONL file of one DATASET: ` +
        `${EXPORT_DATASETS.join(", ")} (default issues) — one JSON object per line, ` +
        "evidence intact. Answers {dataset, path, rows, bytes}.\n" +
        `  format=csv writes a spreadsheet of one VIEW: ${CSV_VIEWS.join(", ")} ` +
        "(default issues). issue_urls is one rule's findings and needs a ruleId; " +
        "the other five refuse one. Answers {format, view, path, rows, bytes}.\n" +
        "'dataset' is the first format's word and 'view' is the second's; asking " +
        "with both is refused rather than resolved.\n\n" +
        "WHAT THE CSV LOOKS LIKE, because a human opens it and you are the one who " +
        "can warn them. RFC 4180, UTF-8, CRLF line endings, and a header row " +
        "ALWAYS — including for a view with no rows. 'rows' counts DATA rows; the " +
        "header is not one of them, so it compares directly against findingsCount. " +
        "A list inside a cell (checkIds, a redirect chain, an evidence array) is " +
        "joined with '|'. An empty cell means the engine has no value there — " +
        "never zero, never false.\n" +
        "The evidence column is the finding's evidence FLATTENED to a deterministic " +
        "summary rather than a JSON blob: sorted key=value pairs joined with '; ', " +
        "dotted paths for nested objects (truncated.total=222), indices for arrays " +
        "of objects, long values clipped with '…' and the remainder counted as " +
        "'+N more'. The whole evidence stays on issues_list and issue_urls.\n" +
        "THREE VIEWS MEAN SOMETHING NARROWER THAN THEIR NAME, and quoting any " +
        "one wrongly misreports the site. links_to_4xx is INTERNAL links only: " +
        "the status comes from the target's own crawled page row, and an external " +
        "target is never fetched, so an external 4xx is ABSENT from this file " +
        "rather than clean. redirects is one row per REDIRECTING PAGE, not per " +
        "chain: a -> b -> c is two rows and the destination appears in both, so " +
        "the row count is how many URLs redirect and never how many chains there " +
        "are. resources is one row per FILE the SERVED HTML points at, not per " +
        "reference and not per request a browser makes: an image on four hundred " +
        "pages is one row with referencingPages 400, and a file a script injects " +
        "at runtime is absent from this file rather than clean, so an empty export " +
        "is 'the server sent no references' and never 'this site loads no assets'. " +
        "Read its fetchClass column before its status: an empty status means the " +
        "file was never asked about, refused by our own URL policy, put out of " +
        "reach by robots.txt, or asked about with no answer — none of which is a " +
        "broken file, and fetchReason is the sentence that says which.\n" +
        "Cells beginning '=', '+', '-' or '@' are written with a leading apostrophe. " +
        "A crawled page's title is attacker-controlled text and these files open in " +
        "Excel at somebody's desk; the apostrophe is what stops a title being " +
        "executed as a formula. It is part of the cell, not a defect.\n\n" +
        "The same CSV rows are streamed as text/csv over the HTTP transport " +
        "(GET /crawls/:id/export?format=csv&view=...), which is what a dashboard's " +
        "download button reads. Here they go to a file, because a stdio client has " +
        "nowhere to stream to. The file is named for the crawl, the format and the " +
        "view, and a re-export replaces it rather than piling up copies. The server " +
        "chooses the directory; there is no way to name a destination.",
      inputSchema: z.strictObject({
        crawlId: crawlIdField(),
        format: z
          .string()
          .describe(
            `Which file to write: ${EXPORT_FORMATS.join(" or ")}. Defaults to jsonl.gz, ` +
              "which takes a dataset; csv takes a view.",
          )
          .optional(),
        dataset: z
          .string()
          .describe(
            `Which dataset the jsonl.gz format writes: ${EXPORT_DATASETS.join(", ")}. ` +
              "Defaults to issues. Not accepted with format=csv.",
          )
          .optional(),
        view: z
          .string()
          .describe(
            `Which spreadsheet the csv format writes: ${CSV_VIEWS.join(", ")}. Defaults ` +
              "to issues. Requires format=csv.",
          )
          .optional(),
        ruleId: z
          .string()
          .describe(
            "The rule whose findings the issue_urls view writes, e.g. 'links.orphan'. " +
              "Required for that view and refused for every other one.",
          )
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
    sitemapUrls: z
      .array(z.string())
      .describe(
        "Sitemap documents to walk in addition to the ones robots.txt declares — the " +
          "way to crawl a sitemap the site publishes but never points at. The engine " +
          "does NOT probe /sitemap.xml on spec, so an undeclared sitemap is only read " +
          "if you name it here. Full http(s) URLs; a host outside this site's own " +
          "spellings must be on the allowlist in its own right. Supplying one does not " +
          "hide the finding: robots.txt still declares no sitemap, and the audit still " +
          "says so.",
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
    findingCap: z
      .number()
      .nullable()
      .describe(
        "How many findings each listing rule may report when this crawl is judged. " +
          "Defaults to 200 (and 500 near-duplicate pairs) — a bounded first look. Pass " +
          "null for a BILLED AUDIT: every orphan, every duplicate group, every blocked " +
          "sitemap entry, listed in full. It costs wall time on a large site and it is " +
          "the whole picture rather than a snapshot. It is read when the RULES run, not " +
          "while crawling, so it must be set here — crawl_rules has no cap argument of " +
          "its own. Uncapped listings normally carry no 'and N more' note, but keep " +
          "reading the note rather than the setting: a note means the list is " +
          "incomplete and its absence means complete. content.near-duplicate has a " +
          "100,000-pair scan ceiling that findingCap cannot lift (it is the engine's " +
          "memory contract), and a site that reaches it gets the usual 'at least' note " +
          "— which is itself the finding: that site has no distinct content.",
      )
      .optional(),
    fetchResources: z
      .boolean()
      .describe(
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
      )
      .optional(),
  };
}

function crawlIdField() {
  return z
    .string()
    .describe("The crawl id, as crawl_start returned it or crawl_list reported it.");
}

/**
 * One side of a comparison. Named rather than reusing `crawlIdField` because
 * WHICH SIDE a crawl is on is the whole meaning of the answer — `new` and
 * `resolved` swap places if the two are handed over the wrong way round — and a
 * field description is where an agent finds that out.
 */
function compareIdField(side: "base" | "head", role: string) {
  return z
    .string()
    .describe(
      `The ${side} crawl's id: ${role}. Both crawls must be of the same site and ` +
        "both must have been judged (crawl_rules run over them).",
    );
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
