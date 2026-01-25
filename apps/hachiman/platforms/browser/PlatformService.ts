import type { IPlatformService } from '@/shared/IPlatformService'

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    return Promise.resolve('browser')
  }
}
