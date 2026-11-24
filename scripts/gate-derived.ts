/**
 * Phase 29d gate tooling: export and compare the derived link columns.
 *
 * The 29d gate runs the rules twice on ONE gate crawl: once from a detached
 * worktree at the pre-phase commit `12e832e`, once at the branch head. After
 * each run this script exports the derived columns; a compare then proves the
 * phase left them unchanged. So the export reads only `pages` columns that
 * exist at both commits.
 *
 *   --export --crawl <id> --out <file> [--smoke]
 *       One JSON object per line, `{url, clickDepth, inlinksInternal,
 *       outlinksInternal, outlinksExternal, linkScoreRaw, linkScore}`, sorted by
 *       URL in byte order (`collate "C"`). Rows are read through a server-side
 *       cursor and written as they arrive, so memory is O(batch), not O(URLs).
 *
 *   --compare <a> <b>
 *       A streaming merge of two exports, line by line. Prints the first 20
 *       differences and exits 1 on any. Integers compare exactly; `linkScoreRaw`
 *       within 1e-9 relative. Null equals null; null versus a number (0
 *       included) differs.
 *
 *   DATABASE_URL=…/ariadne_gate29d npx tsx scripts/gate-derived.ts --export \
 *     --crawl <id> --out before.jsonl
 *
 * SAFETY. An export's database name must start with `ariadne_gate`; `--smoke`
 * lifts that so the script can be exercised on the dev database.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import pg from "pg";

const GATE_DB_PREFIX = "ariadne_gate";
/** Differences listed before the compare stops listing (it still counts them all). */
export const MAX_LISTED_DIFFERENCES = 20;
/** `linkScoreRaw` agrees when |a - b| <= this fraction of the larger magnitude. */
export const RAW_SCORE_RELATIVE_TOLERANCE = 1e-9;
/** Rows fetched from the server-side cursor per round trip. */
const FETCH_ROWS = 2_000;

export interface DerivedRow {
  url: string;
  clickDepth: number | null;
  inlinksInternal: number | null;
  outlinksInternal: number | null;
  outlinksExternal: number | null;
  linkScoreRaw: number | null;
  linkScore: number | null;
}

const INTEGER_FIELDS = ["clickDepth", "inlinksInternal", "outlinksInternal", "outlinksExternal", "linkScore"] as const;
const FIELD_NAMES: readonly string[] = ["url", ...INTEGER_FIELDS, "linkScoreRaw"];

