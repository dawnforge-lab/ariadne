/**
 * Whether a robots directive string (a robots meta `content`, or an
 * `X-Robots-Tag` value) asks for the page to stay out of the index. ONE
 * DEFINITION, read by the crawl writer when it stamps `pages.is_indexable`
 * (src/crawl/persist.ts) and by the rule layer's `saysNoindex`
 * (src/rules/helpers.ts), which every finding's indexability label is computed
 * by. The two must agree, or `indexabilityOf` throws on the row; one function
 * means they cannot drift. Its SQL spelling is `SAYS_NOINDEX`
 * (src/rules/helpers.ts), pinned against this in
 * test/rules/robots-nofollow-sql.test.ts.
 *
 * This module imports nothing, so the crawl layer can read it without loading
 * the rule registry.
 *
 * Two tests on the verbatim value:
 *  - the substring `noindex`, because the directive arrives as a comma list
 *    ("max-snippet:-1, noindex, nofollow") with any bot prefix;
 *  - `none` (Google's shorthand for "noindex, nofollow") as a WHOLE directive,
 *    read as `robotsTokens` reads it:
 *     - bounded on both sides, so "nonevent" is not the directive;
 *     - a `name:` prefix names a bot and is read as a directive for the page,
 *       so a colon also opens the token (`googlebot:none`);
 *     - the value directives (`max-snippet`, `max-image-preview`,
 *       `max-video-preview`) keep their value: `max-image-preview: none` asks
 *       for no image preview, not for `none`, with or without the space after
 *       the colon, so those spans are cut out before `none` is looked for.
 */

/** A value directive with its value: `max-image-preview: none`, `max-snippet:-1`. */
const VALUE_DIRECTIVE_SPAN = /max-(?:snippet|image-preview|video-preview)\s*:\s*[^\s,]*/gi;

/** `none` as a whole directive, a bot prefix's colon counting as a left bound. */
const NONE_DIRECTIVE = /(?:^|[\s,:])none(?:[\s,]|$)/i;

export function saysNoindex(value: string | null): boolean {
  if (value === null) return false;
  return /noindex/i.test(value) || NONE_DIRECTIVE.test(value.replace(VALUE_DIRECTIVE_SPAN, ""));
}

/**
 * Whether a `Content-Type` value names a PDF: the media type `application/pdf`,
 * case-insensitive, parameters ignored (`application/PDF; charset=binary` is
 * one). Its SQL spelling is `IS_PDF` (src/rules/helpers.ts), pinned against
 * this in test/crawl/pdf-indexable.test.ts.
 *
 * A PDF is the one non-HTML answer whose indexability is a reading of its
 * headers rather than false by construction (owner ruling 2026-11-24, Phase 29d
 * R1): see `isDocumentOk`.
 */
const PDF_MEDIA_TYPE = /^\s*application\/pdf\s*(?:;|$)/i;

export function isPdf(contentType: string | null): boolean {
  return contentType !== null && PDF_MEDIA_TYPE.test(contentType);
}

/** The three columns `isDocumentOk` reads, as the crawl and the rule layer both hold them. */
export interface DocumentAnswer {
  fetchClass: string;
  statusCode: number | null;
  contentType: string | null;
}

/**
 * A 200 whose indexability its robots directives decide: an HTML page fetched
 * `ok`, or a PDF (`non_html` with a PDF content type). ONE DEFINITION, read by
 * the crawl writer when it stamps `pages.is_indexable` (src/crawl/persist.ts)
 * and by the rule layer wherever "an indexable document" is the question
 * (`indexabilityOf`, `canonical.non-indexable-target`); its SQL spelling is
 * `DOCUMENT_OK` (src/rules/helpers.ts).
 *
 * Every other answer — a redirect, an error, a Word file, an image — is not
 * indexable whatever its headers say, so its `is_indexable` is false by
 * construction rather than read. A PDF's robots channel is its `X-Robots-Tag`
 * header only; it has no HTML to carry a meta, and its `Link` canonical does
 * not change the stamp, exactly as an HTML canonical does not.
 */
export function isDocumentOk(answer: DocumentAnswer): boolean {
  return (
    answer.statusCode === 200 &&
    (answer.fetchClass === "ok" || (answer.fetchClass === "non_html" && isPdf(answer.contentType)))
  );
}
