CREATE TABLE "crawls" (
	"id" text PRIMARY KEY NOT NULL,
	"site_url" text NOT NULL,
	"config_jsonb" jsonb NOT NULL,
	"ruleset_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"pages_total" integer,
	"render_pass_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frontier" (
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"depth" integer NOT NULL,
	"discovered_via" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" text,
	"leased_until" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "frontier_crawl_id_url_pk" PRIMARY KEY("crawl_id","url")
);
--> statement-breakpoint
CREATE TABLE "hreflang" (
	"crawl_id" text NOT NULL,
	"page_id" text NOT NULL,
	"hreflang_code" text NOT NULL,
	"target_url" text NOT NULL,
	"target_page_id" text,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"crawl_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"page_id" text,
	"severity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"details_jsonb" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"crawl_id" text NOT NULL,
	"source_page_id" text NOT NULL,
	"target_url" text NOT NULL,
	"target_page_id" text,
	"anchor" text,
	"rel" text,
	"is_internal" boolean NOT NULL,
	"is_nofollow" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"crawl_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_value" text DEFAULT '' NOT NULL,
	"value_jsonb" jsonb NOT NULL,
	CONSTRAINT "metrics_crawl_id_metric_id_scope_scope_value_pk" PRIMARY KEY("crawl_id","metric_id","scope","scope_value")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"url_normalised" text NOT NULL,
	"page_type" text,
	"status_code" integer,
	"fetch_class" text NOT NULL,
	"content_type" text,
	"redirect_url" text,
	"redirect_hops" integer,
	"depth" integer NOT NULL,
	"in_sitemap" boolean DEFAULT false NOT NULL,
	"discovered_via" text NOT NULL,
	"title" text,
	"meta_description" text,
	"canonical_html" text,
	"canonical_header" text,
	"robots_meta" text,
	"x_robots_tag" text,
	"is_indexable" boolean,
	"og_title" text,
	"og_description" text,
	"og_image" text,
	"h1_count" integer DEFAULT 0 NOT NULL,
	"h2_count" integer DEFAULT 0 NOT NULL,
	"h3_count" integer DEFAULT 0 NOT NULL,
	"h4_count" integer DEFAULT 0 NOT NULL,
	"h5_count" integer DEFAULT 0 NOT NULL,
	"h6_count" integer DEFAULT 0 NOT NULL,
	"heading_order" integer[],
	"word_count" integer,
	"text_ratio" real,
	"content_hash" text,
	"simhash" bigint,
	"response_time_ms" integer,
	"html_bytes" integer,
	"dom_size" integer,
	"images_total" integer DEFAULT 0 NOT NULL,
	"images_missing_alt" integer DEFAULT 0 NOT NULL,
	"has_amp" boolean DEFAULT false NOT NULL,
	"rel_next" text,
	"rel_prev" text,
	"rendered" boolean DEFAULT false NOT NULL,
	"rendered_word_count" integer,
	"rendered_link_count" integer
);
--> statement-breakpoint
CREATE TABLE "sitemap_urls" (
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"sitemap_source" text NOT NULL,
	"lastmod" text,
	"page_id" text,
	CONSTRAINT "sitemap_urls_crawl_id_url_pk" PRIMARY KEY("crawl_id","url")
);
--> statement-breakpoint
CREATE TABLE "structured_data" (
	"crawl_id" text NOT NULL,
	"page_id" text NOT NULL,
	"schema_type" text NOT NULL,
	"raw_jsonb" jsonb NOT NULL,
	"field_presence_jsonb" jsonb
);
--> statement-breakpoint
CREATE TABLE "url_params" (
	"crawl_id" text NOT NULL,
	"param_name" text NOT NULL,
	"occurrence_count" integer NOT NULL,
	"sample_urls" text[] NOT NULL,
	"is_tracking" boolean DEFAULT false NOT NULL,
	CONSTRAINT "url_params_crawl_id_param_name_pk" PRIMARY KEY("crawl_id","param_name")
);
--> statement-breakpoint
ALTER TABLE "frontier" ADD CONSTRAINT "frontier_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hreflang" ADD CONSTRAINT "hreflang_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_urls" ADD CONSTRAINT "sitemap_urls_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structured_data" ADD CONSTRAINT "structured_data_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_params" ADD CONSTRAINT "url_params_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "frontier_leasable" ON "frontier" USING btree ("crawl_id","state","leased_until");--> statement-breakpoint
CREATE INDEX "hreflang_crawl_page" ON "hreflang" USING btree ("crawl_id","page_id");--> statement-breakpoint
CREATE INDEX "hreflang_crawl_target" ON "hreflang" USING btree ("crawl_id","target_url");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_dedupe" ON "issues" USING btree ("crawl_id","rule_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "issues_crawl_rule" ON "issues" USING btree ("crawl_id","rule_id");--> statement-breakpoint
CREATE INDEX "links_crawl_target_url" ON "links" USING btree ("crawl_id","target_url");--> statement-breakpoint
CREATE INDEX "links_crawl_target_page" ON "links" USING btree ("crawl_id","target_page_id");--> statement-breakpoint
CREATE INDEX "links_crawl_source" ON "links" USING btree ("crawl_id","source_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_crawl_url" ON "pages" USING btree ("crawl_id","url");--> statement-breakpoint
CREATE INDEX "pages_crawl_normalised" ON "pages" USING btree ("crawl_id","url_normalised");--> statement-breakpoint
CREATE INDEX "pages_crawl_type" ON "pages" USING btree ("crawl_id","page_type");--> statement-breakpoint
CREATE INDEX "sd_crawl_type" ON "structured_data" USING btree ("crawl_id","schema_type");