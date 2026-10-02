import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TitleBar } from '@/components/ui/title-bar'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { useGuildStore } from '@/stores/guildStore'

/**
 * Channel sidebar header: the guild name with the guild menu. With a banner, the name sits over
 * the top of a cropped banner strip (Discord-style); without one (or if it fails to load), the
 * plain 48px title bar.
 */
export function GuildHeader({ guildId }: { guildId: string }): React.JSX.Element {
  const name = useGuildStore((s) => s.guilds.get(guildId)?.name)
  const banner = useGuildStore((s) => s.guilds.get(guildId)?.banner ?? null)
  // Remembers which key failed, so a new banner gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null)
  const showBanner = banner !== null && banner !== failed

  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={cn(
          'flex h-12 w-full min-w-0 items-center gap-2 px-3 text-left text-[15px] leading-5 font-semibold',
          showBanner
            ? 'text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.9)] hover:bg-black/30 data-[state=open]:bg-black/30'
            : 'hover:bg-accent/60 data-[state=open]:bg-accent/60'
        )}
      >
        <span className="min-w-0 flex-1 truncate">{name ?? 'Loading…'}</span>
        <ChevronDown
          className={cn('size-4 shrink-0', showBanner ? 'drop-shadow' : 'text-muted-foreground')}
        />
      </button>
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu>
      {showBanner ? (
        <div className="bg-rail relative h-[135px] shrink-0 overflow-hidden border-b">
          <img
            src={hachiman.rest.fileUrl(banner)}
            alt=""
            onError={() => setFailed(banner)}
            className="absolute inset-0 size-full object-cover"
          />
          <div className="relative">{trigger}</div>
        </div>
      ) : (
        <TitleBar className="px-0" left={trigger} />
      )}
      <DropdownMenuContent align="start" sideOffset={4} className="w-56">
        <GuildMenuItems
          guildId={guildId}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
