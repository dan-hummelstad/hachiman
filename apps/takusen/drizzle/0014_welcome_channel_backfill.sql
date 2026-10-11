-- Existing guilds: the oldest text channel (the #general of guild creation) greets new members.
UPDATE "guilds" g SET "welcome_channel_id" = (
  SELECT c."id" FROM "channels" c
  WHERE c."guild_id" = g."id" AND c."type" = 'text'
  ORDER BY c."created_at", c."id"
  LIMIT 1
)
WHERE g."welcome_channel_id" IS NULL;
