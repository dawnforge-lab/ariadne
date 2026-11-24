/**
 * The identity a crawl presents (Phase 29d, Task 6): the `User-Agent` request
 * header, and the product token robots.txt groups are matched against.
 *
 * Two strings, because they answer two questions. The header is what the site
 * sees on the wire; the robots token is the name RFC 9309 §2.2.1 says a
 * crawler matches `User-agent:` lines with: one product token, never the full
 * header. A `Mozilla/5.0 (compatible; Googlebot/2.1; ...)` header matches the
 * `Googlebot` group, not a group called `mozilla`, and matching the whole
 * header against robots.txt matches nothing useful.
 *
 * Resolved ONCE, when a crawl's config is built, and stored in `config_jsonb`
 * (`robotsUserAgent`, `userAgentPreset`). Every robots reader takes the token
 * from the config; every request header keeps `userAgent`.
 *
 * WHAT A PRESET IS NOT. A spoofed bot identity fails any site that verifies
 * bots by IP address or reverse DNS (Cloudflare, most CDNs). A preset only
 * helps on a site that filters by user-agent alone. It never bypasses a
 * challenge. The branded default (hard rule 9) stays the default.
 *
 * Strings read 2026-11-24 against
 * https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers:
 *  - Googlebot Smartphone: as published, with the Chrome version placeholder
 *    `W.X.Y.Z` filled by `PRESET_CHROME_VERSION`.
 *  - Googlebot Desktop: the page's primary string, with `W.X.Y.Z` filled by
 *    `PRESET_CHROME_VERSION`. The page also lists a short form,
 *    `Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
 *    as "rarely" used; the preset does not use it (owner ruling).
 *  - bingbot: bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0
 *    could not be read on that date (the fetch returned only the page title);
 *    the string is the plan's R3 value and is UNVERIFIED.
 */

export type UserAgentPreset = "ariadne" | "googlebot-smartphone" | "googlebot-desktop" | "bingbot";

/**
 * The Chrome version the Googlebot Smartphone preset reports. Google writes it
 * `W.X.Y.Z` and raises it over time; this value was set on 2026-11-24 and is
 * not read from any live source. Update it with the preset strings' next check.
 */
export const PRESET_CHROME_VERSION = "142.0.0.0";

export const ARIADNE_USER_AGENT = "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)";

export const USER_AGENT_PRESETS: Record<
  UserAgentPreset,
  { userAgent: string; robotsUserAgent: string }
> = {
  ariadne: { userAgent: ARIADNE_USER_AGENT, robotsUserAgent: "AriadneBot" },
  "googlebot-smartphone": {
    userAgent:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 " +
      `(KHTML, like Gecko) Chrome/${PRESET_CHROME_VERSION} Mobile Safari/537.36 ` +
      "(compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    robotsUserAgent: "Googlebot",
  },
  "googlebot-desktop": {
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; " +
      `+http://www.google.com/bot.html) Chrome/${PRESET_CHROME_VERSION} Safari/537.36`,
    robotsUserAgent: "Googlebot",
  },
  bingbot: {
    userAgent: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    robotsUserAgent: "bingbot",
  },
};

/** A refused identity: the API maps it to a 400 naming `field`. */
export class CrawlIdentityError extends Error {
  constructor(
    readonly field: "userAgentPreset" | "userAgent" | "robotsUserAgent",
    message: string,
  ) {
    super(message);
    this.name = "CrawlIdentityError";
  }
}

export interface CrawlIdentityInput {
  userAgentPreset?: string;
  userAgent?: string;
  robotsUserAgent?: string;
}

export interface CrawlIdentity {
  userAgentPreset: UserAgentPreset | null;
  userAgent: string;
  robotsUserAgent: string;
}

const PRESET_NAMES = Object.keys(USER_AGENT_PRESETS) as UserAgentPreset[];
const TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * The crawl's identity from what a caller supplied. A preset sets both strings
 * and refuses to be mixed with either; a custom `userAgent` derives its token
 * from the product name it starts with, and one whose derived token is
 * `mozilla` (any case, `Mozilla/5.0 …` or `Mozilla (compatible; …)`) must name
 * the token itself, because `mozilla` would match nobody's group.
 */
export function resolveCrawlIdentity(input: CrawlIdentityInput): CrawlIdentity {
  const { userAgentPreset, userAgent, robotsUserAgent } = input;
  if (userAgentPreset !== undefined) {
    if (userAgent !== undefined) {
      throw new CrawlIdentityError("userAgent", "userAgentPreset and userAgent cannot both be set");
    }
    if (robotsUserAgent !== undefined) {
      throw new CrawlIdentityError(
        "robotsUserAgent",
        "userAgentPreset and robotsUserAgent cannot both be set",
      );
    }
    if (!Object.hasOwn(USER_AGENT_PRESETS, userAgentPreset)) {
      throw new CrawlIdentityError(
        "userAgentPreset",
        `unknown userAgentPreset; expected one of ${PRESET_NAMES.join(", ")}`,
      );
    }
    const preset = userAgentPreset as UserAgentPreset;
    return { userAgentPreset: preset, ...USER_AGENT_PRESETS[preset] };
  }

  // The branded identity always obeys the AriadneBot group: a token alone
  // would let AriadneBot follow another bot's group (hard rule 9).
  if (userAgent === undefined && robotsUserAgent !== undefined) {
    throw new CrawlIdentityError(
      "robotsUserAgent",
      "robotsUserAgent needs a custom userAgent; the default AriadneBot identity always matches the AriadneBot robots group",
    );
  }
  const header = userAgent ?? ARIADNE_USER_AGENT;
  if (header.trim() === "") {
    throw new CrawlIdentityError("userAgent", "userAgent must not be empty");
  }
  let token: string;
  let derived = false;
  if (robotsUserAgent !== undefined) {
    token = robotsUserAgent;
  } else if (userAgent === undefined) {
    token = USER_AGENT_PRESETS.ariadne.robotsUserAgent;
  } else {
    derived = true;
    token = /^\s*([^\s/]+)/.exec(header)?.[1] ?? "";
    // The derived token, not a prefix of the header: `Mozilla (compatible; X)`
    // derives `Mozilla` as surely as `Mozilla/5.0 (...)` does.
    if (token.toLowerCase() === "mozilla") {
      throw new CrawlIdentityError(
        "robotsUserAgent",
        "userAgent starts with Mozilla; robots rules would be matched as 'mozilla'. " +
          "Set robotsUserAgent.",
      );
    }
  }
  if (!TOKEN.test(token)) {
    throw new CrawlIdentityError(
      "robotsUserAgent",
      derived
        ? `the robots token derived from userAgent ('${token.slice(0, 64)}') must be one product ` +
            "token (letters, digits, - and _); set robotsUserAgent"
        : "robotsUserAgent must be one product token (letters, digits, - and _)",
    );
  }
  const isDefault = userAgent === undefined && robotsUserAgent === undefined;
  return {
    userAgentPreset: isDefault ? "ariadne" : null,
    userAgent: header,
    robotsUserAgent: token,
  };
}
