-- Phase 28a: every crawl belongs to a tenant. The column is added nullable so
-- the existing rows can be backfilled to `local` (the single tenant every
-- pre-28a crawl belonged to), then made NOT NULL. There is deliberately no
-- column default: every writer must say whose crawl it is.
ALTER TABLE "crawls" ADD COLUMN "tenant_id" text;--> statement-breakpoint
UPDATE "crawls" SET "tenant_id" = 'local' WHERE "tenant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "crawls" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "crawls_tenant_started" ON "crawls" USING btree ("tenant_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);
