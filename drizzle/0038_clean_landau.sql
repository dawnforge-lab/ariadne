-- Phase 28b: each sitemap entry records the walk that last listed it. The column
-- is added nullable so the existing rows can be backfilled to their crawl's
-- `started_at` (the earliest walk they can belong to, so any later walk's stamp
-- is newer), then made NOT NULL. No column default: every writer says which walk.
ALTER TABLE "sitemap_urls" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sitemap_urls" SET "seen_at" = "crawls"."started_at" FROM "crawls" WHERE "crawls"."id" = "sitemap_urls"."crawl_id";--> statement-breakpoint
ALTER TABLE "sitemap_urls" ALTER COLUMN "seen_at" SET NOT NULL;
