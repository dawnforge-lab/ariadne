ALTER TABLE "crawls" ADD COLUMN "render_urls_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "template_inference_jsonb" jsonb;--> statement-breakpoint
CREATE INDEX "pages_dupe_title" ON "pages" USING btree ("crawl_id",btrim("title"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."title" is not null;--> statement-breakpoint
CREATE INDEX "pages_dupe_meta_description" ON "pages" USING btree ("crawl_id",btrim("meta_description"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."meta_description" is not null;--> statement-breakpoint
CREATE INDEX "pages_dupe_h1_text" ON "pages" USING btree ("crawl_id",btrim("h1_text"),"url") WHERE "pages"."fetch_class" = 'ok' and "pages"."status_code" = 200 and "pages"."is_indexable" = true and "pages"."h1_text" is not null;--> statement-breakpoint
-- Hand-appended to the generated file: drizzle-kit diffs SCHEMA, and moving the
-- data a retired schema decision left behind is not a schema diff. Two
-- statements, in this order — copy the record out of `config_jsonb`, then
-- remove the key, so `config_jsonb` returns to being exactly what
-- `storableConfig` wrote (src/crawl/loop.ts) and has ONE writer again.
--
-- `template_inference_jsonb` is deliberately NOT backfilled: the pre-0012
-- crawls' collapse numbers exist only in a log line, and a guessed backfill
-- would be a silent fallback (hard rule 7). Their NULL is the truth.
UPDATE crawls SET render_urls_jsonb = config_jsonb->'renderUrls'
WHERE config_jsonb ? 'renderUrls' AND config_jsonb->'renderUrls' IS NOT NULL;--> statement-breakpoint
UPDATE crawls SET config_jsonb = config_jsonb - 'renderUrls' WHERE config_jsonb ? 'renderUrls';