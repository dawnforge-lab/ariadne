/**
 * The render image rule: an image file much wider than the box it is shown in
 * (CHECK-49).
 *
 *  - `images.larger-than-displayed`  some measured image's intrinsic width is
 *    more than `IMAGE_OVERSIZE_PERCENT` percent of its displayed width (warning)
 *
 * It reads `pages.render_images`, the capture the render pass writes
 * (`RenderImages`, src/crawl/render/image-stand-in.ts). Nothing fetches (hard
 * rule 2): the renderer answered each image request with a blank SVG of the
 * image's stored size and measured the `<img>` boxes, and what is read here is
 * that measurement.
 *
 * **THE RATIO IS APPLIED HERE, NOT THERE.** The renderer cannot know the
 * threshold, which an agent overrides per crawl (27a), so it stores every
 * image wider than its box in the counts and the 50 that waste the most pixels
 * in `kept` (ruling R1). This rule applies `IMAGE_OVERSIZE_PERCENT` over `kept`:
 * an image fires when `intrinsicWidth * 100 > IMAGE_OVERSIZE_PERCENT *
 * displayedWidth` and the box is at least 1 px wide. Both sides are integers
 * (the capture validates it), so the comparison is exact, with no float in it.
 *
 * **"AT LEAST".** `kept` holds the worst 50 by wasted pixels, not every image
 * wider than its box. A page with more than 50 such images has more candidates
 * than `kept` shows, and an image the rule did not see could only have added to
 * the count, so `atLeast` is `widerThanDisplayed > kept.length` and the
 * `oversizedCount` is a floor then.
 *
 * **WHICH ROWS: `render_version >= 3` with a non-null `render_images`.** A page
 * rendered before capture 3 has no image measurement, and a page whose render
 * failed has none either; null is "not measured", which is not "no oversized
 * image", and the row is not a candidate. The rendered sample is not the site,
 * and `measuredShare` is in the evidence so a reader sees how much of the
 * page's images were measured at all: lazy, hidden, never-requested, broken
 * and size-unknown images are counted but cannot be judged.
 *
 * **A VALUE THAT IS NOT A `RenderImages` THROWS**, naming the crawl and the
 * page (`readImages`, hard rule 7). The renderer is the only writer of the
 * column; a row in another shape is one this engine did not write, and a rule
 * that skipped it would report the page as clean. The metric
 * `render.image-measurement` (render-metrics.ts) reads through the same
 * validator.
 *
 * The scan is a keyset cursor over `pages` in batches (`IMAGES_BATCH`): RAM is
 * the batch, never the crawl's blobs (the memory contract).
 */
import { sql } from "drizzle-orm";

