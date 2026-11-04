/**
 * The two version stamps rows carry (migration 0025, Phase 25).
 *
 * `EXTRACTION_VERSION` is stamped on every `pages` row the page writer writes
 * (`pages.extraction_version`). Bump it whenever the fetch layer or the analyzer
 * changes WHAT it extracts, so a rule reading a fact introduced at version N can
 * tell rows that measured it from rows that could not have
 * (`extractionCoverage`, src/rules/helpers.ts). Null on a row means it was
 * written before Phase 25.
 *
 * `RENDER_CAPTURE_VERSION` is the render writer's own stamp
 * (`pages.render_version`), separate so re-rendering an older crawl never claims
 * its page-writer columns were extracted by newer code.
 */
export const EXTRACTION_VERSION = 1;
export const RENDER_CAPTURE_VERSION = 1;
