/**
 * The fixture contract: one engineered page, one set of rule ids it must make
 * the engine produce.
 *
 * A fixture is not a unit test. It is a page served over real HTTP, crawled by
 * the real crawler, judged by the real rules, and read back out of the `issues`
 * table — so `expectedIssues` is an end-to-end claim about the whole engine,
 * not about one function.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { absorbedFixtures } from "./pages/absorbed.js";
import { authoredFixtures } from "./pages/authored.js";
import { authoredP3Fixtures } from "./pages/authored-p3.js";
import { authoredP7Fixtures } from "./pages/authored-p7.js";
import { authoredP11Fixtures } from "./pages/authored-p11.js";
import { authoredP23Fixtures } from "./pages/authored-p23.js";
import { authoredP25Fixtures } from "./pages/authored-p25.js";
import { authoredP26Fixtures } from "./pages/authored-p26.js";
import { controlFixture } from "./pages/control.js";
import { renderFixtures } from "./pages/render-p5.js";

export interface Fixture {
  /**
   * Path this fixture is served at, e.g. "/head/missing-title".
   *
   * A path may carry a query string (`/authored3/tracked?utm_source=…`), and
   * then it is the whole request target that identifies the fixture: the app
   * matches the raw URL first and the path alone second (see `startFixtureApp`),
   * the hub links this exact string, and the harness keys its assertions on
   * pathname + search. That is what lets a parameterised URL be a fixture with
   * expectations of its own rather than a page nothing can assert about.
   */
  path: string;
  /** Grouping, for reading a failure quickly. */
  category: string;
  name: string;
  /**
   * Rule ids that fire on this path. Read as a floor by default — a page can
   * trip a rule it was not built for, and the harness asserts containment —
   * unless `exact` says otherwise. The one page that must fire *nothing* is
   * `/control`.
   */
  expectedIssues: string[];
  /**
   * Whether `expectedIssues` is the COMPLETE set of rules the page fires rather
   * than a floor. The authored fixtures set it: each one starts from the
   * control recipe and breaks exactly the signals its name promises, so any
   * other finding is either a defect in the page or a rule that has grown too
   * eager, and a containment assertion would notice neither.
   *
   * The absorbed pages leave it unset. Their content came from upstream to
   * demonstrate one issue, not to be silent about the other twenty-seven, so
   * pinning their full finding set would be asserting something we did not
   * engineer.
   */
  exact?: boolean;
  /**
   * Whether `/sitemap.xml` lists this fixture's URL. Default true.
   *
   * The default is what keeps the sitemap rules honest rather than deafening:
   * `pages.not-in-sitemap` fires on EVERY indexable 200 the sitemap omits, so a
   * site whose sitemap listed a handful of pages would put that finding on most
   * of the collection and every `exact` list would have to carry it. Listing by
   * default and opting out one page at a time makes each omission a decision
   * with a reason beside it, and there are only three reasons in the whole
   * collection:
   *
   *  - the page is not an indexable 200 (a 404, a redirect, a noindex), so a
   *    listing would fire a sitemap rule on a page that is not what this fixture
   *    is about — except for the three entries deliberately left listed, which
   *    are exactly what `sitemap.non-200`, `sitemap.redirected` and
   *    `sitemap.non-indexable` report;
   *  - the page's DEPTH is the thing under test. Sitemap entries are enqueued at
   *    depth 0 before the crawl starts (see the crawl loop's seeding), so a
   *    listed page is a depth-0 page whatever links to it — which would quietly
   *    flatten the deep click-path and silence `structure.deep-page`;
   *  - `/authored3/unlisted`, which exists to be the page the sitemap forgot.
   */
  inSitemap?: boolean;
  /**
   * The request target `/sitemap.xml` publishes for this fixture, when it
   * deliberately differs from `path`. Default: `path` itself.
   *
   * A sitemap is written by a CMS, not by the crawler, and it publishes URLs
   * the way its templates spell them — with a fragment on the end, with query
   * parameters in whatever order the code appended them. `normalizeUrl` strips
   * the first and sorts the second before the URL becomes a frontier key, so
   * the `<loc>` and the `pages.url` created FROM that `<loc>` are two spellings
   * of one URL. The rules join `sitemap_urls.url_normalised`, so they match;
   * this field is what puts a divergent spelling in front of them end to end
   * (see `/authored3/loc-variant`).
   *
   * It may begin with `{legacy}`, which the writer replaces with the site's
   * second name (`FixtureApp.legacyBase`): the port is only known once the
   * server listens, and an entry on that host is the cross-host `<loc>`
   * (`sitemap.cross-host-loc`).
   */
  sitemapLoc?: string;
  /**
   * The `<lastmod>` `/sitemap.xml` publishes for this fixture, verbatim. Default:
   * none. Verbatim so a fixture can publish a value no W3C parser accepts
   * (`sitemap.lastmod-invalid`).
   */
  sitemapLastmod?: string;
  /**
   * Whether the hub links this fixture. Default true.
   *
   * The hub is what makes one crawl from the seed reach the whole collection, so
   * opting out means the page is reachable only through the sitemap — which is
   * the definition of the orphan `links.orphan` reports, and the shape
   * `pagination.next-not-linked` needs for the page a `rel=next` points at.
   */
  linkedFromHub?: boolean;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Every fixture the site serves: the pages absorbed from badseo, the pages
 * authored in Phase 2 for the rules absorb left unclaimed, the Phase 3 pages
 * authored for the query rules, the Phase 5 pages authored for the render pass,
 * the Phase 7 page whose markup hides most of its own words, the Phase 11 pair
 * whose resources rather than whose markup are broken, and the control.
 *
 * The render fixtures need a second HTTP origin to exist before the app serves
 * them — `/render/js-redirect-offsite` reads it on every request — so a caller
 * that starts this site must call `startOffsiteHost()` first. Nothing here
 * enforces that; the handler does, by throwing rather than serving a redirect
 * to nowhere (see test/fixtures/pages/render-p5.ts).
 *
 * A THIRD origin joined it in P11-T2: `startAssetHost()` (test/fixtures/
 * assets.ts), the CDN the hub carries one image from, which the resource fetch
 * pass has to open a queue for and read a robots.txt from. The hub reads it on
 * every request and throws the same way. Both must be running before
 * `startFixtureApp`.
 */
export function allFixtures(): Fixture[] {
  return [
    ...absorbedFixtures,
    ...authoredFixtures,
    ...authoredP3Fixtures,
    ...renderFixtures,
    ...authoredP7Fixtures,
    // P11: two pages whose markup is the control's and whose RESOURCES are the
    // defect — an image the site does not serve, and one that weighs 120,000
    // bytes. The first fixtures whose finding depends on a request the crawler
    // made after the page was parsed.
    ...authoredP11Fixtures,
    // P23: three URLs the crawler cannot read as pages — no response, a body
    // over the 2 MiB cap, and a coding it did not ask for. Fetch outcomes no
    // rule judged before 0.18.0.
    ...authoredP23Fixtures,
    // P25: a plain-text document whose content-security-policy runs past the
    // 2,048-character cap `pages.response_headers` keeps — the stored value is
    // cut, and the header is named in `truncated`.
    ...authoredP25Fixtures,
    // P26: the 26a rules' fixture pages, added task by task. Plain HTTP on
    // 127.0.0.1, so the HTTPS-only rules have none (SKIP_HARNESS_CLAIMS).
    ...authoredP26Fixtures,
    controlFixture,
  ];
}
