import type { User } from '@hachiman/client'
import { LinkPreviewSetting } from '@/components/settings/user/link-previews'
import {
  MobileCap,
  MobileCard,
  MobileNote,
  SettingsCap,
  SettingsRule
} from '@/components/settings/user/rows'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { useAction } from '@/hooks/use-action'
import { blockedLine, useBlockedUsers } from '@/hooks/use-blocked-users'
import { useLayout } from '@/hooks/use-layout'
import { usePlatform } from '@/shared/PlatformContext'
import { blockService } from '@/services/guild-features'

const NOTE = 'Blocked people can’t DM you or poke you. They aren’t told.'

/**
 * User settings -> Privacy and safety: what this device loads (link previews), then BLOCKED · n,
 * each person with Unblock. The reach controls (who can DM you, message requests) wait for their
 * server settings.
 */
export function PrivacySection(): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const showLinks = usePlatform().fetchLinkResource !== null
  const { users, count, blockedAt } = useBlockedUsers()
  const empty = count === 0 || users.length === 0
  const emptyText = count === 0 ? 'You haven’t blocked anyone.' : 'Loading…'
  const rows = users.map((u) => (
    <BlockedRow key={u.id} user={u} blockedAt={blockedAt.get(u.id)} mobile={mobile} />
  ))

  if (mobile) {
    return (
      <div className="grid gap-[18px]">
        {showLinks && (
          <section className="flex flex-col gap-1.5">
            <MobileCap>Links</MobileCap>
            <MobileCard>
              <LinkPreviewSetting />
            </MobileCard>
          </section>
        )}
        <section className="flex flex-col gap-1.5">
          <MobileCap>Blocked · {count}</MobileCap>
          {empty ? (
            <p className="text-text-tertiary px-1 py-5 text-center text-sm">{emptyText}</p>
          ) : (
            <MobileCard>{rows}</MobileCard>
          )}
          <MobileNote>{NOTE}</MobileNote>
        </section>
      </div>
    )
  }

  return (
    <div>
      {showLinks && (
        <>
          <SettingsCap>What your device loads</SettingsCap>
          <div className="mt-1.5">
            <LinkPreviewSetting />
          </div>
          <SettingsRule />
        </>
      )}
      <SettingsCap>Blocked · {count}</SettingsCap>
      <div className="mt-2">
        {empty ? <p className="text-text-tertiary text-[13px]">{emptyText}</p> : rows}
      </div>
      <p className="text-text-tertiary mt-3 text-[12.5px]">{NOTE}</p>
    </div>
  )
}

/** A blocked person: avatar, the name, when I blocked them, and Unblock. */
function BlockedRow({
  user,
  blockedAt,
  mobile
}: {
  user: User
  blockedAt: string | undefined
  mobile: boolean
}): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <div
      className={
        mobile ? 'flex min-h-16 items-center gap-3 px-3 py-2.5' : 'flex h-12 items-center gap-3'
      }
    >
      <UserAvatar avatar={user.avatar} name={user.username} size={mobile ? 34 : 28} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-text-secondary truncate text-[13.5px] leading-[18px] font-medium">
          {user.username}
        </span>
        {error ? (
          <span role="alert" className="text-you-text text-[12.5px] leading-[15px]">
            {error}
          </span>
        ) : (
          <span className="text-text-disabled truncate font-mono text-[9px] tracking-[0.8px] uppercase">
            {blockedLine(blockedAt)}
          </span>
        )}
      </div>
      <Button
        variant="secondary"
        size={mobile ? 'default' : 'sm'}
        disabled={busy}
        aria-label={`Unblock ${user.username}`}
        onClick={() => void run(`unblock ${user.username}`, () => blockService.unblock(user.id))}
      >
        Unblock
      </Button>
    </div>
  )
}
