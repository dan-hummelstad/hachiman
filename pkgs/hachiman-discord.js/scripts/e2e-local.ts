/**
 * End-to-end check against a running Hachiman stack (Takusen, its gRPC process, the gateway):
 * bot A (a raw @hachiman/bot runtime) makes a guild and an invite; bot B is an ordinary discord.js
 * bot through this package, configured by environment only. A sends "!ping" until it decrypts B's
 * "pong". Make two bots on the dashboard (/bots) first.
 *
 *   HACHIMAN_E2E_TOKEN_A=hbot_… HACHIMAN_E2E_TOKEN_B=hbot_… \
 *     node --import ../hachiman-bot/node_modules/tsx/dist/loader.mjs scripts/e2e-local.ts
 *
 * HACHIMAN_URL and HACHIMAN_GATEWAY_URL default to the local dev stack.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRuntime } from '@hachiman/bot'

const tokenA = process.env['HACHIMAN_E2E_TOKEN_A']
const tokenB = process.env['HACHIMAN_E2E_TOKEN_B']
if (!tokenA || !tokenB) throw new Error('Set HACHIMAN_E2E_TOKEN_A and HACHIMAN_E2E_TOKEN_B (two bot tokens).')
const origin = process.env['HACHIMAN_URL'] ?? 'http://localhost:3000'
const gatewayUrl = process.env['HACHIMAN_GATEWAY_URL'] ?? 'ws://localhost:8080/gateway'
const deadline = setTimeout(() => {
  console.log('E2E TIMEOUT')
  process.exit(1)
}, 150_000)

const a = new BotRuntime({
  token: tokenA,
  apiUrl: `${origin}/api/v1`,
  gatewayUrl,
  stateDir: await mkdtemp(join(tmpdir(), 'hachiman-e2e-a-')),
  log: () => {},
})
const meA = await a.start()
const guild = await a.client.rest.createGuild({ name: 'discord.js e2e' })
const text = guild.channels.find(c => c.type === 'text')
if (!text) throw new Error('the new guild has no text channel')
const invite = await a.client.rest.createInvite(guild.id, {})

// ---- Bot B: the bot code as written for Discord. Only the environment differs. ----
process.env['HACHIMAN_BOT_STATE'] = await mkdtemp(join(tmpdir(), 'hachiman-e2e-b-'))
process.env['HACHIMAN_BOT_JOIN'] = invite.code
process.env['DISCORD_TOKEN'] = tokenB
const { Client, Events, GatewayIntentBits } = await import('../src/index')
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})
client.on(Events.MessageCreate, async message => {
  if (message.content === '!ping') await message.reply('pong')
})
await client.login(process.env['DISCORD_TOKEN'])
// ---- end of bot B ----

let done = false
a.on('message', m => {
  if (m.author.id !== meA.id && m.content === 'pong') done = true
})
for (let i = 0; !done && i < 40; i++) {
  await a.send(text.id, { text: '!ping' }).catch(() => undefined)
  await new Promise(r => setTimeout(r, 3000))
}
clearTimeout(deadline)
console.log(done ? 'E2E OK: discord.js answered an E2EE message on Hachiman' : 'E2E FAILED')
await client.destroy()
await a.client.rest.deleteGuild(guild.id).catch(() => undefined)
a.stop()
process.exit(done ? 0 : 1)
