import { ConnectionRejectedError, Reject_RejectType } from '@hachiman/hachiman-node'
import { IMumbleService } from '@/shared/IMumbleService'
import { useServerStore, type Server } from '@/stores/serverStore'
import { useOracleStore } from '@/stores/oracleStore'
import { deriveServerId } from '@/lib/server-key'
import { voiceService } from './VoiceService'
import { oracleService } from './OracleService'
import { getMumbleServiceFactory } from './platformRegistry'

/**
 * When a server rejects an anonymous connection with `AuthenticatorFail`
 * (Grumble's signal for "this server is OracleOnly"), and the client already
 * has a signed-in Oracle session, we treat the rejection as an instruction
 * to retry with the Oracle path instead of surfacing the error or — worse —
 * triggering a fresh PKCE flow the user has already completed.
 */
function shouldRetryWithOracle(err: unknown): boolean {
  if (!(err instanceof ConnectionRejectedError)) return false
  if (err.reject.type !== Reject_RejectType.AuthenticatorFail) return false
  return useOracleStore.getState().session !== null
}

/**
 * Connection parameters for adding or reconnecting to a server.
 *
 * Anonymous joins are no longer supported — every connect MUST satisfy
 * exactly one of:
 *   - `useOracle: true` with an active Oracle session (mints a per-server
 *     token; `serverId` recommended for managed servers).
 *   - `superUser: true` with a non-empty `password` (self-hosted only;
 *     managed Oracle servers reject SuperUser via `OracleOnly=true`).
 *
 * `username` is informational for Oracle (we use the handle from the session
 * instead) and ignored for SuperUser (we send the literal "SuperUser").
 */
export interface ConnectOptions {
  /**
   * The actual network host of the server (e.g. "localhost",
   * "gateway.example.com"). NOT used as the local store key — see
   * {@link deriveServerId}. Kept named `url` for backward compatibility
   * with callers; semantically it's the host.
   */
  url: string
  port: string
  username: string
  useOracle: boolean
  /** Self-hosted SuperUser mode. Requires `password` and forces username. */
  superUser?: boolean
  password?: string
  /** Display name for first-time adds. Defaults to the host if omitted. */
  name?: string
  /** Oracle server UUID. Required when `useOracle: true` to mint a token. */
  serverId?: string
}

/**
 * The literal Mumble admin username. SuperUser is the only username allowed
 * on the manual/self-hosted path now that anonymous joins are gone.
 */
export const SUPERUSER_USERNAME = 'SuperUser'

// Services to manage the interaction between the app and multiple Mumble servers
// Basically the interface between the actual mumble connection and the interface state.
export class ServersService {
  /**
   * Resolve an Oracle-minted per-server token for `server`, if applicable.
   * Returns undefined if the user is not signed in, the server isn't
   * Oracle-registered, or the mint fails. Non-blocking on failure — callers
   * should proceed with anonymous connect and surface a soft warning.
   */
  private async resolveOracleToken(server: Pick<Server, 'serverId'>): Promise<string | undefined> {
    const oracleStore = useOracleStore.getState()
    if (!oracleStore.session) return undefined
    if (!server.serverId) return undefined
    return await oracleService.mintServerToken(server.serverId)
  }

