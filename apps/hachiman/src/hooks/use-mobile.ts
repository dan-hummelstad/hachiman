import { useMediaQuery } from '@/hooks/use-media-query'

/** Phone-width viewport (below Tailwind's `md`). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
