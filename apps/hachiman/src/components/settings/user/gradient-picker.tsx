import { useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import { dialAngle, nudgeStop, pickStop, sliderKey, stopAt, stopOffset } from '@/lib/gradient-pad'
import {
  DEFAULT_CUSTOM_GRADIENT,
  LIGHTNESS_RANGE,
  stopColor,
  type CustomGradient,
  type GradientStop
} from '@/lib/guild-tint'
import { cn } from '@/lib/utils'
import { useGradientEditor } from '@/components/settings/user/use-gradient-editor'
import { usePlatform } from '@/shared/PlatformContext'

const DIAL = 48
const DIAL_RING = 18

/** Colour swatches: a hue and saturation for the selected stop, shown at a fitting lightness. */
const SWATCHES: { name: string; stop: GradientStop; l: number }[] = [
  { name: 'Off-white', stop: { h: 40, s: 12 }, l: 94 },
  { name: 'Pink', stop: { h: 340, s: 80 }, l: 80 },
  { name: 'Mauve', stop: { h: 290, s: 35 }, l: 65 },
  { name: 'Red', stop: { h: 355, s: 80 }, l: 58 },
  { name: 'Orange', stop: { h: 25, s: 90 }, l: 58 },
  { name: 'Yellow', stop: { h: 48, s: 95 }, l: 60 },
  { name: 'Green', stop: { h: 140, s: 55 }, l: 50 },
  { name: 'Light blue', stop: { h: 200, s: 85 }, l: 72 },
  { name: 'Slate', stop: { h: 215, s: 20 }, l: 45 }
]

const PRESETS: { name: string; gradient: CustomGradient }[] = [
  { name: 'Twilight', gradient: DEFAULT_CUSTOM_GRADIENT },
  {
    name: 'Sunset',
    gradient: {
      stops: [
        { h: 37, s: 92 },
        { h: 354, s: 85 }
      ],
      lightness: 60,
      angle: 160
    }
  },
  {
    name: 'Lagoon',
    gradient: {
      stops: [
        { h: 173, s: 70 },
        { h: 201, s: 90 }
      ],
      lightness: 55,
      angle: 120
    }
  },
  {
    name: 'Orchid',
    gradient: {
      stops: [
        { h: 265, s: 80 },
        { h: 330, s: 95 }
      ],
      lightness: 70,
      angle: 200
    }
  },
  {
    name: 'Meadow',
    gradient: {
      stops: [
        { h: 150, s: 60 },
        { h: 50, s: 95 },
        { h: 25, s: 90 }
      ],
      lightness: 58,
      angle: 90
    }
  }
]

/** The unwashed CSS gradient of `g` (swatches and chips). */
function rawGradient(g: CustomGradient): string {
  const colors = g.stops.map((st) => stopColor(st, g.lightness))
  if (colors.length === 1) colors.push(colors[0])
  return `linear-gradient(${g.angle}deg, ${colors.join(', ')})`
}

/** Pointer handlers that call `onPoint` on press and while the pointer stays captured. */
function dragHandlers(
  onPoint: (e: React.PointerEvent<HTMLElement>, rect: DOMRect, start: boolean) => void
): Pick<
  React.HTMLAttributes<HTMLElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
> {
  return {
    onPointerDown: (e) => {
      // A second finger is not primary; a mouse always is.
      if (e.button !== 0 || !e.isPrimary) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      onPoint(e, e.currentTarget.getBoundingClientRect(), true)
    },
    onPointerMove: (e) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        onPoint(e, e.currentTarget.getBoundingClientRect(), false)
    },
    onPointerUp: (e) => e.currentTarget.releasePointerCapture(e.pointerId),
    onPointerCancel: (e) => e.currentTarget.releasePointerCapture(e.pointerId)
  }
}

/**
 * Arc-style gradient picker: a colour pad with 1 to 3 draggable stops (hue around the centre,
 * saturation out from it), colour swatches, a wavy lightness slider and an angle dial.
 */
