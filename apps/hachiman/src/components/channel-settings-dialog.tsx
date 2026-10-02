import { useState } from 'react'
import { Check, Plus, Slash, Trash2, User, X } from 'lucide-react'
import { Permissions, has, type Channel, type PermissionOverwrite } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PermissionRow } from '@/components/ui/permission-row'
import { SelectableRow } from '@/components/ui/selectable-row'
import { Textarea } from '@/components/ui/textarea'
import { channelPermissionLabels } from '@/components/settings/permission-labels'
import { SettingsLayout, type SettingsGroup } from '@/components/settings/settings-layout'
import { SideList, SidePaneHeader } from '@/components/settings/side-list'
import { useAction } from '@/hooks/use-action'
import { trimName, useDraft } from '@/hooks/use-draft'
import { usePermissions } from '@/hooks/use-hachiman'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useSettingsSection } from '@/hooks/use-settings-section'
import { displayName, rolesByPositionDesc } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog, type DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

type Section = 'overview' | 'permissions'

const useSettingsChannel = (d: DialogOf<'channelSettings'>): Channel | undefined =>
  useChannelStore((s) => s.channels.get(d.channelId))

/** Full-window channel settings: rename/topic (MANAGE_CHANNELS) + permission overwrites (MANAGE_ROLES). */
export function ChannelSettingsDialog(): React.JSX.Element {
  // Closes itself when the channel is deleted underneath us.
  const {
    dialog,
    subject: channel,
    open,
    close
  } = useDialogSubject('channelSettings', useSettingsChannel)
  const { channelId } = dialog
  const perms = usePermissions(channel?.guildId ?? null, channelId)
  const canManage = has(perms, Permissions.MANAGE_CHANNELS)
  const isCategory = channel?.type === 'category'

  const groups: SettingsGroup<Section>[] = [
    {
      heading: `${channel?.type === 'text' ? '# ' : ''}${channel?.name ?? ''}`,
      sections: [
        { id: 'overview', label: 'Overview' },
        { id: 'permissions', label: 'Permissions', visible: has(perms, Permissions.MANAGE_ROLES) }
      ]
    }
  ]
  const [section, setSection] = useSettingsSection(groups, channelId)

  return (
    <SettingsLayout
      open={open}
      onClose={close}
      label={isCategory ? 'Category settings' : 'Channel settings'}
      groups={groups}
      selected={section}
      onSelect={setSection}
      destructive={
        canManage
          ? {
              label: isCategory ? 'Delete category' : 'Delete channel',
              icon: <Trash2 />,
              onClick: () => openDialog({ kind: 'deleteChannel', channelId })
            }
          : undefined
      }
    >
      {channel?.guildId && (
        <>
          {section === 'overview' && <OverviewTab channel={channel} editable={canManage} />}
          {section === 'permissions' && (
            <OverwritesTab channel={channel} guildId={channel.guildId} />
          )}
        </>
      )}
    </SettingsLayout>
  )
}

