import { describe, expect, it } from 'vitest'
import type { Message } from '@hachiman/client'
import type { DecryptResult, EncryptedMessage, MessageContent } from '@hachiman/crypto'
import type { ChatMessage } from '@/stores/messagesStore'
import { createMessageDecryptor, toEncrypted, type MessageDecryptor } from './message-decrypt'

const author = { id: 'u-1', username: 'alice', avatar: null }

function wire(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId: 'c-1',
    guildId: 'g-1',
    author,
    senderDevice: 'd-1',
    groupId: 'grp-1',
    epoch: 4,
    clientMsgId: `cmid-${id}`,
    envelope: `ENVELOPE-${id}`,
    attachments: [{ id: 'up-1', key: 'up-1/blob', size: 128 }],
    createdAt: `2026-10-02T10:00:0${id.slice(-1)}.000Z`,
    editedAt: null,
    ...extra
  }
}

const content = (text: string): MessageContent => ({
  text,
  mentions: [],
  attachments: [],
  replyTo: null,
  sentAtMs: 1
})

const ok = (m: EncryptedMessage, text: string): DecryptResult => ({
  status: 'ok',
  messageId: m.id,
  clientMsgId: m.clientMsgId,
  kind: 'message',
  editOf: null,
  content: content(text),
  sender: {
    userId: m.authorId,
    deviceId: 'd-1',
    leafIndex: 0,
    trust: 'tofu',
    membershipVerified: true
  }
})

/** A fake store plus a log of what happened, in order. */
interface Harness {
  d: MessageDecryptor
  log: string[]
  rows: Map<string, ChatMessage>
}

function harness(decrypt: (ms: EncryptedMessage[]) => Promise<DecryptResult[]>): Harness {
  const log: string[] = []
  const rows = new Map<string, ChatMessage>()
  const d = createMessageDecryptor({
    decrypt: async (ms) => {
      log.push(`decrypt:${ms.map((m) => m.id).join(',')}`)
      const r = await decrypt(ms)
      log.push('decrypted')
      return r
    },
    existing: (_c, id) => rows.get(id),
    upsert: (_c, list) => {
      log.push(`upsert:${list.map((m) => m.id).join(',')}`)
      for (const m of list) rows.set(m.id, m)
    }
  })
  return { d, log, rows }
}

describe('toEncrypted', () => {
  it('passes the upload rows as {id, size} and the author id', () => {
    const e = toEncrypted(wire('m1'))
    expect(e.attachments).toEqual([{ id: 'up-1', size: 128 }])
    expect(e.authorId).toBe('u-1')
    expect(e.envelope).toBe('ENVELOPE-m1')
  })
})