export function GradientPicker({
  value,
  onChange
}: {
  value: CustomGradient
  onChange: (value: CustomGradient) => void
}): React.JSX.Element {
  const ed = useGradientEditor(value, onChange)

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="grid justify-items-center gap-2">
        <ColourPad value={value} active={ed.active} onSelect={ed.select} onStop={ed.setStop} />
        <div className="flex items-center gap-2">
          <PadButton label="Remove colour" disabled={!ed.canRemove} onClick={ed.remove}>
            <Minus />
          </PadButton>
          <PadButton label="Add colour" disabled={!ed.canAdd} onClick={ed.add}>
            <Plus />
          </PadButton>
        </div>
      </div>
      <div className="grid min-w-56 flex-1 content-start gap-4">
        <SwatchRow onPick={(stop) => ed.setStop(ed.active, stop)} />
        <div className="flex items-center gap-4">
          <WavySlider
            value={value.lightness}
            onChange={(lightness) => onChange({ ...value, lightness })}
          />
          <AngleDial value={value.angle} onChange={(angle) => onChange({ ...value, angle })} />
        </div>
        <PresetRow onPick={ed.applyPreset} />
      </div>
    </div>
  )
}

/**
 * The gradient picker of the phone (M31 Background): the same parts, stacked in one column, with a
 * 240 pad, a wider reach around each stop, and a tap that selects a stop without moving it. Each
 * stop also has a hidden saturation range, since VoiceOver's swipes only send Left and Right.
 */
export function GradientPickerMobile({
  value,
  onChange
}: {
  value: CustomGradient
  onChange: (value: CustomGradient) => void
}): React.JSX.Element {
  const ed = useGradientEditor(value, onChange)
  const platform = usePlatform()
  const n = value.stops.length

  return (
    <div
      data-swipe-ignore=""
      className="border-line-hairline relative flex flex-col gap-4 border bg-white/2 p-3.5"
    >
      <ColourPad
        value={value}
        active={ed.active}
        onSelect={ed.select}
        onStop={ed.setStop}
        size={240}
        inset={18}
        reach={24}
        keepGrab
        focusOnGrab={false}
        onGrab={() => platform.haptic('light')}
        className="self-center"
      />
      {value.stops.map((st, i) => (
        <input
          key={i}
          type="range"
          min={0}
          max={100}
          step={5}
          value={st.s}
          aria-label={`Colour ${i + 1} saturation`}
          aria-valuetext={`${st.s}%`}
          onFocus={() => ed.select(i)}
          onChange={(e) => ed.setStop(i, { ...st, s: Number(e.target.value) })}
          className="sr-only"
        />
      ))}
      <div className="flex items-center justify-between gap-3">
        <PadButton label="Remove colour" disabled={!ed.canRemove} onClick={ed.remove}>
          <Minus />
        </PadButton>
        <span className="text-text-secondary text-[13px] leading-4 font-semibold tabular-nums">
          {ed.active + 1} of {n} {n === 1 ? 'colour' : 'colours'}
        </span>
        <PadButton label="Add colour" disabled={!ed.canAdd} onClick={ed.add}>
          <Plus />
        </PadButton>
      </div>
      <SwatchRow onPick={(stop) => ed.setStop(ed.active, stop)} />
      <div className="flex items-center gap-4">
        <WavySlider
          value={value.lightness}
          onChange={(lightness) => onChange({ ...value, lightness })}
        />
        <AngleDial value={value.angle} onChange={(angle) => onChange({ ...value, angle })} />
      </div>
      <PresetRow onPick={ed.applyPreset} />
    </div>
  )
}

/**
 * The colour pad: a `size` square with the colour circle `inset` in from its edge. A press within
 * `reach` of a stop grabs it, elsewhere it moves the selected stop there. With `keepGrab`, the
 * grabbed stop keeps its offset from the finger, so a tap selects it without moving it.
 */
