/**
 * The Phase 26c 50 MB probe: one 49 MB sitemap, streamed from a local server
 * through `discover`, with the crawl's own sink writing to Postgres.
 *
 * Until Phase 26c discovery buffered a sitemap whole and dropped anything over
 * 10 MB, so a legal 10–50 MB sitemap lost every URL it listed. The stream
 * (src/crawl/sitemap-stream.ts) reads up to the protocol's 50 MB and holds
 * O(chunk + one entry). Task 7's unit test proves the parser alone on a
 * generated stream; this probe proves the whole walk on a real socket — the
 * HTTP client, the hop deadline, the policy check per `<loc>`, the membership
 * and alternate staging, and `SitemapRowSink`'s batched inserts — and states
 * the two numbers the gate (docs/gates/phase-26c.md, clause 4) is about:
 *
 *  - **every URL read**: `discover` returns all `URL_COUNT` entries, the
 *    database holds `URL_COUNT` memberships and every alternate, and nothing is
 *    reported oversized, failed or capped;
 *  - **peak RSS delta ≤ 64 MB** over the RSS just before the walk, sampled
 *    every 250 ms.
 *
 * Run it:
 *
 *   DATABASE_URL=… node --import tsx scripts/probe-sitemap-50mb.ts [--gzip]
 *
 * `--gzip` serves the same document as a `.xml.gz` file (gzip bytes, no
 * content-encoding), which the stream recognises by its magic bytes; the 50 MB
 * cap counts the decompressed bytes either way.
 *
 * THE DOCUMENT. 50,000 `<url>`s — the protocol's own per-sitemap maximum, so the
 * document is one a site may legally publish — each with a `<lastmod>` and 10
 * `xhtml:link` alternates, padded with indentation to 49 MB uncompressed (with
 * the URL count capped by the protocol, heavy alternates and pretty-printing
 * are how a real sitemap reaches this size). It is GENERATED
 * LAZILY, 64 KB at a time, into a stream with backpressure: the server runs in
 * this process, and a 49 MB string would be the probe's memory, not the
 * walk's. What the server holds is O(one chunk), and that is inside the delta.
 *
 * THE SINK is the real one, `SitemapRowSink` (exported from src/crawl/loop.ts
 * for this), against `DATABASE_URL`: a probe crawl row is created, the walk
 * writes its memberships and alternates under it, the counts are read back, and
 * the row is deleted at the end (the staging tables cascade). Point it at the
 * development database, never at a gate database.
 *
 * The probe is local-only — the server binds 127.0.0.1 and `allowPrivate` is
 * the sanctioned loopback use of `scripts/gate-*.ts` — and it is not part of
 * `npm test`: it is a gate script, a minute of wall time and half a million rows.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { crawls } from "../src/db/schema.js";
import { discover } from "../src/crawl/discovery.js";
import { closeFetchAgents } from "../src/crawl/http.js";
import { CRAWL_DEFAULTS, SitemapRowSink } from "../src/crawl/loop.js";
import { SITEMAP_MAX_BYTES } from "../src/crawl/sitemap-stream.js";
import { RULESET_VERSION } from "../src/rules/registry/registry.js";
import { LOCAL_TENANT } from "../src/api/tenant.js";

const MB = 1024 * 1024;

/** The probe's two numbers, from the Phase 26c plan (Task 12, clause 4). */
const PROBE_RSS_DELTA_BYTES = 64 * MB;
const TARGET_BYTES = 49 * MB;

/** The protocol's per-sitemap URL maximum: the document is a legal one. */
const URL_COUNT = 50_000;

/** Alternates per `<url>`. */
const ALTERNATES = ["de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pt-PT", "pl-PL", "sv-SE", "da-DK", "x-default"];

/** How often RSS is sampled. */
const SAMPLE_MS = 250;

/** How much of the document is generated per chunk. */
const CHUNK_BYTES = 64 * 1024;

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
  'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
const TAIL = "</urlset>\n";

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL must be set (no fallback)");
  }
  return url;
}

/** `--gzip` or nothing; any other argument is refused rather than ignored. */
function gzipFlag(): boolean {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg !== "--gzip") throw new RangeError(`unknown argument ${JSON.stringify(arg)} (only --gzip)`);
  }
  return args.includes("--gzip");
}

