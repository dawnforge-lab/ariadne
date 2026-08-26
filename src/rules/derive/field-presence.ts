/**
 * The `field_presence` derivation: which fields of a profiled schema type each
 * JSON-LD block on the site actually carries.
 *
 * Like `deriveUrlParams` this is not a rule. It accuses nobody and writes no
 * findings — it fills in `structured_data.field_presence_jsonb`, which
 * `schema.product-incomplete` reads and which the agent reads as context. The
 * split is the same one the runner enforces: derivations write their own
 * columns, rules write `issues`.
 *
 * **Why the arithmetic is in JavaScript here, and in SQL there.** The URL
 * inventory aggregates every URL of the crawl, so pulling it into memory would
 * break the memory contract for nothing. This one asks a different question —
 * "does this object carry a usable value under this key" — of a nested JSON
 * document whose `offers` may be an object or an array of objects. Expressed in
 * SQL that is a pile of `jsonb_typeof` branches nobody can read; expressed here
 * it is `hasValue` and a predicate, and the streaming keeps RAM bounded (see
 * `FIELD_PRESENCE_PAGE_BATCH`).
 *
 * **The group contract.** `structured_data` has NO primary key: a page can
 * carry two `Product` blocks and nothing in the row identifies which is which.
 * The write-back therefore targets `(crawl_id, page_id, schema_type)` and every
 * row of that group receives the SAME answer — the union (logical OR, field by
 * field) of what the group's blocks carry. That is a deliberate reading, not an
 * accident of the table: a page whose second Product block supplies the image
 * the first omits is not a page missing an image, and the rule's copy says "no
 * Product block on the page provides…" for exactly this reason. The cost is
 * that a page with two Product blocks cannot be told *which* block is thin —
 * a question no PK-less table can answer, and one the raw blocks beside the
 * presence blob still let a reader settle by eye.
 */
import { eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";

/** A schema type's fields, and how to tell whether a block carries one. */
export interface SchemaProfile {
  /** Fields Google requires for the type's rich result. */
  required: readonly string[];
  /** Fields that improve the result but whose absence is not a fault. */
  recommended: readonly string[];
  /**
   * Fields whose presence is more than "the key carries something", by field
   * name. Everything not named here is judged by `hasValue`.
   */
  predicates?: Readonly<Record<string, (value: unknown) => boolean>>;
}

/**
 * The fields of an `offers` object that make it an offer rather than a
 * placeholder. Google's Product documentation asks for one of the two, and a
 * Merchant listing with neither shows no price at all.
 */
export const OFFER_PRICE_FIELDS: readonly string[] = ["price", "priceSpecification"];

/**
 * The schema types this engine has an opinion about, and what that opinion is.
 *
 * Deliberately two. A profile is a claim about what a type NEEDS, and a claim
 * we get wrong produces a false accusation about a client's markup; these two
 * are the ones the plan's table names, and the rest of a site's structured data
 * is left to the agent, whose judgement is not constrained by a table here.
 *
 * Keyed by the exact `@type` string the analyzer stored (`ldJsonType`), so a
 * block declaring `https://schema.org/Product` is not profiled — it is a
 * spelling this engine has never seen from a crawl, and guessing that it means
 * `Product` would be a claim about markup nobody checked.
 */
export const SCHEMA_PROFILES: Readonly<Record<string, SchemaProfile>> = {
  Product: {
    required: ["name", "image", "offers"],
    recommended: ["description", "sku", "brand", "aggregateRating", "review"],
    predicates: { offers: offersCarryPrice },
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
  },
};

/** The presence blob written into `field_presence_jsonb`. */
export interface FieldPresence {
  required: Record<string, boolean>;
  recommended: Record<string, boolean>;
}

export interface FieldPresenceDerivation extends Record<string, number> {
  /** `structured_data` rows whose presence blob was written. */
  blocks: number;
}

/**
 * Pages whose blocks are held in memory at once.
 *
 * Pages rather than rows, because the group contract above needs every block of
 * a page to be judged together: a batch that ended mid-page would write half a
 * group's union and then overwrite it with the other half. RAM is therefore
 * O(pages per batch × their profiled fields), never O(crawl).
 *
 * The honest worst case: the analyzer stores at most 50 blocks per page from
 * scripts of at most 100KB each, so an adversarial page could carry megabytes
 * of JSON-LD and a hundred of them would be a large batch. Only the profiled
 * FIELDS are selected (see the projection in the query below) rather than the
 * whole `raw_jsonb`, which is what keeps the ordinary case — a few kilobytes of
 * markup per page — in the tens of kilobytes per batch.
 */
export const FIELD_PRESENCE_PAGE_BATCH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a JSON value declares something.
 *
 * The rule layer's `present()` applied to JSON: a key whose value is null, an
 * empty (or blank) string, or an empty array declares nothing, and reading it
 * as a declaration would hide a page from the rule that reports the absence
 * while every other reader treats the field as missing (hard rule 1).
 *
 * An array counts when at least one member does, so `image: ["", "/a.jpg"]` is
 * an image. An object counts as present whatever it holds: this engine has no
 * profile for an arbitrary nested type, and calling `brand: {}` absent would be
 * a judgement about a shape nothing here checked.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry));
  return true;
}

