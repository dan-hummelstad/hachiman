import { CheckIcon } from 'lucide-react'
import { Fragment } from 'react'

import { ProductMark, type Product } from '@/components/takusen-logo'
import { cn } from '@/lib/utils'

export interface HandoffStep {
  product: Product
  label: string
  state: 'done' | 'current' | 'next'
}

/**
 * T3 / Handoff rail: where you came from, where you are, where you'll land. The current
 * step is a pill in its product's colour, so the rail turns violet as you return to
 * Hachiman. Below `sm` only the current step keeps its label; the marks still tell the story.
 */
export function HandoffRail({
  steps,
  className,
}: {
  steps: readonly HandoffStep[]
  className?: string
}): React.JSX.Element {
  return (
    <ol
      aria-label="Sign-in steps"
      className={cn('flex items-center gap-2.5', className)}
    >
      {steps.map((step, i) => (
        <Fragment key={`${step.product}-${step.label}`}>
          {i > 0 && <li aria-hidden className="h-px w-5 shrink-0 bg-line-strong sm:w-9" />}
          <RailStep step={step} />
        </Fragment>
      ))}
    </ol>
  )
}

function RailStep({ step }: { step: HandoffStep }): React.JSX.Element {
  const current = step.state === 'current'
  return (
    <li
      aria-current={current ? 'step' : undefined}
      className={cn(
        'flex h-[30px] shrink-0 items-center gap-2 rounded-pill border pl-1.5 text-[13px] leading-none font-bold whitespace-nowrap',
        current
          ? step.product === 'hachiman'
            ? 'border-line-focus bg-accent-tint pr-3 font-extrabold text-accent-text'
            : 'border-gold-line bg-gold-tint pr-3 font-extrabold text-gold-text'
          : 'border-transparent pr-1.5 sm:pr-3',
        step.state === 'done' && 'text-text-secondary',
        step.state === 'next' && 'text-text-tertiary',
      )}
    >
      <ProductMark
        product={step.product}
        size={18}
        className={step.state === 'next' ? 'opacity-50' : undefined}
      />
      <span className={current ? undefined : 'sr-only sm:not-sr-only'}>{step.label}</span>
      {step.state === 'done' && (
        <>
          <CheckIcon aria-hidden className="size-3.5 text-feature-voice-text" />
          <span className="sr-only">(done)</span>
        </>
      )}
    </li>
  )
}
