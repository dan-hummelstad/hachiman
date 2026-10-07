import { AudioLines, Volume2 } from 'lucide-react'
import { activityLabel, type VoiceActivity } from '@/lib/member-activity'
import { cn } from '@/lib/utils'

/**
 * "In Lounge" / "Speaking in Lounge · Guild" with the voice icon (activityLabel). The caller
 * gives the size and color; the icon follows the text size.
 */
export function VoiceActivityLine({
  activity,
  className
}: {
  activity: VoiceActivity
  className?: string
}): React.JSX.Element {
  const Icon = activity.speaking ? AudioLines : Volume2
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{activityLabel(activity)}</span>
    </span>
  )
}
