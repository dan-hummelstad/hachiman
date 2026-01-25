import type { IPlatformService } from '@/shared/IPlatformService'
import fs from 'fs'

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    console.log(fs!.statSync('/'))
    return 'electron'
  }
}