/** One `<url>` without its padding: fixed width, so every entry is one length. */
function bareEntry(base: string, i: number): string {
  const id = String(i).padStart(6, "0");
  const links = ALTERNATES.map((code) => {
    const href = code === "x-default" ? `${base}/p/${id}` : `${base}/${code.toLowerCase()}/p/${id}`;
    return `\n<xhtml:link rel="alternate" hreflang="${code}" href="${href}"/>`;
  }).join("");
  return `<url>\n<loc>${base}/p/${id}</loc>\n<lastmod>2026-11-07</lastmod>${links}`;
}

/**
 * The padding that brings every entry to the length that puts the document
 * within one entry of `TARGET_BYTES`: indentation whitespace before `</url>`,
 * which the parser reads and ignores, as it does a pretty-printed sitemap's.
 */
function padFor(base: string): string {
  const close = "\n</url>\n";
  const per = Math.floor((TARGET_BYTES - HEAD.length - TAIL.length) / URL_COUNT);
  const room = per - bareEntry(base, 0).length - close.length;
  if (room < 0) throw new Error(`probe: an entry is ${-room} bytes over its share of ${TARGET_BYTES}`);
  return " ".repeat(room) + close;
}

/** The document, 64 KB at a time. `served.bytes` counts what it generated. */
async function* documentChunks(
  base: string,
  served: { bytes: number },
): AsyncGenerator<Buffer> {
  const pad = padFor(base);
  let text = HEAD;
  for (let i = 0; i < URL_COUNT; i++) {
    text += bareEntry(base, i) + pad;
    if (text.length >= CHUNK_BYTES) {
      served.bytes += text.length;
      yield Buffer.from(text, "latin1");
      text = "";
    }
  }
  text += TAIL;
  served.bytes += text.length;
  yield Buffer.from(text, "latin1");
}

async function startProbeServer(gzip: boolean): Promise<{
  server: Server;
  base: string;
  sitemapUrl: string;
  served: { bytes: number; wire: number };
  serveErrors: unknown[];
}> {
  const served = { bytes: 0, wire: 0 };
  const serveErrors: unknown[] = [];
  let base = "";
  const sitemapPath = gzip ? "/probe.xml.gz" : "/probe.xml";
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${base}${sitemapPath}\n`);
      return;
    }
    if (path !== sitemapPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": gzip ? "application/gzip" : "application/xml; charset=utf-8" });
    const source = Readable.from(documentChunks(base, served));
    const counted = async function* (input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of input) {
        served.wire += chunk.byteLength;
        yield chunk;
      }
    };
    // A failure while serving is the probe's own: kept, and `main` fails on it
    // (the walk sees a cut-off document and records it as a failure too).
    const done = gzip
      ? pipeline(source, createGzip(), counted, res)
      : pipeline(source, counted, res);
    done.catch((error: unknown) => {
      serveErrors.push(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, sitemapUrl: `${base}${sitemapPath}`, served, serveErrors };
}

async function countRows(db: Db, table: string, crawlId: string): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where crawl_id = ${crawlId}`,
  );
  const n = res.rows[0]?.["n"];
  if (typeof n !== "number") throw new Error(`countRows(${table}): got ${typeof n}, not a number`);
  return n;
}

