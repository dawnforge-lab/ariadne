-- Phase 28b Task 4b fix round 1 (Ruling R17): a `shutdown` pause is requeued by the reaper
-- without spending the auto-resume cap (a graceful stop is a deploy, not a crash); only
-- `worker_lost` counts, and only it is capped at 3. 0043's index held only crawls under the
-- cap of either reason, so it is replaced by one on the reaper's new predicate
-- (src/worker/reaper.ts, SYSTEM_PAUSED_SQL), written there as literals so the planner can use it.
DROP INDEX "crawls_system_paused";--> statement-breakpoint
CREATE INDEX "crawls_requeuable" ON "crawls" USING btree ("finished_at","id") WHERE "crawls"."status" = 'paused' and ("crawls"."pause_reason" = 'shutdown' or ("crawls"."pause_reason" = 'worker_lost' and "crawls"."auto_resume_count" < 3));