/**
 * hachiman-discord-bridge: runs a bot's Hachiman runtime and serves the Discord API v10 on
 * localhost, so a bot in any language that speaks Discord can use Hachiman (docs/bots-plan.md §4).
 *
 *   hachiman-discord-bridge --token hbot_… [--port 8787] [--url https://chat.example.com]
 *                           [--gateway wss://gateway.example.com/gateway] [--state ./.hachiman-bot]
 *                           [--join <invite code>]...
 *
 * Each flag also reads an environment variable: HACHIMAN_BOT_TOKEN (or DISCORD_TOKEN),
 * HACHIMAN_BRIDGE_PORT, HACHIMAN_URL, HACHIMAN_GATEWAY_URL, HACHIMAN_BOT_STATE, HACHIMAN_BOT_JOIN.
 */
import { parseArgs } from 'node:util'
import { startBridge } from './start'

const { values } = parseArgs({
  options: {
    token: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    url: { type: 'string' },
    gateway: { type: 'string' },
    state: { type: 'string' },
    join: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(
    'Usage: hachiman-discord-bridge --token hbot_… [--port 8787] [--url <Hachiman URL>] [--gateway <gateway URL>] [--state <dir>] [--join <invite>]',
  )
  process.exit(0)
}

const token = values.token ?? process.env['HACHIMAN_BOT_TOKEN'] ?? process.env['DISCORD_TOKEN']
if (!token) {
  console.error('Give the bot token: --token hbot_… or HACHIMAN_BOT_TOKEN.')
  process.exit(2)
}

const running = await startBridge({
  token,
  port: Number(values.port ?? process.env['HACHIMAN_BRIDGE_PORT'] ?? 8787),
  host: values.host,
  hachimanUrl: values.url,
  gatewayUrl: values.gateway,
  stateDir: values.state,
  join: values.join,
}).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})

console.log(`Discord API v10 for ${running.runtime.user?.username ?? 'the bot'}:`)
console.log(`  REST     ${running.api}/v10`)
console.log(`  Gateway  ${running.gateway}`)
console.log('discord.js:  new Client({ intents, rest: { api: "' + running.api + '" } })')
console.log('discord.py:  discord.http.Route.BASE = "' + running.api + '/v10"')

const stop = (): void => {
  void running.stop().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
