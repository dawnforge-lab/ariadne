ALTER TABLE "crawls" ADD COLUMN "discovery_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "host_probe_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "notfound_probe_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "ruleset_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "has_soft404_phrases" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "pages_crawl_id" ON "pages" USING btree ("crawl_id","id");