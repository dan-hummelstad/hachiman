export interface ClientOptions {
  /**
   * The host URL.
   */
  host: string

  /**
   * The port number.
   * Default: 64738
   */
  port: number

  /**
   * Username to use when logging in to the Mumble server.
   */
  username: string

  /**
   * Server or user password.
   */
  password?: string

  /**
   * Additional access tokens for server ACL groups.
   */
  tokens?: string[]

  /**
   * Client name.
   * Default: 'hachiman-client'
   */
  clientName?: string

  /**
   * The interval the bot will send pings to the server (in milliseconds).
   * It has to be less than 30000 (30 seconds), otherwise the server will kick the client.
   * Default: 10000 (10 seconds)
   */
  pingInterval?: number

  // --- TLS-specific options (used when transport is 'tls') ---

  /**
   * PEM-encoded client certificate (string or Buffer).
   */
  cert?: string | Buffer

  /**
   * PEM-encoded client private key (string or Buffer).
   */
  key?: string | Buffer

  /**
   * Whether to reject unauthorized TLS connections.
   * Default: true
   */
  rejectUnauthorized?: boolean

  // --- Transport options ---

  /**
   * Transport mode: 'tls' uses a Node.js TLS socket (default),
   * 'websocket' uses a browser-compatible WebSocket.
   */
  transport?: 'tls' | 'websocket'

  /**
   * WebSocket URL. Required when transport is 'websocket'.
   * Example: 'ws://localhost:443'
   */
  wsUrl?: string

  /**
   * Whether to request WebRTC voice transport instead of native UDP.
   * Works with any transport — SDP/ICE messages flow over the control
   * channel while voice goes through the WebRTC PeerConnection.
   */
  webrtc?: boolean
}