describe('createMessageDecryptor', () => {
  it('decrypts before it upserts, in history order, and never stores the envelope', async () => {
    const { d, log, rows } = harness(async (ms) => ms.map((m) => ok(m, `text ${m.id}`)))
    await d.ingest([wire('m2'), wire('m1')])
    expect(log).toEqual(['decrypt:m1,m2', 'decrypted', 'upsert:m1,m2'])
    const row = rows.get('m1')
    expect(row?.content).toBe('text m1')
    expect(row?.decrypt).toEqual({ status: 'ok' })
    expect(JSON.stringify([...rows.values()])).not.toContain('ENVELOPE')
  })

  it('runs calls one after another', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { d, log } = harness(async (ms) => {
      if (ms[0]?.id === 'm1') await gate
      return ms.map((m) => ok(m, m.id))
    })
    const first = d.ingest([wire('m1')])
    const second = d.ingest([wire('m2')])
    await Promise.resolve()
    expect(log).toEqual(['decrypt:m1'])
    release()
    await Promise.all([first, second])
    expect(log).toEqual([
      'decrypt:m1',
      'decrypted',
      'upsert:m1',
      'decrypt:m2',
      'decrypted',
      'upsert:m2'
    ])
  })

  it('shows a placeholder for pending, and decrypts again on retryGroup', async () => {
    let keys = false
    const { d, rows } = harness(async (ms) =>
      ms.map((m) =>
        keys ? ok(m, 'later') : { status: 'pending', messageId: m.id, reason: 'epoch_ahead' }
      )
    )
    await d.ingest([wire('m1')])
    expect(rows.get('m1')?.decrypt).toEqual({ status: 'pending', reason: 'epoch_ahead' })
    expect(rows.get('m1')?.content).toBe('')
    expect(d.pendingIds()).toEqual(['m1'])

    await d.retryGroup('other-group')
    expect(rows.get('m1')?.decrypt.status).toBe('pending')

    keys = true
    await d.retryGroup('grp-1')
    expect(rows.get('m1')?.content).toBe('later')
    expect(d.pendingIds()).toEqual([])
  })

  it('keeps the newer content on stale_edit', async () => {
    let result: 'ok' | 'stale' = 'ok'
    const { d, rows, log } = harness(async (ms) =>
      ms.map((m) =>
        result === 'ok'
          ? ok(m, 'newer edit')
          : { status: 'failed', messageId: m.id, reason: 'stale_edit' }
      )
    )
    await d.ingest([wire('m1')])
    result = 'stale'
    log.length = 0
    await d.ingest([wire('m1', { envelope: 'OLDER' })])
    expect(log).toEqual(['decrypt:m1', 'decrypted'])
    expect(rows.get('m1')?.content).toBe('newer edit')
  })

  it('shows stale_edit as a failure when there is no newer content', async () => {
    const { d, rows } = harness(async (ms) =>
      ms.map((m) => ({ status: 'failed', messageId: m.id, reason: 'stale_edit' }))
    )
    await d.ingest([wire('m1')])
    expect(rows.get('m1')?.decrypt).toEqual({ status: 'failed', reason: 'stale_edit' })
  })

  it('keeps shown content while an edit is pending', async () => {
    let pending = false
    const { d, rows } = harness(async (ms) =>
      ms.map((m) =>
        pending ? { status: 'pending', messageId: m.id, reason: 'epoch_ahead' } : ok(m, 'v1')
      )
    )
    await d.ingest([wire('m1')])
    pending = true
    await d.ingest([wire('m1', { epoch: 5 })])
    expect(rows.get('m1')?.content).toBe('v1')
    expect(d.pendingIds()).toEqual(['m1'])
  })

  it('shows "unable to decrypt" with the reason', async () => {
    const { d, rows } = harness(async (ms) =>
      ms.map((m) => ({ status: 'failed', messageId: m.id, reason: 'bad_signature' }))
    )
    await d.ingest([wire('m1')])
    expect(rows.get('m1')?.decrypt).toEqual({ status: 'failed', reason: 'bad_signature' })
    expect(rows.get('m1')?.attachments).toEqual([])
  })

  it('fails closed when the Worker returns no result for a message', async () => {
    const { d, rows } = harness(async () => [])
    await d.ingest([wire('m1')])
    expect(rows.get('m1')?.decrypt).toEqual({ status: 'failed', reason: 'malformed' })
  })

  it('waits for retryAll when the Worker is not there', async () => {
    let up = false
    const { d, rows } = harness(async (ms) => {
      if (!up) throw new Error('NotInitialized')
      return ms.map((m) => ok(m, 'now'))
    })
    await d.ingest([wire('m1')])
    expect(rows.get('m1')?.decrypt.status).toBe('pending')
    up = true
    await d.retryAll()
    expect(rows.get('m1')?.content).toBe('now')
  })

  it('drops the results of a call that a reset overtook', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { d, rows } = harness(async (ms) => {
      await gate
      return ms.map((m) => ok(m, 'late'))
    })
    const running = d.ingest([wire('m1')])
    d.reset()
    release()
    expect(await running).toEqual([])
    expect(rows.size).toBe(0)
  })
})
