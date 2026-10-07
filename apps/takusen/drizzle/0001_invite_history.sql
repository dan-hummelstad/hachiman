CREATE TABLE "invite_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" integer NOT NULL,
	"sender_device" uuid NOT NULL,
	"sender_user" uuid NOT NULL,
	"blob" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_members" ADD COLUMN "invite_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "record" "bytea";--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "key_id" "bytea";--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "exhausted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite_bundles" ADD CONSTRAINT "invite_bundles_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_bundles_invite_created_idx" ON "invite_bundles" USING btree ("invite_id","created_at");--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_members_invite_idx" ON "guild_members" USING btree ("invite_id") WHERE "guild_members"."invite_id" is not null;--> statement-breakpoint
CREATE INDEX "invites_guild_idx" ON "invites" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_key_id_uq" ON "invites" USING btree ("key_id");