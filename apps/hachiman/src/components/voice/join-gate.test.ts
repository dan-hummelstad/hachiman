import { describe, expect, it } from 'vitest'
import { canJoinVoice } from './join-gate'

describe('canJoinVoice', () => {
  it('needs CONNECT', () => {
    expect(canJoinVoice(false, 'none')).toBe(false)
    expect(canJoinVoice(true, 'none')).toBe(true)
  })

  it('blocks a join while the client must update or rejoins after 4013', () => {
    expect(canJoinVoice(true, 'update_required')).toBe(false)
    expect(canJoinVoice(true, 'resyncing')).toBe(false)
  })

  it('allows a join from another call and after failed rejoins', () => {
    expect(canJoinVoice(true, 'secure')).toBe(true)
    expect(canJoinVoice(true, 'securing')).toBe(true)
    expect(canJoinVoice(true, 'resync_failed')).toBe(true)
  })
})
