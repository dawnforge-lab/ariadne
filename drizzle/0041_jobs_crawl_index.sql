-- Phase 28b (Task 3 fix round 1). `instances.stopped_at`: a graceful shutdown marks its
-- instance stopped, so its pinned queued work is not "held" from that moment (liveness = not
-- stopped and a heartbeat within deadAfter). `jobs_crawl_queued`: a crawl's jobs by time, for
-- crawl_status.job (the latest), the live-job guards and crawl_delete's cascade, which otherwise
-- scan every crawl's settled job history.
ALTER TABLE "instances" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_crawl_queued" ON "jobs" USING btree ("crawl_id","queued_at");
