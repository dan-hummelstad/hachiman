import { useMemo, useState } from 'react'
import { Search, SquarePen } from 'lucide-react'
import type { User } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { useAction } from '@/hooks/use-action'
import { usePresence } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { openDmWith } from '@/services/hachiman'
import { useUserStore } from '@/stores/userStore'
import { filterPeople, usePeople } from './use-people'

/** "New message": pick a person I share a guild with; opens (or reuses) the DM with them. */
export function NewMessageDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <ModalWindow
      open={open}
      onClose={onClose}
      title="New message"
      description="Pick someone you share a guild with."
      icon={<SquarePen />}
    >
      {open && <Picker onClose={onClose} />}
    </ModalWindow>
  )
}

function Picker({ onClose }: { onClose: () => void }): React.JSX.Element {
  const people = usePeople()
  const blocks = useUserStore((s) => s.blocks)
  const [query, setQuery] = useState('')
  const { run, busy, error } = useAction()
  const matches = useMemo(
    () => filterPeople(people, query).filter((u) => !blocks.has(u.id)),
    [people, query, blocks]
  )

  const pick = async (user: User): Promise<void> => {
    if ((await run('open the conversation', () => openDmWith(user.id))).ok) onClose()
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="rounded-control border-line-strong bg-surface-sunken focus-within:border-accent-primary flex h-9 items-center gap-2 border px-3">
        <Search className="text-text-tertiary size-4 shrink-0" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find people"
          aria-label="Find people"
          className="placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      <ul className="-mx-2 flex max-h-72 flex-col overflow-y-auto">
        {matches.length === 0 ? (
          <li className="text-text-tertiary px-2 py-6 text-center text-sm">
            {people.length === 0 ? 'Nobody to message yet.' : 'No one matches.'}
          </li>
        ) : (
          matches.map((u) => (
            <PickRow key={u.id} user={u} disabled={busy} onPick={() => void pick(u)} />
          ))
        )}
      </ul>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function PickRow({
  user,
  disabled,
  onPick
}: {
  user: User
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  const status = usePresence(user.id)
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        className={cn(
          'rounded-control hover:bg-surface-hover focus-visible:outline-line-focus flex w-full items-center gap-2.5 px-2 py-1.5 text-left focus-visible:outline-2',
          'disabled:opacity-50'
        )}
      >
        <UserAvatar
          avatar={user.avatar}
          name={user.username}
          status={status}
          cutout="bg-surface-content"
        />
        <span className="text-text-primary truncate text-sm font-semibold">{user.username}</span>
      </button>
    </li>
  )
}
