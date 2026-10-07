CREATE TABLE "channel_pins" (
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_pins_channel_id_message_id_pk" PRIMARY KEY("channel_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "guild_event_rsvps" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_event_rsvps_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "guild_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" uuid NOT NULL,
	"channel_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_user_id_blocked_user_id_pk" PRIMARY KEY("user_id","blocked_user_id")
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "hoist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_event_rsvps" ADD CONSTRAINT "guild_event_rsvps_event_id_guild_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."guild_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_event_rsvps" ADD CONSTRAINT "guild_event_rsvps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_events" ADD CONSTRAINT "guild_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_events" ADD CONSTRAINT "guild_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_events" ADD CONSTRAINT "guild_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_events_guild_starts_idx" ON "guild_events" USING btree ("guild_id","starts_at");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_user_id_idx" ON "user_blocks" USING btree ("blocked_user_id");