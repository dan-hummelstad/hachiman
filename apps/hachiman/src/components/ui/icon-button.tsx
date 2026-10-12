import { cva } from 'class-variance-authority'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// `mobile:active:` is the press fill on touch, where `hover:` never applies.
const iconButton = cva(
  'text-muted-foreground hover:bg-accent hover:text-foreground mobile:active:bg-surface-hover shrink-0 p-0 has-[>svg]:p-0',
  {
    variants: {
      size: {
        // Same arbitrary variant as Button's default icon size, so tailwind-merge replaces it.
        sm: "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        md: 'size-8',
        /** Mobile kit: a 36 touch target with an 18 icon. */
        touch: "size-9 [&_svg:not([class*='size-'])]:size-[18px]"
      },
      // Colour while pressed (aria-pressed=true); danger also colours the hover.
      tone: {
        default: 'aria-pressed:bg-accent aria-pressed:text-foreground',
        danger: 'hover:text-destructive aria-pressed:text-destructive',
        online: 'aria-pressed:text-online'
      }
    },
    defaultVariants: { size: 'md', tone: 'default' }
  }
)

export interface IconButtonProps extends Omit<React.ComponentProps<'button'>, 'aria-label'> {
  /** Accessible name and tooltip text. */
  label: string
  /** Toggle state; sets aria-pressed (omit for a plain action button). */
  pressed?: boolean
  size?: 'sm' | 'md' | 'touch'
  tone?: 'default' | 'danger' | 'online'
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
}

/** Square ghost icon button with a tooltip. Children are the icon. */
export function IconButton({
  label,
  pressed,
  size,
  tone,
  tooltipSide = 'top',
  className,
  type = 'button',
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="quiet"
          type={type}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(iconButton({ size, tone }), className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  )
}
