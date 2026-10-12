import { cn } from '@/lib/utils'

/**
 * The window wallpaper: tinted by the guild (N4), or the user's custom gradient (useGuildTint).
 * The desktop shell, the mobile shell and the mobile pushed and search screens use it.
 */
export const WALLPAPER = cn(
  'bg-surface-window',
  'bg-(image:--wallpaper-light)',
  'dark:bg-(image:--wallpaper-dark)'
)
