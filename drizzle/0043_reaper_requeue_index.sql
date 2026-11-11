-- Phase 28b Task 4b: the reaper's requeue scan. A crawl paused by the system (`shutdown`,
-- `worker_lost`) and still under the auto-resume cap (3) is requeued by the reaper every tick
-- (src/worker/reaper.ts); this partial index holds exactly those, in the scan's order, so the
-- tick reads a handful of rows rather than every crawl ever run. The reaper writes the
-- predicate as literals so the planner can use it.
CREATE INDEX "crawls_system_paused" ON "crawls" USING btree ("finished_at","id") WHERE "crawls"."status" = 'paused' and "crawls"."pause_reason" in ('shutdown', 'worker_lost') and "crawls"."auto_resume_count" < 3;