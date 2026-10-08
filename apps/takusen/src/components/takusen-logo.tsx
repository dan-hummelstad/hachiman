import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export type Product = 'takusen' | 'hachiman'

const PRODUCT = {
  // 託 "to entrust": gold is Takusen.
  takusen: { glyph: '託', name: 'Takusen', fill: 'bg-linear-135 from-gold-strong to-gold text-on-gold' },
  // 八 "eight": violet is Hachiman. The gradient is the brand pair, the same in both themes.
  hachiman: { glyph: '八', name: 'Hachiman', fill: 'bg-linear-135 from-[#7b6cff] to-[#b98cff] text-white' },
} as const

/**
 * A product mark ("Two marks, two products"): a square with the kanji. Square because it is
 * an identity, not a control. `size` is the side in px: 18 in the handoff rail, 28 in the
 * Brand row, 34 in the Hachiman launcher. Decorative; the label next to it names it.
 */
export function ProductMark({
  product,
  size = 28,
  className,
}: {
  product: Product
  size?: number
  className?: string
}): React.JSX.Element {
  const p = PRODUCT[product]
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-glyph leading-none font-bold select-none',
        p.fill,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.57) }}
    >
      {p.glyph}
    </span>
  )
}

export function TakusenMark(props: { size?: number; className?: string }): React.JSX.Element {
  return <ProductMark product="takusen" {...props} />
}

export function HachimanMark(props: { size?: number; className?: string }): React.JSX.Element {
  return <ProductMark product="hachiman" {...props} />
}

/** T3 / Brand: 28px mark, then the wordmark in Figtree 16/800. */
export function Brand({
  product = 'takusen',
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { product?: Product }): React.JSX.Element {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-2.5 text-base leading-5 font-extrabold tracking-[-0.2px] text-text-primary',
        className,
      )}
    >
      <ProductMark product={product} />
      {PRODUCT[product].name}
    </span>
  )
}

/** The Takusen Brand row. Older name of `<Brand />`. */
export const TakusenLogo = Brand
