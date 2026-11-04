ALTER TABLE "crawls" ADD COLUMN "request_headers" jsonb;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "render_launch_error" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "response_headers" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "extraction_version" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_version" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_console" jsonb;