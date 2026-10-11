import { describe, expect, it } from 'vitest'
import { phaseOf } from './voice-phase'

describe('phaseOf', () => {
  it('is connected only when the peer connection is', () => {
    expect(phaseOf('connected')).toBe('connected')
  })

  it('is lost when the connection failed or dropped', () => {
    expect(phaseOf('failed')).toBe('lost')
    expect(phaseOf('disconnected')).toBe('lost')
  })

  it('is connecting while the call sets up or idles', () => {
    expect(phaseOf('new')).toBe('connecting')
    expect(phaseOf('connecting')).toBe('connecting')
    expect(phaseOf('idle')).toBe('connecting')
    expect(phaseOf('closed')).toBe('connecting')
  })
})
