import { sql } from "drizzle-orm";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";

/**
 * BCP-47-lite: a 2–3 letter language, optionally followed by a region that is
 * either two letters (a country) or three digits (a UN M.49 area). Deliberately
 * narrower than the full BCP-47 grammar — scripts and variants are vanishingly
 * rare in hreflang and a false "invalid" is worse than a missed exotic code.
 * `x-default` is the one special value and is checked separately.
 *
 * This is a test of FORM ONLY; there is no ISO membership check, so a
 * well-formed but nonexistent code (`en-XX`, `zz`) passes. Shipping the ISO
 * 639/3166 tables to catch it would mean keeping them current, and the far
 * commoner mistake — `en_GB`, `english`, `en-UK` — is a shape this catches.
 */
const HREFLANG_CODE = /^[a-z]{2,3}(-(?:[a-z]{2}|\d{3}))?$/i;

const CATEGORY = "hreflang";

/**
 * Hreflang rules are `kind: "query"` rather than page rules because hreflang
 * declarations live in their own table, one row per declaration — they are not
 * a column on `pages` a page rule could read.
 */
export const hreflangRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: "hreflang.invalid-code",
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: "warning",
    ...copyFor("hreflang.invalid-code"),
    rulesetVersion: RULESET_VERSION,
    // The validity test runs in JS over the crawl's hreflang rows, streamed
    // once — acceptable at this scale. A site with millions of declarations
    // would want the pattern pushed into SQL.
    run: async (db, crawlId): Promise<Finding[]> => {
      const res = await db.execute<{
        page_id: string;
        hreflang_code: string;
        target_url: string;
        page_url: string;
      }>(sql`
        select h.page_id, h.hreflang_code, h.target_url, p.url as page_url
        from hreflang h join pages p on p.id = h.page_id
        where h.crawl_id = ${crawlId}`);
      // The analyzer stores the attribute verbatim, so `hreflang="en-GB "` — a
      // formatting artefact, not a mistake — arrives with its whitespace. Trim
      // before judging it; surrounding space is not what makes a code invalid.
      return res.rows
        .map((r) => ({ ...r, code: String(r.hreflang_code).trim() }))
        .filter(
          ({ code }) => code.toLowerCase() !== "x-default" && !HREFLANG_CODE.test(code),
        )
        .map((r) => ({
          ruleId: "hreflang.invalid-code",
          pageId: String(r.page_id),
          pageUrl: String(r.page_url),
          severity: "warning" as const,
          evidence: { code: r.code, targetUrl: r.target_url },
          // One finding per declaration, not per page: a page can carry several
          // broken codes and each is a separate thing to fix.
          dedupeKey: `${r.page_url}#${r.code}`,
        }));
    },
  }),

  // A site-wide fact with no page to attach to, hence the null page and the
  // fixed dedupe key: x-default is declared once for a cluster, and its absence
  // is a property of the annotation set, not of any one URL.
  defineRule<QueryRule>({
    kind: "query",
    id: "hreflang.missing-x-default",
    checkIds: ["CHECK-25"],
    category: CATEGORY,
    severity: "info",
    ...copyFor("hreflang.missing-x-default"),
    rulesetVersion: RULESET_VERSION,
    run: async (db, crawlId): Promise<Finding[]> => {
      // `trim` for the same reason as invalid-code: a stored `"x-default "`
      // is a real fallback declaration, and missing it would report the whole
      // site as lacking one.
      const counts = await db.execute<{ xd: string; total: string }>(sql`
        select count(*) filter (where lower(trim(hreflang_code)) = 'x-default') as xd,
               count(*) as total
        from hreflang where crawl_id = ${crawlId}`);
      const row = counts.rows[0]!;
      // No annotations at all is not a missing x-default — a site with no
      // hreflang has nothing to fall back from.
      if (Number(row.total) === 0 || Number(row.xd) > 0) return [];
      return [
        {
          ruleId: "hreflang.missing-x-default",
          pageId: null,
          pageUrl: null,
          severity: "info",
          evidence: { declarations: Number(row.total) },
          dedupeKey: "site",
        },
      ];
    },
  }),
];
