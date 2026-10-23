/**
 * Platform profiles: a site whose platform we can name from its own response
 * headers is crawled at the pace that platform tolerates, not at whatever the
 * caller configured (Phase 24a spec §3.1).
 *
 * WHY THIS EXISTS. Shopify storefronts sit behind a per-client token bucket.
 * The owner crawls them in Screaming Frog at one thread and one URL a second
 * because anything faster gets 429s. Our API default is 16 concurrent fetches,
 * and our ratchet only backs off after the site has already refused us
 * (lavishalice.com, 2026-10-23: 1 s, then 2 s, then 4 s for the rest of the
 * crawl). Reading the platform off the first page means we start at the pace
 * the site tolerates instead of finding it by being refused (hard rule 9).
 *
 * Three properties this module holds:
 *
 *  - **Headers only.** `powered-by: Shopify`, or any header whose name starts
 *    with `x-shopify-`. No body sniffing and no extra request: the probe and
 *    seed responses are already in hand. A Shopify store whose CDN strips
 *    those headers is NOT detected, and then the caller's settings apply,
 *    visibly (`crawls.platform` stays null). There is no guessing.
 *  - **A profile caps, it never speeds up.** `maxConcurrency := min(config, 1)`
 *    and `perHostDelayMs := max(config, 1000)`. A caller who asked for a slower
 *    crawl than the profile keeps it. The render pass gets one browser context
 *    and a 60 s navigation budget (slower is the polite direction there too).
 *  - **It is recorded.** `crawls.platform` and `crawls.platform_profile_jsonb`
 *    (migration 0024) hold what was detected and what was actually applied, or
 *    that the operator opted out (`CrawlConfig.platformProfiles: false`).
 */
import type { FetchResult } from "./fetch-page.js";
import { isSameOrigin } from "./parse/url-utils.js";

/** The platforms we can name. One today. */
export type Platform = "shopify";

/** What one platform's profile does to a crawl. Every value is a bound, not a setting. */
export interface PlatformProfile {
  /** Upper bound on the crawl window: `min(config.maxConcurrency, this)`. */
  maxConcurrency: number;
  /** Lower bound on the per-host spacing: `max(config.perHostDelayMs, this)`. */
  minPerHostDelayMs: number;
  /** Upper bound on browser contexts in the render pass. */
  renderConcurrency: number;
  /** Lower bound on the render pass's navigation timeout. */
  navigationTimeoutMs: number;
}

export const PLATFORM_PROFILES: Record<Platform, PlatformProfile> = {
  // The owner's Screaming Frog setting for Shopify: one thread, one URL a second.
  shopify: {
    maxConcurrency: 1,
    minPerHostDelayMs: 1000,
    renderConcurrency: 1,
    navigationTimeoutMs: 60_000,
  },
};

/** Header bag as undici gives it, or a WHATWG `Headers`. */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

/**
 * Name the platform from response headers, or null.
 *
 * Shopify when `powered-by` is `Shopify` (value compared case-insensitively),
 * or when ANY header name starts with `x-shopify-` (header names are
 * case-insensitive in HTTP, so they are lowercased here whatever the caller's
 * bag holds). `shopify-complexity-score`, which real storefronts send, is not
 * `x-`-prefixed and does not count on its own: the rule is the two signals
 * above, and `powered-by` already covers every store we have seen.
 */
export function detectPlatform(headers: HeaderSource): Platform | null {
  for (const [rawName, rawValue] of entriesOf(headers)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("x-shopify-")) return "shopify";
    if (name === "powered-by") {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      if (values.some((v) => v !== undefined && v.trim().toLowerCase() === "shopify")) {
        return "shopify";
      }
    }
  }
  return null;
}

function entriesOf(headers: HeaderSource): Iterable<[string, string | string[] | undefined]> {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.entries();
  return Object.entries(headers);
}

/** The values a profile left in force: the config, capped by the profile. */
export interface AppliedPlatformProfile {
  maxConcurrency: number;
  perHostDelayMs: number;
  renderConcurrency: number;
  navigationTimeoutMs: number;
}

/**
 * `crawls.platform_profile_jsonb`. Written only when a platform was detected.
 *
 *  - Applied: `applied` holds the values in force after the clamp (the
 *    caller's own number where it was already slower), and `appliedAt` is
 *    when the clamp took effect. When detection came from the host probe that
 *    is before the first worker started; when it came from the seed fetch
 *    (no probe) it is mid-crawl, and requests already in flight finished at
 *    the old settings.
 *  - Opted out (`CrawlConfig.platformProfiles: false`): `optedOut: true`,
 *    `applied: null`, `appliedAt: null`. Nothing was clamped, and the record
 *    says so rather than holding numbers nobody applied.
 */
