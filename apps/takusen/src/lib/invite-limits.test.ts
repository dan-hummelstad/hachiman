/**
 * Invite limits (docs/gateway-protocol.md §4 "Invite limits"): the 403 / 400
 * rules of POST /guilds/:id/invites, the invites that need ADMINISTRATOR, the
 * demotion predicate behind their revoke, and the INVITE_DELETE events. No
 * DB / Redis: the permission data comes from InMemoryMlsRepo, and publishes
 * are captured.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'

import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'
import {
  assertInviteLimits,
  MAX_INVITE_AGE_S,
  MAX_LIMITED_INVITE_AGE_S,
  needsAdministrator,
  publishInviteDeletes,
} from '@/lib/invite-limits'
import { hasGuildPermission } from '@/lib/mls/readers'
import { InMemoryMlsRepo } from '@/lib/mls/repo.in-memory'

const RECORD = new Uint8Array([1, 2, 3])

describe('assertInviteLimits', () => {
  test('a non-admin gets 1 s to 24 h', () => {
    for (const maxAgeSeconds of [1, 3600, MAX_LIMITED_INVITE_AGE_S]) {
      assert.doesNotThrow(() => assertInviteLimits({ maxAgeSeconds }, false), String(maxAgeSeconds))
    }
  })

  test('a non-admin gets 403 for a permanent invite or more than 24 h, also with the acknowledgment', () => {
    for (const body of [
      { maxAgeSeconds: 0 },
      { maxAgeSeconds: 0, acknowledgedPermanent: true },
      { maxAgeSeconds: MAX_LIMITED_INVITE_AGE_S + 1 },
      { maxAgeSeconds: MAX_INVITE_AGE_S },
    ]) {
      assert.throws(() => assertInviteLimits(body, false), MissingPermissionsError, JSON.stringify(body))
    }
  })

  test('an admin gets up to 7 days', () => {
    for (const maxAgeSeconds of [1, MAX_LIMITED_INVITE_AGE_S + 1, MAX_INVITE_AGE_S]) {
      assert.doesNotThrow(() => assertInviteLimits({ maxAgeSeconds }, true), String(maxAgeSeconds))
    }
  })

  test('an admin gets a permanent invite only with acknowledgedPermanent: true', () => {
    assert.doesNotThrow(() => assertInviteLimits({ maxAgeSeconds: 0, acknowledgedPermanent: true }, true))
    assert.throws(() => assertInviteLimits({ maxAgeSeconds: 0 }, true), ValidationError)
    assert.throws(() => assertInviteLimits({ maxAgeSeconds: 0, acknowledgedPermanent: false }, true), ValidationError)
  })

  test('a non-admin gets 403 for an invite with history, before the 400 of a missing acknowledgment', () => {
    for (const body of [
      { maxAgeSeconds: 3600, record: RECORD },
      { maxAgeSeconds: 0, record: RECORD },
    ]) {
      assert.throws(
        () => assertInviteLimits(body, false),
        (err: unknown) => err instanceof MissingPermissionsError && err.message === 'Only an administrator can make an invite with history',
        String(body.maxAgeSeconds),
      )
    }
  })

  test('an admin gets an invite with history', () => {
    assert.doesNotThrow(() => assertInviteLimits({ maxAgeSeconds: 3600, record: RECORD }, true))
    assert.doesNotThrow(() => assertInviteLimits({ maxAgeSeconds: 0, acknowledgedPermanent: true, record: RECORD }, true))
    assert.throws(() => assertInviteLimits({ maxAgeSeconds: 0, record: RECORD }, true), ValidationError)
  })
})

describe('needsAdministrator', () => {
  test('a permanent invite and an invite with history, not a limited invite', () => {
    const later = new Date(Date.now() + 3_600_000)
    assert.equal(needsAdministrator({ expiresAt: null, record: null }), true)
    assert.equal(needsAdministrator({ expiresAt: later, record: RECORD }), true)
    assert.equal(needsAdministrator({ expiresAt: null, record: RECORD }), true)
    assert.equal(needsAdministrator({ expiresAt: later, record: null }), false)
  })
})

describe('hasGuildPermission (ADMINISTRATOR)', () => {
  function world() {
    const repo = new InMemoryMlsRepo()
    const owner = repo.addUser()
    const guild = repo.addGuild(owner, undefined, DEFAULT_EVERYONE)
    const adminRole = repo.addRole(guild, Permissions.ADMINISTRATOR)
    const modRole = repo.addRole(guild, Permissions.MANAGE_GUILD | Permissions.KICK_MEMBERS)
    const admin = repo.addUser()
    const mod = repo.addUser()
    repo.addGuildMember(guild, admin, [adminRole])
    repo.addGuildMember(guild, mod, [modRole])
    const admins = async (ids: string[]) => {
      const data = (await repo.getGuildPermissionData(guild))!
      return ids.filter((id) => hasGuildPermission(data, id, Permissions.ADMINISTRATOR))
    }
    return { repo, guild, owner, admin, mod, adminRole, admins }
  }

  test('the owner and a member with an ADMINISTRATOR role have it', async () => {
    const w = world()
    assert.deepEqual(await w.admins([w.owner, w.admin]), [w.owner, w.admin])
  })

  test('a member without ADMINISTRATOR, also with MANAGE_GUILD, does not have it', async () => {
    const w = world()
    assert.deepEqual(await w.admins([w.owner, w.admin, w.mod]), [w.owner, w.admin])
  })

  test('a role edit that clears ADMINISTRATOR demotes every holder', async () => {
    const w = world()
    const second = w.repo.addUser()
    w.repo.addGuildMember(w.guild, second, [w.adminRole])
    w.repo.addRole(w.guild, Permissions.MANAGE_GUILD, w.adminRole)
    assert.deepEqual(await w.admins([w.owner, w.admin, second]), [w.owner])
  })

  test('a removed role, a removed member and a non-member do not have it', async () => {
    const w = world()
    w.repo.addGuildMember(w.guild, w.admin, [])
    assert.deepEqual(await w.admins([w.admin]), [])
    w.repo.removeGuildMember(w.guild, w.mod)
    assert.deepEqual(await w.admins([w.mod]), [])
    const stranger = w.repo.addUser()
    assert.deepEqual(await w.admins([stranger]), [])
  })

  test('ADMINISTRATOR on @everyone counts, and clearing it demotes everyone but the owner', async () => {
    const w = world()
    w.repo.addRole(w.guild, DEFAULT_EVERYONE | Permissions.ADMINISTRATOR, w.guild)
    assert.deepEqual(await w.admins([w.owner, w.mod]), [w.owner, w.mod])
    w.repo.addRole(w.guild, DEFAULT_EVERYONE, w.guild)
    w.repo.addRole(w.guild, 0, w.adminRole)
    assert.deepEqual(await w.admins([w.owner, w.admin, w.mod]), [w.owner])
  })
})

describe('publishInviteDeletes', () => {
  after(() => setBusPublisher(null))

  test('one INVITE_DELETE to the guild per revoked invite, without channelId', async () => {
    const sent: { channel: string; payload: unknown }[] = []
    setBusPublisher(async (channel, payload) => {
      sent.push({ channel, payload: JSON.parse(payload) })
    })
    await publishInviteDeletes('g1', [
      { inviteId: 'i1', code: 'ABCDEFGH' },
      { inviteId: 'i2', code: 'JKLMNPQR' },
    ])
    await publishInviteDeletes('g1', [])
    assert.deepEqual(sent, [
      { channel: 'guild:g1', payload: { t: 'INVITE_DELETE', d: { guildId: 'g1', code: 'ABCDEFGH', inviteId: 'i1' } } },
      { channel: 'guild:g1', payload: { t: 'INVITE_DELETE', d: { guildId: 'g1', code: 'JKLMNPQR', inviteId: 'i2' } } },
    ])
  })
})
