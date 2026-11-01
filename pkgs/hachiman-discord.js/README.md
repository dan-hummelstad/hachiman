# @hachiman/discord.js

Run a discord.js bot on Hachiman. You do not change the bot code. You change the package and the token.

## Use it

1. Sign in to the dashboard of your Hachiman server. Open **Bots** and click **Create bot**. Copy the token (`hbot_…`). The dashboard shows it one time only. Click **Add to guild** to add the bot to a guild where you have the Manage server permission.
2. Install this package under the name `discord.js`:

   ```json
   "dependencies": {
     "discord.js": "npm:@hachiman/discord.js@^0.1.0"
   }
   ```

3. Start the bot with the Hachiman token, where it had its Discord token:

   ```sh
   DISCORD_TOKEN=hbot_… node bot.js
   ```

   The token names its server, and the server names its gateway, so the bot needs nothing else.

The bot code stays the same:

```js
const { Client, Events, GatewayIntentBits } = require('discord.js')

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
client.on(Events.MessageCreate, async (message) => {
  if (message.content === '!ping') await message.reply('pong')
})
client.login(process.env.DISCORD_TOKEN)
```

## Settings

All are optional.

| Variable | Default | Use |
|---|---|---|
| `HACHIMAN_URL` | the server that the token names | The Hachiman server (Takusen) |
| `HACHIMAN_GATEWAY_URL` | what the server names (`GET /api/v1/gateway`) | The Hachiman gateway |
| `HACHIMAN_BOT_STATE` | `./.hachiman-bot` | The directory for the bot's keys |
| `HACHIMAN_BOT_JOIN` | none | Invite codes, comma separated. The bot joins these guilds on start. **Add to guild** on the dashboard does the same without a setting |

## Keep the state directory

Hachiman encrypts all messages end to end. The bot is a device, as the desktop app is. It keeps its keys in the state directory:

- `wrap.key` encrypts the key store. Keep it secret.
- `crypto-<userId>.bin` is the key store.
- `recovery-key.txt` restores the bot identity in a new directory.
- `ids.json` keeps the Discord ids of Hachiman objects stable.

Keep the directory with the token. If you lose it, put `recovery-key.txt` in a new directory. If you lose the recovery key too, click **Reset keys** on the Bots page. The bot then gets a new identity. People in its guilds see that its key changed, and the bot cannot read its old messages.

## How it works

With an `hbot_` token, `Client.login` first starts a Hachiman client in the bot process (`@hachiman/bot`). That client decrypts and encrypts the messages. It serves the Discord API v10 on `127.0.0.1`, and discord.js connects to it. With any other token, `login` connects to Discord as before.

## What works

- Gateway: READY, guilds, channels, roles, members, messages (create, update, delete), reactions, typing, presences. Intents filter the events, and `MESSAGE_CONTENT` works as on Discord.
- REST: send, reply, edit and delete messages; reactions; read message history; typing; open a DM; read guilds, channels, roles, members and users.
- Mentions (`<@id>`, `<@&id>`, `@everyone`) work in both directions.
- Embeds show as text under the message.

## What does not work yet

The bot logs each of these one time when it uses them:

- Slash commands and other interactions. Registration succeeds but does nothing.
- File attachments, buttons and select menus.
- Voice, threads (created by the bot), webhooks, stickers, scheduled events, audit logs.
- The `zlib-sync` package: do not install it next to the bot. The local gateway does not compress.

## Build

`pnpm -F @hachiman/discord.js build:dist` writes `dist/index.mjs` and `dist/index.cjs` for plain Node 22. A publish uses them (`publishConfig`). In the workspace, the package is TypeScript source.

## Test

- `pnpm -F @hachiman/discord.js test`: a discord.js client against the bridge with a fake Hachiman runtime.
- `scripts/e2e-local.ts`: a full check against a running Hachiman stack, with two bot tokens. See the file header.
