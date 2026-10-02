// Hand-rolled WebSocket fake for the node test env (no jsdom).
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('no socket opened')
    return ws
  }
  readyState = 1
  sent: { op: unknown; d: unknown }[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onopen: (() => void) | null = null
  closedWith: number | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { op: unknown; d: unknown })
  }
  close(code = 1000): void {
    this.closedWith = code
    this.readyState = 3
  }
  /** Server → client frame. */
  recv(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  /** Server-side close. */
  drop(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  ops(): unknown[] {
    return this.sent.map(f => f.op)
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = []
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
}
