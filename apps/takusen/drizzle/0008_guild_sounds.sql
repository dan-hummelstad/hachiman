ALTER TYPE "public"."upload_purpose" ADD VALUE 'sound';--> statement-breakpoint
CREATE TABLE "guild_sounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"name" text NOT NULL,
	"emoji" text,
	"upload_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_device" uuid,
	"envelope" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_sounds_upload_id_unique" UNIQUE("upload_id")
);
--> statement-breakpoint
ALTER TABLE "guild_sounds" ADD CONSTRAINT "guild_sounds_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_sounds" ADD CONSTRAINT "guild_sounds_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_sounds" ADD CONSTRAINT "guild_sounds_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_sounds" ADD CONSTRAINT "guild_sounds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_sounds_guild_id_idx" ON "guild_sounds" USING btree ("guild_id","created_at");