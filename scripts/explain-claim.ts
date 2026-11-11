/**
 * EXPLAIN (ANALYZE, BUFFERS) of the unpinned crawl claim (`claimNextJob`,
 * src/worker/jobs.ts) with 10,000 ineligible queued jobs at the head of the
 * queue: once with a busy host, once with a capped tenant. The Phase 28b gate's
 * open item (4a review), run on the database the gate used.
 *
 *   DATABASE_URL=postgresql://…/ariadne_gate28b node --import tsx scripts/explain-claim.ts
 *
 * Everything happens in one transaction that is rolled back, so nothing is
 * committed; it refuses any database but `ariadne_gate28b`. The statement below
 * is a copy of the claim's (the same CTEs and the same `liveHolderSql`), taken
 * under the same global advisory lock the runner takes: keep the two in step if
 * the claim changes.
 */
import { sql } from "drizzle-orm";

import { closeDb, createDb } from "../src/db/client.js";
import { HOST_CLAIM_LOCK, liveHolderSql } from "../src/worker/jobs.js";
import { RULESET_VERSION } from "../src/rules/registry/registry.js";
import { EXTRACTION_VERSION } from "../src/crawl/versions.js";

const url = process.env["DATABASE_URL"] ?? "";
if (url === "" || new URL(url).pathname !== "/ariadne_gate28b") {
  throw new Error("run against ariadne_gate28b only (DATABASE_URL must name it)");
}
const db = createDb(url);
const N = 10_000;
const DEAD_AFTER = 60_000;

class Rollback extends Error {}

async function scenario(label: "busy host" | "capped tenant"): Promise<void> {
  const capped = label === "capped tenant";
  // `busy host`: the N queued jobs are on the host a running job holds, each of its own tenant.
  // `capped tenant`: the N queued jobs are one tenant's, which already has its one running crawl, each on its own host.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into instances (id, role, hostname, pid, version) values ('explain-live', 'worker', 'x', 1, 'x')`);
      await tx.execute(sql`
        insert into crawls (tenant_id, id, site_url, host_key, config_jsonb, ruleset_version, status)
        select case when ${capped} then 't-capped' else 't-queued-' || g end,
               'explain_c_' || g,
               'https://h' || g || '.example/',
               case when ${capped} then 'h' || g || '.example' else 'busy.example' end,
               '{}'::jsonb, ${RULESET_VERSION}, 'queued'
          from generate_series(1, ${N}) g`);
      await tx.execute(sql`
        insert into jobs (id, tenant_id, crawl_id, kind, status, queued_at, ruleset_version, extraction_version)
        select 'explain_j_' || g, c.tenant_id, c.id, 'crawl', 'queued',
               now() - interval '1 day' + g * interval '1 millisecond', ${RULESET_VERSION}, ${EXTRACTION_VERSION}
          from generate_series(1, ${N}) g join crawls c on c.id = 'explain_c_' || g`);
      // The one running job that makes them ineligible.
      await tx.execute(sql`
        insert into crawls (tenant_id, id, site_url, host_key, config_jsonb, ruleset_version, status)
        values (${capped ? "t-capped" : "t-runner"}, 'explain_running', 'https://busy.example/', 'busy.example', '{}'::jsonb, ${RULESET_VERSION}, 'running')`);
      await tx.execute(sql`
        insert into jobs (id, tenant_id, crawl_id, kind, status, claimed_by, claimed_at, heartbeat_at, ruleset_version, extraction_version)
        values ('explain_running_job', ${capped ? "t-capped" : "t-runner"}, 'explain_running', 'crawl', 'running', 'explain-live', now(), now(), ${RULESET_VERSION}, ${EXTRACTION_VERSION})`);
      // The one eligible job, last in claim order.
      await tx.execute(sql`
        insert into crawls (tenant_id, id, site_url, host_key, config_jsonb, ruleset_version, status)
        values ('t-eligible', 'explain_eligible', 'https://free-eligible.example/', 'free-eligible.example', '{}'::jsonb, ${RULESET_VERSION}, 'queued')`);
      await tx.execute(sql`
        insert into jobs (id, tenant_id, crawl_id, kind, status, ruleset_version, extraction_version)
        values ('explain_eligible_job', 't-eligible', 'explain_eligible', 'crawl', 'queued', ${RULESET_VERSION}, ${EXTRACTION_VERSION})`);
      await tx.execute(sql`analyze jobs`);
      await tx.execute(sql`analyze crawls`);

      const cap = 1;
      const statement = sql`
        explain (analyze, buffers)
        with busy_hosts as materialized (
          select distinct c.host_key
            from jobs r join crawls c on c.id = r.crawl_id
           where r.status = 'running' and r.kind in ('crawl', 'render')
             and ${liveHolderSql(DEAD_AFTER, "r")})
          , tenant_running as materialized (
          select r.tenant_id, count(*)::int as n
            from jobs r
           where r.status = 'running' and r.kind = 'crawl' and r.pinned_to is null
             and ${liveHolderSql(DEAD_AFTER, "r")}
           group by r.tenant_id)
        update jobs
           set status = 'running', claimed_by = 'explain-live',
               claimed_at = now(), heartbeat_at = now()
         where id = (
           select q.id from jobs q join crawls qc on qc.id = q.crawl_id
            where q.status = 'queued'
              and q.kind in ('crawl')
              and q.pinned_to is null
              and q.ruleset_version = ${RULESET_VERSION}
              and q.extraction_version = ${EXTRACTION_VERSION}
              and (q.kind not in ('crawl', 'render')
                   or not exists (select 1 from busy_hosts b where b.host_key = qc.host_key))
              and (q.kind <> 'crawl' or not exists (
                    select 1 from tenant_running t
                     where t.tenant_id = q.tenant_id and t.n >= ${cap}::int))
            order by q.queued_at, q.id
            for update of q skip locked
            limit 1)
           and status = 'queued'
        returning id`;
      await tx.execute(sql`select pg_advisory_xact_lock(${HOST_CLAIM_LOCK}::bigint)`);
      const plan = await tx.execute(statement);
      console.log(`### scenario: ${label} (${N} ineligible queued jobs ahead of one eligible)`);
      for (const row of plan.rows as { "QUERY PLAN": string }[]) console.log(row["QUERY PLAN"]);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

await scenario("busy host");
await scenario("capped tenant");
const leftovers = await db.execute(sql`select count(*)::int as n from crawls where id like 'explain_%'`);
console.log(`rows left behind: ${(leftovers.rows[0] as { n: number }).n}`);
await closeDb(db);
