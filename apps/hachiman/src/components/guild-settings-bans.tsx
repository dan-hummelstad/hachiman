import { useEffect, useState } from 'react'
import type { Ban } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_6rem] items-center gap-3 px-3.5'

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
      <div role="table" aria-label="Bans" className="bg-surface-panel border-line-hairline border">
        <div
          role="row"
          className={`section-label bg-surface-raised/60 border-line-hairline border-b py-2.5 ${GRID}`}
        >
          <span role="columnheader">User</span>
          <span role="columnheader">Reason</span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {bans?.map((b) => (
          <div
            key={b.user.id}
            role="row"
            className={`border-line-hairline border-b py-2 last:border-b-0 ${GRID}`}
          >
            <span role="cell" className="flex min-w-0 items-center gap-2.5">
              <UserAvatar name={b.user.username} avatar={b.user.avatar} size={28} />
              <span className="flex min-w-0 flex-col">
                <span className="text-text-primary truncate text-sm font-semibold">
                  {b.user.username}
                </span>
                <span className="text-text-tertiary text-xs">
                  {new Date(b.createdAt).toLocaleDateString()}
                </span>
              </span>
            </span>
            <span role="cell" className="text-text-secondary truncate text-sm">
              {b.reason ?? <span className="text-text-tertiary">No reason</span>}
            </span>
            <span role="cell" className="flex justify-end">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void unban(b)}>
                Unban
              </Button>
            </span>
          </div>
        ))}
        {bans?.length === 0 && (
          <p className="text-text-tertiary px-2 py-6 text-center text-sm">No one is banned.</p>
        )}
        {bans === null && !error && (
          <p className="text-text-tertiary px-2 py-6 text-center text-sm">Loading…</p>
        )}
      </div>
    </div>
  )
}
