import { useEffect, useId, useRef, useState } from 'react'
import { Ghost } from 'lucide-react'
import { SectionLabel } from '@/components/mobile/list'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { MESSAGE_TEXT_SIZES, usePrefsStore, type MessageTextSize } from '@/stores/prefsStore'

const SIZE_NAME: Record<MessageTextSize, string> = {
  13: 'Smallest',
  14: 'Small',
  15: 'Default',
  17: 'Large',
  19: 'Largest'
}

const LAST = MESSAGE_TEXT_SIZES.length - 1
/** Half the 22 knob: the knob's centre runs from here to the width minus here. */
const KNOB_HALF = 11
/** The centre of the knob at step `i`, as a CSS length in the track. */
const stepAt = (i: number): string =>
  `calc(${KNOB_HALF}px + (100% - ${KNOB_HALF * 2}px) * ${i / LAST})`

/** The native thumb as the 22 white knob, on an invisible track (WebKit, then Firefox). */
const RANGE = cn(
  'absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-control bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-line-focus',
  '[&::-webkit-slider-runnable-track]:h-9 [&::-webkit-slider-runnable-track]:bg-transparent',
  '[&::-webkit-slider-thumb]:mt-[7px] [&::-webkit-slider-thumb]:size-[22px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_#00000059]',
  '[&::-moz-range-track]:bg-transparent',
  '[&::-moz-range-thumb]:size-[22px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_#00000059]'
)

/**
 * M31 TEXT SIZE: a sample message, then a slider over the five sizes with drawn ticks. The sample
 * follows the finger; the size applies to the transcript on release (the native `change` event),
 * so the transcript lays out once. A light haptic marks each step.
 */
export function TextSizeSection(): React.JSX.Element {
  const stored = usePrefsStore((s) => s.messageTextSize)
  const platform = usePlatform()
  const [draft, setDraft] = useState<MessageTextSize | null>(null)
  const size = draft ?? stored
  const index = MESSAGE_TEXT_SIZES.indexOf(size)
  const labelId = useId()
  const input = useRef<HTMLInputElement>(null)

  // React's onChange is the `input` event. The native `change` comes on release, and once per key
  // step (also from VoiceOver), so that is where the size applies.
  useEffect(() => {
    const el = input.current
    if (!el) return
    const apply = (): void => {
      const next = MESSAGE_TEXT_SIZES[Number(el.value)]
      const prefs = usePrefsStore.getState()
      if (next !== undefined && next !== prefs.messageTextSize) prefs.setMessageTextSize(next)
      setDraft(null)
    }
    el.addEventListener('change', apply)
    el.addEventListener('blur', apply)
    return () => {
      el.removeEventListener('change', apply)
      el.removeEventListener('blur', apply)
    }
  }, [])

  const onInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = MESSAGE_TEXT_SIZES[Number(e.target.value)]
    if (next === undefined || next === size) return
    platform.haptic('light')
    setDraft(next)
  }

  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <SectionLabel id={labelId}>Text size</SectionLabel>
      <div className="border-line-hairline flex flex-col gap-4 border bg-white/2 p-3.5">
        <div aria-hidden className="flex gap-2.5">
          <span className="bg-feature-voice text-surface-window flex size-8 shrink-0 items-center justify-center rounded-full">
            <Ghost className="size-[18px]" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className="text-feature-event-text text-[15px] leading-[18px] font-bold">
                marlowe
              </span>
              <span className="text-text-tertiary text-xs font-medium tabular-nums">11:41</span>
            </span>
            <span
              className="text-text-primary font-medium"
              style={{ fontSize: size, lineHeight: 1.45 }}
            >
              ok who is around for a few customs now
            </span>
          </span>
        </div>
        <div className="flex items-center gap-5.5" data-swipe-ignore>
          <span aria-hidden className="text-text-secondary text-[13px] leading-4 font-bold">
            A
          </span>
          <div className="relative h-9 min-w-0 flex-1">
            <span
              aria-hidden
              className="bg-fill-control-strong absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
            />
            <span
              aria-hidden
              className="bg-accent-primary absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full"
              style={{ width: stepAt(index) }}
            />
            {MESSAGE_TEXT_SIZES.map((step, i) => (
              <span
                key={step}
                aria-hidden
                className={cn(
                  'absolute top-1/2 size-1.5 -translate-1/2 rounded-full',
                  i <= index ? 'bg-accent-text' : 'bg-text-disabled'
                )}
                style={{ left: stepAt(i) }}
              />
            ))}
            <input
              ref={input}
              type="range"
              min={0}
              max={LAST}
              step={1}
              value={index}
              onChange={onInput}
              aria-labelledby={labelId}
              aria-valuetext={`${SIZE_NAME[size]}, ${size} points`}
              className={RANGE}
            />
          </div>
          <span aria-hidden className="text-text-secondary text-[21px] leading-6 font-bold">
            A
          </span>
        </div>
        <p className="text-text-tertiary text-[12.5px] leading-[18px] font-medium">
          {SIZE_NAME[size]} · {size} pt. Sets the size of message text.
        </p>
      </div>
    </section>
  )
}
