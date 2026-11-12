/**
 * The render link (Phase 28c): one render pass over a finished crawl, from the
 * crawl's own stored configuration. The API's `crawl_render` and a schedule's
 * chain both call it, so a pass run either way takes the same configuration,
 * refuses with the same sentences and writes the same rows.
 *
 * The caller owns the claim: a `render` job pinned to its process, whose insert
 * is the busy check (`withPinnedJob`). Nothing here claims anything.
 *
 * `renderHtmlDir: null` is a pass that keeps no rendered documents — a worker's
 * chain render passes null, and the pages' `rendered_html_path` stays null.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { ServiceError, clip } from "../../api/errors.js";
import type { Db } from "../../db/client.js";
import { crawls, pages } from "../../db/schema.js";
import { ROBOTS_OUTCOMES } from "../discovery.js";
import { parseStoredConfig, type CrawlConfig } from "../loop.js";
import type { CredentialVault } from "../credential-vault.js";
import {
  describeShape,
  sameShape,
  shapeOf,
  type CrawlCredentials,
  type CredentialShape,
} from "../credentials.js";
import { hostProbeStarts, normalizeUrl } from "../parse/url-utils.js";
import { isUrlAllowed, UrlPolicyError, type AddressResolver } from "../url-policy.js";
import type { TenantId } from "../../tenant.js";
import { storedCredentialsOf } from "../../worker/crawl-job.js";
import { RenderPassRefusal, runRenderPass, type RenderPassSummary } from "./run-render.js";
import { resolveRenderConfig, type RenderSelectionConfig } from "./select.js";

/**
 * How many unrenderable URLs a refusal spells out before it says "…".
 *
 * A caller who pasted a whole listing can be wrong about all of it, and a 400
 * carrying four hundred URLs is a body nobody reads. Enough to see the PATTERN
 * of the mistake — a stale host, a missing trailing slash — and the count above
 * it is exact either way.
 */
const MISSING_URLS_NAMED = 5;

/** What asked for the credentials: a request, or a schedule's chain (which never sends any). */
export type CredentialOperation = "crawl_resume" | "crawl_render" | "chain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RenderLinkOptions {
  /** A named page list (`crawl_render urls`); absent, the engine selects. */
  urls?: string[];
  /** Credentials sent with the request; a chain never passes them. */
  sent?: CrawlCredentials;
  /** Where rendered documents are written; null keeps none. */
  renderHtmlDir: string | null;
  allowPrivate: boolean;
  /** The server's crawl allowlist, applied to the hosts of `urls`. */
  hostAllowed: (host: string) => boolean;
  resolveAddress?: AddressResolver;
  log: (line: string) => void;
  where: "crawl_render" | "chain";
}

/**
 * `renderCrawl`'s work, under its `render` job: the body of
 * `ApiService.renderUnderJob`, moved here unchanged.
 */
export async function runRenderLink(
  db: Db,
  vault: CredentialVault,
  tenant: TenantId,
  crawlId: string,
  opts: RenderLinkOptions,
): Promise<RenderPassSummary> {
  const [row] = await db
    .select()
    .from(crawls)
    .where(and(eq(crawls.id, crawlId), eq(crawls.tenantId, tenant)))
    .limit(1);
  if (row === undefined) {
    throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
  }

  let config: CrawlConfig;
  try {
    config = parseStoredConfig(row.config, crawlId);
  } catch (error) {
    throw new ServiceError("CONFLICT", messageOf(error));
  }
  // Before the driver, which would throw `CredentialsMissingError` and
  // answer 500: a crawl that needed credentials is refused with the code an
  // agent acts on (27c). Validated here, as `runRenderPass` does not.
  const credentials = await credentialsFor(
    vault,
    opts.log,
    crawlId,
    opts.where,
    config.credentialShape,
    opts.sent,
  );
  const robotsCrawlDelaySec = robotsCrawlDelay(row.discovery, crawlId);
  const renderUrls =
    opts.urls === undefined
      ? undefined
      : await checkRenderUrls(db, crawlId, opts.urls, config, opts.allowPrivate, opts.hostAllowed);

  let summary: RenderPassSummary;
  try {
    summary = await runRenderPass(db, crawlId, {
      ...config,
      ...(credentials === undefined ? {} : { credentials }),
      robotsCrawlDelaySec,
      ...(renderUrls === undefined ? {} : { renderUrls }),
      // NOT left to the pass's own cwd-relative default: the directory is the
      // caller's (a SERVER property for the API, `ServiceConfig.renderDir`;
      // null for a chain), and no request may name it.
      renderHtmlDir: opts.renderHtmlDir,
      allowPrivate: opts.allowPrivate,
      ...(opts.resolveAddress === undefined ? {} : { resolveAddress: opts.resolveAddress }),
    });
  } catch (error) {
    throw mapRenderPassError(error, crawlId, opts.log);
  }
  // Stored for the next pass (Deviation 9) only once the pass was ACCEPTED
  // and ran, as a resume stores them only on acceptance: a render refused
  // for its urls, its status or a lease must not replace the stored copy (a
  // mistyped password would overwrite the right one). Never for a
  // cancelled crawl, whose credentials a cancel released: they served this
  // pass only. A cancel cannot land meanwhile — its FOR UPDATE row lock and
  // `refuseWhileBusy` hold it off while this pass's job is live.
  // The pass changes no crawl row a write could share a transaction with,
  // so the write has its own (28b).
  if (opts.sent !== undefined && credentials !== undefined && row.status !== "cancelled") {
    await db.transaction(async (tx) => {
      await vault.write(tx, tenant, crawlId, credentials);
    });
  }
  return summary;
}

