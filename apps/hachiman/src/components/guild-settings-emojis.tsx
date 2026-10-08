import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import {
  EMOJI_IMAGE_TYPES,
  EMOJI_NAME_RE,
  MAX_EMOJI_BYTES,
  MAX_GUILD_EMOJIS,
  type GuildEmoji
} from '@hachiman/client'
import { CustomEmojiImage } from '@/components/chat/emoji'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { useAction } from '@/hooks/use-action'
import { formatBytes } from '@/lib/format-bytes'
import { emojiNameFromFile } from '@/lib/custom-emoji'
import { displayName } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { ensureLimits, uploadFile } from '@/services/UploadService'
import { useGuildStore } from '@/stores/guildStore'

const NO_EMOJIS: GuildEmoji[] = []
const ACCEPTED: readonly string[] = EMOJI_IMAGE_TYPES

/**
 * Guild settings → Emoji: upload (PNG, GIF or WebP, at most 256 KiB), rename and delete the
 * custom emojis of the guild. Needs MANAGE_EXPRESSIONS. GUILD_EMOJIS_UPDATE refreshes the list.
 */
export function GuildEmojisTab({ guildId }: { guildId: string }): React.JSX.Element {
  const emojis = useGuildStore((s) => s.emojis.get(guildId) ?? NO_EMOJIS)
  const members = useGuildStore((s) => s.members.get(guildId))
  const input = useRef<HTMLInputElement>(null)
  const { run, busy, error, setError } = useAction()

  useEffect(ensureLimits, [])

  const upload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!ACCEPTED.includes(file.type))
      return setError(`${file.name} is not a PNG, GIF or WebP image.`)
    if (file.size > MAX_EMOJI_BYTES)
      return setError(`${file.name} is larger than ${formatBytes(MAX_EMOJI_BYTES)}.`)
    let name = emojiNameFromFile(file.name)
    for (let i = 2; emojis.some((x) => x.name === name); i++)
      name = `${name.slice(0, 32 - String(i).length - 1)}_${i}`
    await run('upload the emoji', async () => {
      const up = await uploadFile(file)
      await hachiman.rest.createGuildEmoji(guildId, { name, uploadId: up.id })
    })
  }

  const full = emojis.length >= MAX_GUILD_EMOJIS
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={() => input.current?.click()} disabled={busy || full}>
          <ImagePlus />
          {busy ? 'Uploading…' : 'Upload emoji'}
        </Button>
        <span className="text-text-tertiary text-[13px]">
          {emojis.length} of {MAX_GUILD_EMOJIS}. PNG, GIF or WebP, at most{' '}
          {formatBytes(MAX_EMOJI_BYTES)}. Names use a–z, 0–9 and _.
        </span>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED.join(',')}
          hidden
          tabIndex={-1}
          onChange={(e) => void upload(e)}
        />
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      {emojis.length === 0 ? (
        <p className="text-text-tertiary text-[14px]">
          No custom emojis yet. Members can use them in messages and reactions.
        </p>
      ) : (
        <ul
          className="border-line-hairline divide-line-hairline divide-y border"
          aria-label="Emojis"
        >
          {emojis.map((e) => (
            // The key holds the name: a rename (here or elsewhere) starts the row over.
            <EmojiRow
              key={`${e.id}:${e.name}`}
              emoji={e}
              uploader={e.createdBy ? displayName(members?.get(e.createdBy)) : 'Unknown'}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function EmojiRow({ emoji, uploader }: { emoji: GuildEmoji; uploader: string }): React.JSX.Element {
  const [name, setName] = useState(emoji.name)
  const [armed, setArmed] = useState(false)
  const { run, busy, error, setError } = useAction()

  const save = async (): Promise<void> => {
    if (name === emoji.name) return
    if (!EMOJI_NAME_RE.test(name)) {
      setError('Use 2 to 32 characters: a–z, 0–9 and _.')
      return
    }
    const r = await run('rename the emoji', () =>
      hachiman.rest.renameGuildEmoji(emoji.guildId, emoji.id, name)
    )
    if (!r.ok) setName(emoji.name)
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <CustomEmojiImage emoji={emoji} className="size-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <Input
          aria-label={`Name of :${emoji.name}:`}
          value={name}
          maxLength={32}
          disabled={busy}
          onChange={(ev) => setName(ev.target.value.toLowerCase())}
          onBlur={() => void save()}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
            else if (ev.key === 'Escape') setName(emoji.name)
          }}
          className="h-8 max-w-64"
        />
        {error && <ErrorText>{error}</ErrorText>}
      </div>
      <span className="text-text-tertiary w-40 truncate text-[13px]" title={uploader}>
        {uploader}
      </span>
      <IconButton
        tone="danger"
        label={armed ? `Click again to delete :${emoji.name}:` : `Delete :${emoji.name}:`}
        className={cn(
          'size-8',
          armed &&
            'bg-feature-danger hover:bg-feature-danger text-text-on-accent hover:text-text-on-accent'
        )}
        disabled={busy}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (!armed) return setArmed(true)
          setArmed(false)
          void run('delete the emoji', () =>
            hachiman.rest.deleteGuildEmoji(emoji.guildId, emoji.id)
          )
        }}
      >
        <Trash2 />
      </IconButton>
    </li>
  )
}
