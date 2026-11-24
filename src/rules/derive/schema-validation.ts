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
 * **Memory (hard rule 6).** Rows stream by an `id` cursor (the `sd_crawl_id`
 * index serves exactly that query), so RAM is O(batch) however many blocks the
 * crawl holds. A batch is bounded twice, because a row count alone does not
 * bound bytes (29d final review): it is at most `SCHEMA_VALIDATION_BATCH` rows
 * AND at most `SCHEMA_VALIDATION_READ_CHARS` of raw block text (one row always,
 * whatever its size); and the verdicts are written back whenever their JSON
 * reaches `SCHEMA_VALIDATION_WRITE_CHARS`, not once per batch. Each block's
 * page is joined in for its URL, the base its ids resolve against (29a
 * rework): one text per row.
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
 * The most rows one select reads. Each row contributes two parameters to a
 * write-back (id, blob), so even one write-back of a whole batch stays far
 * under Postgres's 65,535-parameter limit.
 */
export const SCHEMA_VALIDATION_BATCH = 500;

/**
 * The most raw block text (`raw_jsonb` as JSON, plus the page URL) one select
 * reads: 8 MiB. Rows are taken in `id` order while the running total stays
 * under it, the first row always (a block is at most about 100k characters,
 * `MAX_LD_JSON_CHARS`, so one row never threatens the bound). Why a byte
 * bound beside the row count: 500 rows of the largest storable block are
 * about 50 MB of text, and JSON parsed into objects costs several times its
 * text — a hostile batch of bare references measured at about 5x. 8 MiB keeps
 * the parsed batch in the tens of megabytes while an ordinary crawl's 500
 * blocks (a few KB each) still fit in one select.
 */
export const SCHEMA_VALIDATION_READ_CHARS = 8 * 1024 * 1024;

/**
 * The verdict JSON one write-back carries: 8 MiB of characters. A verdict is
 * bounded per block (`MAX_BLOCK_ID_CHARS`, 256 KiB of ids, plus 50-entry
 * lists) but not small: on a long page URL every block of bare references
 * fills its id budget, about 340k characters of verdict. 500 of them held as
 * strings, then copied into pg's Bind buffer, were about 340 MB of a 512 MB
 * budget. Flushed at 8 MiB, the strings and their Bind copy stay near 16 MiB
 * plus one verdict, and an ordinary batch (verdicts of a few KB) is still one
 * statement.
 */
export const SCHEMA_VALIDATION_WRITE_CHARS = 8 * 1024 * 1024;

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

    // Verdicts waiting to be written, and their JSON's length.
    let pending: SQL[] = [];
    let pendingChars = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const written = await tx.execute(sql`
        update structured_data sd
        set validation_jsonb = v.val
        from (values ${sql.join(pending, sql`, `)}) as v(id, val)
        where sd.crawl_id = ${crawlId} and sd.id = v.id`);
      if (written.rowCount !== pending.length) {
        throw new Error(
          `deriveSchemaValidation: crawl '${crawlId}' — wrote ${String(written.rowCount)} ` +
            `rows for ${pending.length} verdicts; a block was lost between select and update`,
        );
      }
      blocks += written.rowCount;
      pending = [];
      pendingChars = 0;
    };

    for (;;) {
      // The first `SCHEMA_VALIDATION_BATCH` rows past the cursor, then the
      // prefix of them whose raw text stays under `SCHEMA_VALIDATION_READ_CHARS`
      // (the first row always: its running total less its own size is 0). The
      // inner limit bounds the server's work to one batch, so the size is never
      // computed over the rest of the crawl. The size is the text the driver
      // receives (`::text`), not `pg_column_size`, which is the compressed
      // stored size and reads a repetitive hostile block as small.
      // Qualified on purpose: a bare `order by id` binds to the text alias
      // and sorts lexically while the cursor advances numerically.
      const batch = await tx.execute<BlockRow>(sql`
        select w.id::text as id, w.raw_jsonb, w.url
        from (
          select b.*, sum(b.size) over (order by b.id) as running
          from (
            select sd.id, sd.raw_jsonb, p.url,
                   octet_length(sd.raw_jsonb::text) + octet_length(p.url) as size
            from structured_data sd
            join pages p on p.crawl_id = sd.crawl_id and p.id = sd.page_id
            where sd.crawl_id = ${crawlId} and sd.id > ${cursor}::bigint
            order by sd.id
            limit ${SCHEMA_VALIDATION_BATCH}
          ) b
        ) w
        where w.running - w.size < ${SCHEMA_VALIDATION_READ_CHARS}
        order by w.id`);
      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
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
        const json = JSON.stringify(blob);
        pending.push(sql`(${row.id}::bigint, ${json}::jsonb)`);
        pendingChars += json.length;
        if (pendingChars >= SCHEMA_VALIDATION_WRITE_CHARS) await flush();
      }
      await flush();

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