function OverviewTab({
  channel,
  editable
}: {
  channel: Channel
  editable: boolean
}): React.JSX.Element {
  const draft = useDraft({ name: channel.name ?? '', topic: channel.topic ?? '' }, trimName)
  const { name, topic } = draft.value
  const { run, busy, error } = useAction()

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const saved = await run('save changes', () =>
      hachiman.rest.updateChannel(channel.id, {
        name: name.trim(),
        topic: channel.type === 'text' ? topic.trim() || null : undefined
      })
    )
    if (saved.ok) draft.markSaved()
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-5">
      <Field
        id="channel-name-edit"
        label={channel.type === 'category' ? 'Category name' : 'Channel name'}
      >
        <Input
          id="channel-name-edit"
          value={name}
          maxLength={100}
          disabled={!editable}
          onChange={(e) => draft.set({ name: e.target.value })}
        />
      </Field>
      {channel.type === 'text' && (
        <Field
          id="channel-topic"
          label="Topic"
          hint="Shown in the channel’s title bar. Tell people what the channel is for."
        >
          <Textarea
            id="channel-topic"
            value={topic}
            maxLength={1024}
            disabled={!editable}
            onChange={(e) => draft.set({ topic: e.target.value })}
          />
        </Field>
      )}
      {!editable && (
        <p className="text-muted-foreground text-xs leading-4">
          You need the Manage channels permission to change these.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      {editable && (
        <div className="flex items-center justify-end gap-2">
          {draft.saved && <span className="text-muted-foreground text-xs">Changes saved.</span>}
          <Button type="submit" disabled={busy || !name.trim() || !draft.dirty}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  )
}

type Tri = 'allow' | 'inherit' | 'deny'

function OverwritesTab({
  channel,
  guildId
}: {
  channel: Channel
  guildId: string
}): React.JSX.Element {
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const [selectedId, setSelectedId] = useState(guildId) // @everyone
  const { run, error } = useAction()

  // @everyone is always listed (as an implicit 0/0 overwrite) so its channel defaults are editable.
  const everyone: PermissionOverwrite = channel.permissionOverwrites.find(
    (o) => o.id === guildId
  ) ?? { id: guildId, type: 'role', allow: 0, deny: 0 }
  const list = [everyone, ...channel.permissionOverwrites.filter((o) => o.id !== guildId)]
  const selected = list.find((o) => o.id === selectedId) ?? everyone
  const listed = new Set(list.map((o) => o.id))
  const label = (o: PermissionOverwrite): string =>
    o.id === guildId
      ? '@everyone'
      : o.type === 'role'
        ? (roles?.get(o.id)?.name ?? 'Unknown role')
        : displayName(members?.get(o.id))

  const update = (fn: () => Promise<unknown>): void => void run('update permissions', fn)
  const put = (o: PermissionOverwrite): void =>
    update(() =>
      hachiman.rest.putOverwrite(channel.id, o.id, { type: o.type, allow: o.allow, deny: o.deny })
    )
  const add = (id: string, type: 'role' | 'member'): void => {
    put({ id, type, allow: 0, deny: 0 })
    setSelectedId(id)
  }
  // ponytail: computed from the store copy, so two clicks faster than the CHANNEL_UPDATE round-trip can drop one.
  const setBit = (b: number, v: Tri): void =>
    put({
      ...selected,
      allow: v === 'allow' ? selected.allow | b : selected.allow & ~b,
      deny: v === 'deny' ? selected.deny | b : selected.deny & ~b
    })

  const addableRoles = rolesByPositionDesc(
    [...(roles?.values() ?? [])].filter((r) => !listed.has(r.id))
  )
  const addableMembers = [...(members?.values() ?? [])].filter((m) => !listed.has(m.user.id))

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs leading-4">
        Overrides for this {channel.type === 'category' ? 'category' : 'channel'}. Allow and deny
        win over the guild-wide role; the middle setting keeps the role’s default.
      </p>
      <SideList
        aside={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
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
            <ul className="flex flex-col">
              {list.map((o) => (
                <li key={o.id}>
                  <SelectableRow
                    selected={o.id === selected.id}
                    onClick={() => setSelectedId(o.id)}
                  >
                    {o.type === 'member' && (
                      <User aria-label="Member" className="text-muted-foreground size-3 shrink-0" />
                    )}
                    <span className="truncate">{label(o)}</span>
                  </SelectableRow>
                </li>
              ))}
            </ul>
          </>
        }
      >
        <SidePaneHeader
          actions={
            selected.id !== guildId && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  update(() => hachiman.rest.deleteOverwrite(channel.id, selected.id))
                  setSelectedId(guildId)
                }}
              >
                <Trash2 /> Remove override
              </Button>
            )
          }
        >
          <span className="truncate">{label(selected)}</span>
        </SidePaneHeader>
        <SectionHeading className="mt-4">Permissions</SectionHeading>
        <div className="divide-border divide-y border-y">
          {channelPermissionLabels(channel.type).map((p) => (
            <PermissionRow key={p.name} label={p.label} hint={p.hint}>
              <TriToggle
                label={p.label}
                value={
                  selected.allow & p.bit ? 'allow' : selected.deny & p.bit ? 'deny' : 'inherit'
                }
                onChange={(v) => setBit(p.bit, v)}
              />
            </PermissionRow>
          ))}
        </div>
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      </SideList>
    </div>
  )
}

const TRI: { v: Tri; icon: React.ReactNode; on: string; label: string }[] = [
  { v: 'deny', icon: <X />, on: 'bg-destructive text-destructive-foreground', label: 'Deny' },
  { v: 'inherit', icon: <Slash />, on: 'bg-accent text-foreground', label: 'Use role default' },
  { v: 'allow', icon: <Check />, on: 'bg-online text-white', label: 'Allow' }
]

function TriToggle({
  label,
  value,
  onChange
}: {
  label: string
  value: Tri
  onChange: (v: Tri) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex border">
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
            'flex h-7 w-8 items-center justify-center [&_svg]:size-3.5',
            value === t.v ? t.on : 'text-muted-foreground hover:bg-accent'
          )}
        >
          {t.icon}
        </button>
      ))}
    </div>
  )
}
