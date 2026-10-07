DROP INDEX "channels_parent_id_idx";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "channels" SET "last_activity_at" = COALESCE((SELECT max("m"."created_at") FROM "messages" "m" WHERE "m"."channel_id" = "channels"."id"), "channels"."created_at");--> statement-breakpoint
CREATE INDEX "channels_parent_activity_idx" ON "channels" USING btree ("parent_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "channels_guild_thread_activity_idx" ON "channels" USING btree ("guild_id","last_activity_at") WHERE "channels"."type" = 'thread';