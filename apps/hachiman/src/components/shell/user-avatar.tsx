import type { PresenceStatus } from '@hachiman/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { PresenceDot } from '@/components/ui/presence'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

/**
 * Circular avatar with an optional circular presence dot (bottom-right, cut out of the
 * pane background via `cutout`) and an optional 2px `--online` speaking outline.
 */
export function UserAvatar(props: {
  name: string
  /** Avatar file key (User.avatar). Falls back to the initial while loading or on a load error. */
  avatar?: string | null
  /** Pixel size of the circle (default 32). */
  size?: number
  /** Role colour for the fallback initial. */
  color?: string | undefined
  /** Omit to hide the presence dot. */
  status?: PresenceStatus
  speaking?: boolean
  /** Background class matching the surface behind the avatar (presence cutout). */
  cutout?: string
  className?: string
}): React.JSX.Element {
  const {
    name,
    avatar,
    size = 32,
    color,
    status,
    speaking,
    cutout = 'bg-sidebar',
    className
  } = props
  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Avatar
        className={cn(
          'size-full',
          speaking && 'outline-online outline-2 outline-offset-0 outline-solid'
        )}
      >
        {avatar && <AvatarImage src={hachiman.rest.fileUrl(avatar)} alt="" />}
        <AvatarFallback
          className="bg-surface-raised text-text-primary font-bold"
          style={{ fontSize: Math.max(10, Math.round(size * 0.45)), color }}
        >
          {name.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {status && (
        <span className={cn('absolute -right-0.5 -bottom-0.5 flex rounded-full p-0.5', cutout)}>
          <PresenceDot status={status} />
        </span>
      )}
    </span>
  )
}
