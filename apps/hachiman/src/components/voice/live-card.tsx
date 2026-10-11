import { useEffect, useRef } from 'react'
import { Eye } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { SystemTag } from '@/components/ui/system-tag'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'

/** "<name> is live", or "<name> is live in <channel>", with the member's display name. */
export function StreamerName({
  guildId,
  userId,
  channelName
}: {
  guildId: string | null
  userId: string
  channelName?: string
}): React.JSX.Element {
  const { name } = useMemberView(guildId, userId)
  return (
    <>
      {name} is live{channelName !== undefined && ` in ${channelName}`}
    </>
  )
}

const FRAME = {
  sm: {
    box: 'h-12 w-20 shrink-0',
    avatar: 32,
    tag: 'absolute top-0.5 left-0.5 h-4 px-1 text-[9px]'
  },
  md: { box: 'aspect-video w-full', avatar: 48, tag: 'absolute top-1.5 left-1.5' },
  lg: { box: 'aspect-video w-full max-w-2xl', avatar: 112, tag: 'absolute top-3 left-3' },
  strip: {
    box: 'h-[52px] w-full',
    avatar: 32,
    tag: 'absolute top-1.5 left-1.5 h-[17px] px-[5px] text-[9.5px]'
  }
} as const

/**
 * A live stream seen from outside its call (arc plan decision 4). Only members of the call hold
 * the SFrame keys (§12.10), so the card shows the streamer's avatar on the live tint. `stream`
 * (size 'sm' only) is a share that the viewer already watches in that call.
 * - 'sm': a row for the member list; a button when `onClick` is given.
 * - 'md': a tile with the name under it (Active now).
 * - 'lg': the stage of a voice channel the viewer is not in.
 * - 'strip': the body of a card in the mobile Active now strip (M56), a 52 high frame over the
 *   name. Phrasing content only, as the card is a button.
 */
export function LiveCard({
  guildId,
  userId,
  channelName,
  watching,
  size,
  stream,
  onClick
}: {
  guildId: string | null
  userId: string
  channelName: string
  /** The other people in the channel. */
  watching: number
  size: keyof typeof FRAME
  stream?: MediaStream
  onClick?: () => void
}): React.JSX.Element {
  const { member, name, ink } = useMemberView(guildId, userId)
  const avatar = member?.user.avatar
  const frame = FRAME[size]
  const detail = `${channelName} · ${watching} watching`

  const box = (
    <span
      className={cn(
        'bg-feature-danger/10 relative flex items-center justify-center overflow-hidden',
        (size === 'md' || size === 'lg') && 'border-feature-danger/30 border',
        frame.box
      )}
    >
      {stream ? (
        <StreamThumb stream={stream} />
      ) : (
        <UserAvatar
          name={name}
          avatar={avatar}
          color={ink}
          size={frame.avatar}
          className={cn(
            size !== 'sm' && 'ring-feature-danger/40 rounded-full ring-4',
            size === 'strip' && 'ring-2'
          )}
        />
      )}
      {size === 'lg' ? (
        <span className={cn(frame.tag, 'flex items-center gap-1.5')}>
          <SystemTag kind="live" />
          <span className="bg-surface-window/85 text-text-primary flex h-[18px] items-center gap-1 px-1.5 text-[11px] leading-none font-bold">
            <Eye className="size-3" aria-hidden />
            {watching} watching
          </span>
        </span>
      ) : (
        <SystemTag kind="live" className={frame.tag} />
      )}
      {size === 'lg' && (
        <span className="absolute bottom-3 left-3 flex min-w-0 items-center gap-2">
          <UserAvatar name={name} avatar={avatar} color={ink} size={32} />
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate text-sm font-bold" style={ink ? { color: ink } : undefined}>
              {name}
            </span>
            <span className="text-text-secondary truncate text-xs">Streaming {channelName}</span>
          </span>
        </span>
      )}
    </span>
  )
  if (size === 'lg') return box

  const caption = (
    <span className="flex min-w-0 flex-col text-left">
      <span className="text-text-primary truncate text-[13px] font-bold">
        <StreamerName guildId={guildId} userId={userId} />
      </span>
      <span className="text-text-tertiary truncate text-xs">{detail}</span>
    </span>
  )

  if (size === 'strip')
    return (
      <span className="flex w-full min-w-0 flex-col gap-2">
        {box}
        <span className="flex min-w-0 items-center gap-2 px-1">
          <UserAvatar avatar={avatar} name={name} color={ink} size={24} />
          <span className="flex min-w-0 flex-col gap-px text-left">
            <span className="text-text-primary truncate text-[13.5px] leading-4 font-extrabold">
              <StreamerName guildId={guildId} userId={userId} />
            </span>
            <span className="text-text-tertiary truncate text-xs leading-[14px] font-semibold">
              {detail}
            </span>
          </span>
        </span>
      </span>
    )

  if (size === 'md')
    return (
      <div className="flex flex-col gap-2">
        {box}
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar avatar={avatar} name={name} color={ink} size={24} />
          {caption}
        </div>
      </div>
    )

  const row = 'border-feature-danger/50 bg-feature-danger/10 flex items-center gap-2.5 border p-2'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        row,
        'hover:bg-feature-danger/15 focus-visible:outline-line-focus focus-visible:outline-2'
      )}
    >
      {box}
      {caption}
    </button>
  ) : (
    <div className={row}>
      {box}
      {caption}
    </div>
  )
}

function StreamThumb({ stream }: { stream: MediaStream }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream
  }, [stream])
  return <video ref={video} autoPlay muted playsInline className="size-full object-cover" />
}
