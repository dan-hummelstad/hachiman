import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { SettingsLayout, type SettingsGroup } from '@/components/settings/settings-layout'
import { AccountSection } from '@/components/settings/user/account'
import { AppearanceSection } from '@/components/settings/user/appearance'
import { VoiceSection } from '@/components/settings/user/voice'
import { oracleService } from '@/services/OracleService'
import { useDialog } from '@/stores/dialogStore'

type Section = 'account' | 'appearance' | 'voice'

const GROUPS: SettingsGroup<Section>[] = [
  { heading: 'User settings', sections: [{ id: 'account', label: 'My account' }] },
  {
    heading: 'App settings',
    sections: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'voice', label: 'Voice and audio' }
    ]
  }
]

/** Full-window user settings: account, appearance (theme + message display), voice devices. */
export function UserSettings(): React.JSX.Element {
  const { open, close } = useDialog('userSettings')
  const [section, setSection] = useState<Section>('account')

  return (
    <SettingsLayout
      open={open}
      onClose={close}
      label="User settings"
      groups={GROUPS}
      selected={section}
      onSelect={setSection}
      destructive={{ label: 'Sign out', icon: <LogOut />, onClick: () => oracleService.signOut() }}
    >
      {section === 'account' && <AccountSection />}
      {section === 'appearance' && <AppearanceSection />}
      {section === 'voice' && <VoiceSection />}
    </SettingsLayout>
  )
}
