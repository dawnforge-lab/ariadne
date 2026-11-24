import { describe, expect, it } from "vitest";
import { CRAWL_DEFAULTS } from "../../src/crawl/loop.js";
import {
  CrawlIdentityError,
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
        "bingbot": {
          "robotsUserAgent": "bingbot",
          "userAgent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        },
        "googlebot-desktop": {
          "robotsUserAgent": "Googlebot",
          "userAgent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
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
    expect(refusal({ userAgentPreset: "bingbot", userAgent: "x" })).toBe(
      "userAgentPreset and userAgent cannot both be set",
    );
    expect(refusal({ userAgentPreset: "bingbot", robotsUserAgent: "x" })).toBe(
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
      "userAgent starts with Mozilla/; robots rules would be matched as 'mozilla'. Set robotsUserAgent.",
    );
    expect(resolveCrawlIdentity({ userAgent, robotsUserAgent: "Acme" }).robotsUserAgent).toBe(
      "Acme",
    );
  });

  it("refuses a token that is not one product token", () => {
    expect(refusal({ userAgent: "Acme/1.0", robotsUserAgent: "Acme Bot" })).toBe(
      "robotsUserAgent must be one product token (letters, digits, - and _)",
    );
  });

  it("refuses an unknown preset", () => {
    expect(refusal({ userAgentPreset: "chrome" })).toBe(
      "unknown userAgentPreset; expected one of ariadne, googlebot-smartphone, googlebot-desktop, bingbot",
    );
  });
});
