/**
 * One call that runs a bot: the runtime (Hachiman, E2EE) and the Discord bridge on localhost.
 * The CLI and `@hachiman/discord.js` both use it.
 */
import { join } from 'node:path'
import { DiscordBridge } from './discord/bridge'
import { IdMap } from './ids'
import { BotRuntime } from './runtime'

export interface StartBridgeOptions {
  /** The bot token (`hbot_…`). */
  token: string
  /** Takusen origin. Default: `HACHIMAN_URL`, else the server that the token names, else http://localhost:3000. */
  hachimanUrl?: string | undefined
  /** Default: `HACHIMAN_GATEWAY_URL`, else what the server names (`GET /api/v1/gateway`). */
  gatewayUrl?: string | undefined
  /** Default `HACHIMAN_BOT_STATE`, else `./.hachiman-bot`. */
  stateDir?: string | undefined
  /** Bridge port. Default 0 (any free port). */
  port?: number | undefined
  host?: string | undefined
  /**
   * Discord sharding: the shards that this process serves. Default: `SHARDS` and `SHARD_COUNT`,
   * which discord.js ShardingManager sets for each shard process. Each shard is its own device,
   * in `<stateDir>/shard-<ids>`, and links to the others with the shared deployment key.
   */
  shard?: { ids: number[]; count: number } | undefined
  /** Invite codes to redeem on start. Default `HACHIMAN_BOT_JOIN` (comma separated). */
  join?: string[] | undefined
  log?: ((msg: string) => void) | undefined
}

export interface RunningBridge {
  runtime: BotRuntime
  bridge: DiscordBridge
  /** The REST base for a Discord client (discord.js `rest.api`). */
  api: string
  gateway: string
  stop(): Promise<void>
}

const env = (name: string): string | undefined => {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

/** The server that a token names (`hbot_<base64url origin>.h1.<secret>`), or null. */
export function tokenOrigin(token: string): string | null {
  const m = /^hbot_([A-Za-z0-9_-]+)\.h1\./.exec(token)
  if (!m?.[1]) return null
  try {
    const url = new URL(Buffer.from(m[1], 'base64url').toString('utf8'))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/** The gateway that the server names (contract §4 Gateway discovery). */
async function discoverGateway(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/gateway`)
  if (!res.ok)
    throw new Error(
      `${origin} does not name its gateway (GET /api/v1/gateway: ${res.status}). Set HACHIMAN_GATEWAY_URL.`,
    )
  const { url } = (await res.json()) as { url?: unknown }
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url))
    throw new Error(`${origin} names no valid gateway. Set HACHIMAN_GATEWAY_URL.`)
  return url
}

/** discord.js ShardingManager passes `SHARDS` (a JSON number or array) and `SHARD_COUNT`. */
function shardFromEnv(): { ids: number[]; count: number } | undefined {
  const shards = env('SHARDS')
  const count = Number(env('SHARD_COUNT'))
  if (!shards || !Number.isInteger(count) || count < 1) return undefined
  const parsed = JSON.parse(shards) as unknown
  const ids = (Array.isArray(parsed) ? parsed : [parsed])
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0 && n < count)
  return ids.length > 0 ? { ids, count } : undefined
}

export async function startBridge(opts: StartBridgeOptions): Promise<RunningBridge> {
  const token = opts.token.replace(/^Bot\s+/i, '').trim()
  if (!token.startsWith('hbot_'))
    throw new Error(
      'This is not a Hachiman bot token (hbot_…). Make one on the Bots page of your Hachiman server.',
    )
  const origin = (
    opts.hachimanUrl ??
    env('HACHIMAN_URL') ??
    tokenOrigin(token) ??
    'http://localhost:3000'
  ).replace(/\/+$/, '')
  const gatewayUrl = opts.gatewayUrl ?? env('HACHIMAN_GATEWAY_URL') ?? (await discoverGateway(origin))
  const baseDir = opts.stateDir ?? env('HACHIMAN_BOT_STATE') ?? join(process.cwd(), '.hachiman-bot')
  const shard = opts.shard ?? shardFromEnv()
  const stateDir = shard ? join(baseDir, `shard-${shard.ids.join('-')}`) : baseDir
  const joinCodes =
    opts.join ??
    env('HACHIMAN_BOT_JOIN')
      ?.split(',')
      .map(s => s.trim())
      .filter(Boolean) ??
    []
  const runtime = new BotRuntime({
    token,
    apiUrl: `${origin}/api/v1`,
    gatewayUrl,
    stateDir,
    deploymentDir: baseDir,
    ...(shard ? { shard } : {}),
    join: joinCodes,
    ...(opts.log ? { log: opts.log } : {}),
  })
  const ids = new IdMap(id => runtime.cache.guilds.get(id)?.createdAt)
  await runtime.start()
  const bridge = new DiscordBridge({
    runtime,
    ids,
    token,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  const urls = await bridge.listen()
  return {
    runtime,
    bridge,
    api: urls.api,
    gateway: urls.gateway,
    async stop() {
      runtime.stop()
      await bridge.close()
    },
  }
}
