import type { IMumbleService } from '@hachiman/hachiman'
import {
  ACL,
  Channel,
  Client,
  Events,
  PersistedMessage,
  TextMessage,
  User,
  Permissions
} from '@hachiman/hachiman-node'
import { CertificateCreationResult } from 'pem'

export class MumbleService implements IMumbleService {
  private _rootClient: Client
  private _oracleToken: string | undefined

  constructor(
    serverUrl: string,
    port: string,
    username: string,
    cert: CertificateCreationResult,
    opts?: { oracleToken?: string; password?: string }
  ) {
    this._oracleToken = opts?.oracleToken
    this._rootClient = new Client({
      host: serverUrl,
      port: parseInt(port, 10),
      username,
      cert: cert.certificate,
      key: cert.clientKey,
      rejectUnauthorized: false,
      webrtc: true,
      ...(this._oracleToken ? { oracleToken: this._oracleToken } : {}),
      ...(opts?.password ? { password: opts.password } : {})
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

  async connect(
    _serverUrl?: string,
    _port?: string,
    _username?: string,
    opts?: { oracleToken?: string; password?: string }
  ): Promise<Client> {
    if (this.isConnected()) {
      return this._rootClient
    }

    // Latest-call token / password wins, in case ServersService re-resolves
    // between construction and connect. Both are read from the Client's
    // options inside `authenticate()`, so we mutate options in place — the
    // Client hasn't authenticated yet at this point.
    if (opts?.oracleToken !== undefined) {
      this._oracleToken = opts.oracleToken
      this._rootClient.options.oracleToken = opts.oracleToken
    }
    if (opts?.password !== undefined) {
      this._rootClient.options.password = opts.password
    }

    await this._rootClient.connect()
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

  async fetchChannelMessages(opts: {
    channelId: number
    beforeId?: bigint
    limit?: number
  }): Promise<{ messages: PersistedMessage[]; hasMore: boolean }> {
    return this._rootClient.fetchChannelMessages(opts)
  }

  recieveAudioFrame(_onAudio: (decoded: Buffer) => void): void {
    // No-op: WebRTC handles audio playback natively via HTMLAudioElement
  }

  async startMicrophone(): Promise<void> {
    await this._rootClient.webrtcVoice?.startMicrophone()
    await this._rootClient.webrtcVoice?.sendTalkingState(1)
  }

  stopMicrophone(): void {
    this._rootClient.webrtcVoice?.sendTalkingState(0)
    this._rootClient.webrtcVoice?.stopMicrophone()
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

  async fetchAcl(channelId: number): Promise<ACL> {
    const channel = this._rootClient.channels.byId(channelId)
    if (!channel) throw new Error(`Channel ${channelId} not found`)
    return await channel.fetchAcl()
  }

  async saveAcl(channelId: number, acl: ACL): Promise<void> {
    const channel = this._rootClient.channels.byId(channelId)
    if (!channel) throw new Error(`Channel ${channelId} not found`)
    await channel.saveAcl(acl)
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
