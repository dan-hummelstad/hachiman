import { useEffect, useState } from 'react'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { useSettingsModel } from '@/components/settings/settings-model'
import { SettingsNav } from '@/components/settings/settings-nav'
import { SettingsPage } from '@/components/settings/settings-page'
import { useSettingsMode } from '@/components/settings/use-settings-mode'
import { resolveSection } from '@/lib/settings-sections'
import { closeSettings, setSettingsSection, type SettingsView } from '@/stores/navStore'

/** The time a closed screen keeps its content: the slide out (250) and a margin. */
const SLIDE_OUT_MS = 400

/**
 * `view`, kept until a closed screen has slid out, then null: the settings model of a closed view
 * stops (the user model fetches the device list while active).
 */
function useSlidingView(view: SettingsView | null): SettingsView | null {
  const [kept, setKept] = useState(view)
  if (view !== null && view !== kept) setKept(view)
  useEffect(() => {
    if (view !== null || kept === null) return
    const t = setTimeout(() => setKept(null), SLIDE_OUT_MS)
    return () => clearTimeout(t)
  }, [view, kept])
  return view ?? kept
}

/**
 * Settings on the mobile layout (docs/ios-mobile-ui-spec.md §2.6): a screen pushed from the right
 * while a settings view is open. For now the desktop parts: the section list while no section is
 * picked, else the section's page (its own header hidden: the Nav Bar has the title). Back leaves
 * settings.
 */
export function SettingsHost(): React.JSX.Element | null {
  const settings = useSettingsMode()
  const shown = useSlidingView(settings)
  const model = useSettingsModel(shown?.target ?? null)
  if (!shown || !model) return null

  const list = shown.section === null
  const page = list ? undefined : resolveSection(model.groups, shown.section)?.page

  return (
    <PushedScreen
      open={settings !== null}
      title={page?.title ?? model.crumb}
      subtitle={page ? model.crumb : undefined}
      onBack={closeSettings}
      backLabel="Close settings"
      bodyClassName={
        list ? undefined : 'gap-0 overflow-hidden p-0 [&>div>header:first-child]:hidden'
      }
    >
      {list ? (
        <SettingsNav
          model={model}
          section={null}
          onSelect={setSettingsSection}
          onBack={closeSettings}
        />
      ) : (
        <SettingsPage model={model} section={shown.section} onClose={closeSettings} />
      )}
    </PushedScreen>
  )
}
