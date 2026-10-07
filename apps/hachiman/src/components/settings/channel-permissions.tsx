import { useState } from 'react'
import { AtSign, Check, Plus, Slash, Trash2, User, X } from 'lucide-react'
import type { Channel, PermissionOverwrite } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorText } from '@/components/ui/field'
import { channelPermissionLabels } from '@/components/settings/permission-labels'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { displayName, hexColor, rolesByPositionDesc } from '@/lib/model'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'

type Tri = 'allow' | 'inherit' | 'deny'

const bitCount = (n: number): number => {
  let c = 0
  for (let v = n >>> 0; v; v &= v - 1) c++
  return c
}

/** The number of permissions that the overwrites allow or deny. */
// eslint-disable-next-line react-refresh/only-export-components
export function overrideCount(overwrites: readonly PermissionOverwrite[]): number {
  return overwrites.reduce((n, o) => n + bitCount(o.allow | o.deny), 0)
}

/**
 * Channel settings → Permissions (F8): the roles and members with an overwrite (@everyone always),
 * and a three-way switch per permission. Changes save together; each save is a signed admin
 * action (§12.16), because the overwrites decide who reads the channel.
 */
export function ChannelPermissionsPage({
  channel,
  guildId
}: {
  channel: Channel
  guildId: string
}): React.JSX.Element {
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name)
  const [selectedId, setSelectedId] = useState(guildId) // @everyone
  const [draft, setDraft] = useState<PermissionOverwrite | null>(null)
  const { run, busy, error, clearError } = useAction()

  // @everyone is always listed (as an implicit 0/0 overwrite) so its channel defaults are editable.
  const everyone: PermissionOverwrite = channel.permissionOverwrites.find(
    (o) => o.id === guildId
  ) ?? { id: guildId, type: 'role', allow: 0, deny: 0 }
  const list = [everyone, ...channel.permissionOverwrites.filter((o) => o.id !== guildId)]
  const selected = list.find((o) => o.id === selectedId) ?? everyone
  const current = draft?.id === selected.id ? draft : selected
  const dirty = current.allow !== selected.allow || current.deny !== selected.deny
  const listed = new Set(list.map((o) => o.id))
  const label = (o: PermissionOverwrite): string =>
    o.id === guildId
      ? '@everyone'
      : o.type === 'role'
        ? (roles?.get(o.id)?.name ?? 'Unknown role')
        : displayName(members?.get(o.id))
  const sublabel = (o: PermissionOverwrite): string =>
    o.id === guildId
      ? `everyone in ${guildName ?? 'the guild'}`
      : o.type === 'role'
        ? 'role'
        : 'member'

  const select = (id: string): void => {
    setSelectedId(id)
    setDraft(null)
    clearError()
  }
  const put = (o: PermissionOverwrite): Promise<unknown> =>
    adminActionService.putOverwrite(channel.id, o.id, {
      type: o.type,
      allow: o.allow,
      deny: o.deny
    })
  const add = (id: string, type: 'role' | 'member'): void => {
    void run('add the override', () => put({ id, type, allow: 0, deny: 0 }))
    select(id)
  }
  const save = async (): Promise<void> => {
    const r = await run('update permissions', () => put(current))
    if (r.ok) setDraft(null)
  }
  const setBit = (b: number, v: Tri): void =>
    setDraft({
      ...current,
      allow: v === 'allow' ? current.allow | b : current.allow & ~b,
      deny: v === 'deny' ? current.deny | b : current.deny & ~b
    })

  const addableRoles = rolesByPositionDesc(
    [...(roles?.values() ?? [])].filter((r) => !listed.has(r.id))
  )
  const addableMembers = [...(members?.values() ?? [])].filter((m) => !listed.has(m.user.id))

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-6">
      <div className="sticky top-0 grid gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="lg" className="w-full">
              <Plus /> Add role or member
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Roles</DropdownMenuLabel>
            {addableRoles.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => add(r.id, 'role')}>
                {r.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Members</DropdownMenuLabel>
            {addableMembers.map((m) => (
              <DropdownMenuItem key={m.user.id} onSelect={() => add(m.user.id, 'member')}>
                {displayName(m)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ul className="grid gap-0.5">
          {list.map((o) => {
            const on = o.id === selected.id
            const count = bitCount(o.allow | o.deny)
            const color = o.type === 'role' ? roles?.get(o.id)?.color : undefined
            return (
              <li key={o.id}>
                <button
                  type="button"
                  aria-current={on || undefined}
                  onClick={() => select(o.id)}
                  className={cn(
                    'rounded-control flex h-9 w-full items-center gap-2.5 px-2.5 text-left text-sm font-semibold',
                    on
                      ? 'bg-surface-selected text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  )}
                >
                  {o.id === guildId ? (
                    <AtSign aria-hidden className="text-text-tertiary size-3.5 shrink-0" />
                  ) : o.type === 'member' ? (
                    <User aria-label="Member" className="text-text-tertiary size-3.5 shrink-0" />
                  ) : (
                    <span
                      aria-hidden
                      className="rounded-check size-2.5 shrink-0"
                      style={{ background: color ? hexColor(color) : 'var(--text-tertiary)' }}
                    />
                  )}
                  <span className="flex-1 truncate">{label(o).replace(/^@/, '')}</span>
                  {count > 0 && (
                    <span className="rounded-check bg-accent-primary text-text-on-accent px-1.5 text-[11px] leading-4 font-bold tabular-nums">
                      {count}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="grid gap-1">
        <div className="border-line-hairline flex h-9 items-center gap-2 border-b pb-2">
          <span className="text-heading truncate">{label(selected)}</span>
          <span className="text-meta text-text-tertiary flex-1 truncate">
            · {sublabel(selected)}
          </span>
          {selected.id !== guildId && (
            <Button
              variant="quiet"
              size="sm"
              className="text-text-tertiary hover:text-feature-danger-text"
              disabled={busy}
              onClick={() => {
                void run('remove the override', () =>
                  adminActionService.deleteOverwrite(channel.id, selected.id)
                )
                select(guildId)
              }}
            >
              <Trash2 /> Remove override
            </Button>
          )}
        </div>
        <div className="divide-line-hairline border-line-hairline divide-y border-b">
          {channelPermissionLabels(channel.type).map((p) => {
            const value: Tri =
              current.allow & p.bit ? 'allow' : current.deny & p.bit ? 'deny' : 'inherit'
            return (
              <div key={p.name} className="flex items-center gap-4 py-3">
                <span className="grid min-w-0 flex-1">
                  <span className="text-label flex items-center gap-2">
                    {p.label}
                    {value === 'allow' && (
                      <span className="rounded-check bg-feature-voice/15 text-feature-voice-text px-1.5 text-[10.5px] leading-4 font-bold">
                        Allowed here
                      </span>
                    )}
                    {value === 'deny' && (
                      <span className="rounded-check bg-feature-danger/15 text-feature-danger-text px-1.5 text-[10.5px] leading-4 font-bold">
                        Denied here
                      </span>
                    )}
                  </span>
                  <span className="text-meta text-text-tertiary">{p.hint}</span>
                </span>
                <TriSwitch label={p.label} value={value} onChange={(v) => setBit(p.bit, v)} />
              </div>
            )
          })}
        </div>
        <div className="text-meta text-text-tertiary flex items-center gap-4 py-3 [&_svg]:size-3.5">
          <span className="flex items-center gap-1">
            <X className="text-feature-danger-text" /> Deny
          </span>
          <span className="flex items-center gap-1">
            <Slash /> Role default
          </span>
          <span className="flex items-center gap-1">
            <Check className="text-feature-voice-text" /> Allow
          </span>
        </div>
        <ErrorText>{error}</ErrorText>
        <SaveBar
          dirty={dirty}
          busy={busy}
          onReset={() => setDraft(null)}
          onSave={() => void save()}
        />
      </div>
    </div>
  )
}

const TRI: { v: Tri; icon: React.ReactNode; on: string; label: string }[] = [
  {
    v: 'deny',
    icon: <X />,
    on: 'bg-feature-danger/20 text-feature-danger-text',
    label: 'Deny'
  },
  {
    v: 'inherit',
    icon: <Slash />,
    on: 'bg-surface-hover text-text-primary',
    label: 'Role default'
  },
  {
    v: 'allow',
    icon: <Check />,
    on: 'bg-feature-voice/20 text-feature-voice-text',
    label: 'Allow'
  }
]

/** Deny (coral), role default, allow (green), as one radio group. */
function TriSwitch({
  label,
  value,
  onChange
}: {
  label: string
  value: Tri
  onChange: (v: Tri) => void
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="rounded-control bg-surface-sunken border-line-hairline flex shrink-0 gap-0.5 border p-0.5"
    >
      {TRI.map((t) => (
        <button
          key={t.v}
          type="button"
          role="radio"
          aria-checked={value === t.v}
          aria-label={t.label}
          title={t.label}
          onClick={() => value !== t.v && onChange(t.v)}
          className={cn(
            'rounded-check flex h-7 w-9 items-center justify-center [&_svg]:size-4',
            value === t.v ? t.on : 'text-text-tertiary hover:text-text-primary'
          )}
        >
          {t.icon}
        </button>
      ))}
    </div>
  )
}
