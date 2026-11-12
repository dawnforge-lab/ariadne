-- Phase 28b Task 4a: fair claims.
--
-- 1. `crawls.host_key` gains the port (Ruling R8). `hostKeyOf` (src/crawl/host-key.ts) now
--    appends `:port` when the seed URL names a port that is not its scheme's default, so two
--    servers on two ports of one address are two hosts to claim eligibility. Every older row
--    carries the port-less key (0040's backfill, or the `hostKeyOf` of its day): this appends the
--    port where its `site_url` names one. The suffix is computed from `site_url` alone — the
--    port digits after the host (bracketed IPv6 included, userinfo skipped), as an integer (so
--    `0080` is 80), dropped when empty or the scheme's default (http/ws 80, https/wss 443, ftp
--    21), as `URL` drops it. The host part is NOT recomputed: the stored key came from
--    `hostKeyOf` (punycoded) or 0040, and stays. A key that already ends in its suffix (a row
--    written by R8 code) is left. test/worker/jobs.test.ts runs 0040's expression then this one
--    over edge cases and pins them to `hostKeyOf`.
--
-- 2. Two partial indexes for the claim's eligibility and the queue position: the running jobs
--    by kind and tenant (busy hosts, a tenant's running crawl count, crawl_render's HOST_BUSY),
--    and a tenant's queued jobs in claim order (R12: a position counts the caller's crawls only).
UPDATE "crawls" SET "host_key" = "crawls"."host_key" || "p"."port_suffix"
FROM (SELECT "id", CASE
    WHEN nullif(substring("site_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(?:\[[^]]*\]|[^:/?#]*):([0-9]*)(?:[/?#]|$)'), '') IS NULL THEN NULL
    WHEN nullif(substring("site_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(?:\[[^]]*\]|[^:/?#]*):([0-9]*)(?:[/?#]|$)'), '')::int
       = CASE lower(substring("site_url" from '^([A-Za-z][A-Za-z0-9+.-]*):'))
           WHEN 'http' THEN 80 WHEN 'ws' THEN 80 WHEN 'https' THEN 443 WHEN 'wss' THEN 443 WHEN 'ftp' THEN 21
         END THEN NULL
    ELSE ':' || (nullif(substring("site_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(?:\[[^]]*\]|[^:/?#]*):([0-9]*)(?:[/?#]|$)'), '')::int)::text
  END AS "port_suffix" FROM "crawls") AS "p"
WHERE "p"."id" = "crawls"."id"
  AND "p"."port_suffix" IS NOT NULL
  AND right("crawls"."host_key", length("p"."port_suffix")) <> "p"."port_suffix";--> statement-breakpoint
CREATE INDEX "jobs_running_kind_tenant" ON "jobs" USING btree ("kind","tenant_id") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_queued_tenant" ON "jobs" USING btree ("tenant_id","queued_at","id") WHERE "jobs"."status" = 'queued';
