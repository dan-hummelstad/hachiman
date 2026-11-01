/**
 * Hachiman ids are UUIDs. Discord libraries parse ids as 64-bit snowflakes: discord.js reads the
 * creation time from the top 42 bits with BigInt. The bridge gives each Hachiman id one snowflake
 * and keeps the pair for ever in `ids.json` of the state directory, so an id stays the same across
 * restarts. A new snowflake carries the creation time of the entity when the bridge knows it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DISCORD_EPOCH = 1420070400000n
const INCREMENT_BITS = 22n
const INCREMENT_MASK = (1n << INCREMENT_BITS) - 1n

/** The snowflake of `ms` with `increment` in the low bits. */
export function snowflakeAt(ms: number, increment: bigint): string {
  const t = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH
  return (((t < 0n ? 0n : t) << INCREMENT_BITS) | (increment & INCREMENT_MASK)).toString()
}

export class IdMap {
  private toSnow = new Map<string, string>()
  private toUuid = new Map<string, string>()
  private increment = 0n
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `dir` null: in memory only (tests). */
  constructor(private readonly dir: string | null) {
    if (!dir) return
    let raw: Record<string, string> = {}
    try {
      raw = JSON.parse(readFileSync(join(dir, 'ids.json'), 'utf8')) as Record<string, string>
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    for (const [uuid, snow] of Object.entries(raw)) this.set(uuid, snow)
  }

  private set(uuid: string, snow: string): void {
    this.toSnow.set(uuid, snow)
    this.toUuid.set(snow, uuid)
  }

  /** The snowflake of a Hachiman id. `createdAt` (ISO) dates a new one; else now. */
  snowflake(uuid: string, createdAt?: string | null): string {
    const known = this.toSnow.get(uuid)
    if (known) return known
    const ms = createdAt ? Date.parse(createdAt) : NaN
    let snow: string
    do snow = snowflakeAt(Number.isFinite(ms) ? ms : Date.now(), this.increment++)
    while (this.toUuid.has(snow))
    this.set(uuid, snow)
    this.save()
    return snow
  }

  /** The Hachiman id of a snowflake, or null when the bridge never gave it out. */
  uuid(snowflake: string): string | null {
    return this.toUuid.get(snowflake) ?? null
  }

  private save(): void {
    if (!this.dir || this.timer) return
    this.timer = setTimeout(() => this.flush(), 200)
  }

  /** Writes the map now (on shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dir) return
    const path = join(this.dir, 'ids.json')
    writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(this.toSnow)), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}
