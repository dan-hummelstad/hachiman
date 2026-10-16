ALTER TABLE "push_targets" ADD COLUMN "p256dh" text;--> statement-breakpoint
ALTER TABLE "push_targets" ADD COLUMN "auth" text;--> statement-breakpoint
ALTER TABLE "push_targets" ADD COLUMN "push_key" text;--> statement-breakpoint
ALTER TABLE "push_targets" ADD COLUMN "push_key_sig" text;--> statement-breakpoint
ALTER TABLE "push_targets" ADD COLUMN "kinds" text[] DEFAULT '{dm,mention}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "push_targets" ADD COLUMN "quiet" text[] DEFAULT '{}'::text[] NOT NULL;