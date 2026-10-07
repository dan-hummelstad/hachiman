import { useEffect, useState } from 'react'
import { SettingsOverlay } from '@/components/settings/settings-overlay'
import type { UserSettingsSection } from '@/components/settings/settings-model'
import { openDialog, useDialog } from '@/stores/dialogStore'

export type { UserSettingsSection } from '@/components/settings/settings-model'

/** The section that the next open of the settings shows (read once per open). */
let nextSection: UserSettingsSection = 'account'

/** Opens the user settings at `section`. */
// eslint-disable-next-line react-refresh/only-export-components
export function openUserSettings(section: UserSettingsSection = 'account'): void {
  nextSection = section
  openDialog({ kind: 'userSettings' })
}

const USER = { kind: 'user' } as const

/**
 * User settings (H1–H6): my account, the security pages (devices, recovery key, security log),
 * appearance, voice and audio, and the update check (desktop).
 */
export function UserSettings(): React.JSX.Element {
  const { open, close } = useDialog('userSettings')
  const [initial] = useState<UserSettingsSection>(() => nextSection)
  useEffect(() => {
    nextSection = 'account'
  }, [])
  return (
    <SettingsOverlay
      open={open}
      onClose={close}
      label="User settings"
      target={USER}
      initialSection={initial}
    />
  )
}
