/**
 * The `validation_jsonb` derivation: every stored structured-data block run
 * through the node validator (`validateBlock`, src/rules/schema-org/validate.ts)
 * and the verdict written beside it.
 *
 * Like `deriveUrlParams` this is not a rule. It accuses nobody and writes no
 * findings; the schema rules read the blob it fills in. Derivations write their
 * own columns, rules write `issues`.
 *
 * **Why it runs at rules time and not at crawl time.** The schema.org
 * vocabulary is the ruleset's, not the crawler's: a crawl judged again
 * under a newer ruleset must be re-validated without being re-fetched. The raw
 * block is stored once; the verdict is recomputed on every run.
 *
 * **Memory (hard rule 6).** Rows stream by an `id` cursor, `SCHEMA_VALIDATION_BATCH`
 * at a time (the `sd_crawl_id` index serves exactly that query), so RAM is
 * O(batch) however many blocks the crawl holds. Each block's page is joined in
 * for its URL, the base its ids resolve against (29a rework): one text per row.
 *
 * **Orphan blocks are skipped and counted, not refused.** The page writer
 * leaves `structured_data` rows whose `page_id` has no page row BY DESIGN:
 * when a page insert loses the `(crawl_id, url)` conflict, its child rows keep
 * the minted id (src/crawl/persist.ts, `PageWriter.flushPages`, the comment
 * on the conflict). No surface reads such a row — the rules, the listing, the
 * CSV view and the metric all join `pages` — and its ids have no base to
 * resolve against, so the derivation validates exactly the blocks that have a
 * page (an inner join) and reports how many it left (`orphanBlocks`). Their
 * `validation_jsonb` stays null, and every "re-run the rules" probe counts only
 * blocks with a page, so the null can never refuse a crawl.
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
  /** `structured_data` rows whose validation blob was written: the blocks of existing pages. */
  blocks: number;
  /** Rows whose page row does not exist (see the header), left unvalidated. */
  orphanBlocks: number;
}

type BlockRow = {
  id: string;
  raw_jsonb: unknown;
  /** The block's page URL: the base its ids resolve against. */
  url: string;
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
      // Qualified on purpose: a bare `order by id` binds to the text alias above
      // and sorts lexically while the cursor advances numerically.
      const batch = await tx.execute<BlockRow>(sql`
        select sd.id::text as id, sd.raw_jsonb, p.url
        from structured_data sd
        join pages p on p.crawl_id = sd.crawl_id and p.id = sd.page_id
        where sd.crawl_id = ${crawlId} and sd.id > ${cursor}::bigint
        order by sd.id
        limit ${SCHEMA_VALIDATION_BATCH}`);
      if (batch.rows.length === 0) break;

      const values: SQL[] = batch.rows.map((row) => {
        let blob;
        try {
          blob = validateBlock(row.raw_jsonb, row.url);
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
    // A skipped row must fail here, naming the crawl, not later in a rule: the
    // crawl's blocks with a page are exactly the ones validated, and the rest
    // are counted as orphans.
    const total = await tx.execute<{ n: string; orphans: number }>(sql`
      select count(*) filter (where p.id is not null)::text as n,
             count(*) filter (where p.id is null)::int as orphans
      from structured_data sd
      left join pages p on p.crawl_id = sd.crawl_id and p.id = sd.page_id
      where sd.crawl_id = ${crawlId}`);
    if (String(blocks) !== total.rows[0]!.n) {
      throw new Error(
        `deriveSchemaValidation: crawl '${crawlId}' — validated ${blocks} blocks but the crawl ` +
          `holds ${total.rows[0]!.n} on its pages; the cursor skipped or repeated rows`,
      );
    }
    return { blocks, orphanBlocks: total.rows[0]!.orphans };
  });
}
