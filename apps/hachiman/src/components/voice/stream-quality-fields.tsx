import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  STREAM_FPS,
  STREAM_RESOLUTIONS,
  type StreamFps,
  type StreamResolution
} from '@/lib/stream-quality'
import { usePrefsStore } from '@/stores/prefsStore'

export function StreamQualityFields(): React.JSX.Element {
  const quality = usePrefsStore((s) => s.streamQuality)
  const setQuality = usePrefsStore((s) => s.setStreamQuality)
  return (
    <div className="grid grid-cols-2 gap-2">
      <Label className="flex-col items-stretch gap-1 text-xs">
        Resolution
        <NativeSelect
          value={quality.resolution}
          onChange={(e) =>
            setQuality({ ...quality, resolution: e.target.value as StreamResolution })
          }
        >
          {STREAM_RESOLUTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </Label>
      <Label className="flex-col items-stretch gap-1 text-xs">
        Frame rate
        <NativeSelect
          value={quality.fps}
          onChange={(e) => setQuality({ ...quality, fps: Number(e.target.value) as StreamFps })}
        >
          {STREAM_FPS.map((fps) => (
            <option key={fps} value={fps}>
              {fps} fps
            </option>
          ))}
        </NativeSelect>
      </Label>
    </div>
  )
}
