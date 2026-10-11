import { PushedScreen } from '@/components/mobile/pushed-screen'
import type { SettingsPageSpec } from '@/components/settings/settings-model'

/**
 * The body of one settings page on the mobile layout: the description as the intro paragraph
 * (14.5/500) when the page asks for it, then the page's own `render()`. The Nav Bar has the title.
 */
export function SettingsPageBody({ page }: { page: SettingsPageSpec }): React.JSX.Element {
  return (
    <>
      {page.intro && page.description && (
        <p className="text-text-secondary text-[14.5px] leading-5 font-medium">
          {page.description}
        </p>
      )}
      {page.render()}
    </>
  )
}

/**
 * One settings page pushed over the settings list (M30 to M34, M49). Back goes to the list. The
 * body remounts per section, so each page starts from fresh state.
 */
export function SettingsScreen({
  id,
  page,
  open,
  subtitle,
  onBack,
  backLabel
}: {
  /** The section id. */
  id: string
  page: SettingsPageSpec
  open: boolean
  subtitle?: string
  onBack: () => void
  backLabel: string
}): React.JSX.Element {
  return (
    <PushedScreen
      open={open}
      title={page.title}
      subtitle={page.navSubtitle ?? subtitle}
      onBack={onBack}
      backLabel={backLabel}
    >
      <SettingsPageBody key={id} page={page} />
    </PushedScreen>
  )
}
