import { useEffect, useState } from 'react'
import { MessagesSquare, Plus } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { formatFull } from '@/components/chat/format'
import {
  EmptyLine,
  HeaderCountButton,
  HeaderPopoverFrame
} from '@/components/pins/header-count-button'
import { openChannelView } from '@/components/pins/jump'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { cn } from '@/lib/utils'
import { threadService } from '@/services/guild-features'
import { useMessageStore } from '@/stores/messagesStore'
import { lastActivityOf, useThreadCount, useThreads } from '@/stores/threadsStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { MAX_THREAD_NAME, validThreadName } from './thread-name'

/** The sky threads button of the channel header (N12) and its popover of threads. */
export function ThreadsButton({ channel }: { channel: Channel }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const count = useThreadCount(channel.id)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <HeaderCountButton label="Threads" count={count} feature="thread" pressed={open}>
          <MessagesSquare />
        </HeaderCountButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] max-w-[calc(100vw-32px)] p-0">
        <ThreadsList parent={channel} onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function ThreadsList({
  parent,
  onOpened
}: {
  parent: Channel
  onOpened: () => void
}): React.JSX.Element {
  const threads = useThreads(parent.id)
  const canCreate = has(usePermissions(parent.guildId, parent.id), Permissions.SEND_MESSAGES)
  const [creating, setCreating] = useState(false)

  // Opening the list refreshes the activity order and finds threads that READY did not carry.
  useEffect(() => {
    void threadService
      .list(parent.id)
      .catch((e: unknown) => console.warn('[threads] list failed', e))
  }, [parent.id])

  const open = (t: Channel): void => {
    onOpened()
    openChannelView(t)
  }

  return (
    <HeaderPopoverFrame
      icon={<MessagesSquare className="text-feature-thread-text" />}
      title="Threads"
      actions={
        canCreate &&
        !creating && (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New thread
          </Button>
        )
      }
    >
      {creating && (
        <NewThreadForm
          parentId={parent.id}
          initialName=""
          onCancel={() => setCreating(false)}
          onCreated={open}
        />
      )}
      {threads.length === 0 && !creating ? (
        <EmptyLine>No threads in #{parent.name} yet.</EmptyLine>
      ) : (
        threads.map((t) => <ThreadRow key={t.id} thread={t} onOpen={() => open(t)} />)
      )}
    </HeaderPopoverFrame>
  )
}

function ThreadRow({ thread, onOpen }: { thread: Channel; onOpen: () => void }): React.JSX.Element {
  const last = useMessageStore((s) => lastActivityOf(s.byChannel, thread.id))
  const badge = useChannelUnread(thread.id)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'rounded-option hover:bg-surface-hover flex w-full items-center gap-3 px-2.5 py-2 text-left',
        'focus-visible:outline-line-focus outline-none focus-visible:outline-2'
      )}
    >
      <span className="rounded-control bg-feature-thread/15 text-feature-thread-text flex size-8 shrink-0 items-center justify-center">
        <MessagesSquare className="size-4" aria-hidden />
      </span>
      <span className="grid min-w-0 flex-1">
        <span
          className={cn(
            'truncate text-[14px] font-semibold',
            badge.unread || badge.mentions > 0 ? 'text-text-primary' : 'text-text-secondary'
          )}
        >
          {thread.name}
        </span>
        <span className="text-text-tertiary truncate text-[12px] font-medium">
          {last ? `Last message ${formatFull(last)}` : 'No recent messages'}
        </span>
      </span>
      {badge.mentions > 0 ? (
        <span className="bg-feature-danger text-text-on-accent rounded-pill min-w-5 px-1.5 text-center text-[11px] leading-5 font-bold">
          {badge.mentions}
        </span>
      ) : (
        badge.unread && (
          <span className="bg-text-primary size-2 shrink-0 rounded-full" aria-label="Unread" />
        )
      )}
    </button>
  )
}

/** The name field of a new thread. `startMessageId` ties it to a message of the parent. */
export function NewThreadForm({
  parentId,
  startMessageId,
  initialName,
  onCancel,
  onCreated
}: {
  parentId: string
  startMessageId?: string
  initialName: string
  onCancel: () => void
  onCreated: (thread: Channel) => void
}): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const { run, busy, error } = useAction()
  const valid = validThreadName(name)

  const submit = async (): Promise<void> => {
    if (!valid) return
    const r = await run('create the thread', () =>
      threadService.create(parentId, valid, startMessageId)
    )
    if (r.ok) onCreated(r.value)
  }

  return (
    <form
      className="grid gap-2 px-2.5 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Input
        autoFocus
        aria-label="Thread name"
        placeholder="Thread name"
        maxLength={MAX_THREAD_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !valid}>
          Create thread
        </Button>
      </div>
    </form>
  )
}
