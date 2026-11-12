CREATE TABLE "crawl_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"crawl_id" text,
	"schedule_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_events" ADD CONSTRAINT "crawl_events_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_events_crawl" ON "crawl_events" USING btree ("crawl_id","id") WHERE "crawl_events"."crawl_id" is not null;--> statement-breakpoint
CREATE INDEX "crawl_events_schedule" ON "crawl_events" USING btree ("schedule_id","id") WHERE "crawl_events"."schedule_id" is not null;