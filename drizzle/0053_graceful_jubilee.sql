ALTER TABLE "structured_data" ADD COLUMN "validation_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "structured_data" DROP COLUMN "field_presence_jsonb";