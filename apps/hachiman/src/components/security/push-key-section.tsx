import { useId, useState } from 'react'
import { BellRing } from 'lucide-react'
import { SectionLabel } from '@/components/mobile/list'
import { Button } from '@/components/ui/button'
import { SectionHeading } from '@/components/ui/field'
import { useLayout } from '@/hooks/use-layout'
import { hasPushKey, regeneratePushKey } from '@/services/PushService'
import { usePrefsStore } from '@/stores/prefsStore'

type State = 'idle' | 'busy' | 'done' | 'blocked' | 'failed'

const STATUS: Record<Exclude<State, 'idle' | 'busy'>, string> = {
  done: 'This device has a new push key. The old key is deleted.',
  blocked: 'Notifications are blocked for Hachiman. Allow them in the system settings first.',
  failed: 'Could not make a new push key. Try again.'
}

const ABOUT =
  'Senders encrypt the name and text of a push to the push key of this device. A new key deletes the old one: a push encrypted to it shows only "New message". Make a new key if someone could have copied the data of this device. Messages sent in the next minute can still use the old key.'

/**
 * User settings → Devices, at the end: "Make a new push key" (contract §12.22). Only while this
 * device has a push key (push on, a kind that pushes on). No confirmation: the new key loses
 * nothing but the previews that are on their way.
 */
export function PushKeySection(): React.JSX.Element | null {
  // The switches decide whether there is a key: read them so that the section follows them.
  usePrefsStore((s) => s.pushEnabled)
  usePrefsStore((s) => s.disabledNotifications)
  const mobile = useLayout() === 'mobile'
  const [state, setState] = useState<State>('idle')
  const labelId = useId()
  if (!hasPushKey()) return null

  const regenerate = (): void => {
    setState('busy')
    regeneratePushKey()
      .then((ok) => setState(ok ? 'done' : 'blocked'))
      .catch((e: unknown) => {
        console.error('[push] new push key failed', e)
        setState('failed')
      })
  }
  const status = state === 'idle' || state === 'busy' ? null : STATUS[state]

  return (
    <section
      aria-labelledby={labelId}
      className={mobile ? 'flex flex-col gap-1.5 pt-4' : 'grid gap-2 pt-6'}
    >
      {mobile ? (
        <SectionLabel id={labelId}>Push key</SectionLabel>
      ) : (
        <SectionHeading className="mb-0">
          <span id={labelId}>Push key</span>
        </SectionHeading>
      )}
      <p className={mobile ? 'text-meta text-text-tertiary px-1' : 'text-meta text-text-tertiary'}>
        {ABOUT}
      </p>
      <div className={mobile ? 'pt-1' : 'flex flex-wrap items-center gap-3'}>
        <Button
          variant="secondary"
          size={mobile ? 'mobile' : 'default'}
          disabled={state === 'busy'}
          onClick={regenerate}
        >
          <BellRing /> {state === 'busy' ? 'Making the key…' : 'Make a new push key'}
        </Button>
        {status && (
          <p
            role={state === 'done' ? 'status' : 'alert'}
            className="text-meta text-text-secondary pt-1"
          >
            {status}
          </p>
        )}
      </div>
    </section>
  )
}
