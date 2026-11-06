/**
 * The security rules: what the HTTPS pages of a crawl sent in their response
 * headers, and what they pointed at over plain HTTP (Phase 26a).
 *
 * Five rules, all over evidence the crawl already stored — `pages.response_headers`
 * (migration 0025) and `page_resources` — and none of them fetches (hard rule 2)
 * or loads a table into memory (hard rule 3):
 *
 *  - `security.hsts-missing`      an HTTPS page that sent no `Strict-Transport-Security`
 *  - `security.headers-missing`   an HTTPS page missing CSP, `nosniff`, frame protection
 *                                 or a safe `Referrer-Policy`
 *  - `security.headers-not-recorded`  the NOT MEASURED marker for the crawl that stored no
 *                                 headers (see below)
 *  - `security.http-url`          an HTTPS page linking to an `http:` URL on the site's own
 *                                 host, on a site crawled over `https:`
 *  - `security.mixed-content`     an HTTPS page referencing an image, script or stylesheet
 *                                 over `http:`
 *
 * **THE COHORT** for the header rules and mixed content is the HTTPS pages the
 * crawl fetched OK with a 200 (`FETCHED_OK`, URL starting `https:`). A plain-HTTP
 * page cannot send HSTS and is judged by the host rules instead; a page that
 * never answered has no headers to read.
 *
 * **WHY THE HEADER RULES ARE QUERY RULES, AND WHY THEY HAVE A MARKER.** A crawl
 * written before Phase 25 stores no response headers: `response_headers` is null on
 * every row. A page rule is handed one row and cannot tell that null from "the
 * server sent nothing", so it would file an HSTS finding on every page of an old
 * crawl, which is a false accusation, or pass them all, which is the always-passes
 * hole (hard rule 1). The census that separates the two is a question about the
 * crawl, so both header rules start with `extractionCoverage(db, crawlId, 1)` and
 * return nothing when any page was written below version 1; the marker fires
 * instead. A MIXED crawl gets the marker too: the coverage helper's contract is to
 * refuse rather than judge part of a crawl.
 *
 * A current-extraction HTTPS 200 with a null `response_headers` is not a row the
 * writer produces (null means no response arrived, and such a page is not
 * `FETCHED_OK`), so it is a corrupt row and throws rather than reading as "every
 * header missing" (hard rule 7).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import type { StoredResponseHeaders } from "../../crawl/response-headers.js";
import { extractionCoverage, FETCHED_OK, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { UNSAFE_REFERRER_POLICIES } from "../thresholds.js";
import { capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { BROKEN_SAMPLE_RESOURCES } from "./resources.js";

/** Pages read per round trip by the header scan: a batch, never the table. */
export const SECURITY_BATCH = 500;

const CATEGORY = "technical" as const;

const HSTS_MISSING: RuleIdentity = { id: "security.hsts-missing", severity: "warning" };
const HEADERS_MISSING: RuleIdentity = { id: "security.headers-missing", severity: "info" };
const HEADERS_NOT_RECORDED: RuleIdentity = {
  id: "security.headers-not-recorded",
  severity: "info",
};
const HTTP_URL: RuleIdentity = { id: "security.http-url", severity: "warning" };
const MIXED_CONTENT: RuleIdentity = { id: "security.mixed-content", severity: "warning" };

/** Every occurrence of a header, in arrival order; empty when the page did not send it. */
function occurrences(h: StoredResponseHeaders, name: string): string[] {
  return (h.values[name] ?? []).filter((v) => v.trim() !== "");
}

