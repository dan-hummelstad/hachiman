import { describe, expect, it } from 'vitest'

import { CryptoError, type CryptoEvents } from './api'
import { dsCodeOf, isTransient, reportError } from './errors'

describe('DS error helpers', () => {
  it('reads only a string dsCode', () => {
    expect(dsCodeOf(Object.assign(new Error('x'), { dsCode: 'NotFound' }))).toBe('NotFound')
    expect(dsCodeOf(new CryptoError('Transport', 'x', 'HandshakesExpired'))).toBe('HandshakesExpired')
    expect(dsCodeOf({ dsCode: 7 })).toBeUndefined()
    expect(dsCodeOf(new Error('x'))).toBeUndefined()
    expect(dsCodeOf(null)).toBeUndefined()
    expect(dsCodeOf('NotFound')).toBeUndefined()
  })

  it('takes a DS code or a Transport CryptoError as transient', () => {
    expect(isTransient({ dsCode: 'Conflict' })).toBe(true)
    expect(isTransient(new CryptoError('Transport', 'offline'))).toBe(true)
    expect(isTransient(new CryptoError('InvalidChain', 'bad'))).toBe(false)
    expect(isTransient(new Error('Transport'))).toBe(false)
  })

  it('emits a CryptoError with its code, any other error as Transport', () => {
    const events: CryptoEvents['error'][] = []
    const ctx = {
      emit<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void {
        if (event === 'error') events.push(payload as CryptoEvents['error'])
      },
    }
    reportError(ctx, new CryptoError('InvalidChain', 'bad chain'))
    reportError(ctx, Object.assign(new Error('refused'), { dsCode: 'IllegalAdd' }))
    reportError(ctx, 'plain')
    expect(events).toEqual([
      { code: 'InvalidChain', message: 'bad chain', dsCode: undefined },
      { code: 'Transport', message: 'refused', dsCode: 'IllegalAdd' },
      { code: 'Transport', message: 'plain', dsCode: undefined },
    ])
  })
})
