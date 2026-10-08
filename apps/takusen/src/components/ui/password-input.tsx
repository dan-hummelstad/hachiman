'use client'

import { EyeIcon, EyeOffIcon, LockKeyholeIcon } from 'lucide-react'
import { useState } from 'react'

import { Input, type InputProps } from '@/components/ui/input'

/**
 * Password field with the lock lead and a show/hide eye (kit "Input focused"). `trailing`
 * replaces the eye with a status icon (the error or match mark of E4).
 */
export function PasswordInput({ trailing, ...props }: Omit<InputProps, 'type' | 'leading'>): React.JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <Input
      {...props}
      type={shown ? 'text' : 'password'}
      leading={<LockKeyholeIcon aria-hidden />}
      trailing={
        trailing ?? (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
            className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-check text-text-tertiary hover:text-text-primary"
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )
      }
    />
  )
}
