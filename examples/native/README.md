# Native SDK example

A bot on `@hachiman/bot` directly: no Discord layer, Hachiman ids (UUIDs), decrypted events and calls.

```sh
HACHIMAN_TOKEN=hbot_… pnpm -F @hachiman/example-native start
```

Commands: `!ping`, `!hello`, `!echo <text>`, `!react`, `!countdown`, `!history`, `!dm`, `!whoami`.

The API in `src/bot.ts`:

- `startBot({ token })` returns a started `BotRuntime`. Options and environment variables: `hachimanUrl` / `HACHIMAN_URL`, `gatewayUrl` / `HACHIMAN_GATEWAY_URL`, `stateDir` / `HACHIMAN_BOT_STATE`, `shard` / `SHARDS` + `SHARD_COUNT`, `join` / `HACHIMAN_BOT_JOIN`.
- Events: `message`, `messageUpdate`, `messageDelete`, `reaction`, `event` (guild, channel, member, role, typing and presence events), `ready`, `error`.
- Calls: `send`, `edit`, `delete`, `react`, `fetchMessages`, `fetchMessage`, `typing`, `openDm`, `joinInvite`.
- `cache`: guilds, channels, roles and members, from the Hachiman client.
