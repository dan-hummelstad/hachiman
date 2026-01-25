import { IMumbleService } from '@/shared/IMumbleService'
import { Channel, Client, Events, Permissions, User } from '@hachiman/hachiman-node'
import { CertificateCreationResult } from 'pem'

export class MumbleService implements IMumbleService {
  private _rootClient: Client

  constructor(serverUrl: string, port: string, username: string, cert: CertificateCreationResult) {
    this._rootClient = new Client({
      host: serverUrl,
      port: parseInt(port, 10),
      username,
      cert: cert.certificate,
      key: cert.clientKey,
      rejectUnauthorized: false
    })
  }
  recieveAudioFrame(onAudio: (decoded: Buffer) => void): void {
    throw new Error('Method not implemented.')
  }

  get mumbleClient(): Client {
    throw new Error('Method not implemented.')
  }
  get clientSession(): number | null {
    throw new Error('Method not implemented.')
  }
  connect!: (serverUrl: string, port: string, username: string) => Promise<Client>
  disconnect!: () => Promise<void>
  isConnected!: () => boolean
  get currentUser(): User | undefined {
    throw new Error('Method not implemented.')
  }
  get users(): User[] {
    throw new Error('Method not implemented.')
  }
  getUserBySession!: (session: number) => User | undefined
  getUserByName!: (name: string) => User | undefined
  get channels(): Channel[] {
    throw new Error('Method not implemented.')
  }
  get currentChannel(): Channel | undefined {
    throw new Error('Method not implemented.')
  }
  getChannelById!: (id: number) => Channel | undefined
  getChannelByName!: (name: string) => Channel | undefined
  get welcomeText(): string | undefined {
    throw new Error('Method not implemented.')
  }
  get maxBandwidth(): number | undefined {
    throw new Error('Method not implemented.')
  }
  get maxUsers(): number | undefined {
    throw new Error('Method not implemented.')
  }
  moveToChannel!: (channelId: number) => Promise<void>
  sendTextMessage!: (message: string, channelIds?: number[]) => Promise<void>
  fetchRegisteredUsers!: () => Promise<Array<{ userId: number; name: string }>>
  deregisterUser!: (userId: number) => Promise<void>
  renameRegisteredUser!: (userId: number, name: string) => Promise<void>
  getChannelPermissions!: (channelId: number) => Promise<Permissions | undefined>
  on<K extends keyof Events>(event: K, listener: Events[K]): void {
    throw new Error('Method not implemented.')
  }
  once<K extends keyof Events>(event: K, listener: Events[K]): void {
    throw new Error('Method not implemented.')
  }
  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    throw new Error('Method not implemented.')
  }
  removeAllListeners<K extends keyof Events>(event?: K): void {
    throw new Error('Method not implemented.')
  }
}
