ALTER TABLE "crawls" ADD COLUMN "recheck_pass_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "recheck_pass_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "recheck_fetch_class" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "recheck_status_code" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "recheck_reason" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "recheck_at" timestamp with time zone;