  async addServer(opts: ConnectOptions): Promise<void> {
    // Anonymous joins are gone — every add must declare an auth mode up front.
    // The SuperUser path is mutually exclusive with Oracle and requires a
    // password we never persist.
    if (!opts.useOracle && !opts.superUser) {
      throw new Error(
        'Cannot add server: choose Oracle sign-in or self-hosted SuperUser. Anonymous joins are no longer supported.'
      )
    }
    if (opts.useOracle && opts.superUser) {
      throw new Error('Cannot add server: useOracle and superUser are mutually exclusive')
    }
    if (opts.superUser && !opts.password) {
      throw new Error('SuperUser mode requires a password')
    }

    const serverStore = useServerStore.getState()
    const portNum = parseInt(opts.port, 10)
    const host = opts.url
    // Derive the store key BEFORE the dedupe check — managed servers key on
    // their Takusen UUID so multiple vServers can share a gateway host;
    // self-hosted servers key on `${host}:${port}` so localhost:64738 and
    // localhost:64739 don't collide.
    const id = deriveServerId({ serverId: opts.serverId, host, port: portNum })
    if (serverStore.servers.has(id)) {
      const human = opts.serverId
        ? `Server "${opts.name ?? host}" is already added`
        : `Server "${host}:${portNum}" is already added`
      throw new Error(`${human}. Remove it from the rail first if you want to re-add it.`)
    }
    const effectiveUsername = opts.superUser ? SUPERUSER_USERNAME : opts.username
    // Optimistically add the row so a freshly-typed (non-Oracle) server gets
    // an entry even if the mint or connect fails. We mark `connected: false`
    // until the handshake lands. `password` is never persisted — it's only
    // held in memory for the lifetime of this call.
    const newServer: Server = {
      id,
      name: opts.name ?? host,
      host,
      port: portNum,
      connected: false,
      serverId: opts.serverId,
      username: effectiveUsername,
      useOracle: opts.useOracle,
      superUser: opts.superUser ?? false,
      updatedAt: Date.now()
    }
    serverStore.addServer(newServer)

    try {
      await this.attemptConnect(id, opts.port, effectiveUsername, opts.useOracle, opts.password)
    } catch (err) {
      // OracleOnly-rejected SuperUser attempt with an active Oracle session is
      // probably a managed server that doesn't accept SuperUser at all — flip
      // the row over to Oracle for the retry so future reconnects skip the
      // bounce. We only attempt this for non-Oracle starts (Oracle starts
      // already failed for some other reason).
      if (opts.useOracle || !shouldRetryWithOracle(err)) throw err
      const handle = useOracleStore.getState().session?.user.handle ?? opts.username
      serverStore.updateServer(id, { useOracle: true, superUser: false, username: handle })
      await this.attemptConnect(id, opts.port, handle, true, undefined)
    }
    // Whether the first attempt succeeded or the Oracle retry did, the user
    // expects the freshly-added server to be the active one.
    serverStore.setSelectedServerId(id)
  }

  /**
   * Single connect attempt. Resolves an Oracle token if `useOracle` is true,
   * wires up the factory + connect handshake, and registers the resulting
   * client with the connection manager + voice service on success.
   *
   * Refuses to connect anonymously: at least one of an Oracle token or a
   * SuperUser+password combo must be available, or we throw before opening
   * the socket. This is the last-mile guard against the duplicate-`HachimanUser`
   * bug: even if some caller forgets the upfront validation, we still bail.
   */
  private async attemptConnect(
    id: string,
    port: string,
    username: string,
    useOracle: boolean,
    password: string | undefined
  ): Promise<void> {
    const serverStore = useServerStore.getState()
    const newServer = serverStore.servers.get(id)
    if (!newServer) throw new Error(`Server with id ${id} not found`)
    // The actual network host comes off the record. `id` may be a Takusen
    // UUID and is not a valid network address; passing it to the factory
    // would have the WebSocket layer try to resolve a UUID as DNS.
    const host = newServer.host
    const oracleToken = useOracle ? await this.resolveOracleToken(newServer) : undefined

    // Hard refusal: no anonymous joins. Either we have an Oracle token, OR
    // this is the SuperUser path with a non-empty password.
    const isSuperUserAttempt = username === SUPERUSER_USERNAME && (password ?? '').length > 0
    if (!oracleToken && !isSuperUserAttempt) {
      // Distinguish the three failure modes so the user can actually fix it.
      // "no session" was the old catch-all and lied when the real cause was a
      // missing `serverId` on the persisted row (entries added before the
      // join-payload schema included it).
      if (!useOracle) {
        throw new Error(
          'Anonymous joins are no longer supported. Sign in to Takusen, or supply a SuperUser password for self-hosted servers.'
        )
      }
      const hasSession = useOracleStore.getState().session !== null
      if (!hasSession) {
        throw new Error(
          'Oracle sign-in required for this server, but no Oracle session is available.'
        )
      }
      if (!newServer.serverId) {
        throw new Error(
          `"${newServer.name ?? host}" is missing its Oracle server id (old entry). Remove it from the rail and re-add it via the join link to fix.`
        )
      }
      throw new Error(
        `Could not mint an Oracle access token for "${newServer.name ?? host}". Check the Oracle is reachable, then retry.`
      )
    }

    const factory = getMumbleServiceFactory()
    const client = await factory({
      serverUrl: host,
      port,
      username,
      oracleToken,
      password
    })
    await client.connect(host, port, username, { oracleToken, password })

    if (!client.mumbleClient.isConnected()) return
    connectionManager.add(id, client)
    serverStore.updateServer(id, { connected: true, lastUsedAt: Date.now() })
    voiceService.initVoice(id)
    this.handleDisconnect(client, id)
    const persisted = serverStore.servers.get(id)
    if (persisted?.serverId) void oracleService.touchLastUsed(persisted.serverId)
  }

