import { useEffect, useState, type RefObject } from 'react'
import { createGate, levelDb, meterPercent } from '@/lib/input-sensitivity'
import { errMsg } from '@/lib/utils'
import { usePrefsStore } from '@/stores/prefsStore'

/**
 * Opt-in mic level meter. While on, opens `deviceId` (null = default) and writes the level to
 * `meter`'s width every frame (no re-render per frame). It runs the input sensitivity gate as a
 * call does: `marker` moves to the auto threshold, and `meter` gets `data-open` while the mic
 * would send. `onOpen` runs once the mic opens, e.g. to re-list devices now that labels are
 * visible. Pass a stable `onOpen`.
 */
export function useMicLevel(
  deviceId: string | null,
  meter: RefObject<HTMLElement | null>,
  marker: RefObject<HTMLElement | null>,
  onOpen: () => void
): { on: boolean; toggle: () => void; error: string | null } {
  const [on, setOn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!on) return
    const bar = meter.current
    const mark = marker.current
    let stopped = false
    let raf = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { ideal: deviceId } } : true
        })
        if (stopped) return stream.getTracks().forEach((t) => t.stop())
        onOpen()
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const step = createGate()
        const tick = (): void => {
          analyser.getFloatTimeDomainData(buf)
          const db = levelDb(buf)
          const s = usePrefsStore.getState()
          const { open, threshold } = step(db, performance.now(), s)
          if (bar) {
            bar.style.width = `${meterPercent(db)}%`
            bar.toggleAttribute('data-open', open || s.voiceInputMode === 'pushToTalk')
          }
          if (mark && s.inputSensitivityAuto) mark.style.left = `${meterPercent(threshold)}%`
          raf = requestAnimationFrame(tick)
        }
        tick()
      } catch (e) {
        if (stopped) return
        setError(
          `Could not open the microphone: ${errMsg(e)}. Check that the app is allowed to use it.`
        )
        setOn(false)
      }
    })()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      if (bar) bar.style.width = '0%'
    }
  }, [on, deviceId, meter, marker, onOpen])

  const toggle = (): void => {
    setError(null)
    setOn((v) => !v)
  }
  return { on, toggle, error }
}
