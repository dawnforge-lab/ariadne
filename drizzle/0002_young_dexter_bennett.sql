ALTER TABLE "pages" ADD COLUMN "canonical_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "images_missing_dimensions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "has_viewport" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "has_lorem_ipsum" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "redirect_hops";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "in_sitemap";