/**
 * Whether a Product's `offers` names a price.
 *
 * `offers` may be a single Offer or an array of them (one per variant), and one
 * priced offer is enough — that is the shape a rich result needs. A `price` of
 * `0` counts: a free item has a price, and `hasValue` only rejects emptiness,
 * never a falsy number.
 */
export function offersCarryPrice(value: unknown): boolean {
  const offers = Array.isArray(value) ? value : [value];
  return offers.some(
    (offer) => isRecord(offer) && OFFER_PRICE_FIELDS.some((field) => hasValue(offer[field])),
  );
}

/** Every field name any profile mentions — what the SQL projection keeps. */
export const PROFILED_FIELDS: readonly string[] = [
  ...new Set(
    Object.values(SCHEMA_PROFILES).flatMap((profile) => [
      ...profile.required,
      ...profile.recommended,
    ]),
  ),
];

/** One block's presence, judged against its type's profile. */
function computePresence(profile: SchemaProfile, fields: Record<string, unknown>): FieldPresence {
  const judge = (field: string): boolean => {
    const predicate = profile.predicates?.[field];
    const value = fields[field];
    return predicate === undefined ? hasValue(value) : predicate(value);
  };
  return {
    required: Object.fromEntries(profile.required.map((f) => [f, judge(f)])),
    recommended: Object.fromEntries(profile.recommended.map((f) => [f, judge(f)])),
  };
}

/** The union of two blocks' presence: a field the group carries anywhere. */
function mergePresence(a: FieldPresence, b: FieldPresence): FieldPresence {
  const union = (
    left: Record<string, boolean>,
    right: Record<string, boolean>,
  ): Record<string, boolean> =>
    Object.fromEntries(Object.keys(left).map((f) => [f, left[f] === true || right[f] === true]));
  return { required: union(a.required, b.required), recommended: union(a.recommended, b.recommended) };
}

/**
 * A row of the batch query below. A type alias rather than an interface
 * because `db.execute<T>` constrains T to `Record<string, unknown>`, and only
 * an alias of an object literal carries the implicit index signature that
 * satisfies it.
 */
type BlockRow = {
  page_id: string;
  schema_type: string;
  /** The profiled fields of `raw_jsonb`, or null when it carries none of them. */
  fields: Record<string, unknown> | null;
};

/**
 * Fill in `field_presence_jsonb` for one crawl's profiled blocks.
 *
 * Idempotent by recomputation: the same blocks produce the same blobs, so a
 * second run over the same crawl overwrites each row with what it already held.
 * There is no delete-and-rebuild step (and no need for one): unlike an
 * inventory table, this column lives ON the rows the crawl wrote, so a block
 * that no longer exists took its presence with it.
 *
 * Rows of unprofiled types are left NULL, which is the honest reading: "this
 * engine has no profile for `Article`", not "this Article carries no fields".
 * The rule side treats the two apart — a Product row with a null blob is a
 * derivation that did not run, and it refuses to guess.
 */
