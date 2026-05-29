import { ConnectionRejectedError, Reject_RejectType } from '@hachiman/hachiman-node'
import { IMumbleService } from '@/shared/IMumbleService'
import { useServerStore, type Server } from '@/stores/serverStore'
import { useOracleStore } from '@/stores/oracleStore'
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
 * Connection parameters for adding or reconnecting to a server. `useOracle`
 * picks the auth path: true → mint an Oracle token (requires `serverId` and
 * an active session); false → send `username` + optional `password` verbatim.
 * Mumble's built-in SuperUser account requires `useOracle: false` and a
 * non-empty password.
 */
export interface ConnectOptions {
  url: string
  port: string
  username: string
  useOracle: boolean
  password?: string
  /** Display name for first-time adds. Defaults to the host if omitted. */
  name?: string
  /** Oracle server UUID. Required when `useOracle: true` to mint a token. */
  serverId?: string
}

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
    const serverStore = useServerStore.getState()
    if (serverStore.servers.has(opts.url)) {
      throw new Error(`Server with url ${opts.url} already exists`)
    }
    const portNum = parseInt(opts.port, 10)
    // Optimistically add the row so a freshly-typed (non-Oracle) server gets
    // an entry even if the mint or connect fails. We mark `connected: false`
    // until the handshake lands. `password` is never persisted — it's only
    // held in memory for the lifetime of this call.
    const newServer: Server = {
      id: opts.url,
      name: opts.name ?? opts.url,
      port: portNum,
      connected: false,
      serverId: opts.serverId,
      username: opts.username,
      useOracle: opts.useOracle,
      updatedAt: Date.now()
    }
    serverStore.addServer(newServer)

    try {
      await this.attemptConnect(opts.url, opts.port, opts.username, opts.useOracle, opts.password)
    } catch (err) {
      if (opts.useOracle || !shouldRetryWithOracle(err)) throw err
      // Server is OracleOnly and we have a session — retry transparently
      // using the Oracle path. Patch the persisted record so future
      // reconnects skip the bounce.
      const handle = useOracleStore.getState().session?.user.handle ?? opts.username
      serverStore.updateServer(opts.url, { useOracle: true, username: handle })
      await this.attemptConnect(opts.url, opts.port, handle, true, undefined)
    }
    // Whether the first attempt succeeded or the Oracle retry did, the user
    // expects the freshly-added server to be the active one.
    serverStore.setSelectedServerId(opts.url)
  }

  /**
   * Single connect attempt. Resolves an Oracle token if `useOracle` is true,
   * wires up the factory + connect handshake, and registers the resulting
   * client with the connection manager + voice service on success.
   */
  private async attemptConnect(
    url: string,
    port: string,
    username: string,
    useOracle: boolean,
    password: string | undefined
  ): Promise<void> {
    const serverStore = useServerStore.getState()
    const newServer = serverStore.servers.get(url)
    if (!newServer) throw new Error(`Server with url ${url} not found`)
    const oracleToken = useOracle ? await this.resolveOracleToken(newServer) : undefined
    const factory = getMumbleServiceFactory()
    const client = await factory({
      serverUrl: url,
      port,
      username,
      oracleToken,
      password
    })
    await client.connect(url, port, username, { oracleToken, password })

    if (!client.mumbleClient.isConnected()) return
    connectionManager.add(client)
    serverStore.updateServer(url, { connected: true, lastUsedAt: Date.now() })
    voiceService.initVoice(url)
    this.handleDisconnect(client, url)
    const persisted = serverStore.servers.get(url)
    if (persisted?.serverId) void oracleService.touchLastUsed(persisted.serverId)
  }

  /**
   * Public surface for callers (e.g. deep-link handler) that have an already-
   * resolved server record and want to add+connect in a single step.
   */
  async addAndConnect(info: {
    host: string
    port: number
    name?: string
    serverId?: string
    username: string
  }): Promise<void> {
    const serverStore = useServerStore.getState()
    if (!serverStore.servers.has(info.host)) {
      serverStore.addServer({
        id: info.host,
        name: info.name ?? info.host,
        port: info.port,
        connected: false,
        serverId: info.serverId,
        username: info.username,
        useOracle: Boolean(useOracleStore.getState().session && info.serverId),
        updatedAt: Date.now()
      })
    } else if (info.serverId) {
      serverStore.updateServer(info.host, { serverId: info.serverId })
    }
    const portStr = info.port.toString()
    // reconnect path handles the actual handshake + mint
    await this.reconnectServer({ url: info.host, port: portStr, username: info.username })
  }

  /**
   * Reconnect to a previously-added server. Reads `username` / `useOracle`
   * from the persisted row; callers can override (e.g. to supply a SuperUser
   * password that we never persist). Throws if the server isn't in the store.
   */
  async reconnectServer(opts: {
    url: string
    port: string
    /** Overrides the persisted username for this attempt only. */
    username?: string
    /** Required for SuperUser reconnects — never persisted. */
    password?: string
    /** Forces the Oracle path on (true) or off (false) for this attempt. */
    useOracle?: boolean
  }): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(opts.url)
    if (!server) {
      throw new Error(`Server with url ${opts.url} does not exist`)
    }
    const username = opts.username ?? server.username ?? 'HachimanUser'
    const useOracle =
      opts.useOracle ??
      server.useOracle ??
      Boolean(useOracleStore.getState().session && server.serverId)

    try {
      await this.attemptConnect(opts.url, opts.port, username, useOracle, opts.password)
    } catch (err) {
      if (useOracle || !shouldRetryWithOracle(err)) throw err
      const handle = useOracleStore.getState().session?.user.handle ?? username
      serverStore.updateServer(opts.url, { useOracle: true, username: handle })
      await this.attemptConnect(opts.url, opts.port, handle, true, undefined)
    }
  }

  async removeServer(url: string): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(url)
    if (!server) {
      throw new Error(`Server with url ${url} not found`)
    }
    const mumbleService = connectionManager.connections.find(
      (mumble) => mumble.mumbleClient?.isConnected() && mumble.mumbleClient?.options.host === url
    )
    if (mumbleService) {
      await mumbleService.disconnect()
      connectionManager.remove(mumbleService.mumbleClient?.options.host ?? '')
    }
    serverStore.removeServer(url)
    if (server.serverId) void oracleService.deleteRemoteServer(server.serverId)
  }

  moveToServer(url: string): void {
    const serverStore = useServerStore.getState()
    if (!serverStore.servers.has(url)) {
      throw new Error(`Server with url ${url} not found`)
    }
    serverStore.setSelectedServerId(url)
  }

  getServer(url: string): IMumbleService | null {
    return connectionManager.get(url)
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

    const remoteByHost = new Map(remote.map((r) => [r.host, r]))
    const localServers = Array.from(serverStore.servers.values())

    // 1) Push local-only rows
    for (const local of localServers) {
      const r = remoteByHost.get(local.id)
      if (!r) {
        const pushed = await oracleService.pushServer(local)
        if (pushed) {
          serverStore.updateServer(local.id, { serverId: pushed.id })
        }
      } else {
        // Conflict path: prefer the newer timestamp.
        const localTs = local.updatedAt ?? 0
        if (r.updatedAt > localTs) {
          serverStore.updateServer(local.id, {
            name: r.name,
            port: r.port,
            serverId: r.id,
            lastUsedAt: r.lastUsedAt,
            updatedAt: r.updatedAt
          })
        } else if (!local.serverId) {
          serverStore.updateServer(local.id, { serverId: r.id })
        }
      }
    }

    // 2) Pull remote-only rows
    for (const r of remote) {
      if (!serverStore.servers.has(r.host)) {
        serverStore.addServer({
          id: r.host,
          name: r.name,
          port: r.port,
          connected: false,
          serverId: r.id,
          updatedAt: r.updatedAt,
          lastUsedAt: r.lastUsedAt
        })
      }
    }
  }

  // For now, no updating of servers. The only way a server is updated
  // Is if the admin changes the url which the user can then only change it.
  // TODO: allow the server some config to change things like server name.
  // async updateServer(): Promise<void> {
  async changeServer(url: string, port: string, username: string): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(url)
    if (!server) {
      throw new Error(`Server with url ${url} not found`)
    }
    const useOracle = server.useOracle ?? false
    await this.removeServer(url)
    await this.addServer({ url, port, username, useOracle })
  }

  private handleDisconnect(client: IMumbleService, url: string): void {
    const serverStore = useServerStore.getState()
    client.mumbleClient.on('disconnect', () => {
      voiceService.cleanup()
      connectionManager.remove(client.mumbleClient?.options.host ?? '')
      serverStore.updateServer(url, { connected: false })
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
  private _connections = new Map<string, IMumbleService>()

  add(mumble: IMumbleService): void {
    if (!mumble.mumbleClient?.isConnected()) {
      throw new ConnectionManagerError('Cannot add a disconnected client')
    }
    this._connections.set(mumble.mumbleClient.options.host, mumble)
  }

  remove(host: string): void {
    this._connections.delete(host)
  }

  get(host: string): IMumbleService | null {
    return this._connections.get(host) ?? null
  }

  has(host: string): boolean {
    return this._connections.has(host)
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
