import type { ScreenEncoding } from '@hachiman/client'

export type StreamResolution = '720p' | '1080p' | '1440p' | 'source'
export type StreamFps = 15 | 30 | 60

export const STREAM_RESOLUTIONS: { value: StreamResolution; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: 'source', label: 'Source' }
]
export const STREAM_FPS: StreamFps[] = [15, 30, 60]

export interface StreamQuality {
  resolution: StreamResolution
  fps: StreamFps
}

const HEIGHT: Record<Exclude<StreamResolution, 'source'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440
}

// ponytail: one bits-per-pixel figure for every preset (1080p60 ≈ 6.2 Mbps). Tune per content
// type if text gets blurry or motion stutters.
const BITS_PER_PIXEL = 0.05
const MIN_BITRATE = 500_000

/** Capture constraints for `getDisplayMedia` and `applyConstraints`. Never upscales. */
export function captureConstraints(q: StreamQuality): MediaTrackConstraints {
  const size =
    q.resolution === 'source'
      ? {}
      : { height: { max: HEIGHT[q.resolution] }, width: { max: (HEIGHT[q.resolution] * 16) / 9 } }
  return { ...size, frameRate: { ideal: q.fps, max: q.fps } }
}

/**
 * Tunes a captured track for `q` and returns the sender limits for it. The bitrate uses the real
 * capture size, since sources vary. A 60 fps share is usually a game or video, so it favors
 * motion; anything slower is usually text, so it favors detail.
 */
export function tuneTrack(track: MediaStreamTrack, q: StreamQuality): ScreenEncoding {
  track.contentHint = q.fps >= 60 ? 'motion' : 'detail'
  const { width = 1920, height = 1080 } = track.getSettings()
  return {
    maxFramerate: q.fps,
    maxBitrate: Math.max(MIN_BITRATE, Math.round(width * height * q.fps * BITS_PER_PIXEL))
  }
}
