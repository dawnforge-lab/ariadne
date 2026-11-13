ALTER TABLE "pages" ADD COLUMN "structured_data_microdata_errors" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "structured_data_skips" jsonb;--> statement-breakpoint
ALTER TABLE "structured_data" ADD COLUMN "id" bigserial PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "structured_data" ADD COLUMN "format" text DEFAULT 'jsonld' NOT NULL;--> statement-breakpoint
CREATE INDEX "sd_crawl_id" ON "structured_data" USING btree ("crawl_id","id");