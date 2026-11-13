/**
 * The `validation_jsonb` derivation: every stored structured-data block run
 * through the node validator (`validateBlock`, src/rules/schema-org/validate.ts)
 * and the verdict written beside it.
 *
 * Like `deriveUrlParams` this is not a rule. It accuses nobody and writes no
 * findings; the schema rules read the blob it fills in. Derivations write their
 * own columns, rules write `issues`.
 *
 * **Why it runs at rules time and not at crawl time.** The vocabulary and the
 * Google profiles are the ruleset's, not the crawler's: a crawl judged again
 * under a newer ruleset must be re-validated without being re-fetched. The raw
 * block is stored once; the verdict is recomputed on every run.
 *
 * **Memory (hard rule 6).** Rows stream by an `id` cursor, `SCHEMA_VALIDATION_BATCH`
 * at a time (the `sd_crawl_id` index serves exactly that query), so RAM is
 * O(batch) however many blocks the crawl holds.
 *
 * **Errors are loud.** `validateBlock` throws on a block it cannot judge (a
 * non-object, or one past the nesting cap). The analyzer never stores such a
 * block, so a row that does throw is one this engine did not write; the error
 * names the crawl and the row id, and the transaction rolls back.
 */
import { eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { crawls } from "../../db/schema.js";
import { validateBlock } from "../schema-org/validate.js";

/**
 * Rows validated and written back per round trip. Each row contributes two
 * parameters to the write-back (id, blob), so a batch stays far under
 * Postgres's 65,535-parameter limit.
 */
export const SCHEMA_VALIDATION_BATCH = 500;

export interface SchemaValidationDerivation extends Record<string, number> {
  /** `structured_data` rows whose validation blob was written. */
  blocks: number;
}

type BlockRow = {
  id: string;
  raw_jsonb: unknown;
};

/**
 * Fill in `validation_jsonb` for every block of one crawl.
 *
 * Idempotent by recomputation: the same blocks produce the same blobs, so a
 * second run overwrites each row with what it already held.
 */
export async function deriveSchemaValidation(
  db: Db,
  crawlId: string,
): Promise<SchemaValidationDerivation> {
  // A crawl id nothing knows selects no blocks, and "nothing to derive" reads
  // exactly like a site that publishes no structured data. Ask the crawls table
  // first (hard rule 7, and `deriveUrlParams`' precedent).
  const crawl = await db
    .select({ id: crawls.id })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  if (crawl.length === 0) throw new Error(`deriveSchemaValidation: no such crawl '${crawlId}'`);

  return db.transaction(async (tx) => {
    let blocks = 0;
    // `id` is a bigserial; the driver returns it as a string, and a string
    // cursor compared with `id > $cursor::bigint` stays exact past 2^53.
    let cursor = "0";
    for (;;) {
      const batch = await tx.execute<BlockRow>(sql`
        select id::text as id, raw_jsonb
        from structured_data
        where crawl_id = ${crawlId} and id > ${cursor}::bigint
        order by id
        limit ${SCHEMA_VALIDATION_BATCH}`);
      if (batch.rows.length === 0) break;

      const values: SQL[] = batch.rows.map((row) => {
        let blob;
        try {
          blob = validateBlock(row.raw_jsonb);
        } catch (err) {
          throw new Error(
            `deriveSchemaValidation: crawl '${crawlId}' structured_data row ${row.id} ` +
              `could not be validated: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        return sql`(${row.id}::bigint, ${JSON.stringify(blob)}::jsonb)`;
      });

      const written = await tx.execute(sql`
        update structured_data sd
        set validation_jsonb = v.val
        from (values ${sql.join(values, sql`, `)}) as v(id, val)
        where sd.crawl_id = ${crawlId} and sd.id = v.id`);
      if (written.rowCount !== batch.rows.length) {
        throw new Error(
          `deriveSchemaValidation: crawl '${crawlId}' — wrote ${String(written.rowCount)} ` +
            `rows for a batch of ${batch.rows.length}; a block was lost between select and update`,
        );
      }
      blocks += written.rowCount;

      cursor = batch.rows[batch.rows.length - 1]!.id;
    }
    return { blocks };
  });
}
