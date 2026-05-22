import type { IPlatformService } from '@hachiman/hachiman'

export class PlatformService implements IPlatformService {
  async getPlatform(): Promise<string> {
    return Promise.resolve('browser')
  }
}
