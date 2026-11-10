/**
 * Prune the crawls the test suite left in a development database.
 *
 *   DATABASE_URL=… npx tsx scripts/prune-test-crawls.ts            # dry run
 *   DATABASE_URL=… npx tsx scripts/prune-test-crawls.ts --confirm  # delete
 *
 * A crawl is a test crawl when its `site_url` host is a loopback address
 * (127.0.0.0/8, ::1) or sits under a reserved name (`localhost`, `.test`,
 * `.example`, `.invalid`, `.localhost`). Nothing else is ever touched: a real
 * site's crawl cannot match.
 *
 * Without `--confirm` it prints one line per match (`id status site_url pages`)
 * and the totals, and changes nothing. With it, matching `queued`/`running`
 * rows with no unexpired lease (dead: the suite's processes are gone) are, one
 * crawl at a time, set to `cancelled` (`deleteCrawl` refuses live statuses) and
 * deleted through `ApiService.deleteCrawl`, which removes every child table and
 * file. A queued/running match holding an unexpired lease has a worker on it:
 * it is listed as "live, skipped" and never cancelled or deleted. The first failure stops the run, naming the crawl, and exits non-zero.
 * Only site URLs are printed — never a crawl's config or credentials.
 */
import { isIPv4, isIPv6 } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../src/db/client.js";
import { crawls, frontier } from "../src/db/schema.js";
import { ApiService } from "../src/api/service.js";

const RESERVED_LABELS = ["localhost", "test", "example", "invalid"] as const;

/** True for a loopback IP, `localhost`, or a name under (or equal to) a reserved label. */
export function isTestHost(siteUrl: string): boolean {
  // `new URL` throws on a malformed site_url: a row we cannot read is an error, not a "no".
  const host = new URL(siteUrl).hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(bare)) return bare.startsWith("127.");
  if (isIPv6(bare)) return bare === "::1";
  return RESERVED_LABELS.some((label) => bare === label || bare.endsWith(`.${label}`));
}

export interface PruneOptions {
  confirm: boolean;
  /** Restrict to these crawl ids (tests share a database with other files). */
  onlyIds?: ReadonlySet<string>;
}

export interface PruneResult {
  matched: number;
  pages: number;
  /** Queued/running matches holding an unexpired lease: a worker may be on them, so they are left alone. */
  liveSkipped: number;
  cancelled: number;
  deleted: number;
}

export async function pruneTestCrawls(
  db: Db,
  service: ApiService,
  options: PruneOptions,
  print: (line: string) => void,
): Promise<PruneResult> {
  const rows = await db
    .select({ id: crawls.id, status: crawls.status, siteUrl: crawls.siteUrl, pages: crawls.pagesCrawled })
    .from(crawls)
    .orderBy(crawls.startedAt);
  const matches = rows.filter(
    (r) => (options.onlyIds === undefined || options.onlyIds.has(r.id)) && isTestHost(r.siteUrl),
  );
  const isLiveStatus = (status: string): boolean => status === "queued" || status === "running";
  // A queued/running row with an unexpired lease has a worker on it: not dead.
  const candidates = matches.filter((r) => isLiveStatus(r.status)).map((r) => r.id);
  const leased =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .selectDistinct({ crawlId: frontier.crawlId })
              .from(frontier)
              .where(and(inArray(frontier.crawlId, candidates), gt(frontier.leasedUntil, sql`now()`)))
          ).map((r) => r.crawlId),
        );
  const liveRows = matches.filter((r) => leased.has(r.id));
  const targets = matches.filter((r) => !leased.has(r.id));
  const dead = targets.filter((r) => isLiveStatus(r.status));

  for (const r of targets) print(`${r.id} ${r.status} ${r.siteUrl} ${String(r.pages)}`);
  for (const r of liveRows) print(`${r.id} ${r.status} ${r.siteUrl} live, skipped`);
  const pages = targets.reduce((sum, r) => sum + r.pages, 0);
  print(
    `${String(targets.length)} test crawls to prune (${String(dead.length)} dead queued/running), ` +
      `${String(pages)} pages; ${String(liveRows.length)} live, skipped; ` +
      `${String(rows.length - matches.length)} crawls left alone`,
  );
  if (!options.confirm) {
    print("dry run: nothing changed (pass --confirm to delete)");
    return { matched: matches.length, pages, liveSkipped: liveRows.length, cancelled: 0, deleted: 0 };
  }

  // One crawl at a time, so a failure leaves at most the crawl it names part-way.
  let cancelled = 0;
  let deleted = 0;
  for (const r of targets) {
    try {
      if (isLiveStatus(r.status)) {
        const done = await db
          .update(crawls)
          .set({ status: "cancelled", controlRequest: null, pauseReason: null, cancelledAt: sql`now()` })
          .where(and(eq(crawls.id, r.id), inArray(crawls.status, ["queued", "running"])));
        cancelled += done.rowCount ?? 0;
      }
      await service.deleteCrawl(r.id, r.id);
    } catch (error) {
      throw new Error(`could not prune crawl ${r.id} (${r.siteUrl}): ${(error as Error).message}`);
    }
    deleted += 1;
  }
  print(`deleted ${String(deleted)} crawls (${String(cancelled)} cancelled first); ${String(liveRows.length)} live, skipped`);
  return { matched: matches.length, pages, liveSkipped: liveRows.length, cancelled, deleted };
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--confirm");
  if (unknown.length > 0) throw new Error(`unknown argument '${unknown[0]}'; the only flag is --confirm`);
  const db = createDb(url);
  const service = new ApiService(db, { allowedDomains: [], log: () => {} });
  try {
    await pruneTestCrawls(db, service, { confirm: args.includes("--confirm") }, (l) => console.log(l));
  } finally {
    await service.close();
    await closeDb(db);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
