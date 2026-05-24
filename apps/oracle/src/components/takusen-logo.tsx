import type { HTMLAttributes } from 'react'

/**
 * Placeholder Takusen wordmark. Real logo / SVG can replace this later — for
 * now it's just a styled <span> so layouts have something to render.
 */
export function TakusenLogo({
  className = '',
  ...rest
}: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      {...rest}
      className={`font-mono text-lg font-semibold tracking-tight text-foreground ${className}`}
    >
      Takusen
    </span>
  )
}
