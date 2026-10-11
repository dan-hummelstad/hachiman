import { cn } from '@/lib/utils'

/** Half the 22 knob: the knob's centre runs from here to the width minus here. */
const KNOB_HALF = 11

/** The centre of the knob at `t` (0 to 1), as a CSS length in the track. */
const knobAt = (t: number): string => `calc(${KNOB_HALF}px + (100% - ${KNOB_HALF * 2}px) * ${t})`

/** The native thumb as the 22 white knob, on an invisible track (WebKit, then Firefox). */
const RANGE = cn(
  'absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-control bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-line-focus disabled:cursor-not-allowed',
  '[&::-webkit-slider-runnable-track]:h-9 [&::-webkit-slider-runnable-track]:bg-transparent',
  '[&::-webkit-slider-thumb]:mt-[7px] [&::-webkit-slider-thumb]:size-[22px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_#00000059]',
  '[&::-moz-range-track]:bg-transparent',
  '[&::-moz-range-thumb]:size-[22px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_#00000059]'
)

/**
 * The mobile slider of M31 (text size) and M32 (sound volume): a native range input whose thumb
 * is the 22 white knob, over a drawn 4 track. The accent fill ends under the knob's centre at
 * `fraction`. `ticks` draws that many evenly spaced dots, lit up to the knob. `className` sizes
 * the 36 tall box in its row; the other props go to the input.
 */
export function TouchRange({
  fraction,
  ticks = 0,
  className,
  ...input
}: {
  fraction: number
  ticks?: number
  className?: string
} & Omit<React.ComponentProps<'input'>, 'type' | 'className'>): React.JSX.Element {
  const last = ticks - 1
  return (
    <span data-swipe-ignore="" className={cn('relative h-9', className)}>
      <span
        aria-hidden
        className="bg-fill-control-strong absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
      />
      <span
        aria-hidden
        className="bg-accent-primary absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full"
        style={{ width: knobAt(fraction) }}
      />
      {Array.from({ length: ticks }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            'absolute top-1/2 size-1.5 -translate-1/2 rounded-full',
            i / last <= fraction ? 'bg-accent-text' : 'bg-text-disabled'
          )}
          style={{ left: knobAt(i / last) }}
        />
      ))}
      <input type="range" {...input} className={RANGE} />
    </span>
  )
}