/**
 * The credentials a resume or a render pass of this crawl runs with (27c),
 * given the shape its row stores (`required`) and what the request sent:
 *
 *  - sent: they must be of exactly the stored shape — the same kinds, the
 *    same header and cookie names — else VALIDATION naming both (names
 *    only). A crawl started without credentials gains them through
 *    `crawl_config_set` while paused, never through a resume or a render;
 *  - not sent, and the row needs none: none;
 *  - not sent: the stored copy, decrypted (28b; a restart keeps it), or
 *    `CREDENTIALS_REQUIRED` naming the fields when there is none (cancelled,
 *    swept by retention, or never written) or this server cannot decrypt it
 *    (`unreadable`, logged with its reason) — a refusal until they are
 *    supplied again, never a run without them.
 */
export async function credentialsFor(
  vault: CredentialVault,
  log: (line: string) => void,
  crawlId: string,
  operation: CredentialOperation,
  stored: CredentialShape | undefined,
  sent: CrawlCredentials | undefined,
): Promise<CrawlCredentials | undefined> {
  const required = stored ?? null;
  const remedy = operation === "chain" ? "schedule_update" : operation;
  if (sent !== undefined) {
    const supplied = shapeOf(sent);
    if (!sameShape(required, supplied)) {
      throw new ServiceError(
        "VALIDATION",
        required === null
          ? `crawl ${crawlId} was started without credentials, and ${operation} was sent ` +
              `${supplied === null ? "none" : describeShape(supplied)}: credentials are added ` +
              "to a crawl with crawl_config_set while it is paused"
          : `crawl ${crawlId} needs ${describeShape(required)}, and ${operation} was sent ` +
              `${supplied === null ? "none" : describeShape(supplied)}: send exactly the kinds ` +
              "and names crawl_config_get shows, with their values",
      );
    }
    return supplied === null ? undefined : sent;
  }
  if (required === null) return undefined;
  const held = storedCredentialsOf(crawlId, required, await vault.read(crawlId), log);
  if (held.kind === "missing") {
    throw new ServiceError(
      "CREDENTIALS_REQUIRED",
      `crawl ${crawlId} needs ${describeShape(required)}, and ${held.why}: send them again ` +
        `with ${remedy} (requestHeaders, httpAuth, cookies). A crawl that needed them is ` +
        "never run without them",
    );
  }
  return held.credentials;
}

