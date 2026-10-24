import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  isClassifiableResponse,
  parseStoredPlatformProfile,
  platformProfileRecord,
  PLATFORM_PROFILES,
  readStoredPlatform,
} from "../../src/crawl/platform.js";
import { CrawlWindow, HostGate } from "../../src/crawl/politeness.js";
import {
  RENDER_BUDGET_BASE_MS,
  RENDER_BUDGET_CAP_MS,
  RENDER_BUDGET_PER_SPACING,
  renderEffectiveSpacingMs,
  renderNavigationBudgetMs,
  renderPacing,
} from "../../src/crawl/render/run-render.js";

describe("detectPlatform", () => {
  it("names Shopify from powered-by, whatever its case", () => {
    expect(detectPlatform({ "powered-by": "Shopify" })).toBe("shopify");
    expect(detectPlatform({ "powered-by": "shopify" })).toBe("shopify");
    expect(detectPlatform({ "Powered-By": "SHOPIFY" })).toBe("shopify");
    expect(detectPlatform({ "powered-by": ["Shopify"] })).toBe("shopify");
  });

  it("names Shopify from any x-shopify- header", () => {
    expect(detectPlatform({ "x-shopify-stage": "production" })).toBe("shopify");
    expect(detectPlatform({ "x-shopify-perf-experiments": "a,b" })).toBe("shopify");
    expect(detectPlatform({ "X-Shopify-Shop-Id": "1" })).toBe("shopify");
  });

  it("reads a WHATWG Headers object too", () => {
    expect(detectPlatform(new Headers({ "powered-by": "Shopify" }))).toBe("shopify");
    expect(detectPlatform(new Headers({ "x-shopify-stage": "p" }))).toBe("shopify");
    expect(detectPlatform(new Headers({ server: "nginx" }))).toBeNull();
  });

  it("names nothing when neither signal is there", () => {
    expect(detectPlatform({})).toBeNull();
    expect(detectPlatform({ server: "cloudflare", "x-powered-by": "Express" })).toBeNull();
    // Real storefronts send this, but it is not one of the two signals.
    expect(detectPlatform({ "shopify-complexity-score": "1640" })).toBeNull();
    // A powered-by that merely mentions the word is not the platform's header.
    expect(detectPlatform({ "powered-by": "Shopify-alike CMS" })).toBeNull();
    expect(detectPlatform({ "powered-by": undefined })).toBeNull();
  });
});

describe("PLATFORM_PROFILES", () => {
  it("holds the owner's Shopify setting", () => {
    expect(PLATFORM_PROFILES.shopify).toEqual({
      maxConcurrency: 1,
      minPerHostDelayMs: 1000,
      renderConcurrency: 1,
      navigationTimeoutMs: 60_000,
    });
  });
});

describe("platformProfileRecord", () => {
  const at = new Date("2026-10-23T12:00:00.000Z");

  it("caps concurrency and floors the delay, never the other way", () => {
    expect(
      platformProfileRecord("shopify", { maxConcurrency: 16, perHostDelayMs: 250 }, at),
    ).toEqual({
      platform: "shopify",
      applied: {
        maxConcurrency: 1,
        perHostDelayMs: 1000,
        renderConcurrency: 1,
        navigationTimeoutMs: 60_000,
      },
      appliedAt: "2026-10-23T12:00:00.000Z",
      optedOut: false,
    });
    // A caller already slower than the profile keeps their number.
    const slow = platformProfileRecord("shopify", { maxConcurrency: 1, perHostDelayMs: 3000 }, at);
    expect(slow.applied?.perHostDelayMs).toBe(3000);
    expect(slow.applied?.maxConcurrency).toBe(1);
  });

  it("records an opt-out with nothing applied", () => {
    expect(
      platformProfileRecord(
        "shopify",
        { maxConcurrency: 16, perHostDelayMs: 0, platformProfiles: false },
        at,
      ),
    ).toEqual({ platform: "shopify", applied: null, appliedAt: null, optedOut: true });
  });
});

describe("isClassifiableResponse", () => {
  const site = "https://shop.example/";
  it("asks only an ok page from the crawl's origin", () => {
    expect(isClassifiableResponse({ url: "https://shop.example/", fetchClass: "ok" }, site)).toBe(
      true,
    );
    // The www twin and the http->https upgrade are the same crawl.
    expect(
      isClassifiableResponse({ url: "https://www.shop.example/", fetchClass: "ok" }, site),
    ).toBe(true);
    expect(
      isClassifiableResponse({ url: "https://shop.example/", fetchClass: "redirect" }, site),
    ).toBe(false);
    // A WAF's challenge page says nothing about the platform behind it.
    expect(
      isClassifiableResponse({ url: "https://shop.example/", fetchClass: "blocked" }, site),
    ).toBe(false);
    expect(
      isClassifiableResponse({ url: "https://old-brand.example/", fetchClass: "ok" }, site),
    ).toBe(false);
  });
});

