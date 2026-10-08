ALTER TABLE "guild_members" ADD COLUMN "mute" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_members" ADD COLUMN "deaf" boolean DEFAULT false NOT NULL;