/** The comma-separated tokens of every occurrence, trimmed and lower-cased. */
function tokens(h: StoredResponseHeaders, name: string): string[] {
  return occurrences(h, name)
    .flatMap((v) => v.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
}

/**
 * The policy tokens the Referrer-Policy specification defines. A browser applies
 * the last token of the combined header it RECOGNISES, so an unknown token after
 * a known one does not replace it.
 */
const KNOWN_REFERRER_POLICIES: readonly string[] = [
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
];

/**
 * Which of the four protective headers an HTTPS page lacks, in the order the
 * evidence lists them, plus the unsafe `Referrer-Policy` value when that is why
 * the policy counts as missing.
 *
 * EVERY OCCURRENCE IS READ: `StoredResponseHeaders` keeps each one, and a CDN
 * and an application that both set a header is an ordinary stack. Browsers
 * combine repeated headers, so the values are joined before they are parsed.
 *
 *  - `content-security-policy`: any enforcing occurrence. Report-Only observes
 *    and blocks nothing, so it does not count.
 *  - `x-content-type-options`: the first token of the combined value is
 *    `nosniff`, any case.
 *  - `frame-protection`: every `X-Frame-Options` token is `DENY` or `SAMEORIGIN`,
 *    or ANY CSP occurrence has a `frame-ancestors` directive (every enforced
 *    policy applies, so one occurrence is enough). A CSP cut at the storage cap
 *    (`truncated`) may have had the directive past the cut, so when none was seen
 *    in what survives, frame protection is not reported missing: absence cannot
 *    be shown from a cut value.
 *  - `referrer-policy`: no recognised policy token, or the last recognised token
 *    is in `UNSAFE_REFERRER_POLICIES`.
 */
export function missingSecurityHeaders(h: StoredResponseHeaders): {
  missing: string[];
  referrerPolicy: string | null;
} {
  const missing: string[] = [];
  const csp = occurrences(h, "content-security-policy");
  if (csp.length === 0) missing.push("content-security-policy");

  if (tokens(h, "x-content-type-options")[0] !== "nosniff") {
    missing.push("x-content-type-options");
  }

  const xfo = tokens(h, "x-frame-options");
  const xfoOk = xfo.length > 0 && xfo.every((t) => t === "deny" || t === "sameorigin");
  const cspFrames = csp.some((v) => /(?:^|[\s;])frame-ancestors(?:\s|;|$)/i.test(v));
  const cspCut = h.truncated.includes("content-security-policy");
  if (!xfoOk && !cspFrames && !cspCut) missing.push("frame-protection");

  const recognised = tokens(h, "referrer-policy").filter((t) =>
    KNOWN_REFERRER_POLICIES.includes(t),
  );
  const last = recognised[recognised.length - 1];
  let referrerPolicy: string | null = null;
  if (last === undefined) {
    missing.push("referrer-policy");
  } else if ((UNSAFE_REFERRER_POLICIES as readonly string[]).includes(last)) {
    missing.push("referrer-policy");
    referrerPolicy = last;
  }
  return { missing, referrerPolicy };
}

/** The HTTPS pages the crawl fetched OK with a 200, over an aliased `pages`. */
const HTTPS_COHORT = sql`${FETCHED_OK("p")} and starts_with(p.url, 'https:')`;

type Gate = { recorded: true } | { recorded: false; below: number; atOrAbove: number };

/**
 * Whether every page of the crawl carries Phase 25 evidence. When it does not the
 * rules return nothing and the marker speaks.
 */
async function headersGate(db: Db, crawlId: string): Promise<Gate> {
  const { atOrAbove, below } = await extractionCoverage(db, crawlId, 1);
  return below > 0 ? { recorded: false, below, atOrAbove } : { recorded: true };
}

function corruptHeaders(url: string): Error {
  return new Error(
    `security: ${url} is an HTTPS 200 written by a current extraction with no stored ` +
      "response headers; refusing to read that as 'every header missing'",
  );
}

/**
 * Walk the HTTPS cohort in `url` order (Postgres's own order, so the listing is
 * the one `order by p.url` gives its siblings), a batch at a time, and keep the
 * findings `evidenceFor` produces up to the listing cap.
 *
 * The scan runs to the end either way, so the total behind `noteTruncation` is
 * exact while memory stays O(batch + cap) (hard rule 6). A current-extraction
 * HTTPS 200 with no stored headers throws wherever it is met, inside the cap or
 * past it (hard rule 7).
 */
async function scanHttpsPages(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
  evidenceFor: (h: StoredResponseHeaders) => Record<string, unknown> | null,
): Promise<Finding[]> {
  if (!(await headersGate(db, crawlId)).recorded) return [];
  const findings: Finding[] = [];
  let total = 0;
  let cursor = "";
  for (;;) {
    const batch = await db.execute<{
      id: string;
      url: string;
      response_headers: StoredResponseHeaders | null;
    }>(sql`
      select p.id, p.url, p.response_headers
      from pages p
      where p.crawl_id = ${crawlId} and ${HTTPS_COHORT} and p.url > ${cursor}
      order by p.url
      limit ${SECURITY_BATCH}`);
    if (batch.rows.length === 0) break;
    cursor = batch.rows[batch.rows.length - 1]!.url;
    for (const row of batch.rows) {
      if (row.response_headers === null) throw corruptHeaders(row.url);
      const evidence = evidenceFor(row.response_headers);
      if (evidence === null) continue;
      total += 1;
      if (caps.listing !== null && findings.length >= caps.listing) continue;
      findings.push(
        queryFinding(self, {
          pageId: row.id,
          pageUrl: row.url,
          evidence,
          dedupeKey: row.url,
        }),
      );
    }
  }
  return noteTruncation(findings, total);
}

function hstsMissingFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  return scanHttpsPages(self, db, crawlId, caps, (h) =>
    hstsProblem(h),
  );
}

