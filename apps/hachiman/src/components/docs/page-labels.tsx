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
} from '@/services/docs/DocProvider'
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
 * remove them.
 */
export function PageLabels({
  handle,
  editable
}: {
  handle: DocHandle
  editable: boolean
}): React.JSX.Element | null {
  const [labels, setLabels] = useState<string[]>(() => pageLabels(handle.doc))
  useEffect(() => {
    setLabels(pageLabels(handle.doc))
    return observeLabels(handle.doc, setLabels)
  }, [handle])

  if (labels.length === 0 && !editable) return null
  const remove = (label: string): void =>
    setPageLabels(
      handle.doc,
      labels.filter((l) => l !== label)
    )
  return (
    <ul
      aria-label="Labels"
      className="flex shrink-0 flex-wrap items-center gap-1.5 px-16 pt-3"
    >
      {labels.map((label) => (
        <li
          key={label}
          className={cn(
            'inline-flex h-6 items-center gap-1 px-2 text-xs font-bold',
            FEATURE_TILE[labelFeature(label)]
          )}
        >
          {label}
          {editable && (
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              className="-mr-1 inline-flex size-4 items-center justify-center opacity-70 hover:opacity-100"
              onClick={() => remove(label)}
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </li>
      ))}
      {editable && labels.length < MAX_PAGE_LABELS && (
        <li>
          <AddLabel onAdd={(label) => setPageLabels(handle.doc, [...labels, label])} />
        </li>
      )}
    </ul>
  )
}

function AddLabel({ onAdd }: { onAdd: (label: string) => void }): React.JSX.Element {
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
          className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover inline-flex h-6 items-center gap-1 px-1.5 text-xs font-semibold"
        >
          <Plus className="size-3.5" aria-hidden />
          Add label
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <form className="flex items-center gap-1.5" onSubmit={submit}>
          <Input
            autoFocus
            aria-label="Label"
            placeholder="RFC, Draft…"
            value={text}
            maxLength={MAX_PAGE_LABEL_LENGTH}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={label === ''}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
