import { readFileSync } from "node:fs";

/**
 * The two version stamps rows carry (migration 0025, Phase 25).
 *
 * `EXTRACTION_VERSION` is stamped on every `pages` row the page writer writes
 * (`pages.extraction_version`). Version 2 (Phase 26b, migration 0026) adds the
 * social, html-lang, h2-text, title/description count, bot-robots, meta-refresh,
 * anchor, insecure-ref, image-alt, rel-next/prev-count and html-structure facts
 * (`pages.html_lang` … `html_structure`) and the `refresh` response header. Bump it whenever the fetch layer or the analyzer
 * changes WHAT it extracts, so a rule reading a fact introduced at version N can
 * tell rows that measured it from rows that could not have
 * (`extractionCoverage`, src/rules/helpers.ts). Null on a row means it was
 * written before Phase 25.
 *
 * `RENDER_CAPTURE_VERSION` is the render writer's own stamp
 * (`pages.render_version`), separate so re-rendering an older crawl never claims
 * its page-writer columns were extracted by newer code.
 */
export const EXTRACTION_VERSION = 2;
export const RENDER_CAPTURE_VERSION = 1;

const REDACTED_REQUEST_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * The request headers a crawl sent, as `crawls.request_headers` records them:
 * credential-bearing names (matched case-insensitively) keep their key and lose
 * their value, so the row says a credential was sent without holding it.
 */
export function redactRequestHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([name, value]) => [
      name,
      REDACTED_REQUEST_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
    ]),
  );
}

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * `"<package.json version>+<ARIADNE_GIT_SHA>"` (`crawls.engine_version`). A
 * build that does not set the variable says `sha-unknown` rather than guessing.
 */
export function engineVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env["ARIADNE_GIT_SHA"];
  return `${PACKAGE_VERSION}+${sha === undefined || sha === "" ? "sha-unknown" : sha}`;
}
