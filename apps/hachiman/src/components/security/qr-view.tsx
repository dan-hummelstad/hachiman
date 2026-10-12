import { useEffect, useMemo, useRef } from 'react'
import { Camera, CameraOff, Copy } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { encodeQr, qrSvgPath } from '@/components/security/qr'
import { barcodeDetector, useScanOrPaste } from '@/components/security/use-scan-or-paste'
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

const SCAN_INTERVAL_MS = 300

/**
 * Scan a code with the camera (the native scanner, or BarcodeDetector), or paste its text. Every
 * host has the paste field. `prefix` is the start of a valid code (for example `hachiman-link:1:`).
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
  const scan = useScanOrPaste({ prefix, onCode })

  return (
    <div className="grid gap-3">
      {scan.canScan && (
        <div className="grid gap-2">
          {scan.camera ? (
            <CameraScan prefix={prefix} onCode={scan.onCameraCode} onError={scan.onCameraError} />
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={scan.camera ? scan.stopCamera : scan.scan}
          >
            {scan.camera ? <CameraOff /> : <Camera />}
            {scan.camera ? 'Stop the camera' : 'Scan with the camera'}
          </Button>
        </div>
      )}
      <form onSubmit={scan.submit} className="grid gap-2">
        <Field id="scan-paste" label={pasteLabel}>
          <Textarea
            id="scan-paste"
            className="font-mono text-[12px]"
            placeholder={`${prefix}…`}
            value={scan.text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => scan.setText(e.target.value)}
          />
        </Field>
        <Button type="submit" className="justify-self-end" disabled={busy || !scan.pasted}>
          Use this code
        </Button>
      </form>
      <ErrorText>{scan.error}</ErrorText>
    </div>
  )
}

/**
 * The BarcodeDetector camera view: hands over the first code that starts with `prefix`. Mount it
 * only while `ScanOrPasteState.camera` is on.
 */
export function CameraScan({
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
