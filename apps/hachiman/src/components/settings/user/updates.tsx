import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { usePlatform } from '@/shared/PlatformContext'
import type { UpdateCheckResult } from '@/shared/IPlatformService'

function resultText(r: UpdateCheckResult): string {
  switch (r.status) {
    case 'up-to-date':
      return `Hachiman is up to date (build ${r.build}).`
    case 'offered':
      return `Build ${r.latest} is ready (you have ${r.build}). Restart Hachiman to install it.`
    case 'not-available':
      return r.reason
    case 'failed':
      return ''
  }
}

/** User settings → Updates: a manual update check. The host shows its own restart prompt. */
export function UpdatesSection(): React.JSX.Element {
  const platform = usePlatform()
  const { run, busy, error, setError } = useAction()
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  const check = async (): Promise<void> => {
    setResult(null)
    const r = await run('check for updates', () => platform.checkForUpdate())
    if (!r.ok) return
    if (r.value.status === 'failed') setError(`Could not check for updates: ${r.value.reason}`)
    else setResult(r.value)
  }

  return (
    <section className="grid gap-3">
      <SectionHeading>Updates</SectionHeading>
      <p className="text-muted-foreground text-sm">
        Hachiman checks for a new version when it starts and every 4 hours. A new version downloads
        in the background, then Hachiman asks to restart.
      </p>
      <div>
        <Button onClick={() => void check()} disabled={busy}>
          {busy ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>
      {result && (
        <p className="text-sm" role="status">
          {resultText(result)}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  )
}
