# discord.js example (drop-in)

`bot.js` is a plain discord.js v14 bot. It runs on Hachiman because the package named `discord.js` is `@hachiman/discord.js`:

```json
"dependencies": { "discord.js": "npm:@hachiman/discord.js@^0.1.0" }
```

(In this repo, `package.json` uses the workspace form of that alias.) Then give it a Hachiman bot token:

```sh
DISCORD_TOKEN=hbot_… pnpm -F @hachiman/example-discord-js start     # in this repo
DISCORD_TOKEN=hbot_… node bot.js                                     # an installed package
```

Commands: `!ping`, `!hello`, `!echo <text>`, `!react`, `!embed`, `!countdown`, `!history`, `!dm`, `!whoami`.

What works and what does not yet (slash commands, attachments, buttons, voice): `pkgs/hachiman-discord.js/README.md`.
