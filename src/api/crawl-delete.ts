/**
 * `crawl_delete` (Phase 27b T5): everything a crawl owns, rows and files.
 *
 * Every child table references `crawls` with ON DELETE CASCADE, so deleting the
 * `crawls` row alone would remove the rows. They are deleted one table at a
 * time anyway, because the answer says how many rows went from each, and a
 * count taken before the delete would be a guess about what the delete did.
 * `CRAWL_CHILD_TABLES` is pinned to `information_schema` by a test: a table
 * added with a `crawl_id` and not listed here fails there, not in production
 * with rows left behind a "deleted" crawl.
 *
 * Files are removed AFTER the transaction commits (a rolled-back delete must
 * not have lost files), and a failure to remove one is thrown with every path
 * left on disk, never swallowed (rule 7).
 */
import { eq, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join as joinPath, resolve as resolvePath, sep as pathSep } from "node:path";

import type { Db } from "../db/client.js";
import {
  crawlCredentials,
  crawls,
  frontier,
  hreflang,
  issues,
  links,
  listUrls,
  metrics,
  pageResources,
  pages,
  resources,
  sitemapHreflang,
  sitemapMemberships,
  sitemapUrls,
  structuredData,
  urlParams,
} from "../db/schema.js";
import { tenantExportDir, type TenantId } from "../tenant.js";

type CrawlChildTable = PgTable & { crawlId: PgColumn };

/**
 * The 15 tables with a `crawl_id`, in deletion order: what points at `pages`
 * and `resources` goes before them, then `frontier`, `list_urls`, and the
 * crawl's encrypted credentials (28b).
 */
export const CRAWL_CHILD_TABLES: readonly CrawlChildTable[] = [
  issues,
  metrics,
  links,
  pageResources,
  structuredData,
  hreflang,
  urlParams,
  sitemapHreflang,
  sitemapMemberships,
  sitemapUrls,
  resources,
  pages,
  frontier,
  listUrls,
  crawlCredentials,
];

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Delete the crawl's rows inside the caller's transaction and answer how many
 * went from each table, `crawls: 1` included. A driver that does not report a
 * count, or a crawl row that is not there to delete, throws.
 */
export async function deleteCrawlRows(tx: Tx, crawlId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CRAWL_CHILD_TABLES) {
    const name = getTableName(table);
    const result = await tx.delete(table).where(eq(table.crawlId, crawlId));
    if (result.rowCount === null) {
      throw new Error(`deleteCrawlRows: the driver reported no row count for ${name}`);
    }
    counts[name] = result.rowCount;
  }
  const gone = await tx.delete(crawls).where(eq(crawls.id, crawlId));
  if (gone.rowCount !== 1) {
    throw new Error(
      `deleteCrawlRows: deleting the crawls row for ${crawlId} removed ${String(gone.rowCount)} rows, not 1`,
    );
  }
  counts["crawls"] = 1;
  return counts;
}

/** Every regular file under a directory; a directory that is not there holds none. */
async function filesUnder(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = joinPath(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove the crawl's render artifacts (`<renderDir>/<crawlId>/`, recursively)
 * and every file in the owning tenant's export directory
 * (`<exportDir>/<tenant>/`, `tenantExportDir`) whose name starts with the
 * crawl's slug and a dash — exports and their stray `.tmp-` files alike. Answers how
 * many regular files went. Throws, naming every path left on disk, if any
 * could not be removed; the crawl's rows are gone by then and the message says
 * so.
 */
export async function deleteCrawlFiles(
  crawlId: string,
  crawlSlug: string,
  renderDir: string,
  exportRoot: string,
  tenant: TenantId,
): Promise<{ renders: number; exports: number }> {
  // The tenant's own directory, where `exportCrawl` writes: another tenant's
  // directory is never listed, whatever its files are called.
  const exportDir = tenantExportDir(exportRoot, tenant);
  // CONTAINMENT, as `exportCrawl` checks its file: the recursive remove below
  // must only ever reach a directory INSIDE the render directory. Crawl ids are
  // server-generated, but this is a recursive delete, and an id that resolved
  // to the render directory itself or above it would take what is not this
  // crawl's. Checked before anything is removed.
  const renderBase = resolvePath(renderDir);
  const renderRoot = resolvePath(renderBase, crawlId);
  if (!renderRoot.startsWith(renderBase + pathSep)) {
    throw new Error(
      `crawl ${crawlId}: its database rows are deleted, but its render directory ` +
        `would resolve outside the render directory (${renderRoot}, not under ` +
        `${renderBase}); refusing to remove it, and no file was removed`,
    );
  }

  const leftOnDisk: string[] = [];
  const causes: string[] = [];

  // A directory that cannot be listed is left on disk and named, not thrown
  // raw: by now the rows are gone, and the caller must be told that and where
  // the files still are. The remove is not attempted on a tree nobody could
  // count.
  let renderFiles: string[] | null = null;
  try {
    renderFiles = await filesUnder(renderRoot);
  } catch (error) {
    leftOnDisk.push(renderRoot);
    causes.push(`${renderRoot}: could not be listed: ${describe(error)}`);
  }
  if (renderFiles !== null) {
    try {
      await rm(renderRoot, { recursive: true, force: true });
    } catch (error) {
      leftOnDisk.push(renderRoot);
      causes.push(`${renderRoot}: ${describe(error)}`);
    }
  }

  let exportEntries: Dirent[];
  try {
    exportEntries = await readdir(exportDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      leftOnDisk.push(exportDir);
      causes.push(
        `${exportDir}: could not be listed, so any export of this crawl in it is left: ` +
          describe(error),
      );
    }
    exportEntries = [];
  }
  // A PREFIX MATCH, which is only safe because crawl ids are server-generated
  // in one fixed format (`crawl_<uuid>`): no crawl's slug is a prefix of
  // another's followed by a dash, so `<slug>-` names this crawl's exports and
  // nobody else's. A caller-chosen id, or a slug that collapsed or truncated
  // two ids to one, would break that, and this match with it.
  const prefix = `${crawlSlug}-`;
  let exports = 0;
  for (const entry of exportEntries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const path = joinPath(exportDir, entry.name);
    try {
      await rm(path);
      exports += 1;
    } catch (error) {
      leftOnDisk.push(path);
      causes.push(`${path}: ${describe(error)}`);
    }
  }

  if (leftOnDisk.length > 0) {
    throw new Error(
      `crawl ${crawlId}: its database rows are deleted, but ${leftOnDisk.length} path(s) could ` +
        `not be removed and are still on disk: ${leftOnDisk.join(", ")} (${causes.join("; ")})`,
    );
  }
  if (renderFiles === null) {
    // A listing failure is in `leftOnDisk`, which threw above; never a 0.
    throw new Error(`crawl ${crawlId}: the render directory could not be listed (${renderRoot})`);
  }
  return { renders: renderFiles.length, exports };
}
