import { useEffect, useId, useState } from 'react'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useAction } from '@/hooks/use-action'
import { usePlatform } from '@/shared/PlatformContext'

/** User settings → Desktop app: the close-to-tray switch. Renders nothing on a host without a tray. */
export function CloseToTraySection(): React.JSX.Element | null {
  const closeToTray = usePlatform().closeToTray
  const { run, busy, error } = useAction()
  const [on, setOn] = useState<boolean | null>(null)
  const id = useId()

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
    <section className="grid gap-2">
      <SectionHeading className="mb-0">Window</SectionHeading>
      <div className="flex items-center gap-3">
        <Switch
          id={id}
          checked={on ?? false}
          disabled={on === null || busy}
          onCheckedChange={(v) => void change(v)}
        />
        <label htmlFor={id} className="text-label cursor-pointer">
          Close button minimises to tray
        </label>
      </div>
      <p className="text-text-secondary text-sm">
        Hachiman keeps running in the tray (the menu bar on macOS). Use Quit Hachiman in the tray
        menu to quit.
      </p>
      <ErrorText>{error}</ErrorText>
    </section>
  )
}
