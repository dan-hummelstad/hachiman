import { useEffect, useState } from 'react'
import { oracleService, type RegionInfo } from '@/services/OracleService'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Oracle's voice regions, plus the one it recommends from the host's RTT probes. Hosts that
 * cannot probe (browser) measure nothing, so `recommended` stays null there.
 */
export function useRecommendedRegion(): { regions: RegionInfo[]; recommended: RegionInfo | null } {
  const platform = usePlatform()
  const [regions, setRegions] = useState<RegionInfo[]>([])
  const [recommendedCode, setRecommendedCode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const list = await oracleService.listRegions()
      if (cancelled) return
      setRegions(list)
      const targets = list.flatMap((r) =>
        r.probeHost ? [{ region: r.code, host: r.probeHost, port: r.probePort }] : []
      )
      const measured = targets.length > 0 ? await platform.probeRegions(targets) : []
      if (cancelled || measured.length === 0) return
      const rec = await oracleService.recommendRegion(measured)
      if (!cancelled) setRecommendedCode(rec?.recommended ?? null)
    }
    load().catch((e) => console.warn('[regions] could not load or rank regions', e))
    return () => {
      cancelled = true
    }
  }, [platform])

  return { regions, recommended: regions.find((r) => r.code === recommendedCode) ?? null }
}
