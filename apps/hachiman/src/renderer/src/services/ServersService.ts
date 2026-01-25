import { IMumbleService } from '@/shared/IMumbleService'
import { MumbleService } from '@platform/MumbleService'
import { useServerStore } from '@renderer/stores/serverStore'

import {
  CertificateCreationOptions,
  CertificateCreationResult,
  createCertificate as createCertificateCb
} from 'pem'

// This should be called get and should retrieve the certificate instead of creating a new one each time.
export async function createCertificate(
  options: CertificateCreationOptions
): Promise<CertificateCreationResult> {
  return new Promise<CertificateCreationResult>((resolve, reject) => {
    createCertificateCb(options, (err, result) => {
      if (err) {
        reject(err)
      } else {
        resolve(result)
      }
    })
  })
}

// Services to manage the interaction between the app and multiple Mumble servers
// Basically the interface between the actual mumble connection and the interface state.
export class ServersService {
  async addServer(url: string, port: string, username: string): Promise<void> {
    const serverStore = useServerStore.getState()
    if (serverStore.servers.has(url)) {
      throw new Error(`Server with url ${url} already exists`)
    }
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const client = new MumbleService(url, port, username, cert)
    await client.connect(url, port, username)

    if (client.mumbleClient.isConnected()) {
      connectionManager.add(client)
      serverStore.addServer({
        id: url,
        name: url,
        port: parseInt(port, 10),
        connected: true
      })
      serverStore.setSelectedServerId(url)
      this.handleDisconnect(client, url)
    }
  }

  async reconnectServer(url: string, port: string, username: string): Promise<void> {
    const serverStore = useServerStore.getState()
    if (!serverStore.servers.has(url)) {
      throw new Error(`Server with url ${url} does not exist`)
    }
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const client = new MumbleService(url, port, username, cert)
    await client.connect(url, port, username)

    if (client.mumbleClient?.isConnected()) {
      connectionManager.add(client)
      serverStore.updateServer(url, { connected: true })
      this.handleDisconnect(client, url)
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

  private handleDisconnect(client: IMumbleService, url: string): void {
    const serverStore = useServerStore.getState()
    client.mumbleClient.on('disconnect', () => {
      connectionManager.remove(client.mumbleClient?.options.host ?? '')
      serverStore.updateServer(url, { connected: false })
    })
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