export async function deriveFieldPresence(
  db: Db,
  crawlId: string,
): Promise<FieldPresenceDerivation> {
  // A crawl id nothing knows selects no blocks, and "nothing to derive" reads
  // exactly like a site that publishes no structured data. Ask the crawls table
  // first (hard rule 7, and `deriveUrlParams`' precedent).
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveFieldPresence: no such crawl '${crawlId}'`);

  const types = sql.param([...Object.keys(SCHEMA_PROFILES)]);
  const fields = sql.param([...PROFILED_FIELDS]);

  return db.transaction(async (tx) => {
    let blocks = 0;
    let cursor = "";
    for (;;) {
      // A page's blocks are read whole: the inner `page_ids` picks the next
      // batch of pages by id cursor, and the outer select takes every profiled
      // block of those pages. The projection keeps only the fields any profile
      // mentions — `jsonb_each` over an object, so a row whose `raw_jsonb` is
      // not an object would raise rather than be quietly skipped. Only nodes
      // carrying an `@type` string reach a profiled `schema_type`, so that is a
      // row this crawler could not have written.
      const batch = await tx.execute<BlockRow>(sql`
        with page_ids as (
          select distinct page_id
          from structured_data
          where crawl_id = ${crawlId}
            and page_id > ${cursor}
            and schema_type = any(${types}::text[])
          order by page_id
          limit ${FIELD_PRESENCE_PAGE_BATCH}
        )
        select sd.page_id, sd.schema_type,
               (select jsonb_object_agg(f.key, f.value)
                  from jsonb_each(sd.raw_jsonb) f
                 where f.key = any(${fields}::text[])) as fields
        from structured_data sd
        join page_ids pi on pi.page_id = sd.page_id
        where sd.crawl_id = ${crawlId}
          and sd.schema_type = any(${types}::text[])
        order by sd.page_id`);
      if (batch.rows.length === 0) break;

      const groups = new Map<string, { pageId: string; type: string; presence: FieldPresence }>();
      for (const row of batch.rows) {
        const profile = SCHEMA_PROFILES[row.schema_type];
        // Unreachable while the query filters on the same keys — and if it ever
        // is reached, the alternative is writing a presence blob derived from
        // no profile at all.
        if (profile === undefined) {
          throw new Error(
            `deriveFieldPresence: crawl '${crawlId}' block of type '${row.schema_type}' ` +
              "was selected but has no profile",
          );
        }
        const presence = computePresence(profile, row.fields ?? {});
        const key = `${row.page_id}\n${row.schema_type}`;
        const seen = groups.get(key);
        groups.set(key, {
          pageId: row.page_id,
          type: row.schema_type,
          presence: seen === undefined ? presence : mergePresence(seen.presence, presence),
        });
      }

      const values: SQL[] = [...groups.values()].map(
        (g) =>
          sql`(${g.pageId}::text, ${g.type}::text, ${JSON.stringify(g.presence)}::jsonb)`,
      );
      const written = await tx.execute(sql`
        update structured_data sd
        set field_presence_jsonb = v.presence
        from (values ${sql.join(values, sql`, `)}) as v(page_id, schema_type, presence)
        where sd.crawl_id = ${crawlId}
          and sd.page_id = v.page_id
          and sd.schema_type = v.schema_type`);
      if (written.rowCount === null) {
        throw new Error(
          `deriveFieldPresence: crawl '${crawlId}' — the update reported no row count, ` +
            "so how many blocks were judged is unknown",
        );
      }
      blocks += written.rowCount;

      // The rows come back ordered by page id, so the last one is the batch's
      // high-water mark and the next round starts strictly after it.
      cursor = batch.rows[batch.rows.length - 1]!.page_id;
    }
    return { blocks };
  });
}
