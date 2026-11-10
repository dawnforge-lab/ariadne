CREATE TABLE "list_urls" (
	"crawl_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "list_urls_crawl_id_position_pk" PRIMARY KEY("crawl_id","position")
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "excluded_dropped" integer;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "scope_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "frontier" ADD COLUMN "redirect_hops" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "list_urls" ADD CONSTRAINT "list_urls_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;