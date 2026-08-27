/**
 * The JavaScript redirect rule (CHECK-10).
 *
 * A page that answers a plain 200 over HTTP and then sends the browser
 * somewhere else once its JavaScript runs. The HTTP layer saw no `Location`
 * header and no 3xx, so `redirect.chain` and `redirect.loop` — which read
 * `fetch_class = 'redirect'` — cannot see this at all: to a crawler that does
 * not execute script, the URL is a live page, and to a search engine it is a
 * page whose content is somewhere else.
 *
 * **THIS RULE DOES NOT GATE ON `rendered`, and that is deliberate rather than an
 * oversight.** Its gate is `rendered_redirect_url is not null` plus
 * `fetch_class = 'ok'`, and the reason is written from the other side at the
 * `rendered_redirect_url` column comment (src/db/schema.ts) and at
 * `RenderResult.redirectUrl` (src/crawl/render/renderer.ts): when the page sends
 * itself to ANOTHER ORIGIN the render pass records where it wanted to go and
 * refuses to follow it, which leaves the browser with no DOM of this site's to
 * measure. That row is `rendered = false`, `render_error = 'off-site navigation:
 * …'`, and this column set. It is the commonest shape of the fact and the most
 * serious one, so a `rendered = true` gate would blind the rule to exactly the
 * case it exists to find. A non-null redirect URL IS the render evidence.
 *
 * `fetch_class = 'ok'` is the other half of the gate and does the opposite job:
 * a URL the server itself redirected is already claimed, by the redirect rules,
 * with their own copy and their own fix. This rule speaks only for the JS-only
 * case.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import { assertCrawl, noteTruncation, URL_FINDING_CAP } from "./crawl-evidence.js";

const JS_REDIRECT: RuleIdentity = { id: "redirect.js", severity: "warning" };

/**
 * Pages that redirect themselves in the browser after answering 200 (CHECK-10).
 *
 * No `assertRenderedColumns` guard here, and none is owed: this rule reads one
 * TEXT column whose null is meaningful ("the page navigated nowhere"), not a
 * count whose null would silently drop a row from an arithmetic comparison.
 *
 * The evidence names both URLs as a pair. `pageUrl` already reaches the `issues`
 * row's details through the runner, so `fromUrl` repeats it — deliberately: a
 * redirect is a statement about two URLs together, and an action plan that lifts
 * the evidence blob out of the row must not have to reassemble one side of it
 * from the row's other columns. `rendered` and `renderError` travel with them
 * because they say WHICH shape of the defect this is: a `rendered: false` with an
 * off-site error is a page that left the site entirely, which is a different
 * conversation from one that rewrote its own URL and stayed.
 */
async function jsRedirectFindings(db: Db, crawlId: string): Promise<Finding[]> {
  // A crawl id nothing knows scans no pages, which reads exactly like a site
  // with no JS redirects (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, JS_REDIRECT.id);

  const res = await db.execute<{
    id: string;
    url: string;
    status_code: number | null;
    rendered: boolean;
    rendered_redirect_url: string;
    render_error: string | null;
    total_matches: number;
  }>(sql`
    select p.id, p.url, p.status_code, p.rendered, p.rendered_redirect_url, p.render_error,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and p.rendered_redirect_url is not null
      and p.fetch_class = 'ok'
    order by p.url
    limit ${URL_FINDING_CAP}`);

  const findings = res.rows.map((row) =>
    queryFinding(JS_REDIRECT, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: {
        fromUrl: row.url,
        toUrl: row.rendered_redirect_url,
        statusCode: row.status_code,
        rendered: row.rendered,
        renderError: row.render_error,
      },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, res.rows[0]?.total_matches ?? 0);
}

export const renderRedirectRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: JS_REDIRECT.id,
    checkIds: ["CHECK-10"],
    category: "redirects",
    severity: JS_REDIRECT.severity,
    ...copyFor(JS_REDIRECT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => jsRedirectFindings(db, crawlId),
  }),
];
