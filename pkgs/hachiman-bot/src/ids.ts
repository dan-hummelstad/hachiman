/**
 * Hachiman ids are UUIDs. Discord libraries parse ids as 64-bit snowflakes, and discord.js reads
 * the creation time from the top 42 bits (`createdTimestamp`; a ping command uses it). The bridge
 * computes each snowflake from the UUID, so an id is the same after a restart and on another
 * machine, with no file:
 *
 * - With a creation time (guilds, messages): `(createdAt − DISCORD_EPOCH) << 22 | hash22(uuid)`.
 * - Without one (users, channels, roles): 63 bits of the hash. Its date means nothing.
 *
 * The first snowflake that the bridge gives an id in a run stays for the run, and the map answers
 * the reverse lookup for the ids that the bridge gave out.
 */
// ponytail: a message whose creation time this run never saw (a delete of an old message) gets the undated form; keep a dated cache on disk if bots need those to match.
import { createHash } from 'node:crypto'

export const DISCORD_EPOCH = 1420070400000n
const INCREMENT_BITS = 22n
const INCREMENT_MASK = (1n << INCREMENT_BITS) - 1n
const UNDATED_MASK = (1n << 63n) - 1n

/** The snowflake of `ms` with `increment` in the low bits. */
export function snowflakeAt(ms: number, increment: bigint): string {
  const t = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH
  return (((t < 0n ? 0n : t) << INCREMENT_BITS) | (increment & INCREMENT_MASK)).toString()
}

function hash64(uuid: string): bigint {
  return createHash('sha256').update(uuid.toLowerCase()).digest().readBigUInt64BE(0)
}

export class IdMap {
  private toSnow = new Map<string, string>()
  private toUuid = new Map<string, string>()

  /**
   * `dateOf` gives the creation time of an id when the caller passes none (the bridge looks up
   * guilds in the cache), so that an entity gets its dated form whichever event names it first.
   */
  constructor(private readonly dateOf: (uuid: string) => string | null | undefined = () => null) {}

  /** The snowflake of a Hachiman id. `createdAt` (ISO) gives the dated form. */
  snowflake(uuid: string, createdAt?: string | null): string {
    const known = this.toSnow.get(uuid)
    if (known) return known
    const at = createdAt ?? this.dateOf(uuid)
    const ms = at ? Date.parse(at) : NaN
    const h = hash64(uuid)
    const snow = Number.isFinite(ms) ? snowflakeAt(ms, h) : (h & UNDATED_MASK).toString()
    this.toSnow.set(uuid, snow)
    this.toUuid.set(snow, uuid)
    return snow
  }

  /** The Hachiman id of a snowflake that this run gave out, else null. */
  uuid(snowflake: string): string | null {
    return this.toUuid.get(snowflake) ?? null
  }
}

/** Discord's shard of a guild: `(guild_id >> 22) % shard_count`, from the guild's dated snowflake. */
export function shardOfGuild(createdAt: string, count: number): number {
  const at = Date.parse(createdAt)
  const ms = BigInt(Number.isFinite(at) ? Math.max(0, at) : 0) - DISCORD_EPOCH
  return Number((ms < 0n ? 0n : ms) % BigInt(Math.max(1, count)))
}
