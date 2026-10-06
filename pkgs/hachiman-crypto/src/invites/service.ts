/**
 * InviteService (docs/gateway-protocol.md §12.11.4, §12.16): invites with history in the Worker.
 *
 * - prepareHistoryInvite makes the seed and signs the record. The seed leaves the Worker once, as
 *   the link secret (§12.17). The creator does not keep it.
 * - sendInviteBundles: the creation bundles of this device, one per scope group that it holds.
 *   The first failed post rejects.
 * - After each own commit in a scope group of an active invite (InvitePort.ownCommit), this
 *   device sends a bundle with the new epoch and the epochs after the newest bundled one.
 * - redeemInvite (after the guild join): checks the record against the seed and the admin state,
 *   opens each bundle of a scope group, checks its sender and imports the keys. The redeemer gets
 *   the bundles again INVITE_REFETCH_DELAY_MS after the redemption and after each own join of a
 *   scope group (InvitePort.joined): a later commit bundle fills the epochs that had none.
 * - prune wipes the redeemer seed INVITE_AUTH_WINDOW_MS after the redemption (a timer, and at the
 *   start), and deletes the row of an invite HANDSHAKE_RETENTION_MS after its expiry.
 * - Join authorization (InvitePort.authFor, checkJoin): while the redeemer keeps the seed, it signs
 *   an InviteAuth for its external commit into a 'channel' group of the scope. A member checks the
 *   InviteAuth of such a commit before it applies it. The redemption syncs the groups at once.
 *
 * The service attaches its InvitePort to GroupService once, at its creation (attachInvites).
 *
 * A device checks each record against its current verified admin state (§12.16), and decides the
 * scope from its own MLS group descriptors, never from REST data. Every check fails closed.
 */
import {
  CryptoError,
  type AdminReplayState,
  type ChannelId,
  type CreateInviteService,
  type CryptoGatewayEvent,
  type GroupDescriptor,
  type GroupIdParts,
  type GuildId,
  type HistoryKeyEntry,
  type InvitePort,
  type InviteService,
  type StoreSchema,
  type WireInviteRecord,
} from '../api'
import { AdminBits } from '../admin/index'
import { bytesToUuid, fromB64url, toB64url, uuidToBytes } from '../codec'
import { HANDSHAKE_RETENTION_MS, HISTORY_BUNDLE_MAX_EPOCHS, INVITE_AUTH_WINDOW_MS, INVITE_BUNDLE_FETCH_WINDOW_MS, INVITE_MAX_SCOPE_CHANNELS, INVITE_SEED_BYTES } from '../constants'
import { reportError } from '../errors'
import { compareBytes, equalBytes } from '../identity/bytes'
import { storedEpochSecrets } from '../mls/epoch-secrets'
import { parseGroupId } from '../mls/wire'
import { type InviteRecord, decodeInviteBundleContent, decodeInviteBundleTbs, readSignedInviteRecord } from './codec'
import { deriveInviteKeys, openInviteBundle, sealInviteBundle } from './keys'
import { signInviteAuth, signInviteBundle, signInviteRecord, verifyInviteAuth, verifyInviteBundle, verifyInviteRecordSignature } from './record'

/** How long the record list of a guild serves the commits of this device. INVITE_DELETE drops it. */
export const INVITE_RECORDS_TTL_MS = 60_000
/**
 * The wait before the redeemer gets the bundles again. The member that commits the Add of the
 * redeemer posts its bundle after the DS accepted the commit, so after the Welcome can arrive.
 */
export const INVITE_REFETCH_DELAY_MS = 10_000

export interface InviteServiceExt extends InviteService {
  /** Resolves when the bundles after own commits are sent (tests). */
  idle(): Promise<void>
}

type Row = StoreSchema['invites']
type Check = { ok: true; record: InviteRecord; state: AdminReplayState } | { ok: false; reason: string }
/** A redeemer row that keeps its seed and is not revoked. */
type LiveRedeemer = Row & { role: 'redeemed'; code: string; seed: Uint8Array; redeemedAtMs: number }

const MAX_U32 = 0xffffffff

