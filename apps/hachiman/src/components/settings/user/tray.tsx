import { useEffect, useState } from 'react'
import { SettingsCap, ToggleRow } from '@/components/settings/user/rows'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { usePlatform } from '@/shared/PlatformContext'

/** User settings → Desktop app: the close-to-tray switch. Renders nothing on a host without a tray. */
export function CloseToTraySection(): React.JSX.Element | null {
  const closeToTray = usePlatform().closeToTray
  const { run, busy, error } = useAction()
  const [on, setOn] = useState<boolean | null>(null)

  useEffect(() => {
    if (!closeToTray) return
    let live = true
    closeToTray
      .get()
      .then((v) => live && setOn(v))
      .catch((e: unknown) => console.warn('[settings] could not read close-to-tray', e))
    return () => {
      live = false
    }
  }, [closeToTray])

  if (!closeToTray) return null

  const change = async (next: boolean): Promise<void> => {
    const r = await run('save the setting', () => closeToTray.set(next))
    if (r.ok) setOn(next)
  }

  return (
    <section>
      <SettingsCap>Window</SettingsCap>
      <ToggleRow
        title="Close button minimises to tray"
        hint="Hachiman keeps running in the tray (the menu bar on macOS). Use Quit Hachiman in the tray menu to quit."
        checked={on ?? false}
        disabled={on === null || busy}
        onChange={(v) => void change(v)}
      />
      <ErrorText>{error}</ErrorText>
    </section>
  )
}
