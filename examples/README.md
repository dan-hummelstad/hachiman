# Bot examples

Each folder is a small bot that answers `!` commands. Make the bot first:

1. Sign in to the Takusen dashboard and open **Bots**. Click **Create bot** and copy the token (`hbot_…`).
2. Click **Add to guild** and pick a guild where you have the Manage server permission.

The token is all the bot needs: it names the server, and the server names its gateway. Each bot keeps its keys in `.hachiman-bot/` next to it: keep that folder (see `pkgs/hachiman-discord.js/README.md`, "Keep the state directory").

| Folder | SDK | For |
|---|---|---|
| [`native/`](native) | `@hachiman/bot` (`startBot`) | New bots for Hachiman: plaintext events and calls, no Discord layer |
| [`discord-js/`](discord-js) | `@hachiman/discord.js`, installed as `discord.js` | An existing discord.js bot: no code change |
| [`discord-js-sharding/`](discord-js-sharding) | `@hachiman/discord.js` with `ShardingManager` | A discord.js bot with shards |
| [`discord-py/`](discord-py) | the `hachiman-discord-bridge` process | A bot in another language (discord.py here) |

In this repo, the JavaScript examples are workspace packages: `pnpm install`, then `pnpm -F <name> start` with `HACHIMAN_TOKEN` (native) or `DISCORD_TOKEN` (discord.js) set. Users of a released package install it from npm instead; each README shows how.

A bot ignores messages from bots, as most Discord bots do, so try the commands from a person's account.
