import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import { SettingsLayout, type SettingsGroup } from '@/components/settings/settings-layout'
import { AccountSection } from '@/components/settings/user/account'
import { AppearanceSection } from '@/components/settings/user/appearance'
import { UpdatesSection } from '@/components/settings/user/updates'
import { VoiceSection } from '@/components/settings/user/voice'
import { DevicesPanel } from '@/components/security/devices-panel'
import { RecoverySection } from '@/components/security/recovery-panel'
import { SecurityLog } from '@/components/security/security-log'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'

export type UserSettingsSection =
  'account' | 'devices' | 'recovery' | 'securityLog' | 'appearance' | 'voice' | 'updates'

const groups = (encryption: boolean, desktop: boolean): SettingsGroup<UserSettingsSection>[] => [
  { heading: 'User settings', sections: [{ id: 'account', label: 'My account' }] },
  {
    heading: 'Security',
    sections: [
      { id: 'devices', label: 'Devices', visible: encryption },
      { id: 'recovery', label: 'Recovery key', visible: encryption },
      { id: 'securityLog', label: 'Security log', visible: encryption }
    ]
  },
  {
    heading: 'App settings',
    sections: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'voice', label: 'Voice and audio' },
      // The web app updates on reload.
      { id: 'updates', label: 'Updates', visible: desktop }
    ]
  }
]

/** The section that the next open of the settings shows (read once per open). */
let nextSection: UserSettingsSection = 'account'

/** Opens the user settings at `section`. */
// eslint-disable-next-line react-refresh/only-export-components
export function openUserSettings(section: UserSettingsSection = 'account'): void {
  nextSection = section
  openDialog({ kind: 'userSettings' })
}

/**
 * Full-window user settings: account, the security pages (devices, recovery key, security log),
 * appearance (theme + message display), voice devices, and the update check (desktop).
 */
export function UserSettings(): React.JSX.Element {
  const { open, close } = useDialog('userSettings')
  const [section, setSection] = useState<UserSettingsSection>(() => nextSection)
  useEffect(() => {
    nextSection = 'account'
  }, [])
  // The security pages need the Worker. They hide while it is not ready.
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const desktop = usePlatform().platform === 'electron'

  return (
    <SettingsLayout
      open={open}
      onClose={close}
      label="User settings"
      groups={groups(encryption, desktop)}
      selected={section}
      onSelect={setSection}
      destructive={{ label: 'Sign out', icon: <LogOut />, onClick: () => takusenService.signOut() }}
    >
      {section === 'account' && <AccountSection />}
      {encryption && section === 'devices' && <DevicesPanel />}
      {encryption && section === 'recovery' && <RecoverySection />}
      {encryption && section === 'securityLog' && <SecurityLog />}
      {section === 'appearance' && <AppearanceSection />}
      {section === 'voice' && <VoiceSection />}
      {desktop && section === 'updates' && <UpdatesSection />}
    </SettingsLayout>
  )
}
