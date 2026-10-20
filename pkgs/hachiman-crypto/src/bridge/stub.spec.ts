import { describe, expect, it } from 'vitest'

import { fromB64url } from '../codec'
import { createCryptoStub, STUB_MARKER } from './stub'

describe('createCryptoStub', () => {
  it('is ready at once and round-trips envelopes that say they are not encrypted', async () => {
    const c = createCryptoStub()
    const statuses: string[] = []
    c.on('status', (s) => statuses.push(s.state))
    expect((await c.init({ userId: 'u', wrapKey: {} as CryptoKey, platform: 'browser', clientVersion: '1.0.0', deviceName: 'p', origin: 'http://localhost' })).state).toBe('ready')
    expect(statuses).toEqual(['ready'])

    const out = await c.encryptMessage({ channelId: 'c', kind: 'message', editOf: null, content: { text: 'hi', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    expect(new TextDecoder().decode(fromB64url(out.envelope))).toContain(STUB_MARKER)
    const base = { id: 'm', channelId: 'c', guildId: null, authorId: 'u', senderDevice: null, groupId: out.groupId, epoch: 0, clientMsgId: out.clientMsgId, envelope: out.envelope, attachments: [], createdAt: '', editedAt: null }
    expect((await c.decryptMessages([base]))[0]).toMatchObject({ status: 'ok', content: { text: 'hi' }, sender: { trust: 'unknown', membershipVerified: false } })
    expect((await c.decryptMessages([{ ...base, envelope: 'AAAA' }]))[0]).toMatchObject({ status: 'failed', reason: 'malformed' })

    const edit = await c.encryptMessage({ channelId: 'c', kind: 'edit', editOf: out.clientMsgId, content: { text: 'hi!', mentions: [], attachments: [], replyTo: null, linkPreview: null } })
    expect(edit.clientMsgId).toBe(out.clientMsgId)
    expect((await c.signAdminAction('g', 1, new Uint8Array())).header.length).toBeGreaterThan(0)
    const blob = await c.decryptAttachment({ key: '', sha256: '', mime: 'text/plain', size: 2 }, new Blob(['ab']))
    expect(blob.type).toBe('text/plain')
    c.dispose()
  })
})
