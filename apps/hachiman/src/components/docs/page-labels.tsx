import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  MAX_PAGE_LABEL_LENGTH,
  MAX_PAGE_LABELS,
  observeLabels,
  pageLabels,
  setPageLabels
} from '@/services/docs/labels'
import type { DocHandle } from '@/services/docs/types'

const LABEL_FEATURES: readonly Feature[] = ['page', 'event', 'voice', 'thread', 'accent']

/** A stable colour per label text, so "Draft" looks the same on every page. */
function labelFeature(label: string): Feature {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.toLowerCase().charCodeAt(i)) | 0
  return LABEL_FEATURES[Math.abs(h) % LABEL_FEATURES.length] ?? 'page'
}

/**
 * The labels of the open page (C1 "RFC", "Draft"; feature plan N21.4). They are in the page's
 * Y.Doc, so they are encrypted and synced with the page content. Editors add (free text) and
 * remove them. `touch` (the page screen, M38): 20 high tags (11/800) in a 20 px gutter; the
 * remove mark and "Add label" keep their look in a hit area of 36.
 */
export function PageLabels({
  handle,
  editable,
  variant = 'panel'
}: {
  handle: DocHandle
  editable: boolean
  variant?: 'panel' | 'touch'
}): React.JSX.Element | null {
  const [labels, setLabels] = useState<string[]>(() => pageLabels(handle.doc))
  // The parent mounts this once per open page (keyed by page), so the first read stays valid.
  useEffect(() => observeLabels(handle.doc, setLabels), [handle])

  if (labels.length === 0 && !editable) return null
  const touch = variant === 'touch'
  const remove = (label: string): void =>
    setPageLabels(
      handle.doc,
      labels.filter((l) => l !== label)
    )
  return (
    <ul
      aria-label="Labels"
      className={cn(
        'flex shrink-0 flex-wrap items-center',
        touch ? 'gap-2 px-5 pt-3' : 'gap-1.5 px-16 pt-3'
      )}
    >
      {labels.map((label) => (
        <li
          key={label}
          className={cn(
            'inline-flex items-center gap-1',
            touch
              ? 'h-5 px-[7px] text-[11px] font-extrabold tracking-[0.4px]'
              : 'h-6 px-2 text-xs font-bold',
            FEATURE_TILE[labelFeature(label)]
          )}
        >
          {label}
          {editable && (
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              className={cn(
                '-mr-1 inline-flex size-4 items-center justify-center opacity-70 hover:opacity-100',
                touch && 'relative after:absolute after:-inset-2.5'
              )}
              onClick={() => remove(label)}
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </li>
      ))}
      {editable && labels.length < MAX_PAGE_LABELS && (
        <li>
          <AddLabel
            touch={touch}
            onAdd={(label) => setPageLabels(handle.doc, [...labels, label])}
          />
        </li>
      )}
    </ul>
  )
}

function AddLabel({
  touch,
  onAdd
}: {
  touch: boolean
  onAdd: (label: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const label = text.trim()
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (label === '') return
    onAdd(label)
    setText('')
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'text-text-tertiary hover:text-text-primary hover:bg-surface-hover inline-flex items-center gap-1 px-1.5 text-xs font-semibold',
            touch ? 'relative h-5 after:absolute after:inset-x-0 after:-inset-y-2' : 'h-6'
          )}
        >
          <Plus className="size-3.5" aria-hidden />
          Add label
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        {/* On touch the form is in a sheet: the kit field and the 48 primary last, at its foot. */}
        <form
          className={cn('flex', touch ? 'flex-col gap-3' : 'items-center gap-1.5')}
          onSubmit={submit}
        >
          {/* On touch the field is in a sheet that opens after the tap: a focus there would not
              raise the keyboard (spec §2.8), so the user taps the field. */}
          <Input
            size={touch ? 'touch' : 'default'}
            autoFocus={!touch}
            aria-label="Label"
            placeholder="RFC, Draft…"
            value={text}
            maxLength={MAX_PAGE_LABEL_LENGTH}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size={touch ? 'mobile' : 'sm'} disabled={label === ''}>
            {touch ? 'Add label' : 'Add'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
