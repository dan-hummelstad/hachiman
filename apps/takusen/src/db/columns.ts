import { customType } from 'drizzle-orm/pg-core'

/** Postgres bytea as Uint8Array. The §12 binary objects are stored as they are. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v),
})