  /**
   * Public surface for callers (e.g. deep-link handler) that have an already-
   * resolved server record and want to add+connect in a single step.
   *
   * Refuses if the server is already in the local list — silently re-using
   * the row would (a) hide the previous connection state from the user and
   * (b) reintroduce the duplicate-`HachimanUser` bug we fixed by removing
   * anonymous defaults. Caller should remove the existing entry first or
   * route through the normal "select existing server" UI.
   *
   * Also refuses without an Oracle session — the only entry point through
   * this method is the join-link / Takusen flow, which fundamentally requires
   * a signed-in Oracle identity.
   */
  async addAndConnect(info: {
    host: string
    port: number
    name?: string
    serverId?: string
    username: string
  }): Promise<void> {
    const serverStore = useServerStore.getState()
    const id = deriveServerId({ serverId: info.serverId, host: info.host, port: info.port })
    if (serverStore.servers.has(id)) {
      const human = info.serverId
        ? `Server "${info.name ?? info.host}" is already added`
        : `Server "${info.host}:${info.port}" is already added`
      throw new Error(`${human} — disconnect or remove it first if you want to re-join.`)
    }
    const oracleSession = useOracleStore.getState().session
    if (!oracleSession) {
      throw new Error('Sign in to Takusen to join a server via an invite link.')
    }
    serverStore.addServer({
      id,
      name: info.name ?? info.host,
      host: info.host,
      port: info.port,
      connected: false,
      serverId: info.serverId,
      username: oracleSession.user.handle,
      useOracle: true,
      superUser: false,
      updatedAt: Date.now()
    })
    const portStr = info.port.toString()
    // reconnect path handles the actual handshake + mint; pass the derived
    // id so the store lookup and connection-manager indexing both line up.
    await this.reconnectServer({
      url: id,
      port: portStr,
      username: oracleSession.user.handle,
      useOracle: true
    })
  }

