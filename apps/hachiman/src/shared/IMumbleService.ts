import { Client, User, Channel, Permissions } from '@hachiman/hachiman-node'
import type { Events } from '@hachiman/hachiman-node'

export interface IMumbleService {
  // Core client access
  get mumbleClient(): Client
  get clientSession(): number | null

  // Connection management
  connect: (serverUrl: string, port: string, username: string) => Promise<Client>
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

  recieveAudioFrame: (onAudio: (decoded: Buffer) => void) => void

  // User management (admin functions)
  fetchRegisteredUsers: () => Promise<Array<{ userId: number; name: string }>>
  deregisterUser: (userId: number) => Promise<void>
  renameRegisteredUser: (userId: number, name: string) => Promise<void>

  // Permissions
  getChannelPermissions: (channelId: number) => Promise<Permissions | undefined>

  // Event handling
  on<K extends keyof Events>(event: K, listener: Events[K]): void
  once<K extends keyof Events>(event: K, listener: Events[K]): void
  off<K extends keyof Events>(event: K, listener: Events[K]): void
  removeAllListeners<K extends keyof Events>(event?: K): void
}

// Re-export common event types for convenience
export type MumbleEvents = Events
export type MumbleEventHandler<K extends keyof Events> = (data: Events[K]) => void
