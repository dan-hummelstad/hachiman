'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'

import { useCopy } from '@/components/ui/copy-button'

/** The invite code as a rounded chip: pressing it copies the code (never the `#k=` key). */
export function InviteCodeChip({ code }: { code: string }): React.JSX.Element {
  const { copied, copy } = useCopy(code)
  return (
    <button
      type="button"
      aria-label={copied ? `Copied ${code}` : `Copy invite code ${code}`}
      onClick={copy}
      className="flex h-[30px] max-w-full min-w-0 items-center gap-2 rounded-pill border border-line-strong bg-surface-hover pr-2 pl-3 font-mono text-[13px] font-semibold tracking-[1px] text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="truncate">{code}</span>
      {copied ? (
        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-feature-voice-text" />
      ) : (
        <CopyIcon aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
      )}
    </button>
  )
}
