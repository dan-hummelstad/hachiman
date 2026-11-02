import { Check, ChevronDown, Copy } from 'lucide-react'
import {
  READ_FIELD,
  FieldBlock,
  ReadField,
  SettingsRule,
  SettingsCap,
  ToggleRow
} from '@/components/settings/user/rows'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { isStatus, OWN_STATUS_LABEL, PresenceDot, STATUSES } from '@/components/ui/presence'
import { useCopy } from '@/hooks/use-copy'
import { cn } from '@/lib/utils'
import { setMyStatus } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { openDialog } from '@/stores/dialogStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/**
 * User settings -> Account (desktop only: the phone has no Account row, its identity rows live
 * in Profile): who you are on Takusen, your status and the density of messages.
 */
export function AccountSection(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const takusenUser = useTakusenStore((s) => s.session?.user ?? null)
  const messageDisplay = usePrefsStore((s) => s.messageDisplay)
  const setMessageDisplay = usePrefsStore((s) => s.setMessageDisplay)
  const name = me?.username ?? takusenUser?.handle ?? 'Unknown'
  const { copied, copy } = useCopy()

  return (
    <div>
      <div className="flex items-center gap-4">
        <UserAvatar name={name} avatar={me?.avatar} size={62} className="rounded-[16px]" />
        <div className="min-w-0">
          <p className="text-text-primary truncate text-[17px] font-semibold tracking-[-0.3px]">
            {name}
          </p>
          <p className="text-text-disabled flex items-center gap-1 font-mono text-[9.5px] tracking-[0.8px] uppercase">
            <span className="truncate">
              @{name}
              {me && ` · User ID ${me.id}`}
            </span>
            {me && (
              <IconButton
                label={copied !== null ? 'Copied' : 'Copy user ID'}
                size="sm"
                className={cn(copied !== null && 'text-text-primary')}
                onClick={() => copy(me.id)}
              >
                {copied !== null ? <Check /> : <Copy />}
              </IconButton>
            )}
          </p>
        </div>
        <Button variant="secondary" className="ml-auto" asChild>
          <a href={`${takusenService.env.issuerOrigin}/account`} target="_blank" rel="noreferrer">
            Manage on Takusen
          </a>
        </Button>
      </div>
      <div className="mt-[22px] grid grid-cols-3 gap-3.5">
        <FieldBlock label="Username">
          <ReadField prefix="@">{name}</ReadField>
        </FieldBlock>
        <FieldBlock label="Email">
          <ReadField>
            {takusenUser?.email || (
              <span className="text-text-tertiary">Not shared by your Takusen account</span>
            )}
          </ReadField>
        </FieldBlock>
        <FieldBlock label="Status">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(READ_FIELD, 'w-full justify-between gap-2 text-left outline-none')}
              aria-label={`Status: ${OWN_STATUS_LABEL[status]}`}
            >
              <span className="flex items-center gap-2">
                <PresenceDot status={status} className="size-2" />
                {OWN_STATUS_LABEL[status]}
              </span>
              <ChevronDown aria-hidden className="text-text-tertiary size-[15px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {STATUSES.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => isStatus(s) && setMyStatus(s)}>
                  <PresenceDot status={s} className="size-2" />
                  {OWN_STATUS_LABEL[s]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openDialog({ kind: 'customStatus' })}>
                Set a status…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </FieldBlock>
      </div>
      <SettingsRule />
      <SettingsCap>Preferences</SettingsCap>
      <ToggleRow
        title="Compact density"
        hint="Tighter rows, smaller avatars, more messages on screen."
        checked={messageDisplay === 'compact'}
        onChange={(on) => setMessageDisplay(on ? 'compact' : 'cozy')}
      />
    </div>
  )
}
