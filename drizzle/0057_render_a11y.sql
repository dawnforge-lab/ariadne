CREATE TABLE "render_a11y" (
	"crawl_id" text NOT NULL,
	"page_id" text NOT NULL,
	"axe_rule" text NOT NULL,
	"impact" text,
	"node_count" integer NOT NULL,
	"targets" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_a11y_status" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_a11y_ms" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_a11y_error" text;--> statement-breakpoint
ALTER TABLE "render_a11y" ADD CONSTRAINT "render_a11y_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "render_a11y_crawl_page_rule" ON "render_a11y" USING btree ("crawl_id","page_id","axe_rule");--> statement-breakpoint
CREATE INDEX "render_a11y_crawl_rule" ON "render_a11y" USING btree ("crawl_id","axe_rule");