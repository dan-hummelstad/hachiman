import { useRef, useState } from 'react'
import { checkCode } from '@/components/security/scan-code'
import { usePlatform } from '@/shared/PlatformContext'

// Chromium and Electron have BarcodeDetector. TypeScript's DOM types do not have it yet.
interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

export function barcodeDetector(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

const WRONG_PASTE =
  'This is not the right kind of code. Copy all of the text from the other device.'
const WRONG_SCAN = 'This is not the right kind of code. Scan the code on their device.'
const NO_CAMERA = 'Could not open the camera. Paste the code text instead.'

/** The state and actions of a scan-or-paste step, for the desktop view and a touch view. */
export interface ScanOrPasteState {
  /** The host can scan: the native scanner (iOS) or BarcodeDetector with the camera. */
  canScan: boolean
  /** The host has a native scanner, a full screen of its own: `scan` shows no camera view here. */
  native: boolean
  /** The BarcodeDetector camera view is on. Show `CameraScan` with `onCameraCode` and `onCameraError`. */
  camera: boolean
  /** Open the native scanner, or turn the camera view on. Call it in the tap (iOS). */
  scan: () => void
  stopCamera: () => void
  onCameraCode: (code: string) => void
  onCameraError: (message: string) => void
  text: string
  setText: (text: string) => void
  /** The pasted text, trimmed. */
  pasted: string
  /** Submit the pasted text: a code of the wrong kind sets `error`. */
  submit: (e: React.FormEvent) => void
  error: string | null
  /** Back to the start: camera off, no text, no error. */
  reset: () => void
}

/**
 * Scan a code or paste its text. `prefix` is the start of a valid code (for example
 * `hachiman-link:1:`). A native result is checked against it; null (the user closed the scanner)
 * is a cancel and changes nothing. The camera view hands over only codes with the prefix.
 * `wrongScan` replaces the text for a scanned code of the wrong kind.
 */
export function useScanOrPaste({
  prefix,
  onCode,
  wrongScan = WRONG_SCAN
}: {
  prefix: string
  onCode: (code: string) => void
  wrongScan?: string
}): ScanOrPasteState {
  const nativeScan = usePlatform().scanQr
  const [camera, setCamera] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The native scanner is open: a second tap must not open another one.
  const nativeOpen = useRef(false)
  const canScan = nativeScan !== null || barcodeDetector() !== null

  const scan = (): void => {
    setError(null)
    if (!nativeScan) {
      setCamera(barcodeDetector() !== null)
      return
    }
    if (nativeOpen.current) return
    nativeOpen.current = true
    nativeScan()
      .then(
        (raw) => {
          const checked = checkCode(prefix, raw)
          if (checked.kind === 'code') onCode(checked.code)
          else if (checked.kind === 'wrong') setError(wrongScan)
        },
        () => setError(NO_CAMERA)
      )
      .finally(() => {
        nativeOpen.current = false
      })
  }

  return {
    canScan,
    native: nativeScan !== null,
    camera,
    scan,
    stopCamera: () => {
      setError(null)
      setCamera(false)
    },
    onCameraCode: (code) => {
      setCamera(false)
      onCode(code)
    },
    onCameraError: (message) => {
      setCamera(false)
      setError(message)
    },
    text,
    setText,
    pasted: text.trim(),
    submit: (e) => {
      e.preventDefault()
      const checked = checkCode(prefix, text)
      if (checked.kind !== 'code') {
        setError(WRONG_PASTE)
        return
      }
      setError(null)
      onCode(checked.code)
    },
    error,
    reset: () => {
      setCamera(false)
      setText('')
      setError(null)
    }
  }
}