export const createInviteService = ((ctx, identity, groups, perms): InviteServiceExt => {
  const { store, transport } = ctx
  const background = new Set<Promise<unknown>>()
  const records = new Map<GuildId, { at: number; value: Promise<WireInviteRecord[]> }>()
  /** Records whose creator signature verified, per key id, at the admin seq of the check. */
  const verified = new Map<string, { seq: number; signed: Uint8Array; record: InviteRecord }>()
  let sending: Promise<unknown> = Promise.resolve()
  let pruneTimer: ReturnType<typeof setTimeout> | null = null
  /** Per key id: the pending later fetch of the redeemer. */
  const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>()

  spawn(prune())
  groups.attachInvites({
    authFor,
    checkJoin,
    ownCommit: (e) => {
      // One commit after the other: two sends for one group would race on `bundled`.
      const run = sending.then(() => afterOwnCommit(e))
      sending = run.catch(() => undefined)
      spawn(run)
    },
    joined: (e) => {
      spawn(afterJoin(e))
    },
  } satisfies InvitePort)

  // MARK: - plumbing

  function spawn(p: Promise<unknown>): void {
    const q = p.catch(report).finally(() => background.delete(q))
    background.add(q)
  }

  function report(e: unknown): void {
    reportError(ctx, e)
  }

  function recordsOf(guildId: GuildId): Promise<WireInviteRecord[]> {
    const hit = records.get(guildId)
    if (hit && ctx.now() - hit.at < INVITE_RECORDS_TTL_MS) return hit.value
    const value = transport.inviteRecords(guildId)
    records.set(guildId, { at: ctx.now(), value })
    value.catch(() => {
      if (records.get(guildId)?.value === value) records.delete(guildId)
    })
    spawn(prune())
    return value
  }

  /**
   * Wipes the seeds after INVITE_AUTH_WINDOW_MS, and deletes the row of an invite
   * HANDSHAKE_RETENTION_MS after its expiry. Until then, an invite join that the DS accepted before
   * the expiry can still come in the handshake stream: the row keeps the revoke mark, and the
   * timeline event of the record goes only once into each group. Then arms one timer for the next
   * seed that must go, so a redeemer without a later commit wipes it too.
   */
  async function prune(): Promise<void> {
    const now = ctx.now()
    const next = await store.transaction(['invites'], async (tx) => {
      let at = Infinity
      for (const { key, value } of await tx.list('invites')) {
        const wipeAt = value.seed === null ? Infinity : (value.redeemedAtMs ?? -Infinity) + INVITE_AUTH_WINDOW_MS + 1
        const seedDone = wipeAt <= now
        const expired = value.expiresAtMs !== 0 && value.expiresAtMs + HANDSHAKE_RETENTION_MS <= now
        if (expired && (value.seed === null || seedDone)) await tx.delete('invites', key)
        else if (seedDone) await tx.put('invites', key, { ...value, seed: null })
        else at = Math.min(at, wipeAt)
      }
      return at
    })
    if (pruneTimer !== null) clearTimeout(pruneTimer)
    pruneTimer = null
    if (next === Infinity) return
    pruneTimer = setTimeout(() => {
      pruneTimer = null
      spawn(prune())
    }, next - now)
  }

  // MARK: - checks (§12.16)

  /**
   * The record checks of §12.16 against `state`, the current verified admin state of `guildId`.
   * `graceMs`: the redeemer also accepts a record that expired less than this long ago.
   */
  async function checkRecord(guildId: GuildId, signed: Uint8Array, state: AdminReplayState | null, graceMs = 0): Promise<Check> {
    let rec: InviteRecord
    try {
      rec = readSignedInviteRecord(signed)
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    const keyId = toB64url(rec.signPublic)
    if (rec.guildId !== guildId) return { ok: false, reason: 'another guild' }
    if (rec.expiresAtMs !== 0 && rec.expiresAtMs + graceMs <= ctx.now()) return { ok: false, reason: 'expired' }
    if ((await store.get('invites', keyId))?.revoked === true) return { ok: false, reason: 'revoked' }
    if (state?.guildId !== guildId) return { ok: false, reason: 'no verified admin state' }
    if (rec.adminChainSeq > state.seq) return { ok: false, reason: 'admin_chain_seq is ahead of the admin state' }
    if ((perms.guildPermissions(state, rec.creatorUserId) & AdminBits.ADMINISTRATOR) === 0) return { ok: false, reason: 'the creator is not an administrator' }
    if (!(await transport.guildMembers(guildId)).includes(rec.creatorUserId)) return { ok: false, reason: 'the creator is not a guild member' }
    if ((await identity.chainContextFor(rec.creatorUserId, false)).revokedDeviceIds.has(rec.creatorDeviceId)) return { ok: false, reason: 'the creator device is revoked' }
    if ((await identity.trustOf(rec.creatorUserId)) === 'changed') return { ok: false, reason: 'the creator key changed' }
    const hit = verified.get(keyId)
    if (hit?.seq === state.seq && equalBytes(hit.signed, signed)) return { ok: true, record: hit.record, state }
    const cert = await identity.deviceCertificate(rec.creatorUserId, rec.creatorDeviceId)
    const ok = cert === null ? null : verifyInviteRecordSignature(signed, cert)
    if (ok === null) return { ok: false, reason: 'bad signature or unknown creator device' }
    verified.set(keyId, { seq: state.seq, signed, record: ok })
    return { ok: true, record: ok, state }
  }

  /** §12.11.4 "Scope": from the MLS-authenticated descriptor of the group. */
  function inScope(d: Pick<GroupDescriptor, 'kind' | 'guildId' | 'channelId'>, rec: InviteRecord, state: AdminReplayState): boolean {
    if (d.guildId !== rec.guildId) return false
    if (d.kind === 'public_set') return true
    if (d.kind !== 'channel' || d.channelId === null || !rec.channelIds.includes(d.channelId)) return false
    return (perms.everyoneChannelPermissions(state, d.channelId) & AdminBits.VIEW_CHANNEL) !== 0
  }

  /**
   * The scope check from the group id alone: it names the kind and the scope of the descriptor, and
   * every member checks that it does (§12.6). `public_set` of the record guild, or the `channel`
   * group of a record channel. A channel id does not name its guild: Takusen accepts only a record
   * whose channels are of its guild (§4), and the redeemer also checks the descriptor of a group
   * that it holds.
   */
  function idInScope(groupId: Uint8Array, rec: InviteRecord, state: AdminReplayState): boolean {
    let parts: GroupIdParts
    try {
      parts = parseGroupId(groupId)
    } catch {
      return false
    }
    if (parts.kind === 'public_set') return parts.scope === rec.guildId
    return parts.kind === 'channel' && inScope({ kind: 'channel', guildId: rec.guildId, channelId: parts.scope }, rec, state)
  }

  /**
   * The groups with local state that are in the scope of `rec`. The group id filters first, so only
   * those groups restore their MLS state for the descriptor check.
   */
  async function scopeGroups(rec: InviteRecord, state: AdminReplayState): Promise<{ gid: string; groupId: Uint8Array; descriptor: GroupDescriptor }[]> {
    const out: { gid: string; groupId: Uint8Array; descriptor: GroupDescriptor }[] = []
    for (const { key, value } of await store.list('groups')) {
      if (!idInScope(value.groupId, rec, state)) continue
      const descriptor = await groups.descriptor(value.groupId)
      if (descriptor !== null && inScope(descriptor, rec, state)) out.push({ gid: key, groupId: value.groupId, descriptor })
    }
    return out
  }

  /**
   * The row of a checked record. The first check of a record on this device adds the timeline
   * event 'invite_with_history' to each scope group that it holds (§12.11.4).
   */
  async function noteRecord(inviteId: string | null, rec: InviteRecord, signed: Uint8Array, state: AdminReplayState): Promise<Row> {
    const keyId = toB64url(rec.signPublic)
    const { row, created } = await store.transaction(['invites'], async (tx) => {
      const old = await tx.get('invites', keyId)
      if (old !== undefined) {
        if (old.inviteId !== null || inviteId === null) return { row: old, created: false }
        const next = { ...old, inviteId }
        await tx.put('invites', keyId, next)
        return { row: next, created: false }
      }
      const next: Row = { guildId: rec.guildId, record: signed, role: 'member', inviteId, code: null, revoked: false, expiresAtMs: rec.expiresAtMs, bundled: {}, seed: null, redeemedAtMs: null }
      await tx.put('invites', keyId, next)
      return { row: next, created: true }
    })
    if (created) {
      for (const g of await scopeGroups(rec, state)) {
        const epoch = (await groups.currentEpoch(g.groupId)) ?? 0
        await groups.appendTimeline(g.gid, [{ groupId: g.gid, channelId: g.descriptor.channelId, epoch, actorUserId: rec.creatorUserId, kind: 'invite_with_history', subjects: [], inviteKeyId: keyId }])
      }
    }
    return row
  }

  async function markBundled(keyId: string, gid: string, epoch: number): Promise<void> {
    await store.transaction(['invites'], async (tx) => {
      const row = await tx.get('invites', keyId)
      if (row === undefined || (row.bundled[gid] ?? -1) >= epoch) return
      await tx.put('invites', keyId, { ...row, bundled: { ...row.bundled, [gid]: epoch } })
    })
  }

  /** Seals `keys` (ascending, the newest HISTORY_BUNDLE_MAX_EPOCHS) and posts the bundle with the newest epoch. */
  async function sendBundle(inviteId: string, rec: InviteRecord, gid: string, keys: HistoryKeyEntry[]): Promise<void> {
    const kept = keys.slice(-HISTORY_BUNDLE_MAX_EPOCHS)
    const epoch = kept.at(-1)?.epoch
    if (epoch === undefined) return
    const self = identity.self()
    const groupId = fromB64url(gid)
    const content = signInviteBundle(
      { signPublic: rec.signPublic, groupId, keys: kept.map((k) => ({ epoch: k.epoch, secret: k.secret })), senderUserId: self.userId, senderDeviceId: self.deviceId },
      self.mlsSignatureKey.privateKey,
    )
    const blob = await sealInviteBundle(rec, groupId, content)
    await transport.postInviteBundle(inviteId, { groupId: gid, epoch, blob: toB64url(blob) })
    await markBundled(toB64url(rec.signPublic), gid, epoch)
  }

  // MARK: - bundles on each own commit

  /**
   * §12.11.4 "Member devices": the new epoch always goes, also when the REST `bundled` has it
   * (any reader can raise that hint with a bundle that does not open). Only an own earlier send
   * skips it. The newest of `bundled` and the own sends only bounds the older epochs that go along.
   */
  async function afterOwnCommit(e: { groupId: Uint8Array; epoch: number }): Promise<void> {
    const desc = await groups.descriptor(e.groupId)
    if (desc?.guildId == null || (desc.kind !== 'public_set' && desc.kind !== 'channel')) return
    const list = await recordsOf(desc.guildId)
    if (list.length === 0) return
    const state = await identity.adminState(desc.guildId)
    const gid = toB64url(e.groupId)
    for (const w of list) {
      try {
        const signed = fromB64url(w.record)
        const c = await checkRecord(desc.guildId, signed, state)
        if (!c.ok || !inScope(desc, c.record, c.state)) continue
        const row = await noteRecord(w.inviteId, c.record, signed, c.state)
        const own = row.bundled[gid] ?? -1
        if (own >= e.epoch) continue
        // The REST hint can be at or above the new epoch: then only the new epoch goes.
        const floor = Math.min(Math.max(own, w.bundled.find((b) => b.groupId === gid)?.epoch ?? -1), e.epoch - 1)
        // The epochs above `floor` up to the new one, and at most the newest HISTORY_BUNDLE_MAX_EPOCHS.
        const keys = await storedEpochSecrets(store, gid, Math.max(floor + 1, e.epoch - HISTORY_BUNDLE_MAX_EPOCHS + 1, 0), e.epoch)
        if (keys.at(-1)?.epoch !== e.epoch) continue
        await sendBundle(w.inviteId, c.record, gid, keys)
      } catch (err) {
        report(err)
      }
    }
  }

  // MARK: - redemption (§12.11.4 "Redeemer checks")

  /**
   * GET /invites/:code/bundles with the seed of the link: checks the record and each bundle, and
   * imports the keys that pass. A bundle that fails is dropped alone.
   */
  async function openBundles(code: string, seed: Uint8Array): Promise<{ inviteId: string; signed: Uint8Array; rec: InviteRecord; imported: HistoryKeyEntry[] }> {
    const keys = deriveInviteKeys(seed)
    const res = await transport.inviteBundles(code)
    let signed: Uint8Array
    let rec: InviteRecord
    try {
      signed = fromB64url(res.record)
      rec = readSignedInviteRecord(signed)
    } catch {
      throw new CryptoError('Malformed', 'the invite record does not decode')
    }
    // D1: the seed binds the record. A server cannot give the record of another invite.
    if (!equalBytes(rec.signPublic, keys.sign.publicKey) || !equalBytes(rec.hpkePublic, keys.hpke.publicKey)) {
      throw new CryptoError('InvalidChain', 'the invite record is not the record of this link')
    }
    // Right after POST /invites/:code the client cache can lack the guild (GUILD_CREATE comes
    // later). A retry passes then, so that is not a record failure.
    const memberIds = await transport.guildMembers(rec.guildId)
    if (!memberIds.includes(identity.self().userId)) throw new CryptoError('GroupPending', 'the guild members are not loaded yet')
    // Takusen serves the bundles for 1 h after the join, also when the invite expired since (§12.12).
    const c = await checkRecord(rec.guildId, signed, await identity.adminState(rec.guildId), INVITE_BUNDLE_FETCH_WINDOW_MS)
    if (!c.ok) throw new CryptoError('InvalidChain', `the invite record does not verify: ${c.reason}`)
    const { state } = c
    const members = new Set(memberIds)
    const accepted: { creator: boolean; keys: HistoryKeyEntry[] }[] = []
    for (const b of res.bundles) {
      try {
        const groupId = fromB64url(b.groupId)
        // Any reader of a group of the guild can post a bundle for it (§12.12). Only the groups of
        // the scope count: the AAD and the signed TBS bind the bundle to this group id. The group id
        // does not name the guild of a channel, so in a group that this device holds, the
        // MLS-authenticated descriptor must be in the scope too.
        if (!idInScope(groupId, rec, state)) throw new CryptoError('InvalidChain', 'invite bundle: the group is not in the scope of the invite')
        const held = await groups.descriptor(groupId)
        if (held !== null && !inScope(held, rec, state)) throw new CryptoError('InvalidChain', 'invite bundle: the group is not in the scope of the invite')
        const content = await openInviteBundle(keys, groupId, fromB64url(b.blob))
        // The sender ids before the signature check, only to find the certificate.
        const claimed = decodeInviteBundleTbs(decodeInviteBundleContent(content).tbs)
        const cert = await identity.deviceOwnerCertificate(claimed.senderDeviceId, claimed.senderUserId)
        if (cert === null) throw new CryptoError('InvalidChain', `invite bundle: unknown sender device ${claimed.senderDeviceId}`)
        if (!members.has(cert.userId)) throw new CryptoError('InvalidChain', 'invite bundle: the sender is not a guild member')
        if ((await identity.chainContextFor(cert.userId, false)).revokedDeviceIds.has(cert.deviceId)) throw new CryptoError('InvalidChain', 'invite bundle: the sender device is revoked')
        if ((await identity.trustOf(cert.userId)) === 'changed') throw new CryptoError('InvalidChain', 'invite bundle: the sender key changed')
        const tbs = verifyInviteBundle(content, cert, { signPublic: keys.sign.publicKey, groupId })
        if (tbs === null) throw new CryptoError('InvalidChain', 'invite bundle: bad signature, or another invite or group')
        // Any member can sign a bundle (§12.11.4 "Redeemer checks"). Only epochs up to the bundle
        // epoch, which Takusen kept at or below the group epoch, and below the epoch of a group
        // that this device holds: it derives those secrets itself.
        const current = await groups.currentEpoch(groupId)
        const top = Math.min(b.epoch, current === null ? Infinity : current - 1)
        const creator = cert.userId === rec.creatorUserId && cert.deviceId === rec.creatorDeviceId
        accepted.push({ creator, keys: tbs.keys.filter((k) => k.epoch <= top).map((k) => ({ groupId, epoch: k.epoch, secret: k.secret })) })
      } catch (e) {
        // Fail closed per bundle: the others still count.
        report(e)
      }
    }
    // One secret per epoch: the creator device first, then the first bundle (oldest first). A
    // later bundle never replaces it.
    const entries = new Map<string, HistoryKeyEntry>()
    for (const a of accepted.sort((x, y) => Number(y.creator) - Number(x.creator))) {
      for (const k of a.keys) {
        const key = `${toB64url(k.groupId)}:${k.epoch}`
        if (!entries.has(key)) entries.set(key, k)
      }
    }
    const imported = [...entries.values()]
    await groups.importHistoryKeys(imported, 'bundle')
    return { inviteId: res.inviteId, signed, rec, imported }
  }

  function liveRedeemer(row: Row | undefined, now: number, windowMs: number): row is LiveRedeemer {
    return row?.role === 'redeemed' && !row.revoked && row.seed !== null && row.code !== null && row.redeemedAtMs !== null && now - row.redeemedAtMs < windowMs
  }

  /** One later fetch per invite: a call before it runs moves it. */
  function scheduleRefetch(keyId: string): void {
    const old = refetchTimers.get(keyId)
    if (old !== undefined) clearTimeout(old)
    refetchTimers.set(
      keyId,
      setTimeout(() => {
        refetchTimers.delete(keyId)
        spawn(refetch(keyId))
      }, INVITE_REFETCH_DELAY_MS),
    )
  }

  /** §12.11.4 "Later bundles": the same checks as the redemption. Keeps the row as it is. */
  async function refetch(keyId: string): Promise<void> {
    const row = await store.get('invites', keyId)
    // Takusen gives the bundles for INVITE_BUNDLE_FETCH_WINDOW_MS after the join (§12.12).
    if (liveRedeemer(row, ctx.now(), INVITE_BUNDLE_FETCH_WINDOW_MS)) await openBundles(row.code, row.seed)
  }

  /** This device joined a group: each redeemed invite whose scope has the group fetches again. */
  async function afterJoin(e: { groupId: Uint8Array }): Promise<void> {
    const desc = await groups.descriptor(e.groupId)
    if (desc?.guildId == null || (desc.kind !== 'public_set' && desc.kind !== 'channel')) return
    const now = ctx.now()
    const rows = (await store.list('invites')).filter(({ value }) => value.guildId === desc.guildId && liveRedeemer(value, now, INVITE_BUNDLE_FETCH_WINDOW_MS))
    if (rows.length === 0) return
    const state = await identity.adminState(desc.guildId)
    if (state === null) return
    for (const { key, value } of rows) {
      try {
        if (inScope(desc, readSignedInviteRecord(value.record), state)) scheduleRefetch(key)
      } catch (err) {
        report(err)
      }
    }
  }

  // MARK: - join authorization (§12.11.4)

  /**
   * Joiner: an InviteAuth from a redeemed invite whose seed this device keeps, whose record passes
   * the checks of §12.16 now and names the channel, and that @everyone still views. A record that
   * the members would reject gives no join: the members would raise a fork alert.
   */
  async function authFor(group: { groupId: Uint8Array; guildId: GuildId; channelId: ChannelId }): Promise<Uint8Array | null> {
    let parts: GroupIdParts
    try {
      parts = parseGroupId(group.groupId)
    } catch {
      return null
    }
    // The InviteAuth binds the group id, and the group id names the channel (§12.6).
    if (parts.kind !== 'channel' || parts.scope !== group.channelId) return null
    const now = ctx.now()
    const rows = (await store.list('invites'))
      .map(({ value }) => value)
      .filter((v): v is LiveRedeemer => v.guildId === group.guildId && liveRedeemer(v, now, INVITE_AUTH_WINDOW_MS))
    if (rows.length === 0) return null
    const state = await identity.adminState(group.guildId)
    for (const value of rows) {
      const c = await checkRecord(group.guildId, value.record, state)
      if (!c.ok || !inScope({ kind: 'channel', guildId: group.guildId, channelId: group.channelId }, c.record, c.state)) continue
      const keys = deriveInviteKeys(value.seed)
      return signInviteAuth({ signedRecord: value.record, signPrivateKey: keys.sign.privateKey, groupId: group.groupId, leafSignatureKey: identity.self().mlsSignatureKey.publicKey })
    }
    return null
  }

  /**
   * Member: the InviteAuth of an external commit into a 'channel' group. The record checks of §12.16
   * without the expiry: a member can process the commit long after the upload, and Takusen checked
   * the expiry and the join window then.
   */
  async function checkJoin(input: { groupId: Uint8Array; descriptor: GroupDescriptor; authenticatedData: Uint8Array; leafSignatureKey: Uint8Array }): Promise<string | null> {
    const d = input.descriptor
    if (d.kind !== 'channel' || d.guildId === null || d.channelId === null) return 'not a channel group'
    const v = verifyInviteAuth({ auth: input.authenticatedData, groupId: input.groupId, leafSignatureKey: input.leafSignatureKey })
    if (v === null) return 'the InviteAuth does not verify for this group and leaf'
    const c = await checkRecord(d.guildId, v.signedRecord, await identity.adminState(d.guildId), Infinity)
    if (!c.ok) return c.reason
    if (!inScope(d, c.record, c.state)) return 'the channel is not in the scope of the invite'
    // The timeline event takes the group lock, which the caller holds: it runs after the commit.
    spawn(noteJoinRecord(c.record, v.signedRecord, c.state))
    return null
  }

  /**
   * The row of a record that an invite join shows. The invite id comes from the record list of the
   * guild, so that INVITE_DELETE marks the row. Without it (a failed fetch, or an invite that the
   * list does not have), the id stays null until an own commit in a scope group reads the list.
   */
  async function noteJoinRecord(rec: InviteRecord, signed: Uint8Array, state: AdminReplayState): Promise<void> {
    const keyId = toB64url(rec.signPublic)
    let inviteId: string | null = null
    if ((await store.get('invites', keyId))?.inviteId == null) {
      try {
        const find = (list: WireInviteRecord[]) => list.find((w) => w.keyId === keyId)?.inviteId
        inviteId = find(await recordsOf(rec.guildId)) ?? null
        if (inviteId === null) {
          // The cached list can predate the invite.
          records.delete(rec.guildId)
          inviteId = find(await recordsOf(rec.guildId)) ?? null
        }
      } catch (e) {
        report(e)
      }
    }
    await noteRecord(inviteId, rec, signed, state)
  }

  // MARK: - the public surface

  const service: InviteServiceExt = {
    async prepareHistoryInvite(input) {
      const self = identity.self()
      const { guildId, expiresAtMs, maxUses } = input
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0 || !Number.isInteger(maxUses) || maxUses < 0 || maxUses > MAX_U32) {
        throw new CryptoError('Malformed', 'expiresAtMs and maxUses must be non-negative integers')
      }
      let ids: Uint8Array[]
      try {
        ids = input.channelIds.map(uuidToBytes)
      } catch {
        throw new CryptoError('Malformed', 'channel ids must be UUIDs')
      }
      const state = await identity.adminState(guildId)
      if (state === null) throw new CryptoError('Unsupported', 'the guild has no genesis action yet')
      if (!(await transport.guildMembers(guildId)).includes(self.userId) || (perms.guildPermissions(state, self.userId) & AdminBits.ADMINISTRATOR) === 0) {
        throw new CryptoError('Unsupported', 'only an administrator makes an invite with history')
      }
      const unique = new Map(ids.map((b) => [toB64url(b), b]))
      const channelIds = [...unique.values()]
        .sort(compareBytes)
        .map(bytesToUuid)
        .filter((c) => (perms.everyoneChannelPermissions(state, c) & AdminBits.VIEW_CHANNEL) !== 0)
      if (channelIds.length === 0) throw new CryptoError('Unsupported', 'no channel of the input is visible to @everyone')
      if (channelIds.length > INVITE_MAX_SCOPE_CHANNELS) throw new CryptoError('TooLarge', `an invite with history has at most ${INVITE_MAX_SCOPE_CHANNELS} channels`)
      const seed = ctx.random(INVITE_SEED_BYTES)
      const keys = deriveInviteKeys(seed)
      const record = signInviteRecord(
        {
          guildId,
          hpkePublic: keys.hpke.publicKey,
          signPublic: keys.sign.publicKey,
          channelIds,
          adminChainSeq: state.seq,
          expiresAtMs,
          maxUses,
          creatorUserId: self.userId,
          creatorDeviceId: self.deviceId,
        },
        self.mlsSignatureKey.privateKey,
      )
      return { record: toB64url(record), linkSecret: toB64url(seed), channelIds }
    },

    async sendInviteBundles(input) {
      let signed: Uint8Array
      try {
        signed = fromB64url(input.record)
      } catch {
        throw new CryptoError('Malformed', 'the invite record is not base64url')
      }
      const c = await checkRecord(input.guildId, signed, await identity.adminState(input.guildId))
      if (!c.ok) throw new CryptoError('InvalidChain', `the invite record does not verify: ${c.reason}`)
      const { state } = c
      const row = await noteRecord(input.inviteId, c.record, signed, state)
      // The cached list of the guild predates this invite: the next own commit reads it again.
      records.delete(input.guildId)
      // A failed post rejects: the caller revokes the invite, so no link lacks the bundles of
      // its creator (§11). 0 groups: this device holds no group of the scope.
      let sent = 0
      for (const g of await scopeGroups(c.record, state)) {
        const keys = await storedEpochSecrets(store, g.gid, 0, Infinity)
        const newest = keys.at(-1)?.epoch
        if (newest === undefined || (row.bundled[g.gid] ?? -1) >= newest) continue
        await sendBundle(input.inviteId, c.record, g.gid, keys)
        sent++
      }
      return { groups: sent }
    },

    async redeemInvite(input) {
      let seed: Uint8Array
      try {
        seed = fromB64url(input.linkSecret)
      } catch {
        throw new CryptoError('Malformed', 'the link secret is not base64url')
      }
      const { inviteId, signed, rec, imported } = await openBundles(input.code, seed)
      const keyId = toB64url(rec.signPublic)
      const now = ctx.now()
      await store.transaction(['invites'], async (tx) => {
        const old = await tx.get('invites', keyId)
        await tx.put('invites', keyId, {
          guildId: rec.guildId,
          record: signed,
          role: 'redeemed',
          inviteId,
          code: input.code,
          revoked: false,
          expiresAtMs: rec.expiresAtMs,
          bundled: old?.bundled ?? {},
          seed,
          redeemedAtMs: now,
        })
      })
      // Arms the timer that wipes the seed.
      spawn(prune())
      // The channel groups of the scope join now, by external commit with an InviteAuth.
      spawn(groups.sync())
      // The bundle of a commit just before the redemption, or of a commit that adds this device
      // while the redemption runs, can come after the fetch.
      scheduleRefetch(keyId)
      return { groups: new Set(imported.map((k) => toB64url(k.groupId))).size, keys: imported.length }
    },

    async onGatewayEvent(event: CryptoGatewayEvent) {
      if (event.t !== 'INVITE_DELETE') return
      const d = event.d
      records.delete(d.guildId)
      await store.transaction(['invites'], async (tx) => {
        for (const { key, value } of await tx.list('invites')) {
          if (value.inviteId === d.inviteId && value.guildId === d.guildId && !value.revoked) await tx.put('invites', key, { ...value, revoked: true, seed: null })
        }
      })
      spawn(prune())
    },

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background])
    },
  }
  return service
}) satisfies CreateInviteService