export interface StoredPlatformProfile {
  platform: Platform;
  applied: AppliedPlatformProfile | null;
  appliedAt: string | null;
  optedOut: boolean;
}

/** Build the stored record for a detection, from the crawl's own config. */
export function platformProfileRecord(
  platform: Platform,
  config: { maxConcurrency: number; perHostDelayMs: number; platformProfiles?: boolean },
  at: Date,
): StoredPlatformProfile {
  if (config.platformProfiles === false) {
    return { platform, applied: null, appliedAt: null, optedOut: true };
  }
  const profile = PLATFORM_PROFILES[platform];
  return {
    platform,
    applied: {
      maxConcurrency: Math.min(config.maxConcurrency, profile.maxConcurrency),
      perHostDelayMs: Math.max(config.perHostDelayMs, profile.minPerHostDelayMs),
      renderConcurrency: profile.renderConcurrency,
      navigationTimeoutMs: profile.navigationTimeoutMs,
    },
    appliedAt: at.toISOString(),
    optedOut: false,
  };
}

/**
 * Whether `result` is the response the crawl classifies: an HTML page that
 * answered `ok`, from the crawl's own origin (`isSameOrigin`, so the `www.`
 * twin and the http→https upgrade count). A redirect, an error page, a
 * challenge or a non-HTML response is not it, and the next response is
 * asked instead: a WAF's 403 page says nothing about the platform behind it.
 */
export function isClassifiableResponse(
  result: Pick<FetchResult, "url" | "fetchClass">,
  siteUrl: string,
): boolean {
  // `ok` is HTML by construction: fetch-page turns a non-HTML 200 into `non_html`.
  return result.fetchClass === "ok" && isSameOrigin(result.url, siteUrl);
}

/**
 * Read a stored `platform_profile_jsonb` back. Null stays null (not detected,
 * or a pre-0024 row). Anything that is not the shape above throws: a profile
 * we cannot read is a pace we cannot honour, and guessing would either crawl a
 * Shopify store at 16 threads or clamp a site nobody profiled (rule 7).
 */
export function parseStoredPlatformProfile(
  value: unknown,
  crawlId: string,
): StoredPlatformProfile | null {
  if (value === null || value === undefined) return null;
  const fail = (why: string): never => {
    throw new Error(`crawl ${crawlId}: stored platform_profile_jsonb ${why}`);
  };
  if (typeof value !== "object" || Array.isArray(value)) fail("is not an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw["platform"] !== "string" || !(raw["platform"] in PLATFORM_PROFILES)) {
    fail(`names an unknown platform: ${JSON.stringify(raw["platform"])}`);
  }
  if (typeof raw["optedOut"] !== "boolean") fail("has no boolean optedOut");
  const applied = raw["applied"];
  const appliedAt = raw["appliedAt"];
  if (raw["optedOut"] === true) {
    if (applied !== null || appliedAt !== null) {
      fail("is opted out but carries applied values");
    }
    return { platform: raw["platform"] as Platform, applied: null, appliedAt: null, optedOut: true };
  }
  if (typeof appliedAt !== "string") fail("has no appliedAt");
  if (typeof applied !== "object" || applied === null || Array.isArray(applied)) {
    fail("has no applied values");
  }
  const a = applied as Record<string, unknown>;
  const fields = [
    "maxConcurrency",
    "perHostDelayMs",
    "renderConcurrency",
    "navigationTimeoutMs",
  ] as const;
  for (const field of fields) {
    const v = a[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      fail(`applied.${field} is not a non-negative number`);
    }
  }
  return {
    platform: raw["platform"] as Platform,
    applied: {
      maxConcurrency: a["maxConcurrency"] as number,
      perHostDelayMs: a["perHostDelayMs"] as number,
      renderConcurrency: a["renderConcurrency"] as number,
      navigationTimeoutMs: a["navigationTimeoutMs"] as number,
    },
    appliedAt: appliedAt as string,
    optedOut: false,
  };
}

/**
 * Read both platform columns of a crawls row together. They are written
 * together, so one set without the other — or a `platform` that disagrees
 * with its profile's — is a row we cannot read a pace out of, and it throws
 * (rule 7). Used by the loop before a resume and by `crawl_status`.
 */
export function readStoredPlatform(
  platformColumn: string | null,
  profileColumn: unknown,
  crawlId: string,
): { platform: Platform | null; profile: StoredPlatformProfile | null } {
  const profile = parseStoredPlatformProfile(profileColumn, crawlId);
  if ((profile?.platform ?? null) !== platformColumn) {
    throw new Error(
      `crawl ${crawlId}: crawls.platform (${String(platformColumn)}) disagrees with ` +
        `platform_profile_jsonb (${String(profile?.platform ?? null)})`,
    );
  }
  return { platform: profile?.platform ?? null, profile };
}
