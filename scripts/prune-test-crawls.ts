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
 * Without `--confirm` it prints one line per match (`id status site_url pages`),
 * the totals and the number of other sessions connected to the database, and
 * changes nothing.
 *
 * With `--confirm` it first refuses (throws, exit non-zero) while ANY other
 * session is connected to the same database, and re-checks before each crawl's
 * write. A lease alone is not liveness: a running crawl holds no frontier lease
 * outside the page loop (host probe, sitemap walk, seeding, and after the loop
 * the known-404 probe, recheck and resources), a crawl queued in another
 * server's memory holds none at all, and `crawls` has no heartbeat. The script
 * cannot see another process's work, but Postgres can: every Ariadne server,
 * worker and test run holds a connection. So the rule is "no other session, then
 * delete"; stop every Ariadne server and test run using the database first. The
 * script's own pool carries a distinctive `application_name` and is not counted.
 *
 * Once that holds, matching `queued`/`running` rows with no unexpired lease are,
 * one crawl at a time, set to `cancelled` (`deleteCrawl` refuses live statuses)
 * and deleted through `ApiService.deleteCrawl` as the crawl's own tenant (read
 * from its row), which removes every child table and file. The lease check stays as a second guard: a queued/running match
 * holding an unexpired lease is listed as "live, skipped" and never cancelled or
 * deleted. A pending pause/cancel request on any matched crawl is cleared first
 * (no process will act on it; `deleteCrawl` refuses it), and flagged in the dry
 * run. The first failure stops the run, naming the crawl, and exits non-zero.
 * Only site URLs are printed — never a crawl's config or credentials.
 */
import { isIPv4, isIPv6 } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../src/db/client.js";
import { crawls, frontier } from "../src/db/schema.js";
import { ApiService } from "../src/api/service.js";
import { parseTenant } from "../src/api/tenant.js";

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

/** The script's own pool connections carry this name so the other-session count excludes them. */
export const PRUNE_APPLICATION_NAME = "ariadne-prune-test-crawls";

/** The script's database handle: createDb with the script's application_name on every connection. */
export function createPruneDb(databaseUrl: string): Db {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", PRUNE_APPLICATION_NAME);
  return createDb(url.toString());
}

/**
 * Sessions connected to this database that are neither the caller's own backend nor a connection
 * named `ownApplicationName`. Only a count leaves this function: no addresses, users or queries.
 */