/**
 * The pages a caller named for the render pass, checked and resolved to this
 * crawl's own spellings — or a refusal saying which entry stopped it.
 *
 * ## THE ORDER, and why it is this one
 *
 * Every step is a refusal, so the order decides which sentence a caller with
 * two problems is told about first. It runs cheapest-and-most-fundamental to
 * costliest:
 *
 *  1. **Non-empty.** An empty list is not "render nothing" — a pass meant to
 *     be off is a pass that is not run, the same reading `renderBudgetPct: 0`
 *     already gets.
 *  2. **Readable as a URL** (`normalizeUrl`), which also rejects every scheme
 *     the crawler does not speak. This is the spelling `pages.url` is stored
 *     in, so it is normalisation and parse in one step.
 *  3. **Deduplicated**, on that normalised spelling, first occurrence winning.
 *     Before the cap, so a list that repeats a URL is not refused for a
 *     ceiling it does not actually reach.
 *  4. **The cap.** More than `renderMaxPages` distinct pages is a 400 naming
 *     the cap, NOT a silent slice. The automatic budget cuts and says
 *     `truncated: true`, because it built the candidate list itself; a list a
 *     caller wrote is a deliberate statement about which pages matter, and
 *     rendering the first N of it while answering 200 would be this engine
 *     deciding which of somebody's templates to drop.
 *  5. **The URL policy** — hard rule 5, on every URL this engine is about to
 *     fetch, whoever supplied it. A render IS a fetch.
 *  6. **The allowlist posture**, exactly as `checkLegacyHosts` applies it: a
 *     host in the site's own family (apex/www × http/https) is authorised by
 *     the crawl itself; anything else must be in this server's allowlist in
 *     its own right. Reachable through `legacyHosts`, whose pages are in this
 *     crawl and are a different site by every definition the engine has.
 *  7. **It is a page of THIS crawl that fetched OK with a 200.** Last,
 *     because it is the only step that needs the database — and it is what
 *     makes this list a re-visit rather than a way to point the renderer at a
 *     URL nobody crawled. A URL that misses is a 400 naming it; it is never
 *     fetched.
 *
 * Steps 5 and 6 are belt-and-braces on a page the crawler already fetched
 * under both rules, and they are here anyway: the request is a fetch
 * instruction from a client, and hard rule 5 admits no "it was checked
 * earlier" exemption.
 *
 * Steps 1–6 are `checkRenderUrlList`, which needs no crawl: a schedule's
 * `render.urls` are put through it when the schedule is written (final review
 * I2), against the crawl the schedule will fire. Step 7 can only be asked of a
 * crawl that exists, so a schedule meets it at fire time, here.
 */
async function checkRenderUrls(
  db: Db,
  crawlId: string,
  urls: readonly string[],
  config: CrawlConfig,
  allowPrivate: boolean,
  hostAllowed: (host: string) => boolean,
): Promise<string[]> {
  const normalised = await checkRenderUrlList(urls, config, allowPrivate, hostAllowed, "crawl");

  // One statement for the whole list. `= any(...)` rather than a round trip
  // per URL, and the answer is the SET that resolved — the missing ones are
  // computed here so the refusal can name them rather than say "one of these".
  const found = await db
    .select({ url: pages.url })
    .from(pages)
    .where(
      and(
        eq(pages.crawlId, crawlId),
        eq(pages.fetchClass, "ok"),
        eq(pages.statusCode, 200),
        sql`${pages.url} = any(${sql.param(normalised)}::text[])`,
      ),
    );
  const renderable = new Set(found.map((r) => r.url));
  const missing = normalised.filter((url) => !renderable.has(url));
  if (missing.length > 0) {
    throw new ServiceError(
      "VALIDATION",
      `urls names ${missing.length} page(s) this crawl cannot render — ` +
        `${missing.slice(0, MISSING_URLS_NAMED).map((u) => `'${clip(u)}'`).join(", ")}` +
        `${missing.length > MISSING_URLS_NAMED ? ", …" : ""}. The render pass re-visits ` +
        `pages this crawl already fetched, so a URL must be one of them and must have ` +
        `answered 200; it is never fetched for the first time here. Check the spelling ` +
        `with pages_query, or re-crawl if the page is genuinely missing`,
    );
  }

  return normalised;
}

/**
 * Steps 1–6 of `checkRenderUrls` (its header has the order and the reasons):
 * the list non-empty, each entry a URL, de-duplicated, within `renderMaxPages`,
 * admitted by the URL policy and by the allowlist posture — everything that
 * can be known without a crawl. Answers the normalised, de-duplicated list.
 *
 * `whose` names what the cap and the site belong to in the refusal: a crawl's
 * (`crawl_render`, a chain's render link) or a schedule's (`schedule_create`
 * and `schedule_update`, whose caller can still raise `crawl.renderMaxPages`).
 */
