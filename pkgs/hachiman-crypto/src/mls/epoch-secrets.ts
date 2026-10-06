/**
 * The `epochSecrets` table (docs/gateway-protocol.md §12.11.1). Every write to the table goes
 * through this module, so the rule of §12.11.1 is in one place:
 * - A secret from the MLS state replaces a stored secret that differs.
 * - An import never replaces a stored secret.
 * - A row is flagged backed up only when its secret did not change.
 *
 * Each write is one transaction on ['epochSecrets'], so no other write runs between its read and
 * its write. GroupService and IdentityService write through the module, and InviteService reads
 * the secrets of its bundles with it. It depends on no service.
 */
import type { CryptoStore, EngineContext, HistoryKeyEntry } from '../api'
import { toB64url } from '../codec'
import { equalBytes } from '../identity/bytes'

/**
 * Up to this many epochs, a range read gets each row by its key. A list of the group opens every
 * row of the group, and each row is one AES-GCM open.
 */
const SHORT_GAP = 64

/** The row key: the base64url group id and the epoch. Stored rows use it, so it does not change. */
export const epochSecretKey = (gid: string, epoch: number): string => `${gid}:${epoch}`

/**
 * Stores the secret of an epoch that this device holds the MLS state of. It replaces a stored
 * secret that differs (any member can sign an invite bundle, §12.11.4), and the new row is not
 * backed up. Returns true when it replaced a stored secret.
 */
export async function putEpochSecretFromState(store: CryptoStore, gid: string, groupId: Uint8Array, epoch: number, secret: Uint8Array): Promise<boolean> {
  const key = epochSecretKey(gid, epoch)
  return store.transaction(['epochSecrets'], async (tx) => {
    const old = await tx.get('epochSecrets', key)
    if (old !== undefined && equalBytes(old.secret, secret)) return false
    await tx.put('epochSecrets', key, { groupId, epoch, secret, backedUp: false })
    return old !== undefined
  })
}

/**
 * Stores the imported secrets that this device lacks. It never replaces a stored secret. After the
 * commit, it emits epochKeysAvailable once per group with the added epochs, ascending, so the
 * messages that wait on them decrypt again.
 */
export async function importEpochSecrets(ctx: EngineContext, entries: readonly HistoryKeyEntry[], backedUp: boolean): Promise<void> {
  if (entries.length === 0) return
  const added = new Map<string, number[]>()
  await ctx.store.transaction(['epochSecrets'], async (tx) => {
    for (const e of entries) {
      const gid = toB64url(e.groupId)
      const key = epochSecretKey(gid, e.epoch)
      if ((await tx.get('epochSecrets', key)) !== undefined) continue
      await tx.put('epochSecrets', key, { groupId: e.groupId, epoch: e.epoch, secret: e.secret, backedUp })
      const list = added.get(gid) ?? []
      list.push(e.epoch)
      added.set(gid, list)
    }
  })
  for (const [groupId, epochs] of added) ctx.emit('epochKeysAvailable', { groupId, epochs: epochs.sort((a, b) => a - b) })
}

/**
 * Flags the uploaded secrets as backed up. A row whose secret changed during the upload
 * (putEpochSecretFromState) keeps `backedUp` false, so the next backup uploads the new secret.
 */
export async function markEpochSecretsBackedUp(store: CryptoStore, entries: readonly HistoryKeyEntry[]): Promise<void> {
  await store.transaction(['epochSecrets'], async (tx) => {
    for (const e of entries) {
      const key = epochSecretKey(toB64url(e.groupId), e.epoch)
      const row = await tx.get('epochSecrets', key)
      if (row === undefined || row.backedUp || !equalBytes(row.secret, e.secret)) continue
      await tx.put('epochSecrets', key, { ...row, backedUp: true })
    }
  })
}

/** The stored secrets of the epochs `from` to `to` of a group, ascending. */
export async function storedEpochSecrets(store: CryptoStore, gid: string, from: number, to: number): Promise<HistoryKeyEntry[]> {
  if (to - from < SHORT_GAP) {
    const out: HistoryKeyEntry[] = []
    for (let e = from; e <= to; e++) {
      const row = await store.get('epochSecrets', epochSecretKey(gid, e))
      if (row !== undefined) out.push({ groupId: row.groupId, epoch: row.epoch, secret: row.secret })
    }
    return out
  }
  return (await store.list('epochSecrets', `${gid}:`))
    .map(({ value }) => ({ groupId: value.groupId, epoch: value.epoch, secret: value.secret }))
    .filter((k) => k.epoch >= from && k.epoch <= to)
    .sort((a, b) => a.epoch - b.epoch)
}
