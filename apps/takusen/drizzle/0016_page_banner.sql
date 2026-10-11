ALTER TABLE "doc_pages" ADD COLUMN "banner_envelope" "bytea";--> statement-breakpoint
ALTER TABLE "doc_pages" ADD COLUMN "banner_upload_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;