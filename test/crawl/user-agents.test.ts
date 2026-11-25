import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStartUrlRedirects } from "../../src/crawl/url-policy.js";
import { CRAWL_DEFAULTS } from "../../src/crawl/loop.js";
import {
  CrawlIdentityError,
  PRESET_CHROME_VERSION,
  USER_AGENT_PRESETS,
  resolveCrawlIdentity,
} from "../../src/crawl/user-agents.js";

function refusal(input: Parameters<typeof resolveCrawlIdentity>[0]): string {
  try {
    resolveCrawlIdentity(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CrawlIdentityError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("resolveCrawlIdentity", () => {
  it("defaults to the branded identity", () => {
    expect(resolveCrawlIdentity({})).toEqual({
      userAgentPreset: "ariadne",
      userAgent: CRAWL_DEFAULTS.userAgent,
      robotsUserAgent: "AriadneBot",
    });
  });

  it("each preset resolves to its strings and token", () => {
    expect(USER_AGENT_PRESETS).toMatchInlineSnapshot(`
      {
        "ariadne": {
          "robotsUserAgent": "AriadneBot",
          "userAgent": "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)",
        },
        "bingbot-desktop": {
          "robotsUserAgent": "bingbot",
          "userAgent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/142.0.0.0 Safari/537.36",
        },
        "bingbot-mobile": {
          "robotsUserAgent": "bingbot",
          "userAgent": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        },
        "googlebot-desktop": {
          "robotsUserAgent": "Googlebot",
          "userAgent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/142.0.0.0 Safari/537.36",
        },
        "googlebot-smartphone": {
          "robotsUserAgent": "Googlebot",
          "userAgent": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        },
      }
    `);
    for (const name of Object.keys(USER_AGENT_PRESETS) as (keyof typeof USER_AGENT_PRESETS)[]) {
      expect(resolveCrawlIdentity({ userAgentPreset: name })).toEqual({
        userAgentPreset: name,
        ...USER_AGENT_PRESETS[name],
      });
    }
  });

  it("refuses a preset with a userAgent or a robotsUserAgent", () => {
    expect(refusal({ userAgentPreset: "bingbot-desktop", userAgent: "x" })).toBe(
      "userAgentPreset and userAgent cannot both be set",
    );
    expect(refusal({ userAgentPreset: "bingbot-desktop", robotsUserAgent: "x" })).toBe(
      "userAgentPreset and robotsUserAgent cannot both be set",
    );
  });

  it("derives the token of a custom agent from its product name", () => {
    expect(resolveCrawlIdentity({ userAgent: "Acme/1.0 (+https://acme.test)" })).toEqual({
      userAgentPreset: null,
      userAgent: "Acme/1.0 (+https://acme.test)",
      robotsUserAgent: "Acme",
    });
  });

  it("refuses a Mozilla/ agent with no token, and accepts it with one", () => {
    const userAgent = "Mozilla/5.0 (compatible; Acme/1.0)";
    expect(refusal({ userAgent })).toBe(
      "userAgent starts with Mozilla; robots rules would be matched as 'mozilla'. Set robotsUserAgent.",
    );
    expect(refusal({ userAgent: "Mozilla (compatible; Acme/1.0)" })).toContain("starts with Mozilla");
    expect(refusal({ userAgent: "MOZILLA/5.0" })).toContain("starts with Mozilla");
    expect(resolveCrawlIdentity({ userAgent, robotsUserAgent: "Acme" }).robotsUserAgent).toBe(
      "Acme",
    );
  });

  it("refuses a token that is not one product token", () => {
    expect(refusal({ userAgent: "Acme/1.0", robotsUserAgent: "Acme Bot" })).toBe(
      "robotsUserAgent must be one product token (letters, digits, - and _)",
    );
  });

  it("says a derived token that is not one product token was derived, and how to fix it", () => {
    expect(refusal({ userAgent: "Acme.Bot/1.0" })).toBe(
      "the robots token derived from userAgent ('Acme.Bot') must be one product token (letters, digits, - and _); set robotsUserAgent",
    );
    expect(resolveCrawlIdentity({ userAgent: "Acme.Bot/1.0", robotsUserAgent: "AcmeBot" }).robotsUserAgent).toBe("AcmeBot");
  });

  it("refuses an unknown preset", () => {
    expect(refusal({ userAgentPreset: "chrome" })).toBe(
      "unknown userAgentPreset; expected one of ariadne, googlebot-smartphone, googlebot-desktop, bingbot-desktop, bingbot-mobile",
    );
  });

  it("refuses robotsUserAgent without a custom userAgent: the branded identity keeps its own group", () => {
    const message =
      "robotsUserAgent needs a custom userAgent; the default AriadneBot identity always matches the AriadneBot robots group";
    expect(refusal({ robotsUserAgent: "Googlebot" })).toBe(message);
  });
});

describe("the start-URL redirect probe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a preset crawl's probe request carries the preset's header", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input);
        if (url.includes("dns-query")) {
          return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
            status: 200,
            headers: { "content-type": "application/dns-json" },
          });
        }
        seen.push(init?.headers?.["User-Agent"] ?? "");
        return new Response(null, { status: 200 });
      }),
    );
    const { userAgent } = resolveCrawlIdentity({ userAgentPreset: "googlebot-smartphone" });
    await resolveStartUrlRedirects("https://example.com/", { userAgent });
    expect(seen).toEqual([userAgent]);
  });
});

// Phase 29d, Task 15: the verified bingbot presets.
describe("the bingbot presets", () => {
  it.each(["bingbot-desktop", "bingbot-mobile"] as const)(
    "%s presents bingbot/2.0 with the filled Chrome version, and matches the bingbot group",
    (name) => {
      const preset = USER_AGENT_PRESETS[name];
      expect(preset.userAgent).toContain("bingbot/2.0");
      expect(preset.userAgent).toContain(`Chrome/${PRESET_CHROME_VERSION}`);
      expect(preset.userAgent).not.toContain("W.X.Y.Z");
      expect(preset.userAgent).not.toContain("  ");
      expect(preset.robotsUserAgent).toBe("bingbot");
    },
  );

  it("the bare name bingbot is refused as an unknown preset", () => {
    expect(refusal({ userAgentPreset: "bingbot" })).toBe(
      "unknown userAgentPreset; expected one of ariadne, googlebot-smartphone, googlebot-desktop, bingbot-desktop, bingbot-mobile",
    );
  });
});