export async function countOtherSessions(db: Db, ownApplicationName: string = PRUNE_APPLICATION_NAME): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database()
      and backend_type = 'client backend'
      and pid <> pg_backend_pid()
      and application_name <> ${ownApplicationName}`);
  return Number((result.rows[0] as { n: number }).n);
}

async function databaseName(db: Db): Promise<string> {
  return String((await db.execute(sql`select current_database() as d`)).rows[0]!["d"]);
}

export interface PruneOptions {
  confirm: boolean;
  /** Restrict to these crawl ids (tests share a database with other files). */
  onlyIds?: ReadonlySet<string>;
  /** Test seam: the other-session count (default: `countOtherSessions`). The suite shares its database with other workers, so tests stub it. */
  otherSessions?: (db: Db) => Promise<number>;
  /** Test seam: runs just before each dead crawl's cancel, to take a lease in the check-to-cancel window. */
  beforeCancel?: (crawlId: string) => Promise<void>;
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
  const otherSessions = options.otherSessions ?? ((d: Db) => countOtherSessions(d));
  // Refuse loudly while any other session is connected: it may be a live crawl this script cannot see.
  const assertAlone = async (): Promise<void> => {
    const n = await otherSessions(db);
    if (n > 0) {
      throw new Error(
        `refusing to prune: ${String(n)} other session${n === 1 ? " is" : "s are"} connected to database ` +
          `'${await databaseName(db)}' and may be running a crawl; stop every Ariadne server and test run ` +
          "using this database, then re-run",
      );
    }
  };
  const startSessions = await otherSessions(db);
  if (options.confirm) await assertAlone();
  const rows = await db
    .select({
      id: crawls.id,
      tenantId: crawls.tenantId,
      status: crawls.status,
      siteUrl: crawls.siteUrl,
      pages: crawls.pagesCrawled,
      request: crawls.controlRequest,
    })
    .from(crawls)
    .orderBy(crawls.startedAt);
  const matches = rows.filter(
    (r) => (options.onlyIds === undefined || options.onlyIds.has(r.id)) && isTestHost(r.siteUrl),
  );
  const isLiveStatus = (status: string): boolean => status === "queued" || status === "running";
  // A queued/running row with an unexpired lease has a worker on it: not dead.
  // A pending control request on any status is one no process will ever act on, and deleteCrawl refuses it.
  const needsUpdate = (r: { status: string; request: string | null }): boolean =>
    isLiveStatus(r.status) || r.request !== null;
  const candidates = matches.filter(needsUpdate).map((r) => r.id);
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

  for (const r of targets) {
    print(
      `${r.id} ${r.status} ${r.siteUrl} ${String(r.pages)}` +
        (r.request !== null ? ` request pending (${r.request})` : ""),
    );
  }
  for (const r of liveRows) print(`${r.id} ${r.status} ${r.siteUrl} live, skipped`);
  const pages = targets.reduce((sum, r) => sum + r.pages, 0);
  print(
    `${String(targets.length)} test crawls to prune (${String(dead.length)} dead queued/running), ` +
      `${String(pages)} pages; ${String(liveRows.length)} live, skipped; ` +
      `${String(rows.length - matches.length)} crawls left alone`,
  );
  if (!options.confirm) {
    print(
      `${String(startSessions)} other session${startSessions === 1 ? "" : "s"} connected` +
        (startSessions > 0 ? "; --confirm would refuse while it is > 0" : ""),
    );
    print("dry run: nothing changed (pass --confirm to delete)");
    return { matched: matches.length, pages, liveSkipped: liveRows.length, cancelled: 0, deleted: 0 };
  }

  // One crawl at a time, so a failure leaves at most the crawl it names part-way.
  let cancelled = 0;
  let deleted = 0;
  let liveSkipped = liveRows.length;
  for (const r of targets) {
    try {
      await assertAlone();
      if (needsUpdate(r)) {
        if (options.beforeCancel !== undefined) await options.beforeCancel(r.id);
        // The lease check above may be stale by now: the update re-checks on the database clock,
        // and a crawl it does not touch is treated as live (a worker took a lease, or it moved on).
        // A queued/running row becomes cancelled; any status loses its pending request.
        const live = isLiveStatus(r.status);
        const done = await db
          .update(crawls)
          .set(
            live
              ? { status: "cancelled", controlRequest: null, pauseReason: null, cancelledAt: sql`now()` }
              : { controlRequest: null },
          )
          .where(
            and(
              eq(crawls.id, r.id),
              live ? inArray(crawls.status, ["queued", "running"]) : undefined,
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(frontier)
                  .where(and(eq(frontier.crawlId, crawls.id), gt(frontier.leasedUntil, sql`now()`))),
              ),
            ),
          );
        if ((done.rowCount ?? 0) === 0) {
          print(`${r.id} ${r.status} ${r.siteUrl} live, skipped`);
          liveSkipped += 1;
          continue;
        }
        if (live) cancelled += 1;
      }
      await assertAlone();
      // As the crawl's own tenant, read off its row: the service resolves
      // every crawl with its owner, and this script acts on every owner's.
      await service.deleteCrawl(parseTenant(r.tenantId), r.id, r.id);
    } catch (error) {
      throw new Error(`could not prune crawl ${r.id} (${r.siteUrl}): ${(error as Error).message}`);
    }
    deleted += 1;
  }
  print(`deleted ${String(deleted)} crawls (${String(cancelled)} cancelled first); ${String(liveSkipped)} live, skipped`);
  return { matched: matches.length, pages, liveSkipped, cancelled, deleted };
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--confirm");
  if (unknown.length > 0) throw new Error(`unknown argument '${unknown[0]}'; the only flag is --confirm`);
  const db = createPruneDb(url);
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
