ALTER TABLE "pages" ADD COLUMN "inlinks_internal" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "outlinks_internal" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "outlinks_external" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "link_score_raw" double precision;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "link_score" integer;