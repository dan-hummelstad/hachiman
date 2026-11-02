import type { Guild } from '@hachiman/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { guildInitials } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

const SIZE = {
  md: 'size-10 text-[15px]', // rail
  lg: 'size-14 text-lg', // invite preview
  xl: 'size-20 text-2xl' // guild settings
} as const

/**
 * Rounded-square guild icon: the icon file if set, else initials on a neutral avatar shade (also while loading
 * or when the image fails). Decorative (aria-hidden).
 */
export function GuildTile({
  guild,
  size = 'md',
  className
}: {
  guild: Pick<Guild, 'name'> & { icon?: string | null }
  size?: keyof typeof SIZE
  className?: string
}): React.JSX.Element {
  return (
    <Avatar
      aria-hidden
      className={cn(
        'text-text-secondary border-line-hairline rounded-[22%] border font-mono leading-none font-medium',
        SIZE[size],
        className
      )}
    >
      {guild.icon && <AvatarImage src={hachiman.rest.fileUrl(guild.icon)} alt="" />}
      <AvatarFallback className="text-[length:inherit] text-inherit">
        {guildInitials(guild.name)}
      </AvatarFallback>
    </Avatar>
  )
}
