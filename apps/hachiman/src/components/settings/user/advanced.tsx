import { useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SectionHeading } from '@/components/ui/field'
import { clearCachedData, resetDevice } from '@/lib/local-data'
import { usePlatform } from '@/shared/PlatformContext'
import { useUserStore } from '@/stores/userStore'

/** User settings → Advanced: developer helpers that clear the local data of this device. */
export function AdvancedSection(): React.JSX.Element {
  const platform = usePlatform()
  const userId = useUserStore((s) => s.me?.id ?? null)
  const [confirm, setConfirm] = useState<'cache' | 'reset' | null>(null)
  const close = (): void => setConfirm(null)

  return (
    <section className="grid gap-6">
      <div className="grid gap-2">
        <SectionHeading className="mb-0">Clear cached data</SectionHeading>
        <p className="text-meta text-text-tertiary">
          Removes the saved preferences, open tabs and caches of this app, then reloads. You stay
          signed in, and your encryption keys stay on this device.
        </p>
        <div>
          <Button variant="secondary" onClick={() => setConfirm('cache')}>
            Clear cached data
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <SectionHeading className="mb-0">Reset this device</SectionHeading>
        <p className="text-meta text-text-tertiary">
          Removes all the data of this app on this device, including your encryption keys, then
          reloads. You must sign in again and set up this device again.
        </p>
        <div>
          <Button variant="danger-outline" onClick={() => setConfirm('reset')}>
            Reset this device
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'cache'}
        title="Clear cached data?"
        icon={<RotateCcw />}
        body="Your preferences, open tabs and cached data on this device are removed, and the app reloads. You stay signed in."
        confirmLabel="Clear and reload"
        what="clear the cached data"
        onConfirm={clearCachedData}
        onClose={close}
      />
      <ConfirmDialog
        open={confirm === 'reset'}
        tone="danger"
        title="Reset this device?"
        icon={<Trash2 />}
        body={
          <div className="grid gap-2">
            <p>
              All the data of this app on this device is removed: your encryption keys, the
              encrypted message store, your preferences and your sign-in. The app then reloads.
            </p>
            <p className="font-semibold">
              This signs this device out of end-to-end encryption. If no other device is signed in
              and you do not have your recovery key, you can lose your message history.
            </p>
          </div>
        }
        confirmLabel="Reset this device"
        what="reset this device"
        onConfirm={() => resetDevice(platform, userId)}
        onClose={close}
      />
    </section>
  )
}
