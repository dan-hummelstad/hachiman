import { useEffect, useState } from 'react'
import type { Ban } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

/**
 * Guild settings → Bans (BAN_MEMBERS, contract §4 Bans): newest first, with Unban. There are no
 * ban events, so the list loads when the page opens and changes with each unban here.
 */
export function GuildBansTab({ guildId }: { guildId: string }): React.JSX.Element {
  const [bans, setBans] = useState<Ban[] | null>(null)
  const { run, busy, error, setError } = useAction()

  useEffect(() => {
    hachiman.rest
      .getBans(guildId)
      .then(setBans)
      .catch((e) => setError(`Could not load bans: ${errMsg(e)}. Reopen settings to retry.`))
  }, [guildId, setError])

  const unban = async (b: Ban): Promise<void> => {
    const res = await run(`unban ${b.user.username}`, () =>
      hachiman.rest.unbanMember(guildId, b.user.id)
    )
    if (res.ok) setBans((cur) => cur?.filter((x) => x.user.id !== b.user.id) ?? null)
  }

  return (
    <div className="grid gap-3">
      <ErrorText>{error}</ErrorText>
      {bans && (
        <div className="rounded-control bg-surface-sunken mobile:hidden grid w-[273px] gap-1 px-4 py-3.5">
          <div className="flex items-baseline gap-[9px]">
            <span className="text-text-primary text-[24px] font-semibold tracking-[-0.6px] tabular-nums">
              {bans.length}
            </span>
            <span className="cap text-text-tertiary text-[9px] tracking-[1.3px]">Banned</span>
          </div>
          <span className="cap-sm text-[8.5px]">Unban to let them join again</span>
        </div>
      )}
      <h3 className="cap text-text-disabled mobile:hidden text-[9px] tracking-[1.5px]">
        Banned members
      </h3>
      <div
        role="table"
        aria-label="Bans"
        className="mobile:rounded-[14px] mobile:bg-surface-panel mobile:overflow-hidden"
      >
        <div role="row" className="sr-only">
          <span role="columnheader">User</span>
          <span role="columnheader">Reason</span>
          <span role="columnheader">Actions</span>
        </div>
        {bans?.map((b) => (
          <div
            key={b.user.id}
            role="row"
            className="border-line-hairline mobile:min-h-[54px] mobile:px-3.5 flex min-h-[58px] items-center gap-[11px] border-b px-2.5 last:border-b-0"
          >
            <span
              role="cell"
              className="text-text-disabled mobile:hidden w-16 shrink-0 font-mono text-[9.5px] tracking-[0.6px]"
            >
              {new Date(b.createdAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short'
              })}
            </span>
            <span role="cell" className="flex min-w-0 flex-1 items-center gap-[11px]">
              <UserAvatar
                name={b.user.username}
                avatar={b.user.avatar}
                size={22}
                className="mobile:rounded-full rounded-[6px]"
              />
              <span className="min-w-0 truncate text-[12.5px]">
                <span className="text-text-primary font-semibold">{b.user.username}</span>{' '}
                {b.reason ? (
                  <span className="text-text-secondary">{b.reason}</span>
                ) : (
                  <span className="text-text-tertiary">No reason</span>
                )}
              </span>
            </span>
            <span role="cell" className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                className="mobile:rounded-pill"
                disabled={busy}
                onClick={() => void unban(b)}
              >
                Unban
              </Button>
            </span>
          </div>
        ))}
        {bans?.length === 0 && (
          <p className="text-text-tertiary px-2 py-6 text-center text-[12.5px]">
            No one is banned.
          </p>
        )}
        {bans === null && !error && (
          <p className="text-text-tertiary px-2 py-6 text-center text-[12.5px]">Loading…</p>
        )}
      </div>
    </div>
  )
}
