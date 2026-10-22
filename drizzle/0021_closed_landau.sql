ALTER TABLE "pages" ADD COLUMN "head_closed_by" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "title_outside_head" boolean;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "meta_description_outside_head" boolean;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "robots_outside_head" boolean;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "canonical_outside_head" boolean;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "hreflang_outside_head_count" integer;