/**
 * The device names that the UI shows for other users (§12.5 "Device names"): the `display_name`
 * of each device certificate, never the REST `Device.name`.
 *
 * ponytail: this reads the certificate fields on the UI thread and does not check the signatures.
 * The names are labels only. The Worker checks every chain before a device gets keys (§12.4).
 * Replace this with a Worker call that returns checked names when @hachiman/crypto has one.
 */
import type { UserKeys } from '@hachiman/client'
import { Reader, bytesToUuid, fromB64url } from '@hachiman/crypto/codec'

export interface ContactDevice {
  deviceId: string
  /** From the certificate. */
  name: string
  issuedAt: Date
}

/** DeviceCertificateTBS fields up to display_name (§12.4), or null when it does not decode. */
export function readCertificateName(
  certificate: string
): { userId: string; deviceId: string; name: string; issuedAtMs: number } | null {
  try {
    const r = new Reader(fromB64url(certificate))
    if (r.u8() !== 1) return null
    const userId = bytesToUuid(r.fixed(16))
    const deviceId = bytesToUuid(r.fixed(16))
    if (r.opaque(32).length !== 32) return null // mls_signature_key
    r.fixed(32) // hpke_key
    r.u32() // dsk_generation
    const issuedAtMs = r.u64n()
    const name = r.utf8(64)
    r.opaque() // signature
    r.end()
    return { userId, deviceId, name, issuedAtMs }
  } catch {
    return null
  }
}

/** The active devices of `keys` with a certificate of the same user and device. */
export function contactDevices(keys: UserKeys): ContactDevice[] {
  const out: ContactDevice[] = []
  for (const d of keys.devices) {
    if (d.status !== 'active' || d.certificate === null || d.revocation !== null) continue
    const c = readCertificateName(d.certificate)
    if (!c || c.userId !== keys.userId || c.deviceId !== d.id) continue
    out.push({ deviceId: d.id, name: c.name, issuedAt: new Date(c.issuedAtMs) })
  }
  return out.sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
}
