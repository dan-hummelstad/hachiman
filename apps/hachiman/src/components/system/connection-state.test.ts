import { describe, expect, it } from 'vitest'
import { connectionLost } from './connection-state'

describe('connectionLost', () => {
  it('is false before the first ready', () => {
    expect(connectionLost(false, 'connecting')).toBe(false)
    expect(connectionLost(false, 'closed')).toBe(false)
  })
  it('is false while ready', () => {
    expect(connectionLost(true, 'ready')).toBe(false)
  })
  it('is true when a session that was ready reconnects or closes', () => {
    expect(connectionLost(true, 'connecting')).toBe(true)
    expect(connectionLost(true, 'resuming')).toBe(true)
    expect(connectionLost(true, 'closed')).toBe(true)
  })
  it('is false when idle (signed out)', () => {
    expect(connectionLost(true, 'idle')).toBe(false)
  })
})
