import { useId } from 'react'
import type { User } from '@hachiman/client'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { useAction } from '@/hooks/use-action'
import { blockedLine, useBlockedUsers } from '@/hooks/use-blocked-users'
import { blockService } from '@/services/guild-features'

/**
 * User settings → Privacy and safety on the mobile layout (M34). Today only BLOCKED · n, each
 * person with Unblock. The DM policy, message requests and what others see wait for their server
 * settings (spec §5), and the note says only what a block does today.
 */
export function PrivacySection(): React.JSX.Element {
  const { users, count, blockedAt } = useBlockedUsers()
  const labelId = useId()
  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <SectionLabel id={labelId}>Blocked · {count}</SectionLabel>
      {count === 0 || users.length === 0 ? (
        <p className="text-text-tertiary border-line-hairline border bg-white/2 px-3 py-5 text-center text-sm">
          {count === 0 ? 'You haven’t blocked anyone.' : 'Loading…'}
        </p>
      ) : (
        <ListGroup>
          {users.map((u) => (
            <BlockedRow key={u.id} user={u} blockedAt={blockedAt.get(u.id)} />
          ))}
        </ListGroup>
      )}
      <p className="text-text-tertiary px-1 pt-1 text-[12.5px] leading-[18px] font-medium">
        Blocked people can’t DM you or poke you. They aren’t told.
      </p>
    </section>
  )
}

/** A blocked person (64): avatar 34, the name, when I blocked them, and Unblock (44). */
function BlockedRow({
  user,
  blockedAt
}: {
  user: User
  blockedAt: string | undefined
}): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <div className="flex min-h-16 items-center gap-3 px-3 py-2.5">
      <UserAvatar avatar={user.avatar} name={user.username} size={34} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-text-primary truncate text-[15px] leading-[18px] font-bold">
          {user.username}
        </span>
        {error ? (
          <span
            role="alert"
            className="text-feature-danger-text text-[12.5px] leading-[15px] font-medium"
          >
            {error}
          </span>
        ) : (
          <span className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-medium">
            {blockedLine(blockedAt)}
          </span>
        )}
      </div>
      <Button
        variant="secondary"
        disabled={busy}
        aria-label={`Unblock ${user.username}`}
        onClick={() => void run(`unblock ${user.username}`, () => blockService.unblock(user.id))}
        className="border-line-strong h-11 bg-(--fill-control) px-3.5 text-[13.5px] font-bold"
      >
        Unblock
      </Button>
    </div>
  )
}
