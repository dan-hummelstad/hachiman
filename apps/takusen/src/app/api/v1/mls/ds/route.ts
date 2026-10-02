/**
 * GET /api/v1/mls/ds — DsInfo: the DS ExternalSender, the enabled suites, the
 * KT public key and the limits (§12.7.1, §12.12, §12.14).
 */
import { toB64 } from '@/lib/mls/bytes'
import { BACKUP_BLOB_MAX_BYTES, INBOX_ITEM_MAX_BYTES } from '@/lib/mls/config'
import { HISTORY_BUNDLE_MAX_BYTES, KEY_PACKAGE_LOW_WATER, KEY_PACKAGE_TARGET, type WireDsInfo } from '@/lib/mls/crypto'
import { ed25519PublicKey, loadOrCreateSeed } from '@/lib/mls/keys'
import { dsRoute, json } from '@/lib/mls/route'

let ktPublicKey: Uint8Array | null = null

export const GET = dsRoute('none', async (ctx) => {
  const deps = await ctx.deps()
  ktPublicKey ??= ed25519PublicKey(loadOrCreateSeed(deps.config.ktKeyPath))
  const info: WireDsInfo = {
    externalSender: toB64(deps.signer.externalSender),
    cipherSuites: deps.config.suites,
    ktPublicKey: toB64(ktPublicKey),
    limits: {
      maxEnvelopeBytes: deps.config.maxEnvelopeBytes,
      maxInboxItemBytes: INBOX_ITEM_MAX_BYTES,
      maxHistoryBundleBytes: HISTORY_BUNDLE_MAX_BYTES,
      maxBackupBlobBytes: BACKUP_BLOB_MAX_BYTES,
      keyPackageTarget: KEY_PACKAGE_TARGET,
      keyPackageLowWater: KEY_PACKAGE_LOW_WATER,
    },
  }
  return json(info)
})
