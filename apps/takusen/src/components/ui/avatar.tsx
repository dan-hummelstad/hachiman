'use client'

import { Avatar as AvatarPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/** Up to two initials: from the name, else the email. */
function initialsFor(name: string, email = ''): string {
  const source = name.trim() || email
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

const TONES = {
  /** The signed-in user on a Takusen page. */
  gold: 'bg-gold text-on-gold',
  /** Hachiman people and guilds on an SSO page. */
  hachiman: 'bg-accent-tint text-accent-text',
  /** Rows in the admin console. */
  neutral: 'bg-surface-raised text-text-secondary',
}

/**
 * A round avatar or guild icon: the image, else initials. `size` is the side
 * in px; leave it out to size it with `className` (the initials then take the
 * font size from `className` too).
 */
export function EntityAvatar({
  src,
  name,
  email,
  size,
  tone = 'neutral',
  className,
}: {
  src: string | null
  name: string
  email?: string
  size?: number
  tone?: keyof typeof TONES
  className?: string
}): React.JSX.Element {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full select-none', className)}
      style={size ? { width: size, height: size } : undefined}
    >
      {src && <AvatarPrimitive.Image src={src} alt="" className="aspect-square size-full object-cover" />}
      <AvatarPrimitive.Fallback
        className={cn('flex size-full items-center justify-center font-extrabold', TONES[tone])}
        style={size ? { fontSize: Math.max(9, Math.round(size * 0.37)) } : undefined}
      >
        {initialsFor(name, email)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}
