// Preview attachments: one fixture of each embed kind, with generated files behind their blob keys
// so the transcript renders them without Takusen. The stub crypto client "decrypts" a blob by
// passing it through. Video has no generated file (it does not play).
import { blobKey } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'

const svg = (w: number, h: number, body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`
  )}`

/** A flat, game-ish screenshot: sky, ground, a crosshair in the middle. */
function screenshot(w: number, h: number, sky: string, ground: string, ink: string): string {
  const cx = w / 2
  const cy = h / 2
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="${sky}"/>` +
      `<rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="${ground}"/>` +
      `<rect x="${w * 0.1}" y="${h * 0.34}" width="${w * 0.18}" height="${h * 0.28}" fill="${ground}" opacity="0.7"/>` +
      `<rect x="${w * 0.7}" y="${h * 0.24}" width="${w * 0.12}" height="${h * 0.38}" fill="${ground}" opacity="0.85"/>` +
      `<g fill="${ink}"><rect x="${cx - 14}" y="${cy - 1}" width="10" height="2"/><rect x="${cx + 4}" y="${cy - 1}" width="10" height="2"/>` +
      `<rect x="${cx - 1}" y="${cy - 14}" width="2" height="10"/><rect x="${cx - 1}" y="${cy + 4}" width="2" height="10"/></g>`
  )
}

/** A comp-sheet style grid: header row plus colored cells. */
function sheet(w: number, h: number, accent: string): string {
  let cells = `<rect width="${w}" height="${h}" fill="#f6f7f9"/><rect width="${w}" height="${h * 0.14}" fill="${accent}"/>`
  for (let r = 1; r < 6; r++)
    for (let c = 0; c < 4; c++)
      cells += `<rect x="${c * (w / 4) + 4}" y="${r * (h / 6) + 4}" width="${w / 4 - 8}" height="${h / 6 - 8}" fill="${(r + c) % 3 ? '#dde1e7' : '#cfd4db'}"/>`
  return svg(w, h, cells)
}

/** A wide page banner: a dusk sky with a sun and two ridges. */
function bannerArt(w: number, h: number): string {
  return svg(
    w,
    h,
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2d6e"/>` +
      `<stop offset="0.6" stop-color="#b8577e"/><stop offset="1" stop-color="#f2a65a"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#s)"/>` +
      `<circle cx="${w * 0.72}" cy="${h * 0.62}" r="${h * 0.22}" fill="#ffd27a" opacity="0.9"/>` +
      `<path d="M0 ${h * 0.7} L${w * 0.2} ${h * 0.48} L${w * 0.42} ${h * 0.72} L${w * 0.62} ${h * 0.52} L${w} ${h * 0.78} V${h} H0Z" fill="#3a2a55"/>` +
      `<path d="M0 ${h * 0.86} L${w * 0.3} ${h * 0.7} L${w * 0.55} ${h * 0.88} L${w * 0.8} ${h * 0.74} L${w} ${h * 0.9} V${h} H0Z" fill="#1e1833"/>`
  )
}

/** One second of a 440 Hz tone, as a WAV data URL. */
function tone(): string {
  const rate = 8000
  const samples = rate
  const view = new DataView(new ArrayBuffer(44 + samples))
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  text(36, 'data')
  view.setUint32(40, samples, true)
  // A 440 Hz tone with a pulsing envelope, so that the audio card draws a waveform (N24).
  for (let i = 0; i < samples; i++) {
    const envelope = 0.2 + 0.8 * Math.abs(Math.sin((2 * Math.PI * 2.3 * i) / rate))
    view.setUint8(
      44 + i,
      128 + Math.round(40 * envelope * Math.sin((2 * Math.PI * 440 * i) / rate))
    )
  }
  let bin = ''
  for (const b of new Uint8Array(view.buffer)) bin += String.fromCharCode(b)
  return `data:audio/wav;base64,${btoa(bin)}`
}

const file = (
  name: string,
  mime: string,
  size: number,
  width: number | null = null,
  height: number | null = null,
  uploadId = `att-${name}`
): AttachmentPointer => ({
  uploadId,
  key: '',
  sha256: '',
  size,
  blobSize: size,
  mime,
  name,
  width,
  height,
  durationMs: null,
  blurhash: null,
  thumbnail: null
})

const keyOf = (a: AttachmentPointer): string => blobKey(a.uploadId)

export const ATT = {
  crosshair: file('crosshair-test.png', 'image/png', 1_284_310, 1600, 900),
  compA: file('comp-thursday-a.png', 'image/png', 402_118, 1200, 900),
  compB: file('comp-thursday-b.png', 'image/png', 388_904, 1200, 900),
  compC: file('comp-fallback.png', 'image/png', 377_002, 1200, 900),
  clip: file('flank-1m40s.mp4', 'video/mp4', 18_412_550, 1280, 720),
  callouts: file('callouts-take2.wav', 'audio/wav', 8_044),
  stratDoc: file('strat-doc-v3.pdf', 'application/pdf', 1_873_221),
  /** The banner of the RFC page (a doc_banner pointer: its upload id passes parsePointer). */
  pageBanner: file('banner.png', 'image/png', 214_530, 1600, 400, 'att-page-banner')
}

const URLS: Record<string, string> = {
  [keyOf(ATT.crosshair)]: screenshot(1600, 900, '#5b7fa6', '#3d4a3a', '#00ff88'),
  [keyOf(ATT.compA)]: sheet(1200, 900, '#c98a0b'),
  [keyOf(ATT.compB)]: sheet(1200, 900, '#2f9e8f'),
  [keyOf(ATT.compC)]: sheet(1200, 900, '#c9303a'),
  [keyOf(ATT.pageBanner)]: bannerArt(1600, 400)
}

/** Generated file behind a fixture attachment blob key, if there is one. */
export function attachmentUrl(key: string): string | undefined {
  if (key === keyOf(ATT.callouts)) return (URLS[key] ??= tone())
  return URLS[key]
}
