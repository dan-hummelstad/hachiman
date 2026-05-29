import type { RegionProbeResult, RegionProbeTarget } from '@hachiman/hachiman-node'

export interface IPlatformService {
  getPlatform(): Promise<string>

  /**
   * Measure client→region round-trip latency for each target and return the
   * results in target order. Only hosts that can open raw sockets implement a
   * real probe (the Electron host relays `probeRegionsRtt` from
   * `@hachiman/hachiman-node` over IPC); the browser host returns `[]` because
   * browsers cannot open raw TCP/UDP sockets. Callers treat an empty result as
   * "no measurement available" and fall back to the honest, number-free hint.
   */
  probeRegions(targets: RegionProbeTarget[]): Promise<RegionProbeResult[]>
}
