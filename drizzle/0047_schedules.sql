-- Phase 28c Task 3: schedules. `schedules` holds what a fire inserts (call C2) and when it fires;
-- `schedule_credentials` its encrypted credential values (CredentialVault.writeSchedule);
-- `crawls.schedule_id` / `schedule_chain` mark a fired crawl and the chain it runs. The foreign
-- key on `crawl_events.schedule_id` (a plain column since 0045, Ruling P1) is ON DELETE SET NULL
-- (Ruling P2): a deleted schedule's fired crawls keep their history.
CREATE TABLE "schedule_credentials" (
	"schedule_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"generation" integer NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"site_url" text NOT NULL,
	"config" jsonb NOT NULL,
	"render" jsonb,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_crawl_id" text,
	"credential_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_next_run_while_enabled" CHECK ("schedules"."enabled" = ("schedules"."next_run_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "schedule_chain" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_credentials" ADD CONSTRAINT "schedule_credentials_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_last_crawl_id_crawls_id_fk" FOREIGN KEY ("last_crawl_id") REFERENCES "public"."crawls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_tenant_created" ON "schedules" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "schedules_due" ON "schedules" USING btree ("next_run_at","id") WHERE "schedules"."enabled";--> statement-breakpoint
CREATE INDEX "schedules_last_crawl" ON "schedules" USING btree ("last_crawl_id") WHERE "schedules"."last_crawl_id" is not null;--> statement-breakpoint
ALTER TABLE "crawl_events" ADD CONSTRAINT "crawl_events_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawls_schedule" ON "crawls" USING btree ("schedule_id") WHERE "crawls"."schedule_id" is not null;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_schedule_has_chain" CHECK ("crawls"."schedule_id" is null or "crawls"."schedule_chain" is not null);