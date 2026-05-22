import { Observable, Subject } from 'rxjs'
import { TLSSocket } from 'tls'
import { ITransport } from './transport'

/**
 * TLS transport adapter — wraps a Node.js TLSSocket to implement ITransport.
 */
export class TlsTransport implements ITransport {
  private readonly _data = new Subject<Buffer>()

  constructor(private readonly socket: TLSSocket) {
    this.socket.on('data', (data: Buffer) => {
      this._data.next(data)
    })
    this.socket.on('error', (err) => {
      this._data.error(err)
    })
    this.socket.on('close', () => {
      this._data.complete()
    })
  }

  get onData(): Observable<Buffer> {
    return this._data.asObservable()
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.writable) {
        this.socket.write(data, (err) => {
          if (err) reject(err)
          else resolve()
        })
      } else {
        reject(new Error('socket not writable'))
      }
    })
  }

  close(): void {
    this.socket.end()
  }
}
