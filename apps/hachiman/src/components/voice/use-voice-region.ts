import { useEffect, useState } from 'react'
import { takusenService, type RegionInfo } from '@/services/TakusenService'
import { useGuildStore } from '@/stores/guildStore'

let regionList: Promise<RegionInfo[]> | null = null

/** Takusen's region list, loaded once per app run. A failed load is retried on the next call. */
function loadRegions(): Promise<RegionInfo[]> {
  regionList ??= takusenService.listRegions().catch((e: unknown) => {
    regionList = null
    throw e
  })
  return regionList
}

/**
 * The display name of the guild's voice region ("Europe (West)"), the region code while the list
 * loads or when it has no entry, and null when the guild picks the region automatically.
 */
export function useVoiceRegionName(guildId: string): string | null {
  const code = useGuildStore((s) => s.guilds.get(guildId)?.region ?? null)
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null)

  useEffect(() => {
    if (code === null) return
    let live = true
    loadRegions().then(
      (list) => live && setNames(new Map(list.map((r) => [r.code, r.displayName]))),
      (e: unknown) => console.warn('[voice] could not load the region list', e)
    )
    return () => {
      live = false
    }
  }, [code])

  if (code === null) return null
  return names?.get(code) ?? code
}