export async function checkRenderUrlList(
  urls: readonly string[],
  config: RenderSelectionConfig & { siteUrl: string },
  allowPrivate: boolean,
  hostAllowed: (host: string) => boolean,
  whose: "crawl" | "schedule",
): Promise<string[]> {
  if (urls.length === 0) {
    throw new ServiceError(
      "VALIDATION",
      "urls was given as an empty list: a render pass with no pages is a pass not " +
        "run. Omit urls to let the engine select, or name at least one page",
    );
  }

  const normalised: string[] = [];
  const seen = new Set<string>();
  for (const entry of urls) {
    const url = normalizeUrl(entry);
    if (url === null) {
      throw new ServiceError(
        "VALIDATION",
        `urls entry '${clip(entry)}' is not an http(s) URL this engine can render`,
      );
    }
    if (seen.has(url)) continue;
    seen.add(url);
    normalised.push(url);
  }

  const { renderMaxPages } = resolveRenderConfig(config);
  if (normalised.length > renderMaxPages) {
    throw new ServiceError(
      "VALIDATION",
      `urls names ${normalised.length} distinct pages, above this ${whose}'s ` +
        `renderMaxPages of ${renderMaxPages}. The list is not silently trimmed — ` +
        `a named list is a statement about which pages matter, so shorten it to ` +
        `${renderMaxPages} or fewer. ` +
        (whose === "crawl"
          ? `A crawl's renderMaxPages is fixed at crawl_start and cannot be changed ` +
            `afterwards: a bigger budget means a new crawl started with a higher renderMaxPages`
          : `A bigger budget is a higher crawl.renderMaxPages on the schedule`),
    );
  }

  // The site's own spellings, from the `siteUrl`. A crawl's reaches
  // `hostProbeStarts` unvalidated as a URL — `parseStoredConfig` checks it is
  // a string — so a row nothing this engine wrote could produce a throw here.
  // That is the crawl's config being unreadable, not the caller's list being
  // wrong, and it gets the 409 `parseStoredConfig`'s own failure gets. (A
  // schedule's was planned by `crawl_start`'s planner as it was written.)
  let own: Set<string>;
  try {
    own = new Set(hostProbeStarts(config.siteUrl).map((start) => new URL(start).hostname));
  } catch (error) {
    throw new ServiceError("CONFLICT", messageOf(error));
  }
  for (const url of normalised) {
    const verdict = await isUrlAllowed(url, { allowPrivate });
    if (!verdict.allowed) {
      throw new ServiceError(
        "FORBIDDEN",
        `urls entry '${clip(url)}' refused by the URL policy: ` +
          `${verdict.reason ?? "no reason given"}`,
      );
    }
    const host = new URL(url).hostname;
    if (!own.has(host) && !hostAllowed(host)) {
      throw new ServiceError(
        "FORBIDDEN",
        `urls entry '${clip(url)}' is on '${host}', which is neither a spelling of ` +
          `this ${whose === "crawl" ? "crawl's own site" : "schedule's crawl.siteUrl"} ` +
          `nor in this server's crawl allowlist`,
      );
    }
  }
  return normalised;
}

/**
 * The robots half of a crawl's stored discovery evidence, VALIDATED FIELD BY
 * FIELD rather than cast.
 *
 * Two callers, and both of them act on what it says: the render pass paces
 * itself by `crawlDelaySec` (rule 9 — a pass that ignored it would be a
 * second, ruder visit), and `getRobots` publishes the text an auditor will
 * quote to a site owner. `discovery_jsonb` is a jsonb column, so by read time
 * it is whatever is in the row; a `truncated` that is not a boolean reads as
 * falsy and turns "this text is a 500KB prefix" into silence, which is the
 * exact untruth the flag exists to prevent. This is the discipline
 * `parseDiscovery` applies for the rules (src/rules/query/crawl-evidence.ts),
 * raising the API's own refusal instead of a bare Error.
 *
 * A crawl with no discovery blob is a CONFLICT rather than an empty answer:
 * `discovery_jsonb` is written by `runCrawl` before the frontier is seeded,
 * so a row without one belongs to a crawl that never got that far. Rendering
 * it would mean visiting a site at a pace we have no evidence it permits, and
 * publishing it would mean reporting "no robots.txt" about a file nobody
 * asked for (hard rule 7).
 */
