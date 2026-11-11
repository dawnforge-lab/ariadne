-- Phase 28b: the engine's work queue and its processes. `jobs` replaces the API service's
-- in-process queue and busy sets (one queued|running job per crawl, a partial unique index);
-- `instances` holds one row per engine process. `crawls.host_key` is the crawl's host
-- footprint for claim eligibility, and `crawls.auto_resume_count` caps the reaper's re-queues.
--
-- host_key is added nullable, backfilled from site_url in SQL (the host, lower-cased, without
-- a leading `www.`, as `hostKeyOf` in src/crawl/host-key.ts computes it), then made NOT NULL.
-- A row whose site_url has no host leaves the backfill null and the NOT NULL fails the
-- migration, loudly: no guessed footprint. No column default: every writer names it.
CREATE TABLE "instances" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"crawl_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"pinned_to" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"ruleset_version" text NOT NULL,
	"extraction_version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "host_key" text;--> statement-breakpoint
UPDATE "crawls" SET "host_key" = regexp_replace(
	lower(substring("site_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(\[[^]]*\]|[^:/?#]+)')),
	'^www\.', ''
) WHERE "host_key" IS NULL;--> statement-breakpoint
ALTER TABLE "crawls" ALTER COLUMN "host_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "auto_resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_live_per_crawl" ON "jobs" USING btree ("crawl_id") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claim_order" ON "jobs" USING btree ("queued_at","id") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_by_instance" ON "jobs" USING btree ("claimed_by") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "crawls_host_key" ON "crawls" USING btree ("host_key");