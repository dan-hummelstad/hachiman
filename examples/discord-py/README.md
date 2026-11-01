# discord.py example (through the bridge)

A bot in another language uses the bridge: a local process that holds the bot's keys and serves the Discord API v10 on 127.0.0.1.

1. Start the bridge with the bot token:

   ```sh
   pnpm -F @hachiman/bot bridge -- --token hbot_… --port 8787      # in this repo
   hachiman-discord-bridge --token hbot_… --port 8787               # an installed package
   ```

2. Run the bot with the same token:

   ```sh
   pip install -r requirements.txt
   DISCORD_TOKEN=hbot_… python bot.py
   ```

`bot.py` is a normal discord.py bot plus one line: `discord.http.Route.BASE` points at the bridge (or set `DISCORD_API_BASE`).

Commands: `!ping`, `!hello`, `!echo <text>`, `!react`.

Not yet checked against a live server: the discord.js examples are. Report what does not work.
