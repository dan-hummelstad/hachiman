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
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
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
	"server_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '["openid","profile","email"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_clients_server_id_unique" UNIQUE("server_id"),
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
CREATE TABLE "server_domain_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"txt_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" "citext" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 64738 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
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
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_domain_verifications" ADD CONSTRAINT "server_domain_verifications_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_model_uid_idx" ON "oidc_adapter_payloads" USING btree ("model","uid");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_model_user_code_idx" ON "oidc_adapter_payloads" USING btree ("model","user_code");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_grant_id_idx" ON "oidc_adapter_payloads" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oidc_adapter_payloads_expires_at_idx" ON "oidc_adapter_payloads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_slug_unique" ON "servers" USING btree ("slug");