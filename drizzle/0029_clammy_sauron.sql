CREATE TABLE "sitemap_hreflang" (
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"url_normalised" text NOT NULL,
	"hreflang_code" text NOT NULL,
	"target_url" text NOT NULL,
	"sitemap_source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitemap_memberships" (
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"url_normalised" text NOT NULL,
	"sitemap_source" text NOT NULL,
	CONSTRAINT "sitemap_memberships_crawl_id_url_sitemap_source_pk" PRIMARY KEY("crawl_id","url","sitemap_source")
);
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "name_hint" text;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "name_hint_source" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "overlong_urls" jsonb;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "share_image" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sitemap_hreflang" ADD CONSTRAINT "sitemap_hreflang_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_memberships" ADD CONSTRAINT "sitemap_memberships_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sitemap_hreflang_crawl_normalised" ON "sitemap_hreflang" USING btree ("crawl_id","url_normalised");--> statement-breakpoint
CREATE INDEX "sitemap_memberships_crawl_normalised" ON "sitemap_memberships" USING btree ("crawl_id","url_normalised");