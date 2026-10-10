import { useEffect, useId, useRef, useState } from 'react'
import { Play, SmilePlus, Trash2, Upload, X } from 'lucide-react'
import { Permissions, has, type GuildSound } from '@hachiman/client'
import { EmojiPicker } from '@/components/chat/emoji-picker'
import { Button } from '@/components/ui/button'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { SOUND_ACCEPT, SOUND_NAME_MAX, clipProblem } from '@/lib/soundboard'
import { soundboardService } from '@/services/soundboard'
import { useGuildSounds } from '@/stores/soundsStore'

/**
 * Guild settings → Soundboard (§4 Soundboard). Everyone sees and previews the sounds. MANAGE_EXPRESSIONS
 * uploads (MP3, OGG or WAV, at most 512 KB and 5 s) and deletes.
 */
export function GuildSoundboardPage({ guildId }: { guildId: string }): React.JSX.Element {
  const sounds = useGuildSounds(guildId)
  const canManage = has(usePermissions(guildId), Permissions.MANAGE_EXPRESSIONS)
  useEffect(() => soundboardService.ensureLoaded(guildId), [guildId])
  return (
    <div className="grid gap-6">
      {canManage && <UploadForm guildId={guildId} />}
      <section className="grid gap-2">
        <SectionHeading className="mb-0">Sounds — {sounds.length}</SectionHeading>
        {sounds.length === 0 ? (
          <p className="text-text-tertiary text-sm">No sounds yet.</p>
        ) : (
          <ul className="grid gap-1">
            {sounds.map((s) => (
              <SoundRow key={s.id} sound={s} canManage={canManage} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function UploadForm({ guildId }: { guildId: string }): React.JSX.Element {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [picking, setPicking] = useState(false)
  const action = useAction()

  const pick = (f: File | null): void => {
    setFile(f)
    action.setError(f ? clipProblem(f, null) : null)
    if (f && !name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, SOUND_NAME_MAX))
  }
  const submit = async (): Promise<void> => {
    if (!file) return
    const r = await action.run('upload the sound', () =>
      soundboardService.upload(guildId, { file, name: name.trim(), emoji: emoji || null })
    )
    if (!r.ok) return
    setFile(null)
    setName('')
    setEmoji('')
    if (fileInput.current) fileInput.current.value = ''
  }
  const ready = file !== null && name.trim() !== '' && !clipProblem(file, null)

  return (
    <section className="grid gap-3">
      <SectionHeading className="mb-0">Upload a sound</SectionHeading>
      <p className="text-text-tertiary text-xs">
        MP3, OGG or WAV, at most 512 KB and 5 seconds. The sound is end-to-end encrypted: only the
        members of the guild can play it.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`${id}-file`} label="File">
          <input
            id={`${id}-file`}
            ref={fileInput}
            type="file"
            accept={SOUND_ACCEPT}
            className="text-sm"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field id={`${id}-name`} label="Name" className="w-48">
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={SOUND_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`${id}-emoji`} label="Emoji (optional)">
          <div className="flex items-center gap-1">
            <EmojiPicker
              open={picking}
              onOpenChange={setPicking}
              guildId={guildId}
              label="Pick the sound's emoji"
              side="bottom"
              align="start"
              unicodeOnly
              onPick={(p) => p.kind === 'unicode' && setEmoji(p.emoji)}
            >
              <button
                id={`${id}-emoji`}
                type="button"
                aria-label={emoji ? `Emoji: ${emoji}. Change it.` : 'Pick an emoji'}
                onClick={() => setPicking((v) => !v)}
                className="rounded-control border-line-hairline hover:bg-surface-hover focus-visible:outline-line-focus flex size-10 items-center justify-center border text-lg outline-none focus-visible:outline-2"
              >
                {emoji || <SmilePlus aria-hidden className="text-text-tertiary size-4" />}
              </button>
            </EmojiPicker>
            {emoji && (
              <IconButton label="Remove emoji" size="sm" onClick={() => setEmoji('')}>
                <X />
              </IconButton>
            )}
          </div>
        </Field>
        <Button disabled={!ready || action.busy} onClick={() => void submit()}>
          <Upload /> {action.busy ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </section>
  )
}

function SoundRow({
  sound,
  canManage
}: {
  sound: GuildSound
  canManage: boolean
}): React.JSX.Element {
  const preview = useAction()
  const remove = useAction()
  return (
    <li className="rounded-control hover:bg-surface-hover grid gap-1 px-2 py-1.5">
      <div className="flex items-center gap-3">
        <span aria-hidden className="w-6 text-center text-lg">
          {sound.emoji ?? '🔊'}
        </span>
        <span className="text-text-primary min-w-0 flex-1 truncate text-sm font-semibold">
          {sound.name}
        </span>
        <IconButton
          label={`Preview ${sound.name}`}
          disabled={preview.busy}
          onClick={() =>
            void preview.run(`play ${sound.name}`, () => soundboardService.preview(sound))
          }
        >
          <Play />
        </IconButton>
        {canManage && (
          <IconButton
            label={`Delete ${sound.name}`}
            tone="danger"
            disabled={remove.busy}
            onClick={() =>
              void remove.run(`delete ${sound.name}`, () =>
                soundboardService.remove(sound.guildId, sound.id)
              )
            }
          >
            <Trash2 />
          </IconButton>
        )}
      </div>
      <ErrorText>{preview.error ?? remove.error}</ErrorText>
    </li>
  )
}
