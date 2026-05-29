import { Client, User, Channel, Permissions } from '@hachiman/hachiman-node'
import type { ACL, Events, PersistedMessage } from '@hachiman/hachiman-node'

export interface IMumbleService {
  // Core client access
  get mumbleClient(): Client
  get clientSession(): number | null

  // Connection management
  /**
   * Establish the Mumble session.
   *
   * - `oracleToken` is a per-server JWT minted by the Takusen backend; if
   *   present, the server uses it to bind this session to the authenticated
   *   Oracle user (verified badge + cross-device identity).
   * - `password` is the classic Mumble user/server password. Required for the
   *   built-in SuperUser account on self-hosted servers; the Go server
   *   rejects an empty password for username=SuperUser.
   *
   * Token and password are independent — typically you'd send one or the
   * other, but the wire protocol permits both.
   */
  connect: (
    serverUrl: string,
    port: string,
    username: string,
    opts?: { oracleToken?: string; password?: string }
  ) => Promise<Client>
  disconnect: () => Promise<void>
  isConnected: () => boolean

  // User information
  get currentUser(): User | undefined
  get users(): User[]
  getUserBySession: (session: number) => User | undefined
  getUserByName: (name: string) => User | undefined

  // Channel information
  get channels(): Channel[]
  get currentChannel(): Channel | undefined
  getChannelById: (id: number) => Channel | undefined
  getChannelByName: (name: string) => Channel | undefined

  // Server information
  get welcomeText(): string | undefined
  get maxBandwidth(): number | undefined
  get maxUsers(): number | undefined

  // User actions
  moveToChannel: (channelId: number) => Promise<void>
  sendTextMessage: (message: string, channelIds?: number[]) => Promise<void>

  // Chat history (server-persisted)
  fetchChannelMessages: (opts: {
    channelId: number
    beforeId?: bigint
    limit?: number
  }) => Promise<{ messages: PersistedMessage[]; hasMore: boolean }>

  recieveAudioFrame: (onAudio: (decoded: Buffer) => void) => void

  // Voice control (WebRTC)
  startMicrophone: () => Promise<void>
  stopMicrophone: () => void

  // User management (admin functions)
  fetchRegisteredUsers: () => Promise<Array<{ userId: number; name: string }>>
  deregisterUser: (userId: number) => Promise<void>
  renameRegisteredUser: (userId: number, name: string) => Promise<void>

  // Permissions
  getChannelPermissions: (channelId: number) => Promise<Permissions | undefined>

  // ACL administration (SuperUser / WritePermission required server-side).
  // `fetchAcl` returns the full ACL state for `channelId`: groups (with
  // inherited members + add/remove deltas) and ChanACL entries (grant/deny
  // masks per user or group). `saveAcl` writes back; the server expects
  // the same shape with `query` left unset so it persists rather than
  // returning a snapshot.
  fetchAcl: (channelId: number) => Promise<ACL>
  saveAcl: (channelId: number, acl: ACL) => Promise<void>

  // Event handling
  on<K extends keyof Events>(event: K, listener: Events[K]): void
  once<K extends keyof Events>(event: K, listener: Events[K]): void
  off<K extends keyof Events>(event: K, listener: Events[K]): void
  removeAllListeners<K extends keyof Events>(event?: K): void
}

// Re-export common event types for convenience
export type MumbleEvents = Events
export type MumbleEventHandler<K extends keyof Events> = (data: Events[K]) => void

/**
 * Connection parameters the renderer hands to the platform-specific Mumble service factory.
 * Each platform implementation decides how to materialize a connection from these inputs
 * (e.g. Electron generates a TLS cert internally; browser opens a WebSocket).
 */
export interface MumbleConnectOptions {
  serverUrl: string
  port: string
  username: string
  /**
   * Optional per-server Oracle/Takusen access token (JWT). Forwarded by the
   * platform impl to `client.connect()` so the server can verify the
   * authenticated identity. Omit for anonymous connections.
   */
  oracleToken?: string
  /**
   * Mumble user/server password. Required for the built-in SuperUser
   * account on self-hosted servers. Never persisted client-side — supplied
   * fresh per connection attempt.
   */
  password?: string
}

/**
 * Factory that returns a platform-specific IMumbleService for a given connection.
 * Platform apps construct this in their entry point and pass it through PlatformProvider.
 *
 * Implementations may be async (e.g. Electron needs to generate a self-signed cert).
 */
export type IMumbleServiceFactory = (opts: MumbleConnectOptions) => Promise<IMumbleService>
