import type { IPlatformService } from "@hachiman/hachiman";
import type {
  RegionProbeResult,
  RegionProbeTarget,
} from "@hachiman/hachiman-node";

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    return Promise.resolve("browser");
  }

  /**
   * Browsers cannot open raw TCP/UDP sockets, so there is no honest way to
   * measure client→region RTT here. Return an empty result; the UI treats that
   * as "not measured" and keeps the auto-placed/number-free hint. (A future
   * browser probe would have to go through a WebSocket/HTTP handshake to a
   * per-region endpoint — out of scope; see the prober's doc comment.)
   */
  async probeRegions(
    _targets: RegionProbeTarget[],
  ): Promise<RegionProbeResult[]> {
    return Promise.resolve([]);
  }
}