/**
 * Why a page's HSTS header does not protect, or null when it does. A missing
 * header, `max-age=0` (which tells browsers to DROP HSTS) and a header with no
 * parseable max-age all leave the page unprotected. A browser reads the first
 * Strict-Transport-Security header (RFC 6797 8.1), so that one decides.
 */
function hstsProblem(h: StoredResponseHeaders): Record<string, unknown> | null {
  const first = occurrences(h, "strict-transport-security")[0];
  if (first === undefined) return {};
  for (const directive of first.split(";")) {
    const m = /^\s*max-age\s*=\s*"?(\d+)"?\s*$/i.exec(directive);
    if (m === null) continue;
    return Number(m[1]) === 0
      ? { hstsProblem: "max-age is 0, which tells browsers to drop HSTS" }
      : null;
  }
  return { hstsProblem: "no valid max-age directive" };
}

function headersMissingFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  return scanHttpsPages(self, db, crawlId, caps, (h) => {
    const { missing, referrerPolicy } = missingSecurityHeaders(h);
    if (missing.length === 0) return null;
    return referrerPolicy === null ? { missing } : { missing, referrerPolicy };
  });
}

async function headersNotRecordedFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
): Promise<Finding[]> {
  const gate = await headersGate(db, crawlId);
  if (gate.recorded) return [];
  const cohort = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pages p
    where p.crawl_id = ${crawlId} and ${HTTPS_COHORT}`);
  if ((cohort.rows[0]?.n ?? 0) === 0) return [];
  return [
    queryFinding(self, {
      pageId: null,
      pageUrl: null,
      evidence: { pagesNotRecorded: gate.below, pagesRecorded: gate.atOrAbove },
      dedupeKey: "site",
    }),
  ];
}

/**
 * The host part of an `http:` link target as the analyzer stores it: the
 * `normalizeUrl` spelling (lower-cased host, default port dropped), optionally
 * with userinfo, and an IPv6 literal kept in its brackets. A port is not part of
 * the host, so `http://site:8080/` is still the site's host.
 */
const HTTP_TARGET_HOST = String.raw`^http://(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)`;

/**
 * `security.http-url`: on a site crawled over `https:`, an HTTPS page fetched
 * OK with a 200 that links (`<a href>`) to an `http:` URL on the site's own host.
 *
 * WHY LINKS AND NOT PAGES. The crawl never fetches such a URL: `enqueue` admits
 * a URL only when `isSameOrigin(url, siteUrl)` holds, which on an `https:` site
 * refuses every `http:` spelling, so there is never an `http:` row in `pages` to
 * report. What the crawl does keep is the link that points there, and that link
 * is the defect the site owner can fix.
 *
 * NOT `links.is_internal`: the writer sets it with the same `isSameOrigin`, so
 * an `http:` target on an `https:` page is stored as external. The host is
 * matched here instead, with `isSameOrigin`'s host equivalence (equal, modulo
 * one leading `www.`), in SQL (hard rule 3).
 *
 * Evidence: the exact number of distinct `http:` targets on the page and a
 * sorted sample of them. An `http:` site is the host rules' job, so it files
 * nothing; a crawl that does not exist throws.
 */
async function httpUrlFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const crawl = await db.execute<{ site_url: string }>(sql`
    select site_url from crawls where id = ${crawlId}`);
  const siteUrl = crawl.rows[0]?.site_url;
  // The crawl must exist before anything is concluded from an empty scan.
  if (siteUrl === undefined) throw new Error(`security.http-url: no crawl '${crawlId}'`);
  // A site crawled over http is judged by the host rules; an http link on it is
  // the site, not a downgrade.
  if (!siteUrl.startsWith("https:")) return [];
  const apex = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
  const result = await db.execute<{
    id: string;
    url: string;
    http_target_count: number;
    sample: string[];
    total_matches: number;
  }>(sql`
    select p.id, p.url,
           count(distinct l.target_url)::int as http_target_count,
           (array_agg(distinct l.target_url order by l.target_url))[1:${BROKEN_SAMPLE_RESOURCES}] as sample,
           count(*) over ()::int as total_matches
    from pages p
    join links l on l.crawl_id = p.crawl_id and l.source_page_id = p.id
    where p.crawl_id = ${crawlId} and ${HTTPS_COHORT}
      and starts_with(l.target_url, 'http:')
      and lower(substring(l.target_url from ${HTTP_TARGET_HOST})) in (${apex}, ${"www." + apex})
    group by p.id, p.url
    order by p.url
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: { httpTargetCount: row.http_target_count, sample: row.sample },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

async function mixedContentFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  const result = await db.execute<{
    id: string;
    url: string;
    insecure_count: number;
    sample: string[];
    total_matches: number;
  }>(sql`
    select p.id, p.url,
           count(*)::int as insecure_count,
           (array_agg(pr.resource_url order by pr.resource_url))[1:${BROKEN_SAMPLE_RESOURCES}] as sample,
           count(*) over ()::int as total_matches
    from pages p
    join page_resources pr on pr.crawl_id = p.crawl_id and pr.page_id = p.id
    where p.crawl_id = ${crawlId} and ${HTTPS_COHORT}
      and starts_with(pr.resource_url, 'http:')
    group by p.id, p.url
    order by p.url
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) =>
    queryFinding(self, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: { insecureCount: row.insecure_count, sample: row.sample },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

export const securityRules: QueryRule[] = [
  // HSTS is the one header with its own rule: it is what makes a browser refuse
  // the plain-HTTP spelling at all, so its absence is a warning where the other
  // four are advice.
  defineRule<QueryRule>({
    kind: "query",
    id: HSTS_MISSING.id,
    checkIds: ["CHECK-84"],
    category: CATEGORY,
    severity: HSTS_MISSING.severity,
    columns: [{ key: "hstsProblem", label: "HSTS Problem", optional: true }],
    ...copyFor(HSTS_MISSING.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => hstsMissingFindings(HSTS_MISSING, db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: HEADERS_MISSING.id,
    checkIds: ["CHECK-84"],
    category: CATEGORY,
    severity: HEADERS_MISSING.severity,
    columns: [
      { key: "missing", label: "Missing Headers" },
      { key: "referrerPolicy", label: "Referrer-Policy", optional: true },
    ],
    ...copyFor(HEADERS_MISSING.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) =>
      headersMissingFindings(HEADERS_MISSING, db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: HEADERS_NOT_RECORDED.id,
    checkIds: ["CHECK-84"],
    category: CATEGORY,
    severity: HEADERS_NOT_RECORDED.severity,
    columns: [
      { key: "pagesNotRecorded", label: "Pages Without Recorded Headers" },
      { key: "pagesRecorded", label: "Pages With Recorded Headers" },
    ],
    ...copyFor(HEADERS_NOT_RECORDED.id),
    rulesetVersion: RULESET_VERSION,
    marker:
      "This crawl did not record the response headers of every page, so security header checks were not run; re-crawl the site.",
    run: (db, crawlId) => headersNotRecordedFindings(HEADERS_NOT_RECORDED, db, crawlId),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: HTTP_URL.id,
    checkIds: ["CHECK-14"],
    category: "host",
    severity: HTTP_URL.severity,
    columns: [
      { key: "httpTargetCount", label: "HTTP URLs Linked" },
      { key: "sample", label: "HTTP URL Sample" },
    ],
    ...copyFor(HTTP_URL.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => httpUrlFindings(HTTP_URL, db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: MIXED_CONTENT.id,
    checkIds: ["CHECK-85"],
    category: CATEGORY,
    severity: MIXED_CONTENT.severity,
    columns: [
      { key: "insecureCount", label: "Insecure Resources" },
      { key: "sample", label: "Insecure Resource URLs" },
    ],
    ...copyFor(MIXED_CONTENT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => mixedContentFindings(MIXED_CONTENT, db, crawlId, capsOr(caps)),
  }),
];
