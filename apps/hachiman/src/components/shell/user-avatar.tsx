import { Children } from 'react'
import type { PresenceStatus } from '@hachiman/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { PresenceDot, presenceDotSize, presenceHole } from '@/components/ui/presence'
import { cutMask } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

/**
 * The presence dot of the mobile layout scales with the avatar (11 on 32, 13 on 40, 24 on 72) and
 * sticks out 1 px, with a 2.5 ring (the kit). The desktop keeps its 8 px dot and 2 px ring.
 */
const MOBILE_DOT_BOX = 'mobile:-right-[3.5px] mobile:-bottom-[3.5px] mobile:p-[2.5px]'

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
  /** The purple streaming dot in place of the presence colour (needs `status`). */
  live?: boolean
  speaking?: boolean
  /** Background class matching the surface behind the avatar (presence cutout). */
  cutout?: string
  /**
   * Mobile layout: the ring around the dot is a hole in the avatar, not a painted `cutout`, so a
   * tinted or translucent row (the drawer, a pressed row) shows through.
   */
  ringHole?: boolean
  className?: string
}): React.JSX.Element {
  const {
    name,
    avatar,
    size = 32,
    color,
    status,
    live = false,
    speaking,
    cutout = 'bg-sidebar',
    ringHole = false,
    className
  } = props
  const hole = Boolean(status) && ringHole
  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={
        {
          width: size,
          height: size,
          '--presence-dot': `${presenceDotSize(size)}px`,
          ...(hole && { '--presence-cut': cutMask([presenceHole(size)]) })
        } as React.CSSProperties
      }
    >
      <Avatar
        className={cn(
          'size-full',
          speaking && 'outline-online outline-2 outline-offset-0 outline-solid',
          hole && 'mobile:[mask-image:var(--presence-cut)]'
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
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 flex rounded-full p-0.5',
            MOBILE_DOT_BOX,
            cutout,
            hole && 'mobile:bg-transparent'
          )}
        >
          <PresenceDot status={status} live={live} className="mobile:size-(--presence-dot)" />
        </span>
      )}
    </span>
  )
}

/**
 * Avatars in a row that overlap by `overlap` px, each one in front of the one before it. The gap
 * of `ring` px around a front avatar is a hole in the one behind, so any surface shows through
 * (the online faces of M56, a call's faces in Active now). Pass avatars `size` px wide.
 */
export function AvatarRow({
  size,
  overlap,
  ring = 2,
  label,
  className,
  children
}: {
  size: number
  overlap: number
  ring?: number
  /** The accessible name of the row; without it the row is hidden from assistive tech. */
  label?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const items = Children.toArray(children)
  const r = size / 2
  const behind = cutMask([[size - overlap + r, r, r + ring]])
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('flex shrink-0 items-center', className)}
    >
      {items.map((item, i) => (
        <span
          key={i}
          className="flex shrink-0"
          style={{
            marginLeft: i === 0 ? undefined : -overlap,
            maskImage: i < items.length - 1 ? behind : undefined
          }}
        >
          {item}
        </span>
      ))}
    </span>
  )
}
