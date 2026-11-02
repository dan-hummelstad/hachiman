import type { Channel, Guild, HistoryVisibility, UpdateGuildBody } from '@hachiman/client'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { ErrorText, Field } from '@/components/ui/field'
import { RegionSelect } from '@/components/region-select'
import { GuildOverviewMobile } from '@/components/settings/guild-overview-mobile'
import { ImageField } from '@/components/settings/image-field'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { useGuildChannels } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { trimName, useDraft, type Draft } from '@/hooks/use-draft'
import { guildInitials } from '@/lib/model'
import { hachiman } from '@/services/hachiman'

/** The editable text fields of the overview. `''` is "none" for region and welcome channel. */
export interface GuildOverviewDraft {
  name: string
  region: string
  publicHistoryVisibility: HistoryVisibility
  welcomeChannelId: string
}

/** The `PATCH /guilds/:id` body for a saved draft. */
// eslint-disable-next-line react-refresh/only-export-components
export function guildOverviewPatch(
  guild: Pick<Guild, 'publicHistoryVisibility'>,
  draft: GuildOverviewDraft
): UpdateGuildBody {
  return {
    name: draft.name.trim(),
    region: draft.region || null,
    // Only a change goes in the request: it changes the public channels' group (§12.6).
    publicHistoryVisibility:
      draft.publicHistoryVisibility !== guild.publicHistoryVisibility
        ? draft.publicHistoryVisibility
        : undefined,
    welcomeChannelId: draft.welcomeChannelId || null
  }
}

/** The helper line of the "Earlier messages in public channels" field. */
const publicHistoryHint = (value: HistoryVisibility): string =>
  value === 'shared'
    ? 'New members can read public channels from before they joined. A member’s device sends them the keys.'
    : 'New members see only the messages that come after they join. Channels with their own permissions have their own setting.'

/** The two choices of "Earlier messages in public channels". */
const HISTORY_CHOICES: readonly { value: HistoryVisibility; label: string }[] = [
  { value: 'shared', label: 'Show earlier messages' },
  { value: 'joined', label: 'Hide earlier messages' }
]

/** The form state of the overview, shared by the desktop page and the phone screen (M52). */
export interface GuildOverviewForm {
  draft: Draft<GuildOverviewDraft>
  /** The text channels of the guild, for the welcome channel. */
  textChannels: Channel[]
  busy: boolean
  error: string | null
  /** Saves the draft. Resolves true when it saved. */
  save: () => Promise<boolean>
  reset: () => void
  /** Save is possible: something changed, the name is not empty and no save runs. */
  canSave: boolean
  /** The helper line of "Earlier messages in public channels" for the drafted value. */
  historyHint: string
}

/** Draft, save and reset of the overview fields. Icon and banner save on their own. */
// eslint-disable-next-line react-refresh/only-export-components
export function useGuildOverviewForm(guild: Guild): GuildOverviewForm {
  const draft = useDraft<GuildOverviewDraft>(
    {
      name: guild.name,
      region: guild.region ?? '',
      publicHistoryVisibility: guild.publicHistoryVisibility,
      welcomeChannelId: guild.welcomeChannelId ?? ''
    },
    trimName
  )
  const textChannels = useGuildChannels(guild.id).filter((c) => c.type === 'text')
  const { run, busy, error, clearError } = useAction()

  const save = async (): Promise<boolean> => {
    const saved = await run('save changes', () =>
      hachiman.rest.updateGuild(guild.id, guildOverviewPatch(guild, draft.value))
    )
    if (saved.ok) draft.markSaved()
    return saved.ok
  }

  return {
    draft,
    textChannels,
    busy,
    error,
    save,
    reset: () => {
      draft.reset()
      clearError()
    },
    canSave: draft.dirty && !busy && draft.value.name.trim() !== '',
    historyHint: publicHistoryHint(draft.value.publicHistoryVisibility)
  }
}

/**
 * Guild settings → Overview (G1): icon, banner, name, voice region, earlier messages, welcome
 * channel. The phone screen (M52) is `GuildOverviewMobile`.
 */
export function GuildOverviewPage({ guild }: { guild: Guild }): React.JSX.Element {
  const form = useGuildOverviewForm(guild)
  const mobile = useLayout() === 'mobile'
  if (mobile) return <GuildOverviewMobile guild={guild} form={form} />

  const { draft, textChannels, busy, error } = form
  const { name, region, publicHistoryVisibility, welcomeChannelId } = draft.value

  const save = (e: React.FormEvent): void => {
    e.preventDefault()
    void form.save()
  }

  return (
    <form onSubmit={save} className="grid gap-6">
      <div className="flex items-start gap-6">
        <ImageField
          label="Icon"
          value={guild.icon}
          fallback={guildInitials(name || guild.name)}
          onSave={(icon) => hachiman.rest.updateGuild(guild.id, { icon })}
        />
        <div className="grid w-[416px] gap-4">
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
        </div>
        <div className="rounded-control bg-surface-sunken grid w-[300px] gap-3 p-3.5">
          <span className="cap text-text-tertiary text-[9px] tracking-[1.5px]">Banner</span>
          <ImageField
            label="Banner"
            hint="Shown above the channel list, cropped to fit."
            value={guild.banner}
            fallback={<span className="text-meta text-text-tertiary">No banner</span>}
            wide
            onSave={(banner) => hachiman.rest.updateGuild(guild.id, { banner })}
          />
        </div>
      </div>
      <div className="bg-line-hairline h-px" />
      <div className="grid grid-cols-2 gap-[30px]">
        <div className="grid content-start gap-1">
          <span id="guild-public-history-label" className="cap text-text-tertiary">
            Earlier messages in public channels
          </span>
          <div role="radiogroup" aria-labelledby="guild-public-history-label" className="grid">
            {HISTORY_CHOICES.map((c) => {
              const checked = publicHistoryVisibility === c.value
              return (
                <label
                  key={c.value}
                  className="flex min-h-[46px] cursor-pointer items-center gap-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-line-focus"
                >
                  <input
                    type="radio"
                    name="guild-public-history"
                    className="sr-only"
                    checked={checked}
                    onChange={() => draft.set({ publicHistoryVisibility: c.value })}
                  />
                  <span
                    aria-hidden
                    className="border-line-strong grid size-[17px] shrink-0 place-items-center rounded-full border"
                  >
                    {checked && <span className="bg-text-primary size-[9px] rounded-full" />}
                  </span>
                  <span className="grid gap-0.5">
                    <span
                      className={
                        checked
                          ? 'text-text-primary text-[13px] font-semibold'
                          : 'text-text-secondary text-[13px]'
                      }
                    >
                      {c.label}
                    </span>
                    <span className="text-text-disabled text-[11.5px]">
                      {publicHistoryHint(c.value)}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>
        <div className="grid content-start gap-1">
          <span className="cap text-text-tertiary">When somebody arrives</span>
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
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      <SaveBar
        dirty={draft.dirty}
        saved={draft.saved}
        busy={busy}
        disabled={!name.trim()}
        onReset={form.reset}
      />
    </form>
  )
}
