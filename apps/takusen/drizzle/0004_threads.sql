ALTER TYPE "public"."channel_type" ADD VALUE 'thread';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "thread_start_message_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_thread_start_message_id_messages_id_fk" FOREIGN KEY ("thread_start_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_parent_id_idx" ON "channels" USING btree ("parent_id");