import {
  RENDER_IMAGES_KEPT,
  type RenderImage,
  type RenderImages,
} from "../../crawl/render/image-stand-in.js";
import type { Db } from "../../db/client.js";
import { queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import { judgementOr, type RuleCaps } from "../registry/types.js";
import { assertCrawl, capsOr, noteTruncation } from "./crawl-evidence.js";

const LARGER_THAN_DISPLAYED: RuleIdentity = {
  id: "images.larger-than-displayed",
  severity: "warning",
};

/**
 * The first render capture that carries `render_images`. Written as a literal
 * on purpose: a rule reading a capture states which capture it needs, and a
 * later capture bump must not silently widen what this rule trusts.
 */
const FIRST_IMAGES_CAPTURE = 3;

/** Images listed in a finding's evidence, in `kept` order. */
export const IMAGES_LISTED = 20;

/**
 * Rows read per round trip. Exported so a test can force the cursor to iterate
 * without hardcoding the number.
 */
export const IMAGES_BATCH = 200;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The counts of a `RenderImages`, each a non-negative integer. */
const COUNT_KEYS = [
  "total",
  "examined",
  "measured",
  "hidden",
  "lazyUnloaded",
  "notRequested",
  "noDimensions",
  "broken",
  "widerThanDisplayed",
  "standIns",
] as const;

function isKeptImage(e: unknown): boolean {
  return (
    isObject(e) &&
    typeof e["url"] === "string" &&
    typeof e["cut"] === "boolean" &&
    isCount(e["intrinsicWidth"]) &&
    isCount(e["intrinsicHeight"]) &&
    isCount(e["displayedWidth"]) &&
    isCount(e["displayedHeight"]) &&
    typeof e["wastedPixels"] === "number" &&
    Number.isFinite(e["wastedPixels"]) &&
    e["wastedPixels"] >= 0 &&
    (e["bytes"] === null || isCount(e["bytes"])) &&
    (e["widthFrom"] === "stored" || e["widthFrom"] === "srcset-w")
  );
}

/**
 * Validate a stored `render_images` as a `RenderImages`, or throw naming the
 * rule, the crawl, the page and what is wrong with it. Validate, don't cast
 * (hard rule 7).
 */
export function readImages(value: unknown, ruleId: string, crawlId: string, url: string): RenderImages {
  const refuse = (why: string): never => {
    throw new Error(
      `${ruleId}: crawl '${crawlId}', page '${url}': render_images is not a RenderImages ` +
        `(${why}); the render pass is the only writer of this column, so the row is one this ` +
        "engine did not write, and skipping it would report the page as clean",
    );
  };
  if (!isObject(value)) return refuse("not a JSON object");
  for (const key of COUNT_KEYS) {
    if (!isCount(value[key])) refuse(`'${key}' is not a non-negative integer`);
  }
  const kept = value["kept"];
  if (!Array.isArray(kept)) return refuse("'kept' is not an array");
  if (!kept.every(isKeptImage)) return refuse("'kept' holds an entry of the wrong shape");
  return value as unknown as RenderImages;
}

/**
 * Whether one kept image is wider than `percent` percent of its box. Integer
 * arithmetic only: the capture's widths are integers, so is the threshold.
 */
function isOversized(image: RenderImage, percent: number): boolean {
  return image.displayedWidth >= 1 && image.intrinsicWidth * 100 > percent * image.displayedWidth;
}

/**
 * The share of a page's (or crawl's) examined images that were measured, three
 * decimals, or null when none was measured or left unmeasured. `broken` and
 * `noDimensions` were requested and could not be measured, so they weigh
 * against the share like the measured ones for it; hidden, lazy and
 * never-requested images are not in it, because nothing says they were meant
 * to be measured.
 */
export function measuredShare(c: {
  measured: number;
  noDimensions: number;
  broken: number;
}): number | null {
  const denominator = c.measured + c.noDimensions + c.broken;
  return denominator === 0 ? null : Math.round((c.measured / denominator) * 1000) / 1000;
}

/**
 * Walk every page that carries a capture-3 `render_images`, in `url` order,
 * one validated blob at a time.
 *
 * Shared with the metric so both read through one query and one validator.
 */
export async function scanRenderImages(
  db: Db,
  crawlId: string,
  ruleId: string,
  visit: (page: {
    id: string;
    url: string;
    pageType: string | null;
    images: RenderImages;
  }) => void,
): Promise<void> {
  let cursor = "";
  for (;;) {
    const res = await db.execute<{
      id: string;
      url: string;
      page_type: string | null;
      render_images: unknown;
    }>(sql`
      select p.id, p.url, p.page_type, p.render_images
      from pages p
      where p.crawl_id = ${crawlId}
        and p.render_version >= ${FIRST_IMAGES_CAPTURE}
        and p.render_images is not null
        and p.url > ${cursor}
      order by p.url
      limit ${IMAGES_BATCH}`);
    if (res.rows.length === 0) break;
    cursor = res.rows[res.rows.length - 1]!.url;
    for (const row of res.rows) {
      visit({
        id: row.id,
        url: row.url,
        pageType: row.page_type,
        images: readImages(row.render_images, ruleId, crawlId, row.url),
      });
    }
    if (res.rows.length < IMAGES_BATCH) break;
  }
}

async function largerThanDisplayed(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
  percent: number,
): Promise<Finding[]> {
  const self = LARGER_THAN_DISPLAYED;
  // A crawl id nothing knows scans no pages, which reads exactly like a clean
  // site (`runRules`' precedent, hard rule 7).
  await assertCrawl(db, crawlId, self.id);

  const findings: Finding[] = [];
  let total = 0;
  await scanRenderImages(db, crawlId, self.id, (page) => {
    const oversized = page.images.kept.filter((i) => isOversized(i, percent));
    if (oversized.length === 0) return;
    total += 1;
    if (caps.listing !== null && findings.length >= caps.listing) return;
    findings.push(
      queryFinding(self, {
        pageId: page.id,
        pageUrl: page.url,
        evidence: {
          template: page.pageType,
          oversizedCount: oversized.length,
          // `kept` is the worst RENDER_IMAGES_KEPT of every image wider than its
          // box; more of those exist than kept shows, so the count is a floor.
          atLeast: page.images.widerThanDisplayed > page.images.kept.length,
          keptLimit: RENDER_IMAGES_KEPT,
          images: oversized.slice(0, IMAGES_LISTED),
          measured: page.images.measured,
          measuredShare: measuredShare(page.images),
        },
        dedupeKey: page.url,
      }),
    );
  });
  return noteTruncation(findings, total);
}

export const renderImageRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: LARGER_THAN_DISPLAYED.id,
    checkIds: ["CHECK-49"],
    category: "technical",
    severity: LARGER_THAN_DISPLAYED.severity,
    columns: [
      { key: "template", label: "Template" },
      { key: "oversizedCount", label: "Oversized Images" },
      { key: "atLeast", label: "At Least" },
      { key: "measuredShare", label: "Share Measured" },
    ],
    ...copyFor(LARGER_THAN_DISPLAYED.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps, ctx) =>
      largerThanDisplayed(db, crawlId, capsOr(caps), judgementOr(ctx).thresholds.IMAGE_OVERSIZE_PERCENT),
  }),
];
