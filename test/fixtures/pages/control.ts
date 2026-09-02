/**
 * The control page: the one fixture engineered to fire NOTHING.
 *
 * Every other fixture proves a rule can speak. This one proves the rules can
 * stay quiet, which is the harder half — a rule that always fires is as useless
 * as a rule that never does, and a suite made only of broken pages cannot tell
 * the difference. It is written against all 26 page rules and both query rules,
 * signal by signal:
 *
 *   title.missing / too-short / too-long        title is 38 chars (10..60)
 *   meta-description.missing / short / long     description is 110 chars (70..160)
 *   headings.h1-missing / h1-multiple           exactly one h1
 *   headings.level-skip                         h1 -> h2 -> h3, one step at a time
 *   content.thin                                over 300 words of real prose
 *   content.placeholder                         no placeholder copy anywhere
 *   http.server-error / crawl.blocked           200, fetched cleanly
 *   canonical.missing                           self-referential, absolute
 *   canonical.points-elsewhere / cross-domain   the canonical IS this URL
 *   canonical.multiple                          exactly one canonical link
 *   canonical.html-header-conflict              no Link header at all
 *   indexability.noindex / meta-header-conflict no robots meta, no X-Robots-Tag
 *   directive.canonical-noindex-conflict        neither half of the conflict
 *   mobile.viewport-missing                     viewport meta present
 *   images.missing-alt / missing-dimensions     every img has alt, width, height
 *   performance.slow-response                   answered immediately
 *   structure.deep-page                         linked from the hub, one click deep
 *   hreflang.* (all four)                       no hreflang declarations
 *   links.orphan                                linked from the hub
 *   pagination.*                                no rel=next, no rel=prev
 *   resources.broken                            both its images are served, 200
 *   images.oversized / legacy-format            both are small SVGs, not PNGs
 *
 * ONE RESOURCE FINDING IS PROVOKED BY THIS PAGE ALL THE SAME, and it is not a
 * hole in the list above: `/img/control-outline.svg` is served with no
 * `cache-control`, which `resources.uncached` reports ONCE FOR THE SITE with no
 * page attached (test/fixtures/assets.ts says so where the header is left off).
 * A site-scoped finding lands in the harness's `siteFindings` map rather than on
 * any path, so this page's own set stays empty — which is the correct reading
 * rather than a lucky one: a caching policy is the server's, and the control's
 * silence is a claim about its markup.
 *
 * Every rule that can attach a finding TO A PAGE reaches this one only through
 * its own markup, its own place in the link graph, and — since P11-T3 — the
 * files that markup points at. That is what makes "fires nothing" a claim about
 * the page rather than about how the harness maps findings. The sentence used to
 * read "every rule in the registry is now page-attached", which was true when it
 * was written and is not now: the site-scoped rules above it exist, and one of
 * them is provoked by this very page's markup without landing on it. The
 * distinction is the paragraph above, and it is the reason this page's empty set
 * still means what it says.
 *
 * If a new rule lands and this page starts firing it, the fix is to add the
 * missing signal HERE, in one place, rather than to loosen the rule.
 */
import type { Fixture } from "../fixture.js";
import { serve } from "../render.js";

/** Exactly 38 characters — comfortably inside TITLE_MIN..TITLE_MAX. */
const TITLE = "A healthy page with nothing to report.";

/** Exactly 110 characters — comfortably inside META_MIN..META_MAX. */
const META =
  "A deliberately clean fixture page: correct head tags, one heading per level, and images which name themselves.";

export const controlFixture: Fixture = {
  path: "/control",
  category: "control",
  name: "Control page (must fire nothing)",
  expectedIssues: [],
  handler: (req, res) =>
    serve(req, res, () => ({
      title: TITLE,
      metaDescription: META,
      bodyHtml: `<h1>A page that is simply correct</h1>
<p>This page exists to be boring. It carries the head tags a page is supposed to carry, it says what it is about once and clearly, and it gives the crawler nothing to complain about. Everything on it was chosen because some rule in the engine would have had an opinion if it were missing, wrong, or overdone, and the point of the page is that none of those opinions get triggered.</p>
<img src="/img/control-diagram.svg" alt="A diagram of the control page's heading outline" width="720" height="360">
<h2>Why a clean page belongs in the fixture set</h2>
<p>A suite made only of broken pages proves half of what it needs to prove. It shows that each rule can produce a finding, which is the easy half. It says nothing about whether a rule can hold its tongue on a page that does not deserve a finding, and a rule that fires on everything is worse than no rule at all, because it buries the real problems in noise that somebody then has to read through and dismiss one by one.</p>
<p>So this page is the other half of the argument. It is fetched by the same crawler, parsed by the same analyzer, and judged by the same registry as every broken page beside it, and the harness asserts that the issues table has nothing at all to say about this URL. When that assertion fails, one of two things has happened: a rule has grown too eager, or this page has quietly stopped being clean. Both are worth knowing about the moment they happen, and both are cheap to investigate because the page is small enough to read in full.</p>
<h3>What is deliberately present</h3>
<p>The title is long enough to describe the page and short enough to survive a search result. The description is a real sentence written for a person rather than a keyword list. There is exactly one top-level heading, and the sections below it step down one level at a time so the outline reads like an outline. The images carry alt text and their own dimensions, so nothing shifts as they load and nothing is invisible to a screen reader.</p>
<img src="/img/control-outline.svg" alt="An illustration of a document outline with no skipped levels" width="480" height="240">
<h3>What is deliberately absent</h3>
<p>There is no robots directive in the markup and none in the response headers, so the page is plainly indexable and nothing contradicts anything else. There is one canonical link and it names this page, which is what a canonical is for. There are no language alternates, no placeholder copy left over from a draft, and no artificial delay in front of the response. The server answers straight away, the way a healthy page should.</p>`,
    })),
};
