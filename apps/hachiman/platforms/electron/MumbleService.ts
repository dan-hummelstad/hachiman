import { IMumbleService } from '@/shared/IMumbleService'
import { Channel, Client, Events, TextMessage, User, Permissions } from '@hachiman/hachiman-node'
import { CertificateCreationResult } from 'pem'
import { OpusEncoder } from '@discordjs/opus'

export class MumbleService implements IMumbleService {
  private _rootClient: Client
  private _opus = new OpusEncoder(48_000, 2)

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

  get mumbleClient(): Client {
    return this._rootClient
  }

  get clientSession(): number | null {
    if (!this._rootClient.isConnected()) {
      return null
    }
    return this._rootClient.session
  }

  get channels(): Channel[] {
    return this._rootClient.channels.all()
  }

  get currentUser(): User | undefined {
    return this._rootClient.self
  }

  get users(): User[] {
    return this._rootClient.users.all()
  }

  isConnected(): boolean {
    return this._rootClient?.isConnected() ?? false
  }

  async connect(): Promise<Client> {
    if (this.isConnected()) {
      return this._rootClient
    }

    await this._rootClient.connect()
    for (const channel of this._rootClient.channels.findAll(() => true)) {
      console.log(`Channel: ${channel.name} (ID: ${channel.id})`)
    }
    return this._rootClient
  }

  async disconnect(): Promise<void> {
    this._rootClient.disconnect()
  }

  getUserBySession(session: number): User | undefined {
    return this._rootClient.users.bySession(session)
  }
  getUserByName(name: string): User | undefined {
    return this._rootClient.users.byName(name)
  }

  get currentChannel(): Channel | undefined {
    return this._rootClient.self?.channel
  }

  getChannelById(id: number): Channel | undefined {
    return this._rootClient.channels.byId(id)
  }

  getChannelByName(name: string): Channel | undefined {
    return this._rootClient.channels.byName(name)
  }

  get welcomeText(): string | undefined {
    return this._rootClient.welcomeText
  }
  get maxBandwidth(): number | undefined {
    return this._rootClient.serverConfig?.maxBandwidth
  }
  get maxUsers(): number | undefined {
    return this._rootClient.serverConfig?.maxUsers
  }

  async moveToChannel(channelId: number): Promise<void> {
    await this._rootClient.self?.moveToChannel(channelId)
  }

  async sendTextMessage(message: string, channelIds?: number[]): Promise<void> {
    return await this._rootClient.socket?.send(
      TextMessage,
      TextMessage.create({
        actor: this._rootClient.self!.session,
        message: message,
        channelId: channelIds ?? [],
        treeId: [],
        session: []
      })
    )
  }

  recieveAudioFrame(onAudio: (decoded: Buffer) => void): void {
    this._rootClient.socket?.audioPacket.subscribe((packet) => {
      const decoded = this._opus.decode(packet.data)
      onAudio(decoded)
    })
  }

  async fetchRegisteredUsers(): Promise<Array<{ userId: number; name: string }>> {
    return (await this._rootClient.fetchRegisteredUsers()).map((user) => ({
      userId: user.userId,
      name: user.name ?? 'no-name'
    }))
  }

  async deregisterUser(userId: number): Promise<void> {
    return await this._rootClient.deregisterUser(userId)
  }

  async renameRegisteredUser(userId: number, name: string): Promise<void> {
    return await this._rootClient.renameRegisteredUser(userId, name)
  }

  async getChannelPermissions(channelId: number): Promise<Permissions | undefined> {
    return await this._rootClient.channels.byId(channelId)?.getPermissions()
  }

  on<K extends keyof Events>(event: K, listener: Events[K]): void {
    this._rootClient.on(event, listener)
  }
  once<K extends keyof Events>(event: K, listener: Events[K]): void {
    this._rootClient.once(event, listener)
  }
  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    this._rootClient.off(event, listener)
  }
  removeAllListeners<K extends keyof Events>(event?: K): void {
    this._rootClient.removeAllListeners(event)
  }
}
