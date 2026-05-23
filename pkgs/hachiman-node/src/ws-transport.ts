import { Observable, Subject } from 'rxjs';
import { ITransport } from './transport';

/**
 * WebSocket transport adapter — wraps a browser WebSocket to implement ITransport.
 * Sends and receives binary frames containing Mumble protocol packets.
 */
export class WsTransport implements ITransport {
  private readonly _data = new Subject<Buffer>();
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url, ['mumble', 'binary']);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = (event: MessageEvent) => {
      const data = event.data as ArrayBuffer;
      this._data.next(Buffer.from(data));
    };

    this.ws.onerror = () => {
      this._data.error(new Error('WebSocket error'));
    };

    this.ws.onclose = () => {
      this._data.complete();
    };
  }

  /** Wait for the WebSocket connection to open. */
  waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => { resolve(); };
      this.ws.onerror = () => { reject(new Error('WebSocket connection failed')); };
    });
  }

  get onData(): Observable<Buffer> {
    return this._data.asObservable();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'));
    }
    this.ws.send(data as Uint8Array<ArrayBuffer>);
    return Promise.resolve();
  }

  close(): void {
    this.ws.close();
  }
}
