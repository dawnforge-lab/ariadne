ALTER TABLE "pages" ADD COLUMN "rendered_analyzer_word_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_renderable_word_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_title" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_h1_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_canonical" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_html_path" text;