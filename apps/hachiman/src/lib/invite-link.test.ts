import { fromB64url } from '@hachiman/crypto'
import { describe, expect, it } from 'vitest'
import { parseInviteCode, parseInviteLink } from './invite-link'

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

describe('parseInviteLink', () => {
  it('reads the three forms without a key', () => {
    expect(parseInviteLink('nt0wl5x')).toEqual({ code: 'nt0wl5x', key: null })
    expect(parseInviteLink('takusen://invite/nt0wl5x')).toEqual({ code: 'nt0wl5x', key: null })
    expect(parseInviteLink('https://takusen.example/invite/nt0wl5x')).toEqual({
      code: 'nt0wl5x',
      key: null
    })
    expect(parseInviteLink('  http://localhost:3000/invite/nt0wl5x/  ')).toEqual({
      code: 'nt0wl5x',
      key: null
    })
  })

  it('reads the key of an invite with history', () => {
    expect(parseInviteLink(`https://takusen.example/invite/nt0wl5x#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY
    })
    expect(parseInviteLink(`takusen://invite/nt0wl5x/#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY
    })
    expect(parseInviteLink(`http://localhost:5173/invite/nt0wl5x?preview#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY
    })
  })

  it('ignores a query and an empty fragment', () => {
    expect(parseInviteLink('https://h/invite/nt0wl5x?preview')).toEqual({
      code: 'nt0wl5x',
      key: null
    })
    expect(parseInviteLink('https://h/invite/nt0wl5x#')).toEqual({ code: 'nt0wl5x', key: null })
  })

  it('fails closed on a malformed key or another fragment', () => {
    for (const fragment of [
      'k=',
      `k=${KEY.slice(1)}`,
      `k=${KEY}A`,
      // Non-canonical: the last character has bits that 32 bytes do not use.
      `k=${KEY.slice(0, -1)}B`,
      `k=${KEY.slice(0, -1)}_`,
      `k=${KEY.slice(1)}+`,
      `k=${KEY.slice(1)}=`,
      `k=${KEY}&k=${KEY}`,
      `x=1&k=${KEY}`,
      `K=${KEY}`,
      'section'
    ]) {
      expect(parseInviteLink(`https://h/invite/nt0wl5x#${fragment}`)).toBeNull()
    }
  })

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

  it('rejects other input', () => {
    for (const s of [
      '',
      'a',
      'bad code',
      `nt0wl5x#k=${KEY}`,
      'https://h/other/nt0wl5x',
      'https://h/invite/',
      'ftp://h/invite/nt0wl5x',
      'https://h/invite/nt0wl5x/extra'
    ]) {
      expect(parseInviteLink(s)).toBeNull()
    }
  })
})

describe('parseInviteCode', () => {
  it('is the code of parseInviteLink', () => {
    expect(parseInviteCode(`https://h/invite/nt0wl5x#k=${KEY}`)).toBe('nt0wl5x')
    expect(parseInviteCode('https://h/invite/nt0wl5x#k=bad')).toBeNull()
  })
})
