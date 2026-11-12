/**
 * The Prometheus registry and metric set (Phase 28b Task 6).
 *
 * LABELS ARE CLOSED ENUMS. A label value is one of a small fixed set: a job
 * `kind`, a job `status`, an `outcome`, a `fetch_class`, an instance `role`.
 * Never a tenant id, a crawl id, a host or a URL: every one of those is
 * unbounded (a series per crawl would grow the scraper without limit) and the
 * tenant and host ones would leak who the operator's customers are to anyone
 * holding the metrics token. `test/ops/metrics.test.ts` scans a scrape against
 * a forbidden list.
 *
 * COUNTERS AND HISTOGRAMS ARE PROCESS-LOCAL: each process (API, each worker)
 * counts what it did, and the scraper sums. The two GAUGES `ariadne_jobs` and
 * `ariadne_instances_alive` are read from the database at scrape time
 * (`renderMetrics`), so any process answers for the whole fleet and a gauge is
 * never stale. `ariadne_crawl_peak_rss_bytes` is this process's high-water
 * resident set (`process.resourceUsage().maxRSS`), stamped when a crawl job
 * ends: the memory contract's (hard rule 6) running evidence.
 *
 * Hot path: an increment or an observation; no per-URL allocation and no label
 * built per URL (a fetch class is a closed enum).
 */
import { sql } from "drizzle-orm";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import type { Db } from "../db/client.js";
import { liveInstanceSql } from "../worker/jobs.js";
import { DEFAULT_TIMING } from "../worker/timing.js";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const FETCH_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const WAIT_BUCKETS = [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600];
const JOB_BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 14400, 86400];

export const jobsGauge = new Gauge({
  name: "ariadne_jobs",
  help: "Jobs by kind and status, read from the database at scrape time.",
  labelNames: ["kind", "status"] as const,
  registers: [registry],
});

export const jobClaimWait = new Histogram({
  name: "ariadne_job_claim_wait_seconds",
  help: "Seconds a job waited queued before a runner of this process claimed it.",
  buckets: WAIT_BUCKETS,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "ariadne_job_duration_seconds",
  help: "Seconds a job ran in this process, by kind and how it ended.",
  labelNames: ["kind", "outcome"] as const,
  buckets: JOB_BUCKETS,
  registers: [registry],
});

export const pagesFetched = new Counter({
  name: "ariadne_pages_fetched_total",
  help: "Pages settled by the crawl loop in this process, by fetch class.",
  labelNames: ["fetch_class"] as const,
  registers: [registry],
});

export const fetchDuration = new Histogram({
  name: "ariadne_fetch_duration_seconds",
  help: "Seconds a page fetch took in this process, from policy check to classified result.",
  buckets: FETCH_BUCKETS,
  registers: [registry],
});

export const hostEscalations = new Counter({
  name: "ariadne_host_escalations_total",
  help: "Times a host's answers escalated the crawl's spacing (a block or a rate limit), in this process.",
  registers: [registry],
});

export const instancesAlive = new Gauge({
  name: "ariadne_instances_alive",
  help: "Live instances (heartbeating, not stopped) by role, read from the database at scrape time.",
  labelNames: ["role"] as const,
  registers: [registry],
});

export const crawlPeakRss = new Gauge({
  name: "ariadne_crawl_peak_rss_bytes",
  help: "This process's peak resident set size, stamped when a crawl job ends.",
  registers: [registry],
});

/** Stamp the peak RSS (`maxRSS` is in KiB). */
export function recordPeakRss(): void {
  crawlPeakRss.set(process.resourceUsage().maxRSS * 1024);
}

/**
 * The exposition text: the database-backed gauges are refreshed first. A
 * database failure rejects, so a scrape fails loudly (the caller answers 500)
 * rather than serving gauges that are quietly stale.
 */
export async function renderMetrics(db: Pick<Db, "execute">): Promise<string> {
  const jobRows = await db.execute<{ kind: string; status: string; n: number }>(
    sql`select kind, status, count(*)::int as n from jobs group by kind, status`,
  );
  const instanceRows = await db.execute<{ role: string; n: number }>(
    sql`select i.role, count(*)::int as n from instances i
         where ${liveInstanceSql(sql`i.id`, DEFAULT_TIMING.deadAfter)} group by i.role`,
  );
  jobsGauge.reset();
  for (const row of jobRows.rows) jobsGauge.set({ kind: row.kind, status: row.status }, row.n);
  instancesAlive.reset();
  for (const row of instanceRows.rows) instancesAlive.set({ role: row.role }, row.n);
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
