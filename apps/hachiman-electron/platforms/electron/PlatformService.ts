import type { IPlatformService } from "@hachiman/hachiman";
import fs from "fs";

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    console.log(fs!.statSync("/"));
    return "electron";
  }
}
