ALTER TABLE "pages" ADD COLUMN "redirect_url_normalised" text;--> statement-breakpoint
ALTER TABLE "sitemap_urls" ADD COLUMN "url_normalised" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "sitemap_urls_crawl_normalised" ON "sitemap_urls" USING btree ("crawl_id","url_normalised");