export function parseRobots(
  discovery: unknown,
  crawlId: string,
): {
  outcome: string;
  raw: string | null;
  truncated: boolean;
  crawlDelaySec: number | null;
  note: string | null;
  sitemapSources: string[];
  suppliedSitemaps: string[];
} {
  if (discovery === null || discovery === undefined) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} has no discovery evidence: it never completed discovery, so ` +
        `there is nothing to render and no robots crawl-delay to honour`,
    );
  }
  if (!isRecord(discovery)) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} discovery evidence is not an object`,
    );
  }
  const robots = discovery["robots"];
  if (robots === null || typeof robots !== "object") {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} discovery evidence has no robots object`,
    );
  }
  const bad = (why: string): never => {
    throw new ServiceError("CONFLICT", `crawl ${crawlId} discovery evidence has ${why}`);
  };
  const record = robots as Record<string, unknown>;

  const outcome = record["outcome"];
  if (typeof outcome !== "string" || !(ROBOTS_OUTCOMES as readonly string[]).includes(outcome)) {
    bad(`an unknown robots.outcome (one of: ${ROBOTS_OUTCOMES.join(", ")})`);
  }
  const raw = record["raw"];
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    bad("a non-string robots.raw");
  }
  const truncated = record["truncated"];
  if (typeof truncated !== "boolean") bad("a non-boolean robots.truncated");
  const note = record["note"];
  if (note !== null && note !== undefined && typeof note !== "string") {
    bad("a non-string robots.note");
  }
  const delay = record["crawlDelaySec"];
  if (delay !== null && delay !== undefined && typeof delay !== "number") {
    bad("a non-numeric robots.crawlDelaySec");
  }
  // The declared sitemaps live one level up, on the discovery blob itself —
  // every one of them came off a `Sitemap:` line in this file
  // (`discoveryEvidence`, src/crawl/loop.ts).
  const sources = discovery["sitemapSources"];
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) {
    bad("no sitemapSources array of strings");
  }
  // Its sibling: the documents the CLIENT supplied, which the walk read too.
  // Absent is empty — the field arrived with the ability to supply a sitemap,
  // so a crawl written before it had none — and the wrong shape is a refusal,
  // because "no sitemap was supplied" is a claim about how this crawl was run
  // and must not be invented (the `parseDiscovery` ruling, hard rule 7).
  const supplied = discovery["suppliedSitemaps"];
  if (
    supplied !== undefined &&
    supplied !== null &&
    (!Array.isArray(supplied) || supplied.some((s) => typeof s !== "string"))
  ) {
    bad("a suppliedSitemaps that is not an array of strings");
  }

  return {
    outcome: outcome as string,
    raw: (raw as string | null | undefined) ?? null,
    truncated: truncated as boolean,
    crawlDelaySec: (delay as number | null | undefined) ?? null,
    note: (note as string | null | undefined) ?? null,
    sitemapSources: sources as string[],
    suppliedSitemaps: (supplied as string[] | null | undefined) ?? [],
  };
}

/** The crawl-delay the render pass has to honour, off the same evidence. */
function robotsCrawlDelay(discovery: unknown, crawlId: string): number | null {
  return parseRobots(discovery, crawlId).crawlDelaySec;
}

/**
 * Map a `runRenderPass` throw onto a service refusal.
 *
 * The driver's deliberate refusals are `RenderPassRefusal`s and carry the
 * answer they need (`live` → 409, `missing` → 404); everything else it throws
 * is a defect and is returned untouched, to become a 500 with a correlation id.
 *
 * This used to match on the message prefix, and that was wrong in a way worth
 * recording: `runRenderPass`'s `RangeError` for a bad `renderConcurrency` also
 * begins `runRenderPass: `, so our own bug was being handed to the caller as
 * "the crawl is busy, try later". The type is carried by the throw now, and the
 * guards' wording is free to change without changing this function.
 */
export function mapRenderPassError(
  error: unknown,
  crawlId: string,
  log: (line: string) => void,
): unknown {
  // The render browser could not be launched against this crawl's site:
  // url-policy refused the address the site's name resolves to, or could not
  // resolve it (Phase 24a's DNS pin). A fact about the site and the network,
  // not our defect, so a 409 naming the reason — never a 500 "internal error"
  // the caller can do nothing with. Nothing was rendered; the rows the
  // selection put in `render_pending` stay there, exactly as any launch
  // failure leaves them, and a later pass re-selects.
  //
  // WHAT THE REASON MAY SAY is bounded where it is written
  // (`resolveApprovedAddress`, "What the thrown message may say"): a refused
  // address keeps the host, the answer and the range, because that is public
  // DNS data about the caller's own site and the sentence the crawl's blocked
  // fetches already carry. A resolver failure says only that the name could
  // not be resolved; the resolver's own message rides on `cause` and goes
  // where a 500's stack goes — the log, under a correlation id the caller is
  // handed so an operator can find the line (obligation 6, same seam as
  // `http.ts`'s 500).
  if (error instanceof UrlPolicyError) {
    let reason = error.message;
    if (error.cause !== undefined) {
      const correlationId = randomUUID();
      log(
        `api: render launch ${correlationId} crawl ${crawlId} — ${error.message}: ` +
          messageOf(error.cause),
      );
      reason = `${reason}; detail logged under ${correlationId}`;
    }
    return new ServiceError("CONFLICT", `the render pass could not start: ${reason} (${error.code})`);
  }
  if (!(error instanceof RenderPassRefusal)) return error;
  // The `runRenderPass: ` prefix is the driver naming itself to a log reader.
  // A caller of the API already knows which endpoint they called.
  const message = error.message.startsWith("runRenderPass: ")
    ? error.message.slice("runRenderPass: ".length)
    : error.message;
  return new ServiceError(error.reason === "missing" ? "NOT_FOUND" : "CONFLICT", message);
}
