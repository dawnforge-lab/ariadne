/**
 * Streaming RDFa Lite 1.1 extraction (Phase 29a), schema.org only, into the
 * same JSON-LD node shape as microdata with `format: "rdfa"`.
 *
 * Driven from the page analyzer's htmlparser2 hooks beside the microdata
 * machine; never a DOM (hard rule 4). The item stores, value budget, bounded
 * text and block emission are item-core.ts, shared with microdata.
 *
 * MAPPING. `typeof` opens a node of that type; on an element that also has
 * `property` the node is that property's value in the enclosing node.
 * `resource` on a `typeof` element is its `@id`. `property` without `typeof`
 * takes `content`, else `resource`, else `href` / `src` (resolved), else
 * `datetime` on `<time>`, else the element's text (capped like microdata's).
 * A `property` with no enclosing `typeof` node is `counts.errors += 1`, the
 * same page counter microdata uses.
 *
 * VOCABULARY. `vocab` sets the vocabulary for its subtree and counts only when
 * it is schema.org (`http` or `https`, trailing slash optional); an empty
 * `vocab` clears it. A bare term needs that vocabulary; `schema:Name` and an
 * absolute schema.org IRI are understood without one (the RDFa initial
 * context), unless a `prefix` rebinds `schema:` elsewhere.
 *
 * UNSUPPORTED (counted in `skips.rdfaUnsupported`, once per element, and the
 * element contributes nothing): `rel`, `rev` or `about` alongside an RDFa
 * attribute (`vocab`, `typeof`, `property`, `prefix`); a `vocab` that is not
 * schema.org; a `typeof` / `property` term outside schema.org (another prefix,
 * a foreign IRI, a bare term without the schema.org vocabulary). An
 * unsupported element with `typeof` still opens a dead item, so the properties
 * inside it attach to nothing and are not misreported as errors. A `rel` on a
 * plain element with no RDFa attribute is ordinary HTML and is not counted.
 *
 * Vocabulary context is tracked per element by the depth it opened at, with
 * O(1) state per element (the one thing a `prefix` can change is `schema:`).
 */
import {
  createItemCore,
  resolveUrl,
  type BlockSink,
  type ItemMachine,
  type ItemNode,
  type StructuredDataCounts,
} from "./item-core.js";
import { schemaOrgName } from "./schema-names.js";

const SCHEMA_VOCAB = /^https?:\/\/schema\.org\/?$/i;
const SCHEMA_PREFIX_TERM = /^schema:/i;

/**
 * The `schema` binding of a `prefix` attribute, if it has one: its IRI.
 * A linear walk over whitespace tokens (page-controlled input, so no
 * backtracking regex): a token ending in `:` is a prefix name and the next
 * token is its IRI. Only the `schema` binding matters here.
 */
function schemaBinding(prefixAttr: string): string | null {
  const tokens = prefixAttr.trim().split(/\s+/);
  let bound: string | null = null;
  for (let i = 0; i + 1 < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.endsWith(":") || token.length === 1) continue;
    const name = token.slice(token.lastIndexOf(":", token.length - 2) + 1, -1);
    if (name.toLowerCase() === "schema") bound = tokens[i + 1]!;
  }
  return bound;
}

type Vocab = "schema" | "other" | "none";

interface Context {
  openedAt: number;
  vocab: Vocab;
  /** `schema:` still means schema.org (false once a `prefix` rebinds it). */
  schemaPrefix: boolean;
}

const RDFA_ATTRIBUTES = ["vocab", "typeof", "property", "prefix"] as const;
const FULL_RDFA_ATTRIBUTES = ["rel", "rev", "about"] as const;

