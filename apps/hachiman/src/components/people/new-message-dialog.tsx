import { useEffect, useMemo, useState } from 'react'
import { Check, Search, SquarePen, UserPlus, X } from 'lucide-react'
import { DEFAULT_LIMITS, type Channel, type User } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { useAction } from '@/hooks/use-action'
import { usePresence } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { hachiman, openDmWith } from '@/services/hachiman'
import { ensureLimits } from '@/services/UploadService'
import { useLimitsStore } from '@/stores/limitsStore'
import { useUserStore } from '@/stores/userStore'
import { filterPeople, usePeople } from './use-people'

/**
 * "New message": pick one or more people I share a guild with. One opens (or reuses) the DM, two
 * or more create a group DM. `include` preselects the people of a 1:1 DM, to start a group with
 * them. `addTo` adds the picks to that group DM instead; its members are not offered.
 */
export function NewMessageDialog({
  open,
  onClose,
  include,
  addTo
}: {
  open: boolean
  onClose: () => void
  include?: User[]
  addTo?: Channel
}): React.JSX.Element {
  return (
    <ModalWindow
      open={open}
      onClose={onClose}
      title={include || addTo ? 'Add people' : 'New message'}
      description={
        addTo
          ? 'They’ll see the messages sent from now on.'
          : include
            ? 'Start a new group with the people of this conversation.'
            : 'Pick one person, or several for a group.'
      }
      icon={include || addTo ? <UserPlus /> : <SquarePen />}
    >
      {open && <Picker include={include} addTo={addTo} onClose={onClose} />}
    </ModalWindow>
  )
}

function Picker({
  include,
  addTo,
  onClose
}: {
  include?: User[]
  addTo?: Channel
  onClose: () => void
}): React.JSX.Element {
  const people = usePeople()
  const blocks = useUserStore((s) => s.blocks)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<User[]>(include ?? [])
  const { run, busy, error } = useAction()
  const members = addTo?.recipients
  const matches = useMemo(
    () =>
      filterPeople(people, query).filter(
        (u) => !blocks.has(u.id) && !members?.some((m) => m.id === u.id)
      ),
    [people, query, blocks, members]
  )
  const pickedIds = useMemo(() => new Set(picked.map((u) => u.id)), [picked])
  useEffect(ensureLimits, [])
  // The server's cap counts me too (`Limits.maxGroupDmMembers`, contract §4).
  const maxMembers = useLimitsStore(
    (s) => s.limits?.maxGroupDmMembers ?? DEFAULT_LIMITS.maxGroupDmMembers
  )
  const full = picked.length + (members?.length ?? 0) + 1 >= maxMembers
  // The same people again would make a duplicate group DM: the server reuses only a 1:1 DM.
  const unchanged =
    !!include && include.length === picked.length && include.every((u) => pickedIds.has(u.id))

  const toggle = (user: User): void => {
    setPicked((p) =>
      p.some((u) => u.id === user.id) ? p.filter((u) => u.id !== user.id) : [...p, user]
    )
    setQuery('')
  }

  const start = async (): Promise<void> => {
    const ids = picked.map((u) => u.id)
    const done = addTo
      ? await run('add them', () => hachiman.rest.addToGroupDm(addTo.id, ids))
      : await run(picked.length > 1 ? 'create the group' : 'open the conversation', () =>
          openDmWith(...ids)
        )
    if (done.ok) onClose()
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="rounded-control border-line-strong bg-surface-sunken focus-within:border-accent-primary flex min-h-9 flex-wrap items-center gap-1.5 border px-3 py-1.5">
        <Search className="text-text-tertiary size-4 shrink-0" aria-hidden />
        {picked.map((u) => (
          <span
            key={u.id}
            className="bg-surface-hover text-text-primary flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-xs font-semibold"
          >
            {u.username}
            <button
              type="button"
              aria-label={`Remove ${u.username}`}
              onClick={() => toggle(u)}
              className="hover:text-text-primary text-text-tertiary rounded-full"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && query === '' && picked.length > 0) {
              setPicked((p) => p.slice(0, -1))
            }
          }}
          placeholder={picked.length === 0 ? 'Find people' : ''}
          aria-label="Find people"
          className="placeholder:text-text-tertiary min-w-16 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      <ul className="-mx-2 flex max-h-72 flex-col overflow-y-auto">
        {matches.length === 0 ? (
          <li className="text-text-tertiary px-2 py-6 text-center text-sm">
            {people.length === 0 ? 'Nobody to message yet.' : 'No one matches.'}
          </li>
        ) : (
          matches.map((u) => (
            <PickRow
              key={u.id}
              user={u}
              selected={pickedIds.has(u.id)}
              disabled={busy || (full && !pickedIds.has(u.id))}
              onPick={() => toggle(u)}
            />
          ))
        )}
      </ul>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-3">
        {full && (
          <span className="text-text-tertiary text-xs">
            A group has at most {maxMembers} people.
          </span>
        )}
        <Button disabled={busy || picked.length === 0 || unchanged} onClick={() => void start()}>
          {addTo ? 'Add' : picked.length > 1 ? 'Create group' : 'Message'}
        </Button>
      </div>
    </div>
  )
}

function PickRow({
  user,
  selected,
  disabled,
  onPick
}: {
  user: User
  selected: boolean
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  const status = usePresence(user.id)
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
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
        <span className="text-text-primary min-w-0 flex-1 truncate text-sm font-semibold">
          {user.username}
        </span>
        <span
          className={cn(
            'border-line-strong flex size-5 shrink-0 items-center justify-center rounded-full border',
            selected && 'bg-accent-primary border-accent-primary text-text-on-accent'
          )}
          aria-hidden
        >
          {selected && <Check className="size-3" />}
        </span>
      </button>
    </li>
  )
}
