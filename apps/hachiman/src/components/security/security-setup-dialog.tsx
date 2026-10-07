import { useCallback, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { OnboardingFlow } from '@/components/security/onboarding'
import { type OnboardingStep } from '@/components/security/onboarding-steps'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'

/**
 * Dialog kind 'securitySetup': the onboarding flow in a window, at the step that the opener asks
 * for. Each step brings its own header and footer. The window does not close while a new recovery
 * key shows.
 */
export function SecuritySetupDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('securitySetup')
  const state = useCryptoStore((s) => s.status?.state ?? 'needs_identity')
  const [step, setStep] = useState<OnboardingStep>(dialog.mode)
  const [hold, setHold] = useState(false)
  const onHold = useCallback((h: boolean) => setHold(h), [])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !hold && close()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[560px]">
        <OnboardingFlow
          state={state}
          step={step}
          onStep={setStep}
          onHold={onHold}
          onFinished={close}
        />
      </DialogContent>
    </Dialog>
  )
}
