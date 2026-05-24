import { IMumbleService } from '@/shared/IMumbleService'
import { useServerStore, type Server } from '@/stores/serverStore'
import { useOracleStore } from '@/stores/oracleStore'
import { voiceService } from './VoiceService'
import { oracleService } from './OracleService'
import { getMumbleServiceFactory } from './platformRegistry'

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

  async addServer(url: string, port: string, username: string): Promise<void> {
    const serverStore = useServerStore.getState()
    if (serverStore.servers.has(url)) {
      throw new Error(`Server with url ${url} already exists`)
    }
    const portNum = parseInt(port, 10)
    const factory = getMumbleServiceFactory()
    // Optimistically add the row so a freshly-typed (non-Oracle) server gets
    // an entry even if the mint or connect fails. We mark `connected: false`
    // until the handshake lands.
    const newServer: Server = {
      id: url,
      name: url,
      port: portNum,
      connected: false,
      updatedAt: Date.now()
    }
    serverStore.addServer(newServer)

    const oracleToken = await this.resolveOracleToken(newServer)
    const client = await factory({ serverUrl: url, port, username, oracleToken })
    await client.connect(url, port, username, { oracleToken })

    if (client.mumbleClient.isConnected()) {
      connectionManager.add(client)
      serverStore.updateServer(url, { connected: true, lastUsedAt: Date.now() })
      serverStore.setSelectedServerId(url)
      voiceService.initVoice(url)
      this.handleDisconnect(client, url)
      // Fire-and-forget: bump remote lastUsedAt if the server is Oracle-registered.
      const persisted = serverStore.servers.get(url)
      if (persisted?.serverId) void oracleService.touchLastUsed(persisted.serverId)
    }
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
        updatedAt: Date.now()
      })
    } else if (info.serverId) {
      serverStore.updateServer(info.host, { serverId: info.serverId })
    }
    const portStr = info.port.toString()
    // reconnect path handles the actual handshake + mint
    await this.reconnectServer(info.host, portStr, info.username)
  }

  async reconnectServer(url: string, port: string, username: string): Promise<void> {
    const serverStore = useServerStore.getState()
    const server = serverStore.servers.get(url)
    if (!server) {
      throw new Error(`Server with url ${url} does not exist`)
    }
    const factory = getMumbleServiceFactory()
    const oracleToken = await this.resolveOracleToken(server)
    const client = await factory({ serverUrl: url, port, username, oracleToken })
    await client.connect(url, port, username, { oracleToken })

    if (client.mumbleClient?.isConnected()) {
      connectionManager.add(client)
      serverStore.updateServer(url, { connected: true, lastUsedAt: Date.now() })
      voiceService.initVoice(url)
      this.handleDisconnect(client, url)
      const persisted = serverStore.servers.get(url)
      if (persisted?.serverId) void oracleService.touchLastUsed(persisted.serverId)
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
    await this.removeServer(url)
    await this.addServer(url, port, username)
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
