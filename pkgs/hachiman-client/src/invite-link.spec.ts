import { describe, expect, it } from 'vitest'
import { inviteKeyFragment, parseInviteCode, parseInviteKeyFragment, parseInviteLink } from './invite-link'

/** The seed 0x00, 0x01, … 0x1f in base64url (§12.11.4 test vector). */
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

/** Fragments (without `#`) that are not a well-formed key: every parser of the grammar refuses them. */
const MALFORMED_FRAGMENTS = [
  'k=',
  `k=${KEY.slice(1)}`,
  `k=${KEY}A`,
  // Non-canonical: the last character has bits that 32 bytes do not use.
  `k=${KEY.slice(0, -1)}B`,
  `k=${KEY.slice(0, -1)}_`,
  `k=${KEY.slice(1)}+`,
  `k=${KEY.slice(1)}=`,
  `k=${KEY.slice(1)}%`,
  `k=${KEY}&k=${KEY}`,
  `k=${KEY}&x=1`,
  `x=1&k=${KEY}`,
  `K=${KEY}`,
  `#k=${KEY}`,
  'section',
]

describe('parseInviteKeyFragment', () => {
  it('reads no key from an empty fragment and the key from k=<seed>', () => {
    expect(parseInviteKeyFragment('')).toEqual({ key: null })
    expect(parseInviteKeyFragment(`k=${KEY}`)).toEqual({ key: KEY })
  })

  it('fails closed on any other fragment', () => {
    for (const fragment of MALFORMED_FRAGMENTS) {
      expect(parseInviteKeyFragment(fragment), fragment).toBeNull()
    }
  })
})

describe('inviteKeyFragment', () => {
  it('writes the fragment that parseInviteLink reads', () => {
    expect(inviteKeyFragment(KEY)).toBe(`#k=${KEY}`)
    expect(parseInviteLink(`https://h/invite/nt0wl5x${inviteKeyFragment(KEY)}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY,
    })
  })
})

describe('parseInviteLink', () => {
  it('reads the three forms without a key', () => {
    expect(parseInviteLink('nt0wl5x')).toEqual({ code: 'nt0wl5x', key: null })
    expect(parseInviteLink('takusen://invite/nt0wl5x')).toEqual({ code: 'nt0wl5x', key: null })
    expect(parseInviteLink('https://takusen.example/invite/nt0wl5x')).toEqual({
      code: 'nt0wl5x',
      key: null,
    })
    expect(parseInviteLink('  http://localhost:3000/invite/nt0wl5x/  ')).toEqual({
      code: 'nt0wl5x',
      key: null,
    })
  })

  it('reads the key of an invite with history', () => {
    expect(parseInviteLink(`https://takusen.example/invite/nt0wl5x#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY,
    })
    expect(parseInviteLink(`takusen://invite/nt0wl5x/#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY,
    })
    expect(parseInviteLink(`http://localhost:5173/invite/nt0wl5x?preview#k=${KEY}`)).toEqual({
      code: 'nt0wl5x',
      key: KEY,
    })
  })

  it('ignores a query and an empty fragment', () => {
    expect(parseInviteLink('https://h/invite/nt0wl5x?preview')).toEqual({
      code: 'nt0wl5x',
      key: null,
    })
    expect(parseInviteLink('https://h/invite/nt0wl5x#')).toEqual({ code: 'nt0wl5x', key: null })
  })

  it('fails closed on a malformed key or another fragment', () => {
    for (const fragment of MALFORMED_FRAGMENTS) {
      expect(parseInviteLink(`https://h/invite/nt0wl5x#${fragment}`), fragment).toBeNull()
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
      'https://h/invite/nt0wl5x/extra',
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