describe("parseStoredPlatformProfile / readStoredPlatform", () => {
  const applied = platformProfileRecord(
    "shopify",
    { maxConcurrency: 4, perHostDelayMs: 0 },
    new Date("2026-10-23T12:00:00.000Z"),
  );
  const optedOut = platformProfileRecord(
    "shopify",
    { maxConcurrency: 4, perHostDelayMs: 0, platformProfiles: false },
    new Date(),
  );

  it("round-trips both shapes and keeps null as null", () => {
    expect(parseStoredPlatformProfile(applied, "c")).toEqual(applied);
    expect(parseStoredPlatformProfile(optedOut, "c")).toEqual(optedOut);
    expect(parseStoredPlatformProfile(null, "c")).toBeNull();
    expect(readStoredPlatform(null, null, "c")).toEqual({ platform: null, profile: null });
    expect(readStoredPlatform("shopify", applied, "c")).toEqual({
      platform: "shopify",
      profile: applied,
    });
  });

  it("refuses a column it cannot read a pace out of", () => {
    expect(() => parseStoredPlatformProfile([], "c")).toThrow(/not an object/);
    expect(() => parseStoredPlatformProfile({ ...applied, platform: "wix" }, "c")).toThrow(
      /unknown platform/,
    );
    expect(() =>
      parseStoredPlatformProfile(
        { ...applied, applied: { ...applied.applied, maxConcurrency: "1" } },
        "c",
      ),
    ).toThrow(/applied\.maxConcurrency/);
    expect(() => parseStoredPlatformProfile({ ...applied, appliedAt: null }, "c")).toThrow(
      /appliedAt/,
    );
    expect(() => parseStoredPlatformProfile({ ...optedOut, applied: applied.applied }, "c")).toThrow(
      /opted out/,
    );
    // The two columns are written together; one without the other is a defect.
    expect(() => readStoredPlatform("shopify", null, "c")).toThrow(/disagrees/);
    expect(() => readStoredPlatform(null, applied, "c")).toThrow(/disagrees/);
  });
});

describe("CrawlWindow.clampMax", () => {
  it("lowers the ceiling and the current size, and never raises either", () => {
    const window = new CrawlWindow({ max: 16, initial: 4 });
    window.clampMax(1);
    expect(window.size()).toBe(1);
    expect(window.maxSize()).toBe(1);
    // Growth stops at the new ceiling.
    window.onBatchSettled([{ fetchClass: "ok", responseTimeMs: 1, htmlBytes: 1 }]);
    expect(window.size()).toBe(1);
    window.clampMax(8);
    expect(window.maxSize()).toBe(1);
    expect(() => window.clampMax(0)).toThrow(RangeError);
  });
});

describe("HostGate.raiseBase", () => {
  it("raises the base for hosts seen and unseen, and never lowers it", () => {
    const gate = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    expect(gate.spacingMs("seen.example")).toBe(0);
    gate.raiseHostFloor("seen.example", 0); // the gate now holds state for it
    gate.raiseBase(1000);
    expect(gate.spacingMs("seen.example")).toBe(1000);
    expect(gate.spacingMs("unseen.example")).toBe(1000);
    expect(gate.maxSpacingMs()).toBe(1000);
    gate.raiseBase(200);
    expect(gate.spacingMs("unseen.example")).toBe(1000);
    expect(() => gate.raiseBase(-1)).toThrow(RangeError);
  });

  it("keeps a wider robots Crawl-delay, and a host's escalation stands on the new base", () => {
    const robots = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: 3 });
    robots.raiseBase(1000);
    expect(robots.spacingMs("a.example")).toBe(3000);

    const gate = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    // Two refusals from distinct URLs: one escalation, 500 -> 1000.
    gate.report("a.example", { fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url: "/1" });
    gate.report("a.example", { fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url: "/2" });
    const escalated = gate.spacingMs("a.example");
    expect(escalated).toBeGreaterThan(500);
    gate.raiseBase(1000);
    expect(gate.spacingMs("a.example")).toBe((escalated / 500) * 1000);
  });

  it("makes the next acquisition wait the new spacing after the raise", async () => {
    const gate = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    await gate.acquire("a.example");
    const raisedAt = Date.now();
    gate.raiseBase(150);
    await gate.acquire("a.example");
    expect(Date.now() - raisedAt).toBeGreaterThanOrEqual(140);
  });
});

