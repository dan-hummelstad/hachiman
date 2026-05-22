import { Observable } from 'rxjs'

/**
 * Abstract transport interface for MumbleSocket.
 * Allows the socket to work over either TLS (Node.js) or WebSocket (browser).
 */
export interface ITransport {
  /** Write data to the transport. */
  write(data: Uint8Array): Promise<void>
  /** Observable that emits received data chunks. */
  onData: Observable<Buffer>
  /** Close the transport. */
  close(): void
}
