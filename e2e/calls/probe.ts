/**
 * The init script of every test page (plain browser JS, no imports). It runs before the app and
 * only observes; the app code is unchanged.
 *
 * - window.__pcs: every RTCPeerConnection, for getStats() and the sender/receiver transforms.
 * - window.__frames: one entry per RTCRtpScriptTransform with its options and the last
 *   FrameStatsMessage of the transform Worker. The probe puts a relay MessageChannel between the
 *   crypto Worker port and the transform Worker, so it sees the stats (§12.10.2 "FrameStatsMessage").
 *   It forwards every message both ways unchanged.
 * - getDisplayMedia: a canvas test pattern (no picker in any engine, the same in each).
 * - getUserMedia (opt-in, for engines without fake devices): a 440 Hz tone.
 */
export function probe(opts: { fakeMic: boolean }): void {
  const w = window as unknown as Record<string, unknown>
  const pcs: RTCPeerConnection[] = []
  const frames: { role: string; track: string; userId: string | null; stats: unknown; created: number }[] = []
  w.__pcs = pcs
  w.__frames = frames
  const ports: MessagePort[] = []
  w.__ports = ports
  /** The transform objects, in the order of __frames. */
  const objs: unknown[] = []
  w.__transforms = objs

  const PC = window.RTCPeerConnection
  if (PC) {
    const Wrapped = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
      const pc = new PC(...args)
      pcs.push(pc)
      return pc
    } as unknown as typeof RTCPeerConnection
    Wrapped.prototype = PC.prototype
    Object.setPrototypeOf(Wrapped, PC)
    window.RTCPeerConnection = Wrapped
  }

  const ST = (window as unknown as { RTCRtpScriptTransform?: new (w: Worker, o: unknown, t?: Transferable[]) => unknown })
    .RTCRtpScriptTransform
  if (ST) {
    const Wrapped = function (this: unknown, worker: Worker, options: Record<string, unknown>, transfer?: Transferable[]) {
      const original = options?.port as MessagePort | undefined
      if (!(original instanceof MessagePort)) return new ST(worker, options, transfer)
      const relay = new MessageChannel()
      const entry = {
        role: String(options.role),
        track: String(options.track),
        userId: (options.userId as string | null) ?? null,
        stats: null as unknown,
        created: Date.now()
      }
      frames.push(entry)
      // The main-thread ends of the relay must stay reachable, or a GC drops the messages.
      ports.push(original, relay.port1)
      // crypto Worker -> transform Worker: the frame keys.
      original.onmessage = (ev) => relay.port1.postMessage(ev.data)
      // transform Worker -> crypto Worker: the stats.
      relay.port1.onmessage = (ev) => {
        const d = ev.data as { type?: string }
        if (d && d.type === 'stats') entry.stats = d
        original.postMessage(ev.data)
      }
      const t = (transfer ?? []).map((x) => (x === original ? relay.port2 : x))
      const st = new ST(worker, { ...options, port: relay.port2 }, t)
      objs.push(st)
      return st
    }
    Wrapped.prototype = ST.prototype
    ;(window as unknown as Record<string, unknown>).RTCRtpScriptTransform = Wrapped
  }

  const md = navigator.mediaDevices
  if (md) {
    md.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const g = canvas.getContext('2d')!
      let n = 0
      const draw = (): void => {
        n++
        g.fillStyle = `hsl(${(n * 7) % 360} 70% 50%)`
        g.fillRect(0, 0, 640, 360)
        g.fillStyle = '#fff'
        g.font = '48px sans-serif'
        g.fillText(`frame ${n}`, 40, 180)
      }
      draw()
      const timer = setInterval(draw, 66)
      const stream = canvas.captureStream(15)
      stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(timer))
      ;(w.__keep ??= [] as unknown[]) && (w.__keep as unknown[]).push(canvas)
      return stream
    }
    if (opts.fakeMic) {
      md.getUserMedia = async () => {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        osc.frequency.value = 440
        const dest = ctx.createMediaStreamDestination()
        osc.connect(dest)
        osc.start()
        void ctx.resume()
        ;(w.__keep ??= [] as unknown[]) && (w.__keep as unknown[]).push(ctx)
        return dest.stream
      }
    }
  }
}
