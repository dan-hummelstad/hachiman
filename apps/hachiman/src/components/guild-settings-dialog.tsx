import { LogOut, Trash2 } from 'lucide-react'
import { Permissions, has, type Guild, type HistoryVisibility } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { GuildInvitesTab } from '@/components/guild-settings-invites'
import { GuildMembersTab } from '@/components/guild-settings-members'
import { GuildRolesTab } from '@/components/guild-settings-roles'
import { RegionSelect } from '@/components/region-select'
import { ErrorText, Field } from '@/components/ui/field'
import { ImageField } from '@/components/settings/image-field'
import { SettingsLayout, type SettingsGroup } from '@/components/settings/settings-layout'
import { useAction } from '@/hooks/use-action'
import { guildInitials } from '@/lib/model'
import { trimName, useDraft } from '@/hooks/use-draft'
import { useIsGuildOwner, usePermissions } from '@/hooks/use-hachiman'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useSettingsSection } from '@/hooks/use-settings-section'
import { hachiman } from '@/services/hachiman'
import { openDialog, type DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

type Section = 'overview' | 'roles' | 'members' | 'invites'

const useSettingsGuild = (d: DialogOf<'guildSettings'>): Guild | undefined =>
  useGuildStore((s) => s.guilds.get(d.guildId))

/** Full-window guild settings. Each section only shows if the user holds its permission. */
export function GuildSettingsDialog(): React.JSX.Element {
  // Closes itself when the guild is deleted or left underneath us.
  const {
    dialog,
    subject: guild,
    open,
    close
  } = useDialogSubject('guildSettings', useSettingsGuild)
  const { guildId } = dialog
  const isOwner = useIsGuildOwner(guildId)
  const perms = usePermissions(guildId)
  const canManage = has(perms, Permissions.MANAGE_GUILD)

  const groups: SettingsGroup<Section>[] = [
    {
      heading: guild?.name ?? 'Guild',
      sections: [
        { id: 'overview', label: 'Overview', visible: canManage },
        { id: 'roles', label: 'Roles', visible: has(perms, Permissions.MANAGE_ROLES) },
        // Everyone can at least see the list / change their own nick.
        { id: 'members', label: 'Members' },
        {
          id: 'invites',
          label: 'Invites',
          visible: canManage || has(perms, Permissions.CREATE_INSTANT_INVITE)
        }
      ]
    }
  ]
  const [section, setSection] = useSettingsSection(groups, guildId)

  return (
    <SettingsLayout
      open={open}
      onClose={close}
      label="Guild settings"
      groups={groups}
      selected={section}
      onSelect={setSection}
      destructive={{
        label: isOwner ? 'Delete guild' : 'Leave guild',
        icon: isOwner ? <Trash2 /> : <LogOut />,
        onClick: () => openDialog({ kind: 'removeGuild', guildId })
      }}
    >
      {guild && (
        <>
          {section === 'overview' && <OverviewSection guild={guild} />}
          {section === 'roles' && <GuildRolesTab guildId={guildId} />}
          {section === 'members' && <GuildMembersTab guild={guild} />}
          {section === 'invites' && <GuildInvitesTab guildId={guildId} />}
        </>
      )}
    </SettingsLayout>
  )
}

function OverviewSection({ guild }: { guild: Guild }): React.JSX.Element {
  const draft = useDraft(
    {
      name: guild.name,
      region: guild.region ?? '',
      publicHistoryVisibility: guild.publicHistoryVisibility
    },
    trimName
  )
  const { name, region, publicHistoryVisibility } = draft.value
  const { run, busy, error, clearError } = useAction()

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const saved = await run('save changes', () =>
      hachiman.rest.updateGuild(guild.id, {
        name: name.trim(),
        region: region || null,
        // Only a change goes in the request: it changes the public channels' group (§12.6).
        publicHistoryVisibility:
          publicHistoryVisibility !== guild.publicHistoryVisibility
            ? publicHistoryVisibility
            : undefined
      })
    )
    if (saved.ok) draft.markSaved()
  }
  const reset = (): void => {
    draft.reset()
    clearError()
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-6">
      <div className="grid grid-cols-[auto_1fr] items-start gap-8">
        <ImageField
          label="Icon"
          value={guild.icon}
          fallback={guildInitials(name || guild.name)}
          onSave={(icon) => hachiman.rest.updateGuild(guild.id, { icon })}
        />
        <ImageField
          label="Banner"
          hint="Shown above the channel list, cropped to fit."
          value={guild.banner}
          fallback={<span className="text-muted-foreground text-xs font-normal">No banner</span>}
          wide
          onSave={(banner) => hachiman.rest.updateGuild(guild.id, { banner })}
        />
      </div>
      <Field id="guild-name-edit" label="Guild name">
        <Input
          id="guild-name-edit"
          value={name}
          maxLength={100}
          onChange={(e) => draft.set({ name: e.target.value })}
        />
      </Field>
      <Field
        id="guild-region"
        label="Voice region"
        hint="Where voice for this guild is relayed. Pick the region closest to most members."
      >
        <RegionSelect
          id="guild-region"
          value={region}
          onChange={(next) => draft.set({ region: next })}
        />
      </Field>
      <Field
        id="guild-public-history"
        label="Earlier messages in public channels"
        hint={
          publicHistoryVisibility === 'shared'
            ? 'New members can read the messages of public channels from before they joined. A member device sends them the keys.'
            : 'New members see only the messages that come after they join. Channels with their own permissions have their own setting.'
        }
      >
        <NativeSelect
          id="guild-public-history"
          value={publicHistoryVisibility}
          onChange={(e) =>
            draft.set({ publicHistoryVisibility: e.target.value as HistoryVisibility })
          }
        >
          <option value="shared">Show earlier messages</option>
          <option value="joined">Hide earlier messages</option>
        </NativeSelect>
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-2">
        {draft.saved && <span className="text-muted-foreground text-xs">Changes saved.</span>}
        {draft.dirty && (
          <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
            Reset
          </Button>
        )}
        <Button type="submit" disabled={busy || !name.trim() || !draft.dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
