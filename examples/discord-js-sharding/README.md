# discord.js sharding example

```sh
DISCORD_TOKEN=hbot_… pnpm -F @hachiman/example-discord-js-sharding start
```

`ShardingManager` starts two shard processes. Each is its own encrypted device in `.hachiman-bot/shard-<id>/`. The first one makes the bot's keys and `.hachiman-bot/deployment.key`, and the second one links to it with that key. Neither the owner nor the server takes part, and the token alone never gets the keys.

To run shards on more machines, copy `.hachiman-bot/deployment.key` to each machine once, beside the token.

Commands: `!ping` (answered by the shard of the guild), `!guilds` (counts over all shards).
