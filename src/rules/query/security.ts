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
 *  - `security.http-url`          an `http:` page on a site crawled over `https:`
 *  - `security.mixed-content`     an HTTPS page referencing an image, script or stylesheet
 *                                 over `http:`
 *
 * **THE COHORT** for the header rules and mixed content is the HTTPS pages the
 * crawl fetched OK with a 200 (`FETCHED_OK`, URL starting `https:`). A plain-HTTP
 * page cannot send HSTS and is judged by `security.http-url` and the host rules
 * instead; a page that never answered has no headers to read.
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

/** The first value of a header, or null when the page did not send it. */
function firstValue(h: StoredResponseHeaders, name: string): string | null {
  const values = h.values[name];
  return values === undefined || values.length === 0 ? null : (values[0] ?? null);
}

/**
 * Which of the four protective headers an HTTPS page lacks, in the order the
 * evidence lists them, plus the unsafe `Referrer-Policy` value when that is why
 * the policy counts as missing.
 *
 *  - `content-security-policy`: the enforcing header only. Report-Only observes
 *    and blocks nothing, so it does not count.
 *  - `x-content-type-options`: present only as `nosniff`, any case.
 *  - `frame-protection`: `X-Frame-Options` `DENY` or `SAMEORIGIN`, or a CSP with a
 *    `frame-ancestors` directive.
 *  - `referrer-policy`: absent, or its last token is in `UNSAFE_REFERRER_POLICIES`.
 *    The last token because the browser applies the last policy it understands.
 */
export function missingSecurityHeaders(h: StoredResponseHeaders): {
  missing: string[];
  referrerPolicy: string | null;
} {
  const missing: string[] = [];
  const csp = firstValue(h, "content-security-policy");
  if (csp === null || csp.trim() === "") missing.push("content-security-policy");

  const nosniff = firstValue(h, "x-content-type-options");
  if (nosniff === null || nosniff.trim().toLowerCase() !== "nosniff") {
    missing.push("x-content-type-options");
  }

  const xfo = firstValue(h, "x-frame-options");
  const xfoOk = xfo !== null && ["deny", "sameorigin"].includes(xfo.trim().toLowerCase());
  const cspFrames = csp !== null && /(?:^|[\s;])frame-ancestors(?:\s|;|$)/i.test(csp);
  if (!xfoOk && !cspFrames) missing.push("frame-protection");

  const referrer = firstValue(h, "referrer-policy");
  let referrerPolicy: string | null = null;
  if (referrer === null || referrer.trim() === "") {
    missing.push("referrer-policy");
  } else {
    const last = referrer.split(",").pop()!.trim().toLowerCase();
    if ((UNSAFE_REFERRER_POLICIES as readonly string[]).includes(last)) {
      missing.push("referrer-policy");
      referrerPolicy = last;
    }
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

async function hstsMissingFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  if (!(await headersGate(db, crawlId)).recorded) return [];
  const result = await db.execute<{
    id: string;
    url: string;
    unrecorded: boolean;
    total_matches: number;
  }>(sql`
    select p.id, p.url, (p.response_headers is null) as unrecorded,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId} and ${HTTPS_COHORT}
      and not coalesce(p.response_headers->'values' ? 'strict-transport-security', false)
    order by p.url
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) => {
    if (row.unrecorded) throw corruptHeaders(row.url);
    return queryFinding(self, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {},
      dedupeKey: row.url,
    });
  });
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

async function headersMissingFindings(
  self: RuleIdentity,
  db: Db,
  crawlId: string,
  caps: RuleCaps,
): Promise<Finding[]> {
  if (!(await headersGate(db, crawlId)).recorded) return [];
  const found: Finding[] = [];
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
      where p.crawl_id = ${crawlId} and ${HTTPS_COHORT} and p.id > ${cursor}
      order by p.id
      limit ${SECURITY_BATCH}`);
    if (batch.rows.length === 0) break;
    cursor = batch.rows[batch.rows.length - 1]!.id;
    for (const row of batch.rows) {
      if (row.response_headers === null) throw corruptHeaders(row.url);
      const { missing, referrerPolicy } = missingSecurityHeaders(row.response_headers);
      if (missing.length === 0) continue;
      total += 1;
      found.push(
        queryFinding(self, {
          pageId: row.id,
          pageUrl: row.url,
          evidence: referrerPolicy === null ? { missing } : { missing, referrerPolicy },
          dedupeKey: row.url,
        }),
      );
    }
  }
  // The scan walks in id order and the listing is URL order, like its siblings,
  // so a capped run names the same pages every time. Only the findings of one
  // crawl's hits are held at once, and they are cut to the cap straight away.
  found.sort((a, b) => (a.pageUrl ?? "").localeCompare(b.pageUrl ?? ""));
  const listed = caps.listing === null ? found : found.slice(0, caps.listing);
  return noteTruncation(listed, total);
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
  // A site crawled over http is judged by the host rules; an http page on it is
  // the site, not a downgrade.
  if (!siteUrl.startsWith("https:")) return [];
  const result = await db.execute<{ id: string; url: string; total_matches: number }>(sql`
    select p.id, p.url, count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId} and ${FETCHED_OK("p")} and starts_with(p.url, 'http:')
    order by p.url
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) =>
    queryFinding(self, { pageId: row.id, pageUrl: row.url, evidence: {}, dedupeKey: row.url }),
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
    columns: [],
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
    columns: [],
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
