ALTER TABLE "pages" ADD COLUMN "main_simhash" bigint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "main_word_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "placeholder_snippet" text;