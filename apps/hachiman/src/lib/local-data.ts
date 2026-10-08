import { cryptoService } from '@/services/CryptoService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { TAKUSEN_STORAGE_KEY } from '@/stores/takusenStore'

/**
 * Developer helpers of User settings → Advanced. Both reload the app when they are done, so no
 * store writes the old state back.
 */

/** UI prefs and caches: localStorage except the sign-in, sessionStorage and Cache Storage. */
export async function clearCachedData(): Promise<void> {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key !== null && key !== TAKUSEN_STORAGE_KEY) localStorage.removeItem(key)
  }
  sessionStorage.clear()
  await clearCacheStorage()
  location.reload()
}

/**
 * Everything this device holds: the E2EE store and its wrap key, every IndexedDB database, Cache
 * Storage, localStorage (incl. the sign-in) and sessionStorage. The crypto Worker stops first, so
 * its Web Lock and open database do not block the delete.
 */
export async function resetDevice(
  platform: IPlatformService,
  userId: string | null
): Promise<void> {
  cryptoService.stop()
  // No OS keystore: there is no wrap key to delete, and the rest of the reset still runs.
  if (userId)
    await platform.secureStorage
      .clear(userId)
      .catch((e: unknown) => console.warn('[reset] could not clear the wrap key', e))
  if (typeof indexedDB !== 'undefined' && 'databases' in indexedDB) {
    const dbs = await indexedDB.databases()
    await Promise.all(dbs.flatMap((db) => (db.name ? [deleteDatabase(db.name)] : [])))
  }
  await clearCacheStorage()
  localStorage.clear()
  sessionStorage.clear()
  location.reload()
}

async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return
  const names = await caches.keys()
  await Promise.all(names.map((n) => caches.delete(n)))
}

/**
 * Resolves once the database is gone, or once a connection that is still open blocks it: the
 * delete then finishes when that connection closes (at the latest on reload).
 */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onblocked = () => resolve()
    req.onerror = () => reject(req.error ?? new Error(`could not delete ${name}`))
  })
}
