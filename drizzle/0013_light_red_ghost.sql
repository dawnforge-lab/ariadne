CREATE TABLE "page_resources" (
	"crawl_id" text NOT NULL,
	"page_id" text NOT NULL,
	"resource_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"fetch_class" text,
	"fetch_reason" text,
	"status_code" integer,
	"content_type" text,
	"bytes" integer,
	"bytes_source" text,
	"cache_control" text,
	"expires" text,
	"fetched_at" timestamp with time zone,
	"fetch_ms" integer
);
--> statement-breakpoint
ALTER TABLE "page_resources" ADD CONSTRAINT "page_resources_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_resources_crawl_page" ON "page_resources" USING btree ("crawl_id","page_id");--> statement-breakpoint
CREATE INDEX "page_resources_crawl_resource" ON "page_resources" USING btree ("crawl_id","resource_url");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_crawl_url" ON "resources" USING btree ("crawl_id","url");