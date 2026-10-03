import { E2EE_CAPABILITY } from '@hachiman/crypto/constants'
import { version } from '../../package.json'

/** The version that IDENTIFY sends (§12.13): the `version` of apps/hachiman/package.json. */
export const CLIENT_VERSION: string = version

/** The gateway capabilities of this client (§12.13). */
export const CLIENT_CAPABILITIES: readonly string[] = [E2EE_CAPABILITY]
