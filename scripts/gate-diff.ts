/**
 * The Phase 29c gate, clause 3: a crawl diff checked against known answers.
 *
 * Two crawls of the gate site sit in the gate database: a PLAIN one and one
 * crawled with `GATE_PLANT=1` (test/gate/site-server.ts, R12), both judged by
 * `gate-rules.ts`. The planted site differs from the plain one in three index
 * sets, and this script asserts the diff reports exactly those and nothing else:
 *
 *   removed   exactly the planted removed URLs (added: none)
 *   title     changed: exactly the planted title URLs
 *   status, fetchClass, indexable
 *             changed: exactly the planted status URLs (the 410 pages)
 *   metaDescription, h1, canonical, metaRobots, wordCount, schemaTypes
 *             changed: none
 *   inlinks, clickDepth, linkScore
 *             recorded, not asserted: removing a page moves link counts, depth
 *             and score on pages that linked to it, in ways the plant does not
 *             pin down.
 *
 * Every asserted set is read by paging `listDiffUrls` to its end, and its length
 * must equal the count `crawlDiff` gave. The expected sets come from
 * `siteFixture.plantedSets(pages)`, the function the server plants with, so the
 * script and the server cannot disagree.
 *
 * Timed (each at most 5 s): `crawlDiff`, and the first `listDiffUrls` page for
 * `title`. RSS is sampled across the run and held to the 512 MB contract.
 *
 * Both crawls must have been served from ONE origin (a diff joins on the stored
 * URL, and refuses two sites): run both with the same `GATE_PORT`.
 *
 *   DATABASE_URL=…/ariadne_gate29c node --import tsx scripts/gate-diff.ts \
 *     --base <plainCrawlId> --head <plantedCrawlId> [--tenant <id>] [--json-out <path>]
 *
 * `GATE_PAGES` (default 50000) is the page count both crawls were made with.
 *
 * SAFETY. The database name must start with `ariadne_gate`. `--smoke` lifts
 * that guard so the script can be exercised on the dev database, and in return
 * never prints GATE PASSED.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import { closeDb, createDb } from "../src/db/client.js";
import { ApiService } from "../src/api/service.js";
import { PAGE_SIZE_MAX } from "../src/api/paging.js";
import { DIFF_FIELD_NAMES, type DiffFieldName } from "../src/api/crawl-diff.js";
import type { CredentialKeys } from "../src/crawl/credential-vault.js";
import { LOCAL_TENANT, parseTenant, type TenantId } from "../src/tenant.js";
import { siteFixture } from "../test/gate/site-server.js";

const GATE_PAGES = 50_000;
const GATE_DB_PREFIX = "ariadne_gate";
/** Each timed call must answer within this many ms. */
const GATE_DIFF_MS = 5_000;
/** The memory contract (build plan rule 6). */
const GATE_PEAK_RSS_BYTES = 512 * 1024 * 1024;
const SAMPLE_MS = 2_000;
const MB = 1024 * 1024;
/** Rows per `listDiffUrls` page while walking a set to its end: the largest the surface allows. */
const WALK_LIMIT = PAGE_SIZE_MAX;

/** Fields whose changed set must be exactly the planted status URLs. */
const STATUS_FIELDS: DiffFieldName[] = ["status", "fetchClass", "indexable"];
/** Fields that must not have changed on any URL. */
const UNCHANGED_FIELDS: DiffFieldName[] = [
  "metaDescription", "h1", "canonical", "metaRobots", "wordCount", "schemaTypes",
];
/** Fields recorded and not asserted. */
const RECORDED_FIELDS: DiffFieldName[] = ["inlinks", "clickDepth", "linkScore"];

interface Args {
  base: string;
  head: string;
  tenant: TenantId;
  jsonOut: string | null;
  smoke: boolean;
}

/** `--flag value` pairs and `--smoke`. Anything else, or a missing value, throws. */
function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let smoke = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--smoke") {
      smoke = true;
      continue;
    }
    if (arg === "--base" || arg === "--head" || arg === "--tenant" || arg === "--json-out") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new RangeError(`${arg} needs a value, got ${value === undefined ? "nothing" : JSON.stringify(value)}`);
      }
      values.set(arg, value);
      i += 1;
      continue;
    }
    throw new RangeError(`gate-diff: unknown argument ${JSON.stringify(arg)} (--base, --head, --tenant, --json-out, --smoke)`);
  }
  const base = values.get("--base");
  const head = values.get("--head");
  if (base === undefined || head === undefined) {
    throw new RangeError("gate-diff: --base <crawlId> and --head <crawlId> are both required");
  }
  const tenant = values.get("--tenant");
  return {
    base,
    head,
    tenant: tenant === undefined ? LOCAL_TENANT : parseTenant(tenant),
    jsonOut: values.get("--json-out") ?? null,
    smoke,
  };
}

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("DATABASE_URL must be set (no fallback)");
  return url;
}

