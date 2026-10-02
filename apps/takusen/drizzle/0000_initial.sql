CREATE TYPE "public"."backup_kind" AS ENUM('identity', 'history');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('text', 'voice', 'category', 'dm', 'group_dm', 'pages');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('electron', 'browser');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."handshake_kind" AS ENUM('commit', 'external_commit', 'proposal');--> statement-breakpoint
CREATE TYPE "public"."history_visibility" AS ENUM('joined', 'shared');--> statement-breakpoint
CREATE TYPE "public"."inbox_kind" AS ENUM('welcome', 'dsk_transfer', 'history_keys');--> statement-breakpoint
CREATE TYPE "public"."join_status" AS ENUM('queued', 'committed', 'rejected', 'external_commit', 'waiting');--> statement-breakpoint
CREATE TYPE "public"."mls_group_kind" AS ENUM('public_set', 'channel', 'dm');--> statement-breakpoint
CREATE TYPE "public"."mls_group_status" AS ENUM('pending', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."overwrite_type" AS ENUM('role', 'member');--> statement-breakpoint
CREATE TYPE "public"."pending_op" AS ENUM('add', 'remove');--> statement-breakpoint
CREATE TYPE "public"."pending_status" AS ENUM('queued', 'assigned', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."revoke_reason" AS ENUM('user', 'lost', 'password_reset', 'compromised', 'signed_out');--> statement-breakpoint
CREATE TYPE "public"."upload_purpose" AS ENUM('attachment', 'image', 'page_snapshot', 'page_media');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"guild_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"action" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_actions_guild_id_seq_pk" PRIMARY KEY("guild_id","seq")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" uuid,
	"type" "channel_type" NOT NULL,
	"name" text,
	"topic" text,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" uuid,
	"mls_group_id" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "device_inbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"device_id" uuid NOT NULL,
	"kind" "inbox_kind" NOT NULL,
	"sender_device" uuid,
	"body" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_link_messages" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_device" uuid NOT NULL,
	"body" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_link_messages_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "device_link_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"new_device_id" uuid NOT NULL,
	"offer" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_revocations" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" "revoke_reason" NOT NULL,
	"revocation" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_signing_keys" (
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"master_generation" integer NOT NULL,
	"public_key" "bytea" NOT NULL,
	"cert" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "device_signing_keys_user_id_generation_pk" PRIMARY KEY("user_id","generation")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "device_status" DEFAULT 'pending' NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"client_version" text NOT NULL,
	"certificate" "bytea",
	"mls_signature_key" "bytea",
	"hpke_key" "bytea",
	"dsk_generation" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dm_participants" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "dm_participants_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "doc_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"title_envelope" "bytea" NOT NULL,
	"created_by" uuid,
	"latest_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_snapshots" (
	"page_id" uuid NOT NULL,
	"base_seq" bigint NOT NULL,
	"upload_id" uuid NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_device" uuid,
	"envelope" "bytea" NOT NULL,
	"media_upload_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_snapshots_page_id_base_seq_pk" PRIMARY KEY("page_id","base_seq"),
	CONSTRAINT "doc_snapshots_upload_id_unique" UNIQUE("upload_id")
);
--> statement-breakpoint
CREATE TABLE "doc_updates" (
	"page_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_device" uuid,
	"envelope" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_updates_page_id_seq_pk" PRIMARY KEY("page_id","seq")
);
--> statement-breakpoint
CREATE TABLE "guild_members" (
	"guild_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"nick" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_members_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"banner" text,
	"region" text,
	"page_storage_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_device" uuid NOT NULL,
	"blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"guild_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "key_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_id" "bytea" NOT NULL,
	"kind" "backup_kind" NOT NULL,
	"group_id" "bytea",
	"epoch_from" bigint,
	"epoch_to" bigint,
	"blob" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cipher_suite" integer NOT NULL,
	"ref" "bytea" NOT NULL,
	"data" "bytea" NOT NULL,
	"last_resort" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "key_packages_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "kt_entries" (
	"idx" bigint PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" smallint NOT NULL,
	"entry" "bytea" NOT NULL,
	"leaf_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kt_tree_heads" (
	"tree_size" bigint PRIMARY KEY NOT NULL,
	"root_hash" "bytea" NOT NULL,
	"signed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "master_keys" (
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"public_key" "bytea" NOT NULL,
	"record" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "master_keys_user_id_generation_pk" PRIMARY KEY("user_id","generation")
);
--> statement-breakpoint
CREATE TABLE "media_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"capacity" jsonb NOT NULL,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"cpu_fraction" double precision DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"admin_drain" boolean DEFAULT false NOT NULL,
	"signaling_url" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_roles" (
	"guild_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "member_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "message_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"channel_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"content" "bytea" NOT NULL,
	"franking_key" "bytea" NOT NULL,
	"verified" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_device" uuid,
	"client_msg_id" "bytea" NOT NULL,
	"envelope" "bytea" NOT NULL,
	"franking_tag" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mls_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"device_id" uuid NOT NULL,
	"pending_ids" uuid[] NOT NULL,
	"timed_out_devices" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_group_epochs" (
	"group_id" "bytea" NOT NULL,
	"epoch" bigint NOT NULL,
	"group_info" "bytea" NOT NULL,
	"ratchet_tree" "bytea" NOT NULL,
	"tree_hash" "bytea" NOT NULL,
	"confirmed_transcript_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mls_group_epochs_group_id_epoch_pk" PRIMARY KEY("group_id","epoch")
);
--> statement-breakpoint
CREATE TABLE "mls_group_members" (
	"group_id" "bytea" NOT NULL,
	"leaf_index" integer NOT NULL,
	"device_id" uuid,
	"user_id" uuid,
	"credential_identity" text NOT NULL,
	"signature_key" "bytea" NOT NULL,
	CONSTRAINT "mls_group_members_group_id_leaf_index_pk" PRIMARY KEY("group_id","leaf_index")
);
--> statement-breakpoint
CREATE TABLE "mls_groups" (
	"group_id" "bytea" PRIMARY KEY NOT NULL,
	"kind" "mls_group_kind" NOT NULL,
	"scope_id" uuid NOT NULL,
	"guild_id" uuid,
	"channel_id" uuid,
	"generation" integer NOT NULL,
	"cipher_suite" integer NOT NULL,
	"status" "mls_group_status" NOT NULL,
	"epoch" bigint,
	"group_info" "bytea",
	"ratchet_tree" "bytea",
	"history_visibility" "history_visibility" NOT NULL,
	"epoch_started_at" timestamp with time zone,
	"last_commit_removed" boolean DEFAULT false NOT NULL,
	"latest_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_handshakes" (
	"group_id" "bytea" NOT NULL,
	"seq" bigint NOT NULL,
	"epoch" bigint NOT NULL,
	"kind" "handshake_kind" NOT NULL,
	"sender_device" uuid,
	"message" "bytea" NOT NULL,
	"tree_hash" "bytea",
	"confirmed_transcript_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mls_handshakes_group_id_seq_pk" PRIMARY KEY("group_id","seq")
);
--> statement-breakpoint
CREATE TABLE "mls_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" "bytea" NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key_package" "bytea" NOT NULL,
	"status" "join_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mls_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" "bytea" NOT NULL,
	"op" "pending_op" NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"leaf_index" integer,
	"key_package" "bytea",
	"join_request_id" uuid,
	"reason" text NOT NULL,
	"status" "pending_status" DEFAULT 'queued' NOT NULL,
	"proposal" "bytea",
	"proposal_epoch" bigint,
	"proposal_ref" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_adapter_payloads" (
	"id" text NOT NULL,
	"model" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oidc_adapter_payloads_model_id_pk" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE TABLE "oidc_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '["openid","profile","email"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "permission_overwrites" (
	"channel_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_type" "overwrite_type" NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "permission_overwrites_channel_id_target_id_pk" PRIMARY KEY("channel_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"probe_host" text,
	"probe_port" integer DEFAULT 443 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"permissions" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"key" text NOT NULL,
	"filename" text,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"message_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"purpose" "upload_purpose",
	"page_id" uuid,
	"last_referenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_key_unique" UNIQUE("key"),
	CONSTRAINT "uploads_attachment_has_message" CHECK (("uploads"."purpose" is not distinct from 'attachment') = ("uploads"."message_id" is not null)),
	CONSTRAINT "uploads_page_media_has_page" CHECK ("uploads"."purpose" is distinct from 'page_media' or "uploads"."page_id" is not null),
	CONSTRAINT "uploads_page_id_is_page_purpose" CHECK ("uploads"."page_id" is null or "uploads"."purpose" in ('page_snapshot', 'page_media'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"image" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_id_channels_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_mls_group_id_mls_groups_group_id_fk" FOREIGN KEY ("mls_group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_inbox" ADD CONSTRAINT "device_inbox_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_inbox" ADD CONSTRAINT "device_inbox_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link_messages" ADD CONSTRAINT "device_link_messages_session_id_device_link_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."device_link_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link_messages" ADD CONSTRAINT "device_link_messages_from_device_devices_id_fk" FOREIGN KEY ("from_device") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link_sessions" ADD CONSTRAINT "device_link_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_link_sessions" ADD CONSTRAINT "device_link_sessions_new_device_id_devices_id_fk" FOREIGN KEY ("new_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_revocations" ADD CONSTRAINT "device_revocations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_revocations" ADD CONSTRAINT "device_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signing_keys" ADD CONSTRAINT "device_signing_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_participants" ADD CONSTRAINT "dm_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_participants" ADD CONSTRAINT "dm_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_parent_id_doc_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_page_id_doc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_page_id_doc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_region_regions_code_fk" FOREIGN KEY ("region") REFERENCES "public"."regions"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_bundles" ADD CONSTRAINT "history_bundles_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_bundles" ADD CONSTRAINT "history_bundles_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_backups" ADD CONSTRAINT "key_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_keys" ADD CONSTRAINT "master_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_guild_id_user_id_guild_members_guild_id_user_id_fk" FOREIGN KEY ("guild_id","user_id") REFERENCES "public"."guild_members"("guild_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_batches" ADD CONSTRAINT "mls_batches_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_batches" ADD CONSTRAINT "mls_batches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_epochs" ADD CONSTRAINT "mls_group_epochs_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_group_members" ADD CONSTRAINT "mls_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_groups" ADD CONSTRAINT "mls_groups_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_groups" ADD CONSTRAINT "mls_groups_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_handshakes" ADD CONSTRAINT "mls_handshakes_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_handshakes" ADD CONSTRAINT "mls_handshakes_sender_device_devices_id_fk" FOREIGN KEY ("sender_device") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_join_requests" ADD CONSTRAINT "mls_join_requests_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_join_requests" ADD CONSTRAINT "mls_join_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_join_requests" ADD CONSTRAINT "mls_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_pending" ADD CONSTRAINT "mls_pending_group_id_mls_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mls_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_pending" ADD CONSTRAINT "mls_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_pending" ADD CONSTRAINT "mls_pending_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_pending" ADD CONSTRAINT "mls_pending_join_request_id_mls_join_requests_id_fk" FOREIGN KEY ("join_request_id") REFERENCES "public"."mls_join_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overwrites" ADD CONSTRAINT "permission_overwrites_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_page_id_doc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_guild_id_idx" ON "channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "device_inbox_device_seq_idx" ON "device_inbox" USING btree ("device_id","seq");--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_participants_user_id_idx" ON "dm_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "doc_pages_channel_id_idx" ON "doc_pages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "doc_pages_parent_id_idx" ON "doc_pages" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "history_bundles_group_epoch_sender_uq" ON "history_bundles" USING btree ("group_id","epoch","sender_device");--> statement-breakpoint
CREATE INDEX "key_backups_user_id_idx" ON "key_backups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "key_backups_identity_uq" ON "key_backups" USING btree ("user_id") WHERE "key_backups"."kind" = 'identity';--> statement-breakpoint
CREATE INDEX "key_packages_claim_idx" ON "key_packages" USING btree ("device_id","cipher_suite","last_resort","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "key_packages_last_resort_uq" ON "key_packages" USING btree ("device_id","cipher_suite") WHERE "key_packages"."last_resort";--> statement-breakpoint
CREATE INDEX "kt_entries_user_idx" ON "kt_entries" USING btree ("user_id","idx");--> statement-breakpoint
CREATE INDEX "idx_media_nodes_placement" ON "media_nodes" USING btree ("region","status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_client_msg_id_uq" ON "messages" USING btree ("channel_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "mls_batches_group_id_idx" ON "mls_batches" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_group_members_group_device_uq" ON "mls_group_members" USING btree ("group_id","device_id");--> statement-breakpoint
CREATE INDEX "mls_group_members_device_id_idx" ON "mls_group_members" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_groups_kind_scope_generation_uq" ON "mls_groups" USING btree ("kind","scope_id","generation");--> statement-breakpoint
CREATE INDEX "mls_groups_guild_id_idx" ON "mls_groups" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "mls_groups_channel_id_idx" ON "mls_groups" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "mls_handshakes_created_at_idx" ON "mls_handshakes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mls_join_requests_device_id_idx" ON "mls_join_requests" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "mls_pending_group_status_idx" ON "mls_pending" USING btree ("group_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mls_pending_open_remove_uq" ON "mls_pending" USING btree ("group_id","leaf_index") WHERE "mls_pending"."op" = 'remove' and "mls_pending"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_model_uid_idx" ON "oidc_adapter_payloads" USING btree ("model","uid");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_model_user_code_idx" ON "oidc_adapter_payloads" USING btree ("model","user_code");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_grant_id_idx" ON "oidc_adapter_payloads" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_expires_at_idx" ON "oidc_adapter_payloads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "roles_guild_id_idx" ON "roles" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "uploads_message_id_idx" ON "uploads" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "uploads_page_id_idx" ON "uploads" USING btree ("page_id");