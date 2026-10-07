import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, CameraOff, Copy } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { encodeQr, qrSvgPath } from '@/components/security/qr'
import { cn } from '@/lib/utils'

const BORDER = 4

/**
 * A QR code (byte mode, ECC M) as SVG. Always dark on white, in both themes: scanners need the
 * contrast and the quiet zone.
 */
export function QrCodeView({
  value,
  label,
  className
}: {
  value: string
  label: string
  className?: string
}): React.JSX.Element {
  const { path, dim } = useMemo(() => {
    const qr = encodeQr(value, 'M')
    return { path: qrSvgPath(qr, BORDER), dim: qr.size + BORDER * 2 }
  }, [value])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className={cn('block aspect-square w-full max-w-[240px] bg-white', className)}
    >
      <path d={path} fill="#000" />
    </svg>
  )
}

/** The text of a code with a copy button, for a device that cannot scan. */
export function CopyableCode({
  value,
  label
}: {
  value: string
  label: string
}): React.JSX.Element {
  const { copied, failed, copy } = useCopy()
  return (
    <div className="grid gap-1.5">
      <span className="text-xs leading-4 font-semibold">{label}</span>
      <div className="flex items-start gap-2">
        <code className="border-line-hairline bg-surface-sunken max-h-20 min-w-0 flex-1 overflow-y-auto border p-2 font-mono text-[11px] leading-4 break-all select-all">
          {value}
        </code>
        <Button type="button" size="sm" variant="secondary" onClick={() => copy(value)}>
          <Copy /> {copied !== null ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {failed && <ErrorText>Could not copy. Select the text and copy it by hand.</ErrorText>}
    </div>
  )
}

// Chromium and Electron have BarcodeDetector. TypeScript's DOM types do not have it yet.
interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

function barcodeDetector(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

const SCAN_INTERVAL_MS = 300

/**
 * Scan a code with the camera (where BarcodeDetector exists), or paste its text. Every host has
 * the paste field. `prefix` is the start of a valid code (for example `hachiman-link:1:`).
 */
export function ScanOrPaste({
  prefix,
  onCode,
  busy,
  pasteLabel = 'Or paste the code text'
}: {
  prefix: string
  onCode: (code: string) => void
  busy?: boolean
  pasteLabel?: string
}): React.JSX.Element {
  const [scanning, setScanning] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canScan = barcodeDetector() !== null
  const trimmed = text.trim()

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!trimmed.startsWith(prefix)) {
      setError('This is not the right kind of code. Copy all of the text from the other device.')
      return
    }
    setError(null)
    onCode(trimmed)
  }

  return (
    <div className="grid gap-3">
      {canScan && (
        <div className="grid gap-2">
          {scanning ? (
            <CameraScan
              prefix={prefix}
              onCode={(code) => {
                setScanning(false)
                onCode(code)
              }}
              onError={(msg) => {
                setScanning(false)
                setError(msg)
              }}
            />
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setError(null)
              setScanning((s) => !s)
            }}
          >
            {scanning ? <CameraOff /> : <Camera />}
            {scanning ? 'Stop the camera' : 'Scan with the camera'}
          </Button>
        </div>
      )}
      <form onSubmit={submit} className="grid gap-2">
        <Field id="scan-paste" label={pasteLabel}>
          <Textarea
            id="scan-paste"
            className="font-mono text-[12px]"
            placeholder={`${prefix}…`}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Button type="submit" className="justify-self-end" disabled={busy || !trimmed}>
          Use this code
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function CameraScan({
  prefix,
  onCode,
  onError
}: {
  prefix: string
  onCode: (code: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  // The latest callbacks, so the camera effect runs once per mount.
  const cb = useRef({ onCode, onError })
  useEffect(() => {
    cb.current = { onCode, onError }
  })

  useEffect(() => {
    const Detector = barcodeDetector()
    if (!Detector) return
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let live = true
    const detector = new Detector({ formats: ['qr_code'] })
    const tick = async (): Promise<void> => {
      const v = video.current
      if (!live || !v) return
      try {
        if (v.readyState >= 2) {
          const hit = (await detector.detect(v)).find((b) => b.rawValue.startsWith(prefix))
          if (hit && live) return cb.current.onCode(hit.rawValue)
        }
      } catch {
        // A frame that the detector cannot read: try the next one.
      }
      if (live) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().catch(() => undefined)
        }
        void tick()
      })
      .catch(() => {
        if (live) cb.current.onError('Could not open the camera. Paste the code text instead.')
      })
    return () => {
      live = false
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [prefix])

  return (
    <video
      ref={video}
      muted
      playsInline
      aria-label="Camera view"
      className="aspect-square w-full max-w-[240px] justify-self-center bg-black object-cover"
    />
  )
}
