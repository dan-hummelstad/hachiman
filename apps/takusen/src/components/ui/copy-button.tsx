'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

/** Copies `value`; `copied` is true for a moment after. */
export function useCopy(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => toast.error('Could not copy to the clipboard.'),
    )
  }
  return { copied, copy }
}

/** Copies `value`; the icon turns into a check for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const { copied, copy } = useCopy(value)
  return (
    <Button variant="quiet" size="icon" aria-label={label} title={label} onClick={copy}>
      {copied ? <CheckIcon className="text-feature-voice-text" /> : <CopyIcon />}
    </Button>
  )
}
