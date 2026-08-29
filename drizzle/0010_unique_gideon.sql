ALTER TABLE "crawls" ADD COLUMN "rules_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "h1_text" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "renderable_word_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "click_depth" integer;