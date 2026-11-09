ALTER TABLE "crawls" ADD COLUMN "control_request" text;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "cancelled_at" timestamp with time zone;