/**
 * Thread rules (docs/gateway-protocol.md §4 Threads).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'

import { MissingPermissionsError, ValidationError } from '@/lib/errors'

import { assertCanCreateThread, canManageThread } from './threads'

const text = { type: 'text', guildId: 'g' }

test('create: SEND_MESSAGES on a guild text channel', () => {
  assert.doesNotThrow(() => assertCanCreateThread(text, DEFAULT_EVERYONE))
  assert.throws(() => assertCanCreateThread(text, DEFAULT_EVERYONE & ~Permissions.SEND_MESSAGES), MissingPermissionsError)
  for (const type of ['pages', 'voice', 'category', 'thread']) {
    assert.throws(() => assertCanCreateThread({ type, guildId: 'g' }, DEFAULT_EVERYONE), ValidationError, type)
  }
  assert.throws(() => assertCanCreateThread({ type: 'dm', guildId: null }, DEFAULT_EVERYONE), ValidationError)
})

test('manage: the creator, or MANAGE_CHANNELS', () => {
  assert.equal(canManageThread({ ownerId: 'u' }, 'u', 0), true)
  assert.equal(canManageThread({ ownerId: 'u' }, 'v', DEFAULT_EVERYONE), false)
  assert.equal(canManageThread({ ownerId: 'u' }, 'v', Permissions.MANAGE_CHANNELS), true)
  assert.equal(canManageThread({ ownerId: null }, 'v', 0), false)
})
