import { useState } from 'react'
import { AudioLines, DoorOpen, History, ImagePlus, Tag, Trash2 } from 'lucide-react'
import type { Guild, HistoryVisibility } from '@hachiman/client'
import { MobileField } from '@/components/mobile/field'
import { RegionSelect } from '@/components/region-select'
import { DockedFoot } from '@/components/mobile/foot'
import type { GuildOverviewForm } from '@/components/settings/guild-overview'
import { SaveBar } from '@/components/settings/save-bar'
import { useImageUpload, type ImageUpload } from '@/components/settings/use-image-upload'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { guildInitials } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Guild settings → Overview on the phone (M52): the banner and icon with their Change buttons, then
 * one field per setting, then the Save foot docked under the screen panel (the red row of the tab
 * frame sits between). The icon and banner save at once, as on desktop; the fields save with Save.
 */
export function GuildOverviewMobile({
  guild,
  form
}: {
  guild: Guild
  form: GuildOverviewForm
}): React.JSX.Element {
  const platform = usePlatform()
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null)
  const { draft, textChannels, busy, error } = form
  const { name, region, publicHistoryVisibility, welcomeChannelId } = draft.value

  const save = async (): Promise<void> => {
    if (await form.save()) platform.haptic('success')
  }
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    // Return in the name field submits; Save sits outside the form, so check its guards here.
    if (form.canSave) void save()
  }

  return (
    <form ref={setFormEl} onSubmit={submit} className="flex flex-col gap-3">
      <GuildArtwork guild={guild} name={name} />
      <MobileField
        id="guild-name-edit"
        label="Guild name"
        hint="Shown in the guild list and on invites."
      >
        <Input
          size="touch"
          lead={<Tag />}
          value={name}
          maxLength={100}
          onChange={(e) => draft.set({ name: e.target.value })}
        />
      </MobileField>
      <MobileField
        id="guild-region"
        label="Voice region"
        hint="Where voice runs. Pick the region closest to most members."
      >
        <RegionSelect
          size="touch"
          lead={<AudioLines />}
          className="w-full"
          value={region}
          onChange={(next) => draft.set({ region: next })}
        />
      </MobileField>
      <MobileField
        id="guild-public-history"
        label="Earlier messages in public channels"
        hint={form.historyHint}
      >
        <NativeSelect
          size="touch"
          lead={<History />}
          className="w-full"
          value={publicHistoryVisibility}
          onChange={(e) =>
            draft.set({ publicHistoryVisibility: e.target.value as HistoryVisibility })
          }
        >
          <option value="shared">Show earlier messages</option>
          <option value="joined">Hide earlier messages</option>
        </NativeSelect>
      </MobileField>
      <MobileField
        id="guild-welcome-channel"
        label="Welcome channel"
        hint="Shows a line in this channel when someone joins the guild."
      >
        <NativeSelect
          size="touch"
          lead={<DoorOpen />}
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
      </MobileField>
      <ErrorText>{error}</ErrorText>
      <DockedFoot anchor={formEl}>
        <SaveBar
          layout="foot"
          dirty={draft.dirty}
          saved={draft.saved}
          busy={busy}
          disabled={!name.trim()}
          onReset={form.reset}
          onSave={() => void save()}
        />
      </DockedFoot>
    </form>
  )
}

/** The kit's secondary button at 36 (M52 "Change icon"): `--fill-control`, 13.5/700. */
const CHANGE_BUTTON =
  'pointer-events-auto h-9 px-3 text-[13.5px] font-bold border-line-strong bg-(--fill-control)'

function UploadingVeil(): React.JSX.Element {
  return (
    <span className="bg-surface-window/70 absolute inset-0 flex items-center justify-center text-xs font-semibold">
      Uploading…
    </span>
  )
}

/**
 * The banner (104 high) with the 72 icon over its lower edge, and a Change button for each (M52).
 * A tap on a set image opens Choose image and Remove (a sheet on the phone). A tap on an empty one
 * opens the picker, as its button does.
 */
function GuildArtwork({ guild, name }: { guild: Guild; name: string }): React.JSX.Element {
  const icon = useImageUpload(guild.icon, (id) => hachiman.rest.updateGuild(guild.id, { icon: id }))
  const banner = useImageUpload(guild.banner, (id) =>
    hachiman.rest.updateGuild(guild.id, { banner: id })
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <ArtworkButton
          upload={banner}
          value={guild.banner}
          noun="banner"
          className="border-line-hairline h-[104px] w-full border"
        >
          <Avatar className="bg-surface-raised size-full rounded-none">
            {banner.src && <AvatarImage src={banner.src} alt="" />}
            <AvatarFallback className="bg-surface-raised text-text-tertiary rounded-none text-[13px] font-semibold">
              No banner
            </AvatarFallback>
          </Avatar>
          {banner.uploading && <UploadingVeil />}
        </ArtworkButton>
        {/* Over the banner's lower 36: only the icon and the buttons take taps. */}
        <div className="pointer-events-none -mt-9 flex items-start gap-3 pl-3.5">
          <ArtworkButton
            upload={icon}
            value={guild.icon}
            noun="icon"
            className="ring-surface-content pointer-events-auto size-[72px] shrink-0 rounded-full ring-4"
          >
            <Avatar className="bg-surface-raised size-full">
              {icon.src && <AvatarImage src={icon.src} alt="" />}
              <AvatarFallback className="bg-surface-raised text-text-primary text-[26px] font-bold">
                {guildInitials(name.trim() || guild.name)}
              </AvatarFallback>
            </Avatar>
            {icon.uploading && <UploadingVeil />}
          </ArtworkButton>
          <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2 pt-[46px]">
            <Button
              type="button"
              variant="secondary"
              disabled={icon.busy}
              onClick={icon.pick}
              className={CHANGE_BUTTON}
            >
              {guild.icon ? 'Change icon' : 'Add icon'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={banner.busy}
              onClick={banner.pick}
              className={CHANGE_BUTTON}
            >
              {guild.banner ? 'Change banner' : 'Add banner'}
            </Button>
          </div>
        </div>
      </div>
      <ErrorText>{icon.error}</ErrorText>
      <ErrorText>{banner.error}</ErrorText>
      <p className="text-text-tertiary text-[12.5px] leading-[1.4] font-medium">
        The banner shows above the channel list, cropped to fit.
      </p>
      <input {...icon.input} />
      <input {...banner.input} />
    </div>
  )
}

/**
 * The tappable icon or banner. Set: a button that opens Choose image and Remove. Empty: it opens
 * the picker in the tap (iOS opens it only inside a gesture), hidden from VoiceOver and Tab, since
 * the Add button beside it does the same.
 */
function ArtworkButton({
  upload,
  value,
  noun,
  className,
  children
}: {
  upload: ImageUpload
  value: string | null
  noun: 'icon' | 'banner'
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const look = cn(
    'relative flex overflow-hidden outline-none select-none [-webkit-touch-callout:none]',
    'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:outline-offset-2 active:brightness-110 disabled:opacity-60',
    className
  )
  if (!value)
    return (
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        disabled={upload.busy}
        onClick={upload.pick}
        className={look}
      >
        {children}
      </button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={upload.busy}
          aria-label={`Change or remove the ${noun}`}
          className={look}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Guild ${noun}`} align="start">
        {/* Synchronous in the tap, so iOS opens the picker. */}
        <DropdownMenuItem onSelect={upload.pick}>
          <ImagePlus />
          Choose image
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => void upload.remove()}>
          <Trash2 />
          Remove {noun}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
