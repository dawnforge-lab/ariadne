-- Phase 29d (Task 5a, ruling R1): a PDF is indexable unless its headers say
-- otherwise (owner, 2026-11-24). Before this, PageWriter stamped every
-- `non_html` row `is_indexable = false`; from 29d it stamps a 200 PDF true
-- unless its X-Robots-Tag says noindex (or none). Stored crawls are rewritten
-- here from the facts stored beside the stamp since 26c: the status, the
-- content type and the X-Robots-Tag header. The canonical is not read, as for
-- HTML. Every other row (HTML, a Word file, an image, a non-200) is untouched.
--
-- The two predicates are the rule layer's SQL helpers, copied verbatim:
-- IS_PDF('content_type') and SAYS_NOINDEX('x_robots_tag') in
-- src/rules/helpers.ts (test/db/pdf-indexable-migration.test.ts pins the
-- text). Idempotent: a row already true is not rewritten.
UPDATE pages SET is_indexable = true
WHERE fetch_class = 'non_html'
  AND status_code = 200
  AND coalesce(content_type ~* '^[[:space:]]*application/pdf[[:space:]]*(;|$)', false)
  AND NOT coalesce(x_robots_tag ~* 'noindex' or regexp_replace(x_robots_tag, 'max-(snippet|image-preview|video-preview)[[:space:]]*:[[:space:]]*[^[:space:],]*', '', 'gi') ~* '(^|[\s,:])none([\s,]|$)', false)
  AND is_indexable IS DISTINCT FROM true;