/** Parse one export line, failing loudly on anything that is not a complete row. */
function parseRow(line: string, file: string, lineNo: number): DerivedRow {
  const where = `${file}:${lineNo}`;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`gate-derived: ${where} is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== "object" || value === null) throw new Error(`gate-derived: ${where} is not an object`);
  const record = value as Record<string, unknown>;
  for (const name of FIELD_NAMES) {
    if (!(name in record)) throw new Error(`gate-derived: ${where} has no '${name}' field`);
  }
  if (typeof record["url"] !== "string") throw new Error(`gate-derived: ${where} 'url' is not a string`);
  for (const name of [...INTEGER_FIELDS, "linkScoreRaw"]) {
    const v = record[name];
    if (v !== null && typeof v !== "number") throw new Error(`gate-derived: ${where} '${name}' is neither a number nor null`);
  }
  return record as unknown as DerivedRow;
}

/** Async iterator of rows, enforcing strictly ascending byte order of URLs. */
async function* readRows(file: string): AsyncGenerator<DerivedRow> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  let previous: string | null = null;
  for await (const line of lines) {
    lineNo += 1;
    if (line === "") throw new Error(`gate-derived: ${file}:${lineNo} is an empty line`);
    const row = parseRow(line, file, lineNo);
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(row.url)) >= 0) {
      throw new Error(`gate-derived: ${file}:${lineNo} is not sorted by URL (${JSON.stringify(row.url)} after ${JSON.stringify(previous)}); an export is sorted and unique`);
    }
    previous = row.url;
    yield row;
  }
}

function rawScoresAgree(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true; // covers 0 vs 0
  return Math.abs(a - b) <= RAW_SCORE_RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

function rowDifferences(a: DerivedRow, b: DerivedRow): string[] {
  const out: string[] = [];
  for (const name of INTEGER_FIELDS) {
    if (a[name] !== b[name]) out.push(`${a.url}: ${name} ${String(a[name])} vs ${String(b[name])}`);
  }
  if (!rawScoresAgree(a.linkScoreRaw, b.linkScoreRaw)) {
    out.push(`${a.url}: linkScoreRaw ${String(a.linkScoreRaw)} vs ${String(b.linkScoreRaw)}`);
  }
  return out;
}

export interface CompareResult {
  /** Every difference found, not only the listed ones. */
  total: number;
  /** The first MAX_LISTED_DIFFERENCES of them. */
  differences: string[];
  rows: { a: number; b: number };
}

/**
 * Merge-compare two exports. Memory is one row per file: both are sorted by
 * URL, so a URL missing from one side is found by advancing the other.
 */
export async function compareDerivedFiles(fileA: string, fileB: string): Promise<CompareResult> {
  const result: CompareResult = { total: 0, differences: [], rows: { a: 0, b: 0 } };
  const note = (message: string): void => {
    result.total += 1;
    if (result.differences.length < MAX_LISTED_DIFFERENCES) result.differences.push(message);
  };
  const itA = readRows(fileA);
  const itB = readRows(fileB);
  const next = async (it: AsyncGenerator<DerivedRow>, side: "a" | "b"): Promise<DerivedRow | null> => {
    const step = await it.next();
    if (step.done === true) return null;
    result.rows[side] += 1;
    return step.value;
  };
  try {
    let a = await next(itA, "a");
    let b = await next(itB, "b");
    while (a !== null || b !== null) {
      const order = a === null ? 1 : b === null ? -1 : Buffer.compare(Buffer.from(a.url), Buffer.from(b.url));
      if (order === 0) {
        for (const d of rowDifferences(a as DerivedRow, b as DerivedRow)) note(d);
        a = await next(itA, "a");
        b = await next(itB, "b");
      } else if (order < 0) {
        note(`${(a as DerivedRow).url}: only in ${fileA}`);
        a = await next(itA, "a");
      } else {
        note(`${(b as DerivedRow).url}: only in ${fileB}`);
        b = await next(itB, "b");
      }
    }
  } finally {
    await itA.return(undefined);
    await itB.return(undefined);
  }
  return result;
}

interface ExportArgs { mode: "export"; crawl: string; out: string; smoke: boolean }
interface CompareArgs { mode: "compare"; a: string; b: string }

function parseArgs(argv: readonly string[]): ExportArgs | CompareArgs {
  const usage = "gate-derived: --export --crawl <id> --out <file> [--smoke]  |  --compare <a> <b>";
  if (argv[0] === "--compare") {
    const [, a, b, ...rest] = argv;
    if (a === undefined || b === undefined || rest.length > 0 || a.startsWith("--") || b.startsWith("--")) {
      throw new RangeError(usage);
    }
    return { mode: "compare", a, b };
  }
  if (argv[0] !== "--export") throw new RangeError(usage);
  const values = new Map<string, string>();
  let smoke = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--smoke") {
      smoke = true;
    } else if (arg === "--crawl" || arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new RangeError(`${arg} needs a value, got ${value === undefined ? "nothing" : JSON.stringify(value)}`);
      }
      values.set(arg, value);
      i += 1;
    } else {
      throw new RangeError(`gate-derived: unknown argument ${JSON.stringify(arg)}. ${usage}`);
    }
  }
  const crawl = values.get("--crawl");
  const out = values.get("--out");
  if (crawl === undefined || out === undefined) throw new RangeError(`--crawl and --out are both required. ${usage}`);
  return { mode: "export", crawl, out, smoke };
}

/** Stream the crawl's derived columns to `out`, sorted by URL, through a server-side cursor. */
async function exportDerived(args: ExportArgs): Promise<number> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!args.smoke && !dbName.startsWith(GATE_DB_PREFIX)) {
    throw new Error(
      `refusing to run against '${dbName}': the gate runs only on a database whose name starts with '${GATE_DB_PREFIX}' (--smoke lifts this for a dev-database exercise)`,
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const out = createWriteStream(args.out, { encoding: "utf8" });
  let rows = 0;
  try {
    const found = await client.query("select 1 from crawls where id = $1", [args.crawl]);
    if (found.rowCount === 0) throw new Error(`gate-derived: crawl '${args.crawl}' not found in '${dbName}'`);
    await client.query("begin read only");
    await client.query(
      `declare derived_export no scroll cursor for
         select url, click_depth, inlinks_internal, outlinks_internal, outlinks_external, link_score_raw, link_score
         from pages where crawl_id = $1 order by url collate "C"`,
      [args.crawl],
    );
    for (;;) {
      const batch = await client.query(`fetch ${FETCH_ROWS} from derived_export`);
      if (batch.rows.length === 0) break;
      let chunk = "";
      for (const r of batch.rows as Record<string, unknown>[]) {
        const row: DerivedRow = {
          url: r["url"] as string,
          clickDepth: r["click_depth"] as number | null,
          inlinksInternal: r["inlinks_internal"] as number | null,
          outlinksInternal: r["outlinks_internal"] as number | null,
          outlinksExternal: r["outlinks_external"] as number | null,
          linkScoreRaw: r["link_score_raw"] as number | null,
          linkScore: r["link_score"] as number | null,
        };
        chunk += `${JSON.stringify(row)}\n`;
      }
      rows += batch.rows.length;
      // Honour back-pressure so the file, not RAM, absorbs the stream.
      if (!out.write(chunk)) await once(out, "drain");
    }
    await client.query("commit");
    if (rows === 0) throw new Error(`gate-derived: crawl '${args.crawl}' has no pages to export`);
  } finally {
    out.end();
    await once(out, "finish");
    await client.end();
  }
  console.log(`exported ${rows.toLocaleString()} pages of crawl ${args.crawl} (${dbName}) to ${args.out}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "export") return exportDerived(args);
  const result = await compareDerivedFiles(args.a, args.b);
  console.log(`compared ${result.rows.a.toLocaleString()} rows (a) with ${result.rows.b.toLocaleString()} rows (b)`);
  if (result.total === 0) {
    console.log("derived values identical (integers exact, linkScoreRaw within 1e-9 relative)");
    return 0;
  }
  console.error(`${result.total.toLocaleString()} difference(s); first ${result.differences.length}:`);
  for (const d of result.differences) console.error(`  ${d}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