  /**
   * Reconnect to a previously-added server. Reads `username` / `useOracle` /
   * `superUser` from the persisted row; callers can override (e.g. to supply
   * a SuperUser password that we never persist). Throws if the server isn't
   * in the store, OR if the row is in legacy/anonymous shape (neither
   * `useOracle` nor `superUser`) — those rows can't be auto-reconnected and
   * the user is asked to re-add them via the dialog.
   */
  async reconnectServer(opts: {
    /**
     * Store key — Takusen UUID for managed, `${host}:${port}` for self-
     * hosted. Kept named `url` for backward compatibility with callers; the
     * service uses it as the store key, NOT as the network address (which
     * lives on `server.host`).
     */
    url: string
    port: string
    /** Overrides the persisted username for this attempt only. */
    username?: string
    /** Required for SuperUser reconnects — never persisted. */
    password?: string
    /** Forces the Oracle path on (true) or off (false) for this attempt. */
    useOracle?: boolean
  }): Promise<void> {
    const id = opts.url
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(id)
    if (!server) {
      throw new Error(`Server with id ${id} does not exist`)
    }
    // Derive the effective auth mode. Anonymous (neither Oracle nor SuperUser)
    // is a legacy state — we surface a clear error so the user can re-add.
    const useOracle = opts.useOracle ?? server.useOracle ?? false
    const isSuperUser = !useOracle && (server.superUser ?? false)
    if (!useOracle && !isSuperUser) {
      throw new Error(
        `Cannot reconnect to "${server.name ?? id}": this entry has no auth mode. Remove and re-add the server (Oracle sign-in or self-hosted SuperUser).`
      )
    }
    const username = opts.username ?? (isSuperUser ? SUPERUSER_USERNAME : server.username)
    if (!username) {
      throw new Error(`Cannot reconnect to "${server.name ?? id}": no username available.`)
    }

    try {
      await this.attemptConnect(id, opts.port, username, useOracle, opts.password)
    } catch (err) {
      if (useOracle || !shouldRetryWithOracle(err)) throw err
      const handle = useOracleStore.getState().session?.user.handle ?? username
      serverStore.updateServer(id, {
        useOracle: true,
        superUser: false,
        username: handle
      })
      await this.attemptConnect(id, opts.port, handle, true, undefined)
    }
  }