export function ColourPad({
  value,
  active,
  onSelect,
  onStop,
  size = 208,
  inset = 16,
  reach = 18,
  keepGrab = false,
  focusOnGrab = true,
  onGrab,
  className
}: {
  value: CustomGradient
  active: number
  onSelect: (i: number) => void
  onStop: (i: number, stop: GradientStop) => void
  size?: number
  inset?: number
  reach?: number
  keepGrab?: boolean
  focusOnGrab?: boolean
  onGrab?: () => void
  className?: string
}): React.JSX.Element {
  // The stop that a press grabbed, and its offset from the pointer; it follows until release.
  const [drag, setDrag] = useState({ index: 0, grab: { x: 0, y: 0 } })
  const l = value.lightness
  const radius = size / 2 - inset

  const handlers = dragHandlers((e, rect, start) => {
    const dx = e.clientX - rect.left - size / 2
    const dy = e.clientY - rect.top - size / 2
    if (start) {
      const picked = pickStop(value.stops, dx, dy, radius, reach, active)
      setDrag({ index: picked.index, grab: keepGrab ? picked.grab : { x: 0, y: 0 } })
      onSelect(picked.index)
      onGrab?.()
      if (focusOnGrab)
        e.currentTarget.querySelectorAll<HTMLElement>('[role=slider]')[picked.index]?.focus()
      // With keepGrab, a press on a stop only grabs it; the drag then moves it.
      if (!(keepGrab && picked.hit)) onStop(picked.index, stopAt(dx, dy, radius))
      return
    }
    onStop(drag.index, stopAt(dx + drag.grab.x, dy + drag.grab.y, radius))
  })

  const hues = Array.from({ length: 13 }, (_, i) => `hsl(${i * 30} 85% ${l}%)`).join(', ')

  return (
    <div
      role="group"
      aria-label="Gradient colours"
      className={cn(
        'rounded-option border-line-hairline bg-surface-sunken relative shrink-0 cursor-crosshair touch-none overflow-hidden border select-none',
        className
      )}
      style={{ width: size, height: size }}
      {...handlers}
    >
      <span
        aria-hidden
        className="absolute rounded-full opacity-40"
        style={{
          inset,
          backgroundImage: `radial-gradient(closest-side, hsl(0 0% ${l}%), transparent), conic-gradient(from 90deg, ${hues})`
        }}
      />
      <span
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle,var(--line-strong)_1.2px,transparent_1.5px)] bg-size-[13px_13px] bg-center"
      />
      {value.stops.map((st, i) => {
        const o = stopOffset(st, radius)
        const on = i === active
        return (
          <span
            key={i}
            role="slider"
            tabIndex={0}
            aria-label={`Colour ${i + 1}`}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={st.h}
            aria-valuetext={`hue ${st.h}°, saturation ${st.s}%`}
            onFocus={() => onSelect(i)}
            onKeyDown={(e) => {
              const next = nudgeStop(st, e.key, e.shiftKey)
              if (!next) return
              e.preventDefault()
              onStop(i, next)
            }}
            className={cn(
              'focus-visible:outline-line-focus absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md transition-[width,height] focus-visible:outline-2 focus-visible:outline-offset-2',
              on
                ? 'z-10 size-7 border-4 border-white mobile:size-8'
                : 'size-4 border-2 border-white/85 mobile:size-5'
            )}
            style={{ left: size / 2 + o.x, top: size / 2 + o.y, background: stopColor(st, l) }}
          />
        )
      })}
    </div>
  )
}

/** The preset gradients; Twilight, the default, doubles as the reset. */
export function PresetRow({
  onPick
}: {
  onPick: (gradient: CustomGradient) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.name}
          type="button"
          title={p.name}
          aria-label={`${p.name} preset`}
          onClick={() => onPick(p.gradient)}
          className="rounded-pill border-line-hairline hover:border-line-strong focus-visible:outline-line-focus mobile:size-9 size-8 border focus-visible:outline-2 focus-visible:outline-offset-1"
          style={{ backgroundImage: rawGradient(p.gradient) }}
        />
      ))}
    </div>
  )
}

export function PadButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-pill border-line-hairline text-text-secondary hover:bg-surface-hover focus-visible:outline-line-focus mobile:size-9 flex size-8 items-center justify-center border focus-visible:outline-2 disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

