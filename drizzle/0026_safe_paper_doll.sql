ALTER TABLE "pages" ADD COLUMN "html_lang" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "social" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "h2_text" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "title_count" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "meta_description_count" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "robots_metas" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "meta_refresh" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "anchor_counts" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "insecure_refs" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "images_empty_alt" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "images_alt_too_long" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "images_missing_alt_sample" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rel_next_count" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rel_prev_count" smallint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "html_structure" jsonb;--> statement-breakpoint
CREATE INDEX "pages_dupe_h2_text" ON "pages" USING btree ("crawl_id",btrim("h2_text"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."h2_text" is not null;--> statement-breakpoint
CREATE INDEX "pages_dupe_og_title" ON "pages" USING btree ("crawl_id",btrim("og_title"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."og_title" is not null;--> statement-breakpoint
CREATE INDEX "pages_dupe_og_description" ON "pages" USING btree ("crawl_id",btrim("og_description"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."og_description" is not null;