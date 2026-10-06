/**
 * The SQL of the invite limits (docs/gateway-protocol.md §4 "Invite limits")
 * on a real Postgres: revokePermanentInvitesOfNonAdmins and
 * createPermanentInvite. invite-limits.test.ts covers the pure parts.
 *
 * It runs only when TAKUSEN_PG_TEST_URL is set, as repo.drizzle.pg.test.ts
 * does, and it refuses the dev database `takusen`. Each test makes its own
 * guild with random ids and does not delete its rows.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'

import type { Database } from '@/db/client'
import * as schema from '@/db/schema'
import { MissingPermissionsError } from '@/lib/errors'
import { revokePermanentInvitesOfNonAdmins } from '@/lib/invite-limits'
import { createPermanentInvite, generateInviteCode } from '@/lib/invites'

const url = process.env.TAKUSEN_PG_TEST_URL

function databaseName(u: string): string {
  return decodeURIComponent(new URL(u).pathname.replace(/^\//, ''))
}

const skip = !url ? 'TAKUSEN_PG_TEST_URL is not set' : databaseName(url) === 'takusen' ? 'TAKUSEN_PG_TEST_URL names the dev database "takusen"' : false

const DAY_MS = 86_400_000

describe('invite limits (Postgres)', { skip }, () => {
  let client: ReturnType<typeof postgres>
  let db: Database

  before(() => {
    client = postgres(url!, { max: 4, onnotice: () => {} })
    db = drizzle(client, { schema })
  })

  after(async () => {
    await client.end()
  })

  async function addUser(): Promise<string> {
    const id = randomUUID()
    await db.insert(schema.users).values({ id, email: `${id}@invite-limits.test`, displayName: 'invite-limits' })
    return id
  }

  async function addRole(guildId: string, permissions: number): Promise<string> {
    const id = randomUUID()
    await db.insert(schema.roles).values({ id, guildId, name: 'role', permissions })
    return id
  }

  async function addMember(guildId: string, userId: string, roleIds: string[] = []): Promise<void> {
    await db.insert(schema.guildMembers).values({ guildId, userId })
    for (const roleId of roleIds) await db.insert(schema.memberRoles).values({ guildId, userId, roleId })
  }

  /** The owner, an admin through a role, and a moderator with MANAGE_GUILD but without ADMINISTRATOR. */
  async function world() {
    const owner = await addUser()
    const guild = randomUUID()
    await db.insert(schema.guilds).values({ id: guild, ownerId: owner, name: 'invite-limits' })
    await db.insert(schema.roles).values({ id: guild, guildId: guild, name: '@everyone', permissions: DEFAULT_EVERYONE })
    await addMember(guild, owner)
    const adminRole = await addRole(guild, Permissions.ADMINISTRATOR)
    const modRole = await addRole(guild, Permissions.MANAGE_GUILD | Permissions.CREATE_INSTANT_INVITE)
    const admin = await addUser()
    const mod = await addUser()
    await addMember(guild, admin, [adminRole])
    await addMember(guild, mod, [modRole])
    return { guild, owner, admin, mod, adminRole }
  }

  async function addInvite(
    guildId: string,
    createdBy: string,
    o: { permanent: boolean; revoked?: boolean },
  ): Promise<{ id: string; code: string }> {
    const [row] = await db
      .insert(schema.invites)
      .values({
        guildId,
        createdBy,
        code: generateInviteCode(),
        expiresAt: o.permanent ? null : new Date(Date.now() + DAY_MS),
        revoked: o.revoked ?? false,
      })
      .returning({ id: schema.invites.id, code: schema.invites.code })
    return row!
  }

  async function revokedIds(ids: string[]): Promise<Set<string>> {
    const rows = await db
      .select({ id: schema.invites.id })
      .from(schema.invites)
      .where(and(inArray(schema.invites.id, ids), eq(schema.invites.revoked, true)))
    return new Set(rows.map((r) => r.id))
  }

  describe('revokePermanentInvitesOfNonAdmins', () => {
    test('revokes only the live permanent invites of creators without ADMINISTRATOR', async () => {
      const w = await world()
      const ownerPermanent = await addInvite(w.guild, w.owner, { permanent: true })
      const adminPermanent = await addInvite(w.guild, w.admin, { permanent: true })
      const modPermanent = await addInvite(w.guild, w.mod, { permanent: true })
      const modTimed = await addInvite(w.guild, w.mod, { permanent: false })
      const modRevoked = await addInvite(w.guild, w.mod, { permanent: true, revoked: true })

      const revoked = await db.transaction((tx) => revokePermanentInvitesOfNonAdmins(tx, w.guild))

      assert.deepEqual(revoked, [{ inviteId: modPermanent.id, code: modPermanent.code }])
      const all = [ownerPermanent, adminPermanent, modPermanent, modTimed, modRevoked].map((i) => i.id)
      assert.deepEqual(await revokedIds(all), new Set([modPermanent.id, modRevoked.id]))
    })

    test('sees the uncommitted demotion of its transaction', async () => {
      const w = await world()
      const adminPermanent = await addInvite(w.guild, w.admin, { permanent: true })
      const ownerPermanent = await addInvite(w.guild, w.owner, { permanent: true })

      const revoked = await db.transaction(async (tx) => {
        await tx.update(schema.roles).set({ permissions: 0 }).where(eq(schema.roles.id, w.adminRole))
        return revokePermanentInvitesOfNonAdmins(tx, w.guild)
      })

      assert.deepEqual(revoked, [{ inviteId: adminPermanent.id, code: adminPermanent.code }])
      assert.deepEqual(await revokedIds([adminPermanent.id, ownerPermanent.id]), new Set([adminPermanent.id]))
    })

    test('revokes the invites of a removed member, and of no other guild', async () => {
      const w = await world()
      const other = await world()
      const here = await addInvite(w.guild, w.admin, { permanent: true })
      await addMember(other.guild, w.admin)
      const there = await addInvite(other.guild, w.admin, { permanent: true })

      const revoked = await db.transaction(async (tx) => {
        await tx
          .delete(schema.guildMembers)
          .where(and(eq(schema.guildMembers.guildId, w.guild), eq(schema.guildMembers.userId, w.admin)))
        return revokePermanentInvitesOfNonAdmins(tx, w.guild)
      })

      assert.deepEqual(revoked, [{ inviteId: here.id, code: here.code }])
      assert.deepEqual(await revokedIds([here.id, there.id]), new Set([here.id]))
    })

    test('returns nothing without permanent invites', async () => {
      const w = await world()
      const timed = await addInvite(w.guild, w.mod, { permanent: false })
      assert.deepEqual(await db.transaction((tx) => revokePermanentInvitesOfNonAdmins(tx, w.guild)), [])
      assert.deepEqual(await revokedIds([timed.id]), new Set())
    })
  })

  describe('createPermanentInvite', () => {
    test('an administrator gets a permanent invite', async () => {
      const w = await world()
      for (const createdBy of [w.owner, w.admin]) {
        const row = await createPermanentInvite({ guildId: w.guild, createdBy, maxUses: 5 }, db)
        assert.equal(row.expiresAt, null)
        assert.equal(row.revoked, false)
        assert.equal(row.createdBy, createdBy)
        assert.equal(row.maxUses, 5)
        assert.match(row.code, /^[A-Z2-9]{8}$/)
      }
    })

    test('a member without ADMINISTRATOR, a demoted admin and a non-member get 403', async () => {
      const w = await world()
      await assert.rejects(createPermanentInvite({ guildId: w.guild, createdBy: w.mod, maxUses: null }, db), MissingPermissionsError)

      await db
        .delete(schema.memberRoles)
        .where(and(eq(schema.memberRoles.guildId, w.guild), eq(schema.memberRoles.userId, w.admin)))
      await assert.rejects(createPermanentInvite({ guildId: w.guild, createdBy: w.admin, maxUses: null }, db), MissingPermissionsError)

      const stranger = await addUser()
      await assert.rejects(createPermanentInvite({ guildId: w.guild, createdBy: stranger, maxUses: null }, db), MissingPermissionsError)

      const rows = await db.select({ id: schema.invites.id }).from(schema.invites).where(eq(schema.invites.guildId, w.guild))
      assert.equal(rows.length, 0)
    })
  })
})
