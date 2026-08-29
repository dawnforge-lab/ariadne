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
--
-- THE `jsonb_typeof` GUARD IS LOAD-BEARING, and it is not the same test as the
-- `IS NOT NULL` beside it. `->` yields *jsonb* `null` — not SQL NULL — when the
-- key is present with a JSON null value, and that is what the retired
-- `jsonb_set` writer wrote on EVERY AUTOMATIC Phase 8 render pass. Without the
-- guard those rows land in the column as jsonb `'null'`, a second spelling of
-- the fact the column's comment says SQL NULL means (src/db/schema.ts), and a
-- SQL reader asking `render_urls_jsonb is null` would get the wrong answer on
-- every auto-rendered P8-era crawl. `<> 'null'` and deliberately NOT
-- `= 'array'`: a value that is neither null nor a list of URLs is a config we
-- cannot read, and it must be COPIED so `render.coverage` refuses the crawl
-- out loud rather than having the migration quietly drop it (hard rule 7).
UPDATE crawls SET render_urls_jsonb = config_jsonb->'renderUrls'
WHERE config_jsonb ? 'renderUrls' AND config_jsonb->'renderUrls' IS NOT NULL
  AND jsonb_typeof(config_jsonb->'renderUrls') <> 'null';--> statement-breakpoint
UPDATE crawls SET config_jsonb = config_jsonb - 'renderUrls' WHERE config_jsonb ? 'renderUrls';