export function SwatchRow({ onPick }: { onPick: (stop: GradientStop) => void }): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  const scroll = (by: number): void => row.current?.scrollBy({ left: by, behavior: 'smooth' })
  const chevron =
    'text-text-tertiary hover:text-text-primary focus-visible:outline-line-focus mobile:hidden flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 [&_svg]:size-4'
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Previous colours"
        className={chevron}
        onClick={() => scroll(-120)}
      >
        <ChevronLeft />
      </button>
      <div
        ref={row}
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]"
      >
        {SWATCHES.map((sw) => (
          <button
            key={sw.name}
            type="button"
            title={sw.name}
            aria-label={sw.name}
            onClick={() => onPick(sw.stop)}
            className="border-line-hairline focus-visible:outline-line-focus mobile:size-8 mobile:after:absolute mobile:after:-inset-0.5 mobile:relative size-7 shrink-0 rounded-full border transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1"
            style={{ background: `hsl(${sw.stop.h} ${sw.stop.s}% ${sw.l}%)` }}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="More colours"
        className={chevron}
        onClick={() => scroll(120)}
      >
        <ChevronRight />
      </button>
    </div>
  )
}

/** A sine wave across the track, in the 200×24 viewBox. */
const WAVE = (() => {
  let d = 'M 0 12'
  for (let x = 2; x <= 200; x += 2)
    d += ` L ${x} ${(12 + 4 * Math.sin((x / 200) * Math.PI * 14)).toFixed(2)}`
  return d
})()

/** The lightness slider: a wavy track, filled up to a tall pill thumb. */
export function WavySlider({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const clip = useId()
  const [min, max] = LIGHTNESS_RANGE
  const pct = ((value - min) / (max - min)) * 100
  const handlers = dragHandlers((e, rect) => {
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onChange(Math.round(min + t * (max - min)))
  })
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Lightness"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value}%`}
      onKeyDown={(e) => {
        const next = sliderKey(value, e.key, min, max, 1)
        if (next === null) return
        e.preventDefault()
        onChange(next)
      }}
      className="focus-visible:outline-line-focus mobile:h-11 relative h-8 min-w-0 flex-1 cursor-pointer touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
      {...handlers}
    >
      <svg
        aria-hidden
        viewBox="0 0 200 24"
        preserveAspectRatio="none"
        className="mobile:top-2.5 absolute inset-x-0 top-1 h-6 w-full overflow-visible"
      >
        <clipPath id={clip}>
          <rect x="0" y="-4" width={pct * 2} height="32" />
        </clipPath>
        <path
          d={WAVE}
          fill="none"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          className="stroke-line-strong"
        />
        <path
          d={WAVE}
          fill="none"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          clipPath={`url(#${clip})`}
          className="stroke-accent-primary"
        />
      </svg>
      <span
        aria-hidden
        className="rounded-pill bg-text-primary ring-surface-content mobile:top-1.5 absolute top-0 h-8 w-2 -translate-x-1/2 shadow-md ring-2"
        style={{ left: `${pct}%` }}
      />
    </div>
  )
}

/** The angle dial: a ring of dots with a knob at the gradient angle (0° = up). */
export function AngleDial({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const handlers = dragHandlers((e, rect) => {
    onChange(dialAngle(e.clientX - rect.left - DIAL / 2, e.clientY - rect.top - DIAL / 2))
  })
  const at = (deg: number, r: number): { left: number; top: number } => ({
    left: DIAL / 2 + Math.sin((deg * Math.PI) / 180) * r,
    top: DIAL / 2 - Math.cos((deg * Math.PI) / 180) * r
  })
  return (
    <div className="grid justify-items-center gap-1">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Angle"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={value}
        aria-valuetext={`${value}°`}
        onKeyDown={(e) => {
          const next = sliderKey(value, e.key, 0, 360, 5, true)
          if (next === null) return
          e.preventDefault()
          onChange(next === 360 ? 0 : next)
        }}
        className="border-line-hairline focus-visible:outline-line-focus relative shrink-0 cursor-grab touch-none rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ width: DIAL, height: DIAL }}
        {...handlers}
      >
        {Array.from({ length: 16 }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className="bg-text-tertiary/60 absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={at(i * 22.5, DIAL_RING)}
          />
        ))}
        <span
          aria-hidden
          className="bg-text-primary ring-surface-content absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow ring-2"
          style={at(value, DIAL_RING)}
        />
      </div>
      <span className="text-meta text-text-secondary tabular-nums">{value}°</span>
    </div>
  )
}