async function main(): Promise<number> {
  const gzip = gzipFlag();
  const db = createDb(databaseUrl());
  const probe = await startProbeServer(gzip);
  // Sized against the real origin's length before anything is written: a
  // document that cannot be generated fails here, not mid-stream.
  padFor(probe.base);
  const crawlId = `probe_${randomUUID()}`;
  console.log(
    `PHASE 26c 50 MB PROBE — ${URL_COUNT.toLocaleString()} URLs in one ~${TARGET_BYTES / MB} MB ` +
      `urlset${gzip ? ", served gzipped (.xml.gz)" : ""}; RSS delta must stay ≤ ${PROBE_RSS_DELTA_BYTES / MB} MB`,
  );
  console.log(`sink                SitemapRowSink → ${crawlId} (deleted at the end)`);

  try {
    await db.insert(crawls).values({
      tenantId: LOCAL_TENANT,
      id: crawlId,
      siteUrl: `${probe.base}/`,
      config: { probe: "scripts/probe-sitemap-50mb.ts", gzip },
      rulesetVersion: RULESET_VERSION,
      status: "running",
    });

    const startRss = process.memoryUsage.rss();
    let peakRss = startRss;
    let peakAtMs = 0;
    const startedAt = Date.now();
    const sample = (): void => {
      const rss = process.memoryUsage.rss();
      if (rss > peakRss) {
        peakRss = rss;
        peakAtMs = Date.now() - startedAt;
      }
    };
    const timer = setInterval(sample, SAMPLE_MS);
    timer.unref();

    let discovery: Awaited<ReturnType<typeof discover>>;
    try {
      discovery = await discover(`${probe.base}/`, {
        userAgent: CRAWL_DEFAULTS.userAgent,
        allowPrivate: true,
        perHostDelayMs: 0,
        sink: new SitemapRowSink(db, crawlId),
      });
    } finally {
      sample();
      clearInterval(timer);
    }
    const wallMs = Date.now() - startedAt;

    const memberships = await countRows(db, "sitemap_memberships", crawlId);
    const alternates = await countRows(db, "sitemap_hreflang", crawlId);
    const delta = peakRss - startRss;
    const expectedAlternates = URL_COUNT * ALTERNATES.length;
    const t = discovery.truncation;
    const facts = discovery.sitemapFacts;

    const line = (label: string, value: string): string => `${label.padEnd(20)}${value}`;
    console.log(line("bytes generated", `${probe.served.bytes.toLocaleString()} (${(probe.served.bytes / MB).toFixed(2)} MB uncompressed; cap ${SITEMAP_MAX_BYTES / MB} MB)`));
    console.log(line("bytes on the wire", `${probe.served.wire.toLocaleString()} (${(probe.served.wire / MB).toFixed(2)} MB)`));
    console.log(line("URLs read", `${discovery.sitemapEntries.length.toLocaleString()} of ${URL_COUNT.toLocaleString()}`));
    console.log(line("memberships stored", memberships.toLocaleString()));
    console.log(line("alternates stored", `${alternates.toLocaleString()} of ${expectedAlternates.toLocaleString()}`));
    console.log(line("documents", `fetched ${t.docsFetched}, oversized ${t.oversizedDocsSkipped}, failures ${t.failures.length}, malformed ${t.malformedEntriesSkipped}`));
    console.log(line("caps", `entry ${t.entryLimited}, membership ${facts.membershipLimited}, hreflang ${facts.hreflangLimited}`));
    console.log(line("start RSS", `${(startRss / MB).toFixed(1)} MB`));
    console.log(line("peak RSS", `${(peakRss / MB).toFixed(1)} MB (at +${(peakAtMs / 1000).toFixed(1)}s)`));
    console.log(line("peak RSS delta", `${(delta / MB).toFixed(1)} MB (limit ${PROBE_RSS_DELTA_BYTES / MB} MB)`));
    console.log(line("wall time", `${(wallMs / 1000).toFixed(1)} s`));

    const failures: string[] = [];
    for (const error of probe.serveErrors) {
      failures.push(`the probe server could not serve the sitemap: ${String(error)}`);
    }
    if (discovery.sitemapEntries.length !== URL_COUNT) {
      failures.push(`read ${discovery.sitemapEntries.length} URLs, expected all ${URL_COUNT}`);
    }
    if (memberships !== URL_COUNT) failures.push(`${memberships} memberships stored, expected ${URL_COUNT}`);
    if (alternates !== expectedAlternates) {
      failures.push(`${alternates} alternates stored, expected ${expectedAlternates}`);
    }
    if (t.oversizedDocsSkipped !== 0 || t.failures.length !== 0 || t.malformedEntriesSkipped !== 0) {
      failures.push(`the document was not read clean: ${JSON.stringify(t)}`);
    }
    if (t.entryLimited || facts.membershipLimited || facts.hreflangLimited) {
      failures.push("a cap stopped collection, so not every URL was kept");
    }
    if (probe.served.bytes > SITEMAP_MAX_BYTES) {
      failures.push(`the generated document is ${probe.served.bytes} bytes, over the ${SITEMAP_MAX_BYTES}-byte cap`);
    }
    if (delta > PROBE_RSS_DELTA_BYTES) {
      failures.push(`peak RSS delta ${(delta / MB).toFixed(1)} MB exceeds ${PROBE_RSS_DELTA_BYTES / MB} MB`);
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      return 1;
    }
    console.log("PROBE PASSED");
    return 0;
  } finally {
    await db.delete(crawls).where(eq(crawls.id, crawlId));
    await closeFetchAgents();
    await closeDb(db);
    await new Promise<void>((resolve, reject) => {
      probe.server.closeAllConnections();
      probe.server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
    });
  }
}

process.exitCode = await main();
