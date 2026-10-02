/**
 * The type of the `@hachiman/crypto/ds` entry (pkgs/hachiman-crypto/src/mls/ds.ts).
 * It pins the import to the DsModule contract of api.ts, so Takusen typechecks
 * against the interface and not against one implementation.
 */
declare module '@hachiman/crypto/ds' {
  export const ds: import('@hachiman/crypto').DsModule
}
