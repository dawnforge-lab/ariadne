/** The JSON-LD context URL the writer emits and the extractors recognise. */
export const SCHEMA_ORG_CONTEXT = "https://schema.org";

const IRI = /^https?:\/\/(?:www\.)?schema\.org\/([^/?#\s]+)$/i;
const CURIE = /^schema:([^/?#\s]+)$/i;
const BARE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Reduces a schema.org term in any spelling (bare, `schema:` prefixed, or an
 * http/https IRI with or without www) to its bare name. Anything else, or an
 * empty name, is null.
 */
export function schemaOrgName(term: string): string | null {
  const t = term.trim();
  if (t === "") return null;
  const m = IRI.exec(t) ?? CURIE.exec(t);
  if (m) return m[1]!;
  return BARE.test(t) ? t : null;
}
