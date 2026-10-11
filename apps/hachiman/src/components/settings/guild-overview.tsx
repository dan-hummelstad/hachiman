import { useMemo } from 'react'
import type { Guild, HistoryVisibility } from '@hachiman/client'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { ErrorText, Field } from '@/components/ui/field'
import { RegionSelect } from '@/components/region-select'
import { ImageField } from '@/components/settings/image-field'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { trimName, useDraft } from '@/hooks/use-draft'
import { guildInitials } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'

/** Guild settings → Overview (G1): icon, banner, name, voice region, earlier messages, welcome channel. */
export function GuildOverviewPage({ guild }: { guild: Guild }): React.JSX.Element {
  const draft = useDraft(
    {
      name: guild.name,
      region: guild.region ?? '',
      publicHistoryVisibility: guild.publicHistoryVisibility,
      welcomeChannelId: guild.welcomeChannelId ?? ''
    },
    trimName
  )
  const { name, region, publicHistoryVisibility, welcomeChannelId } = draft.value
  const channels = useChannelStore((s) => s.channels)
  const textChannels = useMemo(
    () =>
      [...channels.values()]
        .filter((c) => c.guildId === guild.id && c.type === 'text')
        .sort((a, b) => a.position - b.position),
    [channels, guild.id]
  )
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
            : undefined,
        welcomeChannelId: welcomeChannelId || null
      })
    )
    if (saved.ok) draft.markSaved()
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-6">
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
          fallback={<span className="text-meta text-text-tertiary">No banner</span>}
          wide
          onSave={(banner) => hachiman.rest.updateGuild(guild.id, { banner })}
        />
      </div>
      <Field id="guild-name-edit" label="Guild name">
        <Input
          id="guild-name-edit"
          className="h-10"
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
        <div className="grid [&_[data-slot=native-select-wrapper]]:w-full">
          <RegionSelect
            id="guild-region"
            value={region}
            onChange={(next) => draft.set({ region: next })}
          />
        </div>
      </Field>
      <Field
        id="guild-public-history"
        label="Earlier messages in public channels"
        hint={
          publicHistoryVisibility === 'shared'
            ? 'New members can read public channels from before they joined. A member’s device sends them the keys.'
            : 'New members see only the messages that come after they join. Channels with their own permissions have their own setting.'
        }
      >
        <NativeSelect
          id="guild-public-history"
          className="w-full"
          value={publicHistoryVisibility}
          onChange={(e) =>
            draft.set({ publicHistoryVisibility: e.target.value as HistoryVisibility })
          }
        >
          <option value="shared">Show earlier messages</option>
          <option value="joined">Hide earlier messages</option>
        </NativeSelect>
      </Field>
      <Field
        id="guild-welcome-channel"
        label="Welcome channel"
        hint="Shows a line in this channel when someone joins the guild."
      >
        <NativeSelect
          id="guild-welcome-channel"
          className="w-full"
          value={welcomeChannelId}
          onChange={(e) => draft.set({ welcomeChannelId: e.target.value })}
        >
          <option value="">No welcome messages</option>
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <ErrorText>{error}</ErrorText>
      <SaveBar
        dirty={draft.dirty}
        saved={draft.saved}
        busy={busy}
        disabled={!name.trim()}
        onReset={() => {
          draft.reset()
          clearError()
        }}
      />
    </form>
  )
}
