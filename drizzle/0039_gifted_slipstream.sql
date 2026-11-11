-- Phase 28b: a crawl's credential values, encrypted (AES-256-GCM, src/crawl/credential-vault.ts),
-- so a resume, a render or another process can run it without Talos sending them again. The key
-- is never in the database. `crawls.credential_generation` counts the writes and is part of each
-- row's associated data, so it lives on the crawl, which outlives a removed credentials row.
CREATE TABLE "crawl_credentials" (
	"crawl_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"generation" integer NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawls" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_credentials" ADD CONSTRAINT "crawl_credentials_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;
