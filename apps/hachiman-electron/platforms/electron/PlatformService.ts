import type { IPlatformService } from "@hachiman/hachiman";
import type {
  RegionProbeResult,
  RegionProbeTarget,
} from "@hachiman/hachiman-node";
import fs from "fs";

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    console.log(fs!.statSync("/"));
    return "electron";
  }

  /**
   * Relay region-latency probing to the main process, where raw node sockets
   * live (the prober can't run in the sandboxed renderer). The preload bridge
   * exposes `window.api.probeRegions`; if it's somehow absent we degrade to the
   * honest "no measurement" empty result rather than throwing.
   */
  async probeRegions(
    targets: RegionProbeTarget[],
  ): Promise<RegionProbeResult[]> {
    const api = window.api;
    if (!api) return [];
    return api.probeRegions(targets);
  }
}
