import { CircleCheckIcon, CircleIcon } from 'lucide-react'

import { passwordStrength } from '@/lib/password-strength'
import { cn } from '@/lib/utils'

const TONE = {
  Weak: { bar: 'bg-feature-danger', text: 'text-feature-danger-text' },
  Fair: { bar: 'bg-feature-event', text: 'text-feature-event-text' },
  Good: { bar: 'bg-feature-voice', text: 'text-feature-voice-text' },
  Strong: { bar: 'bg-feature-voice', text: 'text-feature-voice-text' },
}

/** Four bars, the label, and the three rules the server enforces (lib/password-strength). */
export function PasswordStrengthMeter({
  password,
  email,
  id,
}: {
  password: string
  email: string
  id?: string
}): React.JSX.Element {
  const { checks, score, label } = passwordStrength(password, email)
  const tone = TONE[label]
  const rules = [
    { ok: checks.length, text: '8+ characters' },
    { ok: checks.notEmail, text: 'Not your email' },
    { ok: checks.notCommon, text: 'Not common' },
  ]
  return (
    <div id={id} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div aria-hidden className="flex flex-1 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn('h-1 flex-1', i < score ? tone.bar : 'bg-line-strong')} />
          ))}
        </div>
        <span className={cn('text-[12.5px] leading-4 font-extrabold', tone.text)}>{label}</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {rules.map((r) => (
          <li key={r.text} className="flex items-center gap-1.5 text-[12.5px] font-semibold text-text-secondary">
            {r.ok ? (
              <CircleCheckIcon aria-hidden className="size-3.5 text-feature-voice-text" />
            ) : (
              <CircleIcon aria-hidden className="size-3.5 text-text-disabled" />
            )}
            <span>
              {r.text}
              <span className="sr-only">{r.ok ? ' (met)' : ' (not met)'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
