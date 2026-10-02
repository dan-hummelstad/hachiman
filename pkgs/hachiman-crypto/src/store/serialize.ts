/**
 * The deterministic record encoding of the store (docs/gateway-protocol.md §12.17), before the seal.
 *
 * JSON with sorted object keys. A Uint8Array becomes { "$b": base64url }. Only plain data is
 * accepted: null, booleans, finite numbers, strings, Uint8Array, arrays and plain objects.
 * Object fields that are undefined are left out (as structuredClone keeps them absent on read).
 * Anything else (Map, Set, Date, bigint, class instances) throws, so no value is lost silently.
 */
import { CryptoError } from '../api'
import { fromB64url, toB64url } from '../codec'

const BYTES = '$b'
const MAX_DEPTH = 64

function isUint8Array(v: unknown): v is Uint8Array {
  return ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]'
}

/** Own data property, also for a key named __proto__. */
function setField(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true })
}

function toJson(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CryptoError('Malformed', 'store: value nests too deep')
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new CryptoError('Malformed', 'store: non-finite number')
    return v
  }
  if (isUint8Array(v)) return { [BYTES]: toB64url(v) }
  if (Array.isArray(v)) {
    return v.map((x: unknown) => {
      if (x === undefined) throw new CryptoError('Malformed', 'store: undefined in an array')
      return toJson(x, depth + 1)
    })
  }
  if (typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) throw new CryptoError('Malformed', `store: unsupported value ${Object.prototype.toString.call(v)}`)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      if (k === BYTES) throw new CryptoError('Malformed', `store: the key ${BYTES} is reserved`)
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) setField(out, k, toJson(x, depth + 1))
    }
    return out
  }
  throw new CryptoError('Malformed', `store: unsupported value of type ${typeof v}`)
}

function fromJson(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CryptoError('StoreCorrupt', 'store: record nests too deep')
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x: unknown) => fromJson(x, depth + 1))
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.includes(BYTES)) {
    const b = o[BYTES]
    if (keys.length !== 1 || typeof b !== 'string') throw new CryptoError('StoreCorrupt', 'store: bad bytes field')
    return fromB64url(b)
  }
  const out: Record<string, unknown> = {}
  for (const k of keys) setField(out, k, fromJson(o[k], depth + 1))
  return out
}

export function serializeValue(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(toJson(v, 0)))
}

export function deserializeValue(b: Uint8Array): unknown {
  try {
    return fromJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)), 0)
  } catch (e) {
    if (e instanceof CryptoError) throw e
    throw new CryptoError('StoreCorrupt', 'store: record does not decode')
  }
}
