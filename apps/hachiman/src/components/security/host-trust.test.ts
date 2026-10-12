import { describe, expect, it } from 'vitest'
import type { DeviceSummary } from '@hachiman/crypto'
import { webTrustTitle } from './host-trust'

type Device = Pick<DeviceSummary, 'platform' | 'status' | 'current'>

const phone: Device = { platform: 'ios', status: 'active', current: true }
const desktop: Device = { platform: 'electron', status: 'active', current: false }
const web: Device = { platform: 'browser', status: 'active', current: false }

describe('webTrustTitle', () => {
  it('warns about this browser first', () => {
    expect(webTrustTitle('server_code', null)).toBe('This browser trusts the server’s code')
    expect(webTrustTitle('server_code', [{ ...web, current: true }, web])).toBe(
      'This browser trusts the server’s code'
    )
  })

  it('warns about another browser device of the account', () => {
    expect(webTrustTitle('strong', [phone, desktop, web])).toBe(
      'Your web session trusts the server’s code'
    )
    expect(webTrustTitle('strong', [phone, web, { ...web, status: 'pending' }])).toBe(
      'Your web sessions trust the server’s code'
    )
  })

  it('leaves out signed-out browsers and apps that run their own code', () => {
    expect(webTrustTitle('strong', [phone, desktop])).toBeNull()
    expect(webTrustTitle('strong', [phone, { ...web, status: 'revoked' }])).toBeNull()
    expect(webTrustTitle('strong', null)).toBeNull()
    expect(webTrustTitle(null, [])).toBeNull()
  })
})