describe("renderPacing", () => {
  it("gives a profiled crawl one browser and the longer navigation budget", () => {
    const profile = platformProfileRecord(
      "shopify",
      { maxConcurrency: 16, perHostDelayMs: 0 },
      new Date(),
    );
    const asked = { renderConcurrency: 4, navigationTimeoutMs: 15_000, perHostDelayMs: 250 };
    expect(renderPacing(asked, profile)).toEqual({
      renderConcurrency: 1,
      // 15 s + 30 × 1000 ms = 45 s from the spacing; the profile's 60 s is larger.
      navigationTimeoutMs: 60_000,
      // Floored by the profile itself, not only by what host_spacing_ms says.
      perHostDelayMs: 1000,
    });
    // A caller already more patient, or slower, than the profile keeps it.
    expect(renderPacing({ ...asked, navigationTimeoutMs: 90_000 }, profile).navigationTimeoutMs).toBe(
      90_000,
    );
    expect(renderPacing({ ...asked, perHostDelayMs: 4000 }, profile).perHostDelayMs).toBe(4000);
  });

  it("changes nothing for an opted-out profile or no platform", () => {
    const optedOut = platformProfileRecord(
      "shopify",
      { maxConcurrency: 16, perHostDelayMs: 0, platformProfiles: false },
      new Date(),
    );
    const asked = { renderConcurrency: 4, navigationTimeoutMs: 15_000, perHostDelayMs: 250 };
    // The profile changes nothing; the budget still grows with the spacing,
    // as it does for every pass: 15 s + 30 × 250 ms.
    const unprofiled = { ...asked, navigationTimeoutMs: 22_500 };
    expect(renderPacing(asked, optedOut)).toEqual(unprofiled);
    expect(renderPacing(asked, null)).toEqual(unprofiled);
  });
});

describe("render navigation budget (every pass)", () => {
  const asked = { renderConcurrency: 4, navigationTimeoutMs: 15_000, perHostDelayMs: 1000 };

  it("grows with the spacing: 15 s + 30 spacings, capped at 120 s", () => {
    expect(RENDER_BUDGET_BASE_MS).toBe(15_000);
    expect(RENDER_BUDGET_PER_SPACING).toBe(30);
    expect(RENDER_BUDGET_CAP_MS).toBe(120_000);
    // The default 1000 ms spacing.
    expect(renderPacing(asked, null).navigationTimeoutMs).toBe(45_000);
    // 4000 ms would be 135 s: the cap.
    expect(renderPacing({ ...asked, perHostDelayMs: 4000 }, null).navigationTimeoutMs).toBe(120_000);
    // Zero spacing: the 15 s floor.
    expect(renderPacing({ ...asked, perHostDelayMs: 0 }, null).navigationTimeoutMs).toBe(15_000);
    // A caller's own larger budget stands, above the cap included.
    expect(renderNavigationBudgetMs(150_000, 4000)).toBe(150_000);
    expect(renderNavigationBudgetMs(50_000, 1000)).toBe(50_000);
  });

  it("keeps the profile's 60 s when it is larger: Shopify at 1000 ms", () => {
    const profile = platformProfileRecord(
      "shopify",
      { maxConcurrency: 16, perHostDelayMs: 1000 },
      new Date(),
    );
    expect(renderPacing(asked, profile).navigationTimeoutMs).toBe(60_000);
    // …and the spacing's when that is: Shopify at 2000 ms = 75 s.
    expect(renderPacing({ ...asked, perHostDelayMs: 2000 }, profile).navigationTimeoutMs).toBe(75_000);
  });

  it("sizes on the spacing the crawl left in force, not only the configured one", () => {
    // Robots Crawl-delay 2 s.
    expect(
      renderPacing(asked, null, { robotsCrawlDelaySec: 2, hostSpacingMs: null, hostSpacingJsonb: null })
        .navigationTimeoutMs,
    ).toBe(75_000);
    // A host the crawl escalated to 2000 ms (base 1000, level 1), crawl-wide column absent.
    const entry = {
      spacingMs: 2000,
      baseMs: 1000,
      responses429: 1,
      retryAfterSeen: 0,
      escalations: 1,
      recoveries: 0,
      recoveryLocked: false,
      peakSpacingMs: 2000,
    };
    expect(
      renderPacing(asked, null, {
        robotsCrawlDelaySec: null,
        hostSpacingMs: null,
        hostSpacingJsonb: { "www.shop.example": entry },
      }).navigationTimeoutMs,
    ).toBe(75_000);
    expect(
      renderEffectiveSpacingMs({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: null,
        hostSpacingMs: 2000,
        hostSpacingJsonb: null,
      }),
    ).toBe(2000);
    // A map the gate cannot read is an error here, before the frontier is touched.
    expect(() =>
      renderEffectiveSpacingMs({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: null,
        hostSpacingMs: null,
        hostSpacingJsonb: [1, 2],
      }),
    ).toThrow(/host_spacing_jsonb cannot be restored/);
  });
});
