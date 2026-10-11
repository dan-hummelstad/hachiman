import { useState } from 'react'
import { AtSign, Check, Plus, Slash, Trash2, User, X } from 'lucide-react'
import type { Channel, ChannelType, PermissionOverwrite } from '@hachiman/client'
import { ChipScroller } from '@/components/mobile/chip-scroller'
import { KIT_ICON_BUTTON, NavAction, NavActionButton } from '@/components/mobile/nav-bar'
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
import { DockedFoot } from '@/components/settings/channel-overview'
import { channelPermissionLabels } from '@/components/settings/permission-labels'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { displayName, hexColor, rolesByPositionDesc } from '@/lib/model'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'
import { selectableRowClass } from '@/components/ui/selectable-row'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'

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
 *
 * On the mobile layout (M49) it is one column: the targets as a row of chips, "Add role or
 * member" as the Nav Bar "+" (a sheet), and the Save foot docked under the screen.
 */
export function ChannelPermissionsPage({
  channel,
  guildId
}: {
  channel: Channel
  guildId: string
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name)
  const [selectedId, setSelectedId] = useState(guildId) // @everyone
  const [draft, setDraft] = useState<PermissionOverwrite | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
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
  const roleColor = (o: PermissionOverwrite): string => {
    const color = o.type === 'role' ? roles?.get(o.id)?.color : undefined
    return color ? hexColor(color) : 'var(--text-tertiary)'
  }

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
  const remove = (): void => {
    void run('remove the override', () =>
      adminActionService.deleteOverwrite(channel.id, selected.id)
    )
    select(guildId)
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

  /** The "Add role or member" menu (a sheet on the mobile layout) on `trigger`. */
  const addMenu = (trigger: React.ReactNode): React.JSX.Element => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
  )

  if (mobile) {
    const shown =
      channel.type === 'category' || channel.type === 'voice'
        ? (channel.name ?? '')
        : `#${channel.name ?? ''}`
    return (
      <div ref={setRoot} className="flex flex-col gap-4">
        <NavAction>
          {addMenu(
            <NavActionButton label="Add role or member">
              <Plus />
            </NavActionButton>
          )}
        </NavAction>
        <p className="text-text-secondary text-[14px] leading-[1.5] font-medium">
          Overrides for {shown}. Allow and deny beat the role’s guild-wide setting; the middle keeps
          its default.
        </p>
        <ChipScroller
          label="Roles and members with overrides"
          options={list.map((o) => ({
            value: o.id,
            label: label(o).replace(/^@/, ''),
            lead:
              o.id === guildId ? (
                <AtSign />
              ) : o.type === 'member' ? (
                <User />
              ) : (
                <span className="size-[9px]" style={{ background: roleColor(o) }} />
              ),
            count: bitCount(o.allow | o.deny)
          }))}
          value={selected.id}
          onValueChange={select}
          className="-mx-4 px-4"
        />
        <div className="flex flex-col">
          <div className="border-line-hairline flex items-center gap-2 border-b pt-1 pb-3">
            <span className="text-text-primary min-w-0 truncate text-[17px] leading-[22px] font-extrabold">
              {label(selected)}
            </span>
            <span className="text-text-tertiary min-w-0 flex-1 truncate text-[13.5px] leading-[18px] font-medium">
              · {sublabel(selected)}
            </span>
            {selected.id !== guildId && (
              <button
                type="button"
                aria-label={`Remove the override for ${label(selected)}`}
                disabled={busy}
                onClick={remove}
                className={cn(
                  KIT_ICON_BUTTON,
                  'text-text-tertiary active:bg-surface-hover active:text-feature-danger-text -my-[7px]'
                )}
              >
                <Trash2 />
              </button>
            )}
          </div>
          <PermissionRules type={channel.type} overwrite={current} onChange={setBit} touch />
        </div>
        <TriLegend />
        <ErrorText>{error}</ErrorText>
        <DockedFoot anchor={root}>
          <SaveBar
            layout="foot"
            dirty={dirty}
            busy={busy}
            onReset={() => setDraft(null)}
            onSave={() => void save()}
          />
        </DockedFoot>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-6">
      <div className="sticky top-0 grid gap-3">
        {addMenu(
          <Button variant="secondary" size="lg" className="w-full">
            <Plus /> Add role or member
          </Button>
        )}
        <ul className="grid gap-0.5">
          {list.map((o) => {
            const on = o.id === selected.id
            const count = bitCount(o.allow | o.deny)
            return (
              <li key={o.id}>
                <button
                  type="button"
                  aria-current={on || undefined}
                  onClick={() => select(o.id)}
                  className={selectableRowClass(
                    on,
                    'flex h-9 w-full items-center gap-2.5 px-2.5 text-left text-sm font-semibold'
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
                      style={{ background: roleColor(o) }}
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
              onClick={remove}
            >
              <Trash2 /> Remove override
            </Button>
          )}
        </div>
        <PermissionRules type={channel.type} overwrite={current} onChange={setBit} />
        <TriLegend />
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

/**
 * One row per permission of the channel type: the label with an "Allowed here" or "Denied here"
 * chip, the hint, and the three-way switch. `touch`: the M49 rows (title 15/700, a 44 switch).
 */
function PermissionRules({
  type,
  overwrite,
  onChange,
  touch = false
}: {
  type: ChannelType
  overwrite: PermissionOverwrite
  onChange: (bit: number, value: Tri) => void
  touch?: boolean
}): React.JSX.Element {
  return (
    <div className="divide-line-hairline border-line-hairline divide-y border-b">
      {channelPermissionLabels(type).map((p) => {
        const value: Tri =
          overwrite.allow & p.bit ? 'allow' : overwrite.deny & p.bit ? 'deny' : 'inherit'
        return (
          <div key={p.name} className={cn('flex items-center py-3', touch ? 'gap-3' : 'gap-4')}>
            <span className={cn('grid min-w-0 flex-1', touch && 'gap-[3px]')}>
              <span
                className={cn(
                  'flex items-center gap-2',
                  // A chip that does not fit beside the label goes under it.
                  touch
                    ? 'text-text-primary flex-wrap gap-y-1 text-[15px] leading-5 font-bold'
                    : 'text-label'
                )}
              >
                {p.label}
                {value === 'allow' && (
                  <span
                    className={cn(OVERRIDE_CHIP, 'bg-feature-voice/15 text-feature-voice-text')}
                  >
                    Allowed here
                  </span>
                )}
                {value === 'deny' && (
                  <span
                    className={cn(OVERRIDE_CHIP, 'bg-feature-danger/15 text-feature-danger-text')}
                  >
                    Denied here
                  </span>
                )}
              </span>
              {/* Not `cn`: tailwind-merge takes `text-meta` for a colour and drops the other. */}
              <span
                className={
                  touch
                    ? 'text-text-tertiary text-[13px] leading-4 font-medium'
                    : 'text-meta text-text-tertiary'
                }
              >
                {p.hint}
              </span>
            </span>
            <SegmentedControl
              iconOnly
              label={p.label}
              options={TRI}
              value={value}
              onChange={(v) => onChange(p.bit, v)}
              size={touch ? 'touch' : 'default'}
              className={
                touch
                  ? 'border-line-strong w-auto shrink-0 gap-0.5 [&_[aria-checked=false]]:text-text-disabled'
                  : 'border-line-hairline shrink-0 border'
              }
            />
          </div>
        )
      })}
    </div>
  )
}

/** The "Allowed here" and "Denied here" tag: square, 18 high and 10.5/800 on the mobile layout. */
const OVERRIDE_CHIP =
  'rounded-check px-1.5 text-[10.5px] leading-4 font-bold mobile:rounded-none mobile:leading-[18px] mobile:font-extrabold'

/** The key under the switches: deny, role default, allow. */
function TriLegend(): React.JSX.Element {
  return (
    <div className="text-meta text-text-tertiary mobile:py-0 mobile:text-[12.5px] mobile:font-semibold mobile:[&_svg]:size-[13px] flex items-center gap-4 py-3 [&_svg]:size-3.5">
      <span className="flex items-center gap-1">
        <X className="text-feature-danger-text" /> Deny
      </span>
      <span className="flex items-center gap-1">
        <Slash className="mobile:text-text-primary" /> Role default
      </span>
      <span className="flex items-center gap-1">
        <Check className="text-feature-voice-text" /> Allow
      </span>
    </div>
  )
}

/** Deny (coral), role default, allow (green). */
const TRI: SegmentedOption<Tri>[] = [
  {
    value: 'deny',
    icon: <X />,
    selectedClassName: 'bg-feature-danger/20 text-feature-danger-text',
    label: 'Deny'
  },
  {
    value: 'inherit',
    icon: <Slash />,
    selectedClassName: 'bg-surface-hover text-text-primary',
    label: 'Role default'
  },
  {
    value: 'allow',
    icon: <Check />,
    selectedClassName: 'bg-feature-voice/20 text-feature-voice-text',
    label: 'Allow'
  }
]