function pageTarget(): number {
  const raw = process.env["GATE_PAGES"];
  if (raw === undefined || raw === "") return GATE_PAGES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 3) throw new RangeError(`GATE_PAGES must be an integer ≥ 3, got ${raw}`);
  return value;
}

function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

function line(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`;
}

/** The set difference as two short, printable lists. */
function setDifference(want: ReadonlySet<string>, got: ReadonlySet<string>): string {
  const missing = [...want].filter((u) => !got.has(u));
  const extra = [...got].filter((u) => !want.has(u));
  const show = (urls: string[]): string =>
    `${urls.length}${urls.length === 0 ? "" : ` (${urls.slice(0, 3).join(", ")}${urls.length > 3 ? ", …" : ""})`}`;
  return `missing ${show(missing)}, unexpected ${show(extra)}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const pages = pageTarget();
  const url = databaseUrl();
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!args.smoke && !dbName.startsWith(GATE_DB_PREFIX)) {
    throw new Error(
      `refusing to run against '${dbName}': the gate runs only on a database whose name starts with '${GATE_DB_PREFIX}' (--smoke lifts this for a dev-database exercise)`,
    );
  }
  const isGate = !args.smoke && pages === GATE_PAGES;

  const recorded: string[] = [];
  const fail = (message: string): void => {
    console.error(`FAIL: ${message}`);
    recorded.push(message);
  };

  console.log(
    isGate
      ? `29c GATE clause 3 — crawl diff against the planted site (${GATE_PAGES.toLocaleString()} pages)`
      : `SMOKE RUN — ${pages.toLocaleString()} pages${args.smoke ? ", --smoke" : ""}. NOT the gate.`,
  );
  console.log(line("database", dbName));
  console.log(line("base / head", `${args.base} / ${args.head}`));

  const db = createDb(url);
  // The service requires credential keys; a diff never decrypts one.
  const keyId = `gate-${randomBytes(3).toString("hex")}`;
  const keys: CredentialKeys = { current: { id: keyId, key: randomBytes(32) } };
  const service = new ApiService(db, {
    credentialKeys: keys,
    allowedDomains: [],
    log: (message) => console.error(`api: ${message}`),
  });

  let peak = process.memoryUsage.rss();
  const sample = (): void => {
    peak = Math.max(peak, process.memoryUsage.rss());
  };
  const timer = setInterval(sample, SAMPLE_MS);
  const measurements: Record<string, unknown> = {};

  try {
    // ---- the summary, timed
    let started = performance.now();
    const diff = await service.crawlDiff(args.tenant, args.base, args.head);
    const diffMs = Math.round(performance.now() - started);
    sample();
    console.log(line("crawlDiff", `${diffMs} ms (limit ${GATE_DIFF_MS})`));
    console.log(line("pages", `base ${diff.base.pages.toLocaleString()}, head ${diff.head.pages.toLocaleString()}`));
    console.log(
      line("urls", `common ${diff.urls.common.toLocaleString()}, added ${diff.urls.added}, removed ${diff.urls.removed}`),
    );
    if (diffMs > GATE_DIFF_MS) fail(`crawlDiff took ${diffMs} ms, over ${GATE_DIFF_MS}`);

    // ---- the first page of `title`, timed
    started = performance.now();
    const firstTitlePage = await service.listDiffUrls(args.tenant, args.base, args.head, "title", { state: "changed" });
    const firstPageMs = Math.round(performance.now() - started);
    sample();
    console.log(line("first title page", `${firstPageMs} ms (limit ${GATE_DIFF_MS}), ${firstTitlePage.items.length} urls`));
    if (firstPageMs > GATE_DIFF_MS) fail(`the first listDiffUrls page for title took ${firstPageMs} ms, over ${GATE_DIFF_MS}`);

    // ---- the planted sets, as full URLs of the crawled site
    const origin = diff.base.siteUrl;
    const planted = siteFixture.plantedSets(pages);
    const absolute = (paths: string[]): Set<string> => new Set(paths.map((p) => new URL(p, origin).href));
    const wantTitles = absolute(planted.titles);
    const wantStatuses = absolute(planted.statuses);
    const wantRemoved = absolute(planted.removed);
    console.log(
      line("planted", `${wantTitles.size} titles, ${wantStatuses.size} statuses, ${wantRemoved.size} removed (origin ${origin})`),
    );
    if (diff.base.pages !== pages) {
      fail(`the base crawl has ${diff.base.pages} pages, expected the plain site's ${pages} (GATE_PAGES)`);
    }

    /** Walk a listing to its end, so every URL is read, not just a count. */
    const walk = async (field: string, state?: "changed"): Promise<Set<string>> => {
      const urls = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = await service.listDiffUrls(args.tenant, args.base, args.head, field, {
          limit: WALK_LIMIT,
          ...(state === undefined ? {} : { state }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) {
          if (urls.has(item.url)) throw new Error(`gate-diff: ${field} listed ${item.url} twice`);
          urls.add(item.url);
        }
        sample();
        if (page.nextCursor === null) return urls;
        cursor = page.nextCursor;
      }
    };

    const fieldOf = (name: DiffFieldName): { changed: number; notComparable: number } => {
      const found = diff.fields.find((f) => f.field === name);
      if (found === undefined) throw new Error(`gate-diff: crawlDiff answered no '${name}' field`);
      return found;
    };
    const expectSet = async (label: string, field: string, want: ReadonlySet<string>, state?: "changed"): Promise<void> => {
      const got = await walk(field, state);
      const counted = field === "added" ? diff.urls.added : field === "removed" ? diff.urls.removed : fieldOf(field as DiffFieldName).changed;
      const same = got.size === want.size && [...want].every((u) => got.has(u));
      console.log(line(label, `${got.size} listed, ${counted} counted, ${want.size} planted — ${same ? "exact" : "DIFFERS"}`));
      if (!same) fail(`${label}: ${setDifference(want, got)}`);
      if (counted !== got.size) fail(`${label}: crawlDiff counted ${counted}, the listing held ${got.size}`);
      measurements[label] = { listed: got.size, counted, planted: want.size, exact: same };
    };

    await expectSet("removed", "removed", wantRemoved);
    await expectSet("added", "added", new Set());
    await expectSet("title", "title", wantTitles, "changed");
    for (const name of STATUS_FIELDS) await expectSet(name, name, wantStatuses, "changed");
    for (const name of UNCHANGED_FIELDS) await expectSet(name, name, new Set(), "changed");

    // ---- recorded, not asserted
    console.log("");
    console.log("— recorded, not asserted —");
    for (const name of RECORDED_FIELDS) {
      const f = fieldOf(name);
      console.log(line(name, `changed ${f.changed.toLocaleString()}, notComparable ${f.notComparable.toLocaleString()}`));
      measurements[name] = f;
    }
    // Every field accounted for: a new diff field must be classified here, not ignored.
    const classified = new Set<string>([...STATUS_FIELDS, ...UNCHANGED_FIELDS, ...RECORDED_FIELDS, "title"]);
    const unclassified = DIFF_FIELD_NAMES.filter((n) => !classified.has(n));
    if (unclassified.length > 0) fail(`diff fields this gate does not classify: ${unclassified.join(", ")}`);

    sample();
    console.log("");
    console.log(line("PEAK RSS", `${megabytes(peak)}, contract ${GATE_PEAK_RSS_BYTES / MB} MB`));
    if (peak > GATE_PEAK_RSS_BYTES) fail(`peak RSS ${megabytes(peak)} exceeds the ${GATE_PEAK_RSS_BYTES / MB} MB contract`);

    Object.assign(measurements, { diffMs, firstPageMs, peakRssBytes: peak });
    if (recorded.length > 0) return 1;
    console.log(isGate ? "GATE PASSED (29c clause 3)" : "run passed — NOT the gate (--smoke or GATE_PAGES below 50000)");
    return 0;
  } catch (error) {
    recorded.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    clearInterval(timer);
    if (args.jsonOut !== null) {
      writeFileSync(
        args.jsonOut,
        `${JSON.stringify(
          { node: process.version, database: dbName, pages, isGate, smoke: args.smoke, base: args.base, head: args.head, passed: recorded.length === 0, failures: recorded, measurements },
          null,
          2,
        )}\n`,
      );
      console.log(line("json out", args.jsonOut));
    }
    await service.close();
    await closeDb(db);
  }
}

process.exitCode = await main();
