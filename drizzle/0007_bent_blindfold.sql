ALTER TABLE "pages" ADD COLUMN "nav_link_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "footer_link_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "framework_markers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_nav_link_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_footer_link_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_filter_link_count" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "rendered_redirect_url" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "render_error" text;