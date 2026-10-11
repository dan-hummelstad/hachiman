import { cn } from '@/lib/utils'

/**
 * Docked foot of a mobile screen (kit "Docked foot", M52): padding 12/16/4/16 for one 48 primary
 * button, a 6 gap for a second one under it, then the home-indicator inset. It takes the colour
 * of the panel it sits on. While the keyboard is up the inset goes away, because the foot then
 * rides on the keyboard (`data-keyboard` on `<html>`, spec §2.8).
 */
export function MobileFoot({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="mobile-foot"
      className={cn(
        'flex shrink-0 flex-col gap-1.5 px-4 pt-3 pb-[calc(4px+var(--safe-bottom,0px))] in-data-[keyboard=open]:pb-1',
        className
      )}
      {...props}
    />
  )
}
