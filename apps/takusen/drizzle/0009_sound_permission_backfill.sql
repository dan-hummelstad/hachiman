-- USE_SOUNDBOARD (1 << 25) joined DEFAULT_EVERYONE (contract §2): give it to the @everyone role
-- (id = guild id) of the existing guilds.
UPDATE "roles" SET "permissions" = "permissions" | 33554432 WHERE "id" = "guild_id";
