CREATE TABLE "media_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"capacity" jsonb NOT NULL,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"cpu_fraction" double precision DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"tenant_id" text,
	"sidechannel_addr" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
-- Composite index covering the pickPlacement filter:
--   WHERE region = $1 AND status = 'active' AND last_heartbeat_at > $cutoff
-- Hand-rolled into 0001 per the dev-stage migrations rule (regen the seed
-- rather than stacking ALTERs while schemas are still in flux); see
-- `feedback_dev_migrations` in the user's auto-memory.
CREATE INDEX "idx_media_nodes_placement" ON "media_nodes" ("region","status","last_heartbeat_at");