  async removeServer(id: string): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(id)
    if (!server) {
      throw new Error(`Server with id ${id} not found`)
    }
    // ConnectionManager is keyed on the same store id, so a direct lookup
    // replaces the old "iterate every connection and match on options.host"
    // — that check broke when two managed servers shared a gateway host.
    const mumbleService = connectionManager.get(id)
    if (mumbleService) {
      await mumbleService.disconnect()
      connectionManager.remove(id)
    }
    serverStore.removeServer(id)
    if (server.serverId) void oracleService.deleteRemoteServer(server.serverId)
  }

  moveToServer(id: string): void {
    const serverStore = useServerStore.getState()
    if (!serverStore.servers.has(id)) {
      throw new Error(`Server with id ${id} not found`)
    }
    serverStore.setSelectedServerId(id)
  }

  getServer(id: string): IMumbleService | null {
    return connectionManager.get(id)
  }

  /**
   * Reconcile local server list with Oracle remote list. Called on sign-in.
   *
   * - Remote rows missing locally → added (with their serverId).
   * - Local rows missing remotely → pushed; the returned serverId is patched in.
   * - Conflicts → later `updatedAt` wins. Currently a no-op when keys match
   *   because we don't yet diff the row contents; treat this slot as a TODO
   *   once name/port edits land.
   */
  async syncWithOracle(): Promise<void> {
    if (!useOracleStore.getState().session) return
    const serverStore = useServerStore.getState()
    let remote: Awaited<ReturnType<typeof oracleService.listRemoteServers>>
    try {
      remote = await oracleService.listRemoteServers()
    } catch (e) {
      console.warn('[servers] sync: list failed', e)
      return
    }

    // Remote rows are keyed by their Takusen UUID (`r.id`); local rows whose
    // id matches that UUID are managed entries. We also need the reverse
    // index (UUID → local store id) so the push-result patch knows which
    // local row to update.
    const remoteById = new Map(remote.map((r) => [r.id, r]))
    const localServers = Array.from(serverStore.servers.values())

    // 1) Push local-only rows
    for (const local of localServers) {
      const remoteMatch = local.serverId ? remoteById.get(local.serverId) : undefined
      if (!remoteMatch) {
        const pushed = await oracleService.pushServer(local)
        if (pushed) {
          // The push-back may have minted a fresh serverId for what was a
          // self-hosted row; just stamp it on the existing record. We do NOT
          // re-key the Map here — that would orphan all in-flight references
          // (selectedServerId, connection manager id, etc.). A future
          // "migrate this row to managed" UX can rotate the id explicitly.
          serverStore.updateServer(local.id, { serverId: pushed.id })
        }
      } else {
        // Conflict path: prefer the newer timestamp.
        const localTs = local.updatedAt ?? 0
        if (remoteMatch.updatedAt > localTs) {
          serverStore.updateServer(local.id, {
            name: remoteMatch.name,
            host: remoteMatch.host,
            port: remoteMatch.port,
            serverId: remoteMatch.id,
            lastUsedAt: remoteMatch.lastUsedAt,
            updatedAt: remoteMatch.updatedAt
          })
        } else if (!local.serverId) {
          serverStore.updateServer(local.id, { serverId: remoteMatch.id })
        }
      }
    }

    // 2) Pull remote-only rows. A remote row is "missing locally" iff no
    // local row carries its `serverId` — host-collision is fine now
    // (managed servers can share a gateway host), so we DON'T index by host.
    const localByServerId = new Map(
      localServers
        .filter((s): s is Server & { serverId: string } => Boolean(s.serverId))
        .map((s) => [s.serverId, s])
    )
    for (const r of remote) {
      if (localByServerId.has(r.id)) continue
      // Use the Takusen UUID as the local store id so the keying invariant
      // (managed → UUID, self-hosted → host:port) holds without a migration.
      serverStore.addServer({
        id: r.id,
        name: r.name,
        host: r.host,
        port: r.port,
        connected: false,
        serverId: r.id,
        useOracle: true,
        updatedAt: r.updatedAt,
        lastUsedAt: r.lastUsedAt
      })
    }
  }

  // For now, no updating of servers. The only way a server is updated
  // Is if the admin changes the url which the user can then only change it.
  // TODO: allow the server some config to change things like server name.
  // async updateServer(): Promise<void> {
  async changeServer(
    id: string,
    port: string,
    username: string,
    opts?: { password?: string }
  ): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(id)
    if (!server) {
      throw new Error(`Server with id ${id} not found`)
    }
    const useOracle = server.useOracle ?? false
    const superUser = !useOracle && (server.superUser ?? false)
    await this.removeServer(id)
    await this.addServer({
      // addServer's `url` field is semantically the host — re-add at the
      // same network address. `serverId` is carried through so the derived
      // id matches the row we just removed.
      url: server.host,
      port,
      username,
      useOracle,
      superUser,
      serverId: server.serverId,
      ...(opts?.password ? { password: opts.password } : {})
    })
  }

  private handleDisconnect(client: IMumbleService, id: string): void {
    const serverStore = useServerStore.getState()
    client.mumbleClient.on('disconnect', () => {
      voiceService.cleanup()
      connectionManager.remove(id)
      serverStore.updateServer(id, { connected: false })
    })
  }
}

export const serversService = new ServersService()

class ConnectionManagerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionManagerError'
  }
}

class ConnectionManager {
  // Keyed on the SAME id the serverStore uses (Takusen UUID for managed,
  // `${host}:${port}` for self-hosted). Previously this was indexed on
  // `client.options.host`, which collided when two managed vServers shared
  // a gateway host.
  private _connections = new Map<string, IMumbleService>()

  add(id: string, mumble: IMumbleService): void {
    if (!mumble.mumbleClient?.isConnected()) {
      throw new ConnectionManagerError('Cannot add a disconnected client')
    }
    this._connections.set(id, mumble)
  }

  remove(id: string): void {
    this._connections.delete(id)
  }

  get(id: string): IMumbleService | null {
    return this._connections.get(id) ?? null
  }

  has(id: string): boolean {
    return this._connections.has(id)
  }

  async clear(): Promise<void> {
    for (const mumble of this._connections.values()) {
      await mumble.disconnect()
    }
    this._connections.clear()
  }

  get connections(): IMumbleService[] {
    return Array.from(this._connections.values())
  }
}
// I only ever want one connection manager
// And it should only be used by the ServersService
export const connectionManager = new ConnectionManager()
