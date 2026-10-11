import { Camera, ImagePlus, Trash2 } from 'lucide-react'
import { useImageUpload } from '@/components/settings/use-image-upload'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorText, Field } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/**
 * Pick, upload and apply one profile image (avatar, guild icon or banner), through
 * `useImageUpload`. ponytail: no cropper; the image is shown with object-fit cover wherever it is
 * used.
 */
export function ImageField({
  label,
  hint,
  value,
  fallback,
  wide,
  row,
  variant,
  children,
  onSave
}: {
  label: string
  hint?: string
  /** Current file key, or null. */
  value: string | null
  /** Shown when there is no image or it fails to load. */
  fallback: React.ReactNode
  /** A wide banner strip instead of a circle. */
  wide?: boolean
  /** One row: a small circle, the label and hint, then the buttons (My account). */
  row?: boolean
  /**
   * `badge`: the profile header of a card on the panel colour (M30). A 72 circle that rises half
   * its height over what is above it (the banner), with a 28 camera badge that picks an image, or
   * opens Choose and Remove when there is one. `children` sit beside the circle, the error under
   * both.
   */
  variant?: 'badge'
  children?: React.ReactNode
  /** Apply an upload id, or null to remove the image. */
  onSave: (uploadId: string | null) => Promise<unknown>
}): React.JSX.Element {
  const { src, busy, uploading, error, input, pick, remove } = useImageUpload(value, onSave)
  const picker = <input {...input} />
  const progress = uploading && (
    <span className="bg-surface-window/70 absolute inset-0 flex items-center justify-center text-xs">
      Uploading…
    </span>
  )

  if (variant === 'badge') {
    const noun = label.toLowerCase()
    const badge = (
      <button
        type="button"
        disabled={busy}
        aria-label={value ? `Change ${noun}` : `Add ${noun}`}
        onClick={value ? undefined : pick}
        className={cn(
          'bg-surface-raised ring-surface-panel text-text-primary absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full ring-[3px] outline-none',
          'focus-visible:outline-line-focus focus-visible:outline-2 active:brightness-125 disabled:opacity-60',
          // A 36 hit area around the 28 badge (spec §2.10).
          'after:absolute after:-inset-1'
        )}
      >
        <Camera aria-hidden className="size-3.5" />
      </button>
    )
    return (
      <div className="grid gap-2">
        <div className="flex items-start gap-4">
          <span className="relative -mt-9 shrink-0">
            <Avatar className="bg-surface-raised ring-surface-panel size-[72px] ring-[5px]">
              {src && <AvatarImage src={src} alt="" />}
              <AvatarFallback className="bg-surface-raised text-text-primary text-[32px] font-bold">
                {fallback}
              </AvatarFallback>
              {progress}
            </Avatar>
            {value ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>{badge}</DropdownMenuTrigger>
                <DropdownMenuContent aria-label={label} align="start">
                  {/* Synchronous in the tap, so iOS opens the picker. */}
                  <DropdownMenuItem onSelect={pick}>
                    <ImagePlus />
                    Choose a new {noun}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                    <Trash2 />
                    Remove {noun}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              badge
            )}
          </span>
          {children}
        </div>
        <ErrorText>{error}</ErrorText>
        {picker}
      </div>
    )
  }

  const thumb = (
    <Avatar
      className={cn(
        'bg-surface-raised border-line-hairline border',
        wide ? 'aspect-[11/2] size-auto w-full rounded-none' : row ? 'size-14' : 'size-24'
      )}
    >
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback
        className={cn('bg-surface-raised text-text-secondary', wide ? 'rounded-none' : 'text-2xl')}
      >
        {fallback}
      </AvatarFallback>
      {progress}
    </Avatar>
  )
  const buttons = (
    <div className="flex shrink-0 items-center gap-1">
      <Button type="button" variant="secondary" disabled={busy} onClick={pick}>
        {value ? 'Change' : 'Upload image'}
      </Button>
      {value && (
        <Button type="button" variant="quiet" disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
      )}
    </div>
  )

  if (row)
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-4">
          {thumb}
          <label htmlFor={input.id} className="grid min-w-0 flex-1">
            <span className="text-label">{label}</span>
            {hint && <span className="text-meta text-text-tertiary">{hint}</span>}
          </label>
          {buttons}
          {picker}
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    )

  return (
    <Field id={input.id} label={label}>
      <div className="grid gap-2">
        {thumb}
        <div className="flex items-center gap-2">
          {buttons}
          {hint && <span className="text-meta text-text-tertiary flex-1 text-right">{hint}</span>}
        </div>
        {picker}
      </div>
      <ErrorText>{error}</ErrorText>
    </Field>
  )
}