export function createRdfaMachine(
  pageUrl: string,
  sink: BlockSink,
  counts: StructuredDataCounts,
): ItemMachine {
  const core = createItemCore("rdfa", sink, counts);
  const contexts: Context[] = [];
  let current: Context = { openedAt: -1, vocab: "none", schemaPrefix: true };

  /** A schema.org term's bare name in the current context, or null when it is not one. */
  const termName = (term: string): string | null => {
    if (SCHEMA_PREFIX_TERM.test(term)) return current.schemaPrefix ? schemaOrgName(term) : null;
    if (term.includes(":")) {
      // An absolute IRI is schema.org or it is not; any other prefix is foreign.
      return /^https?:\/\//i.test(term) ? schemaOrgName(term) : null;
    }
    return current.vocab === "schema" ? schemaOrgName(term) : null;
  };

  /** All names, or null when any is outside schema.org (the element is then unsupported). */
  const termNames = (value: string): string[] | null => {
    const out: string[] = [];
    for (const token of new Set(value.trim().split(/\s+/))) {
      if (token === "") continue;
      const name = termName(token);
      if (name === null) return null;
      out.push(name);
    }
    return out;
  };

  const attributeValue = (name: string, attribs: Record<string, string>): string | undefined => {
    if ("content" in attribs) return attribs["content"];
    if ("resource" in attribs) return resolveUrl(attribs["resource"]!, pageUrl);
    const link = attribs["href"] ?? attribs["src"];
    if (link !== undefined) return resolveUrl(link, pageUrl);
    if (name === "time" && "datetime" in attribs) return attribs["datetime"];
    return undefined;
  };

  return {
    open(name, attribs, depth) {
      if (!RDFA_ATTRIBUTES.some((a) => a in attribs)) return;

      let unsupported = FULL_RDFA_ATTRIBUTES.some((a) => a in attribs);

      // The vocabulary this element declares applies to the element itself.
      if ("vocab" in attribs || "prefix" in attribs) {
        let vocab = current.vocab;
        let schemaPrefix = current.schemaPrefix;
        const declared = attribs["vocab"]?.trim();
        if (declared !== undefined) {
          if (declared === "") vocab = "none";
          else if (SCHEMA_VOCAB.test(declared)) vocab = "schema";
          else {
            vocab = "other";
            unsupported = true;
          }
        }
        const bound = schemaBinding(attribs["prefix"] ?? "");
        if (bound !== null) schemaPrefix = SCHEMA_VOCAB.test(bound);
        contexts.push({ openedAt: depth, vocab, schemaPrefix });
        current = contexts[contexts.length - 1]!;
      }

      const typeofValue = attribs["typeof"];
      const propertyValue = attribs["property"];
      const types = typeofValue === undefined ? null : termNames(typeofValue);
      const names = propertyValue === undefined ? null : termNames(propertyValue);
      if ((typeofValue !== undefined && types === null) || (propertyValue !== undefined && names === null)) {
        unsupported = true;
      }

      if (unsupported) {
        counts.skips.rdfaUnsupported += 1;
        if (typeofValue !== undefined) core.openDead(depth);
        return;
      }

      const propertyNames = names !== null && names.length > 0 ? names : null;
      if (propertyNames !== null && !core.hasScope()) counts.errors += 1;

      if (typeofValue !== undefined) {
        core.openItem(depth, propertyNames, types !== null && types.length > 0, () => {
          const resource = attribs["resource"]?.trim();
          return {
            type: types?.[0] ?? null,
            id: resource === undefined || resource === "" ? null : resolveUrl(resource, pageUrl),
            props: new Map(),
          } satisfies ItemNode;
        });
        return;
      }
      core.openValue(depth, propertyNames, propertyNames === null ? undefined : attributeValue(name, attribs));
    },

    text: core.text,

    close(depth) {
      if (current.openedAt === depth) {
        contexts.pop();
        current = contexts[contexts.length - 1] ?? { openedAt: -1, vocab: "none", schemaPrefix: true };
      }
      core.close(depth);
    },

    end() {
      core.end();
      if (contexts.length > 0) {
        throw new Error(`rdfa: end() with ${contexts.length} vocabulary context(s) still open (depth drift)`);
      }
    },
  };
}
