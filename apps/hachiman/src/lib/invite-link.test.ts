// The grammar and its malformed-key table are tested in @hachiman/client (src/invite-link.spec.ts).
// This test needs both packages: the parser must accept a key exactly when the crypto Worker
// decodes it.
import { fromB64url } from '@hachiman/crypto'
import { describe, expect, it } from 'vitest'
import { parseInviteLink } from './invite-link'

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

describe('parseInviteLink', () => {
  it('accepts a key exactly when the crypto Worker decodes it', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    for (const last of alphabet) {
      const key = `${KEY.slice(0, -1)}${last}`
      let decodes = true
      try {
        fromB64url(key)
      } catch {
        decodes = false
      }
      expect(parseInviteLink(`https://h/invite/nt0wl5x#k=${key}`)?.key ?? null, last).toBe(
        decodes ? key : null
      )
    }
  })
})
