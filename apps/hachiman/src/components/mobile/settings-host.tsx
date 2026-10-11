import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { SectionTabs } from '@/components/mobile/section-tabs'
import {
  SettingsDangerGroup,
  SettingsList,
  SettingsProfile
} from '@/components/settings/settings-list'
import { useSettingsModel, type SettingsModel } from '@/components/settings/settings-model'
import { SettingsPageBody, SettingsScreen } from '@/components/settings/settings-screen'
import { useSettingsMode } from '@/components/settings/use-settings-mode'
import { useLatched } from '@/hooks/use-latched'
import { isVisible, listedPageId, resolveSection } from '@/lib/settings-sections'
import {
  closeSettings,
  setSettingsSection,
  type SettingsTarget,
  type SettingsView
} from '@/stores/navStore'

/** The time a closed screen keeps its content: the slide out (250) and a margin. */
const SLIDE_OUT_MS = 400

/** Back from a page to the settings list. */
const toList = (): void => setSettingsSection(null)

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
 * Settings on the mobile layout (docs/ios-mobile-ui-spec.md §2.6, rule 06 "Settings push in from
 * the right"). The user and a channel get a list screen (M29, M48) with each page pushed over it
 * while a section is set; a guild gets one screen with section tabs (M52). Back on the first
 * screen leaves settings; Back on a page goes to the list.
 */
export function SettingsHost(): React.JSX.Element | null {
  const settings = useSettingsMode()
  const shown = useSlidingView(settings)
  const model = useSettingsModel(shown?.target ?? null)
  if (!shown || !model) return null
  const open = settings !== null
  return model.layout === 'tabs' ? (
    <TabbedSettings model={model} section={shown.section} open={open} />
  ) : (
    <ListedSettings model={model} target={shown.target} section={shown.section} open={open} />
  )
}

/**
 * The list screen and the page pushed over it. The user list starts with the profile header; a
 * channel shows its first section inline (the overview), so that section has no page of its own.
 */
function ListedSettings({
  model,
  target,
  section,
  open
}: {
  model: SettingsModel
  target: SettingsTarget
  section: string | null
  open: boolean
}): React.JSX.Element {
  const title = model.navTitle ?? model.label
  const user = target.kind === 'user'
  const inline = user ? undefined : resolveSection(model.groups, null)?.id
  const items = model.groups.flatMap((g) => g.items)
  // A hidden, unknown or inline section shows the list, not the first page.
  const pageId = listedPageId(model.groups, section, inline)
  // The page keeps its content while it slides out after Back.
  const keptId = useLatched(pageId)
  const kept = items.find((s) => s.id === keptId)
  const pageOpen = open && pageId !== null

  return (
    <>
      <PushedScreen
        open={open}
        covered={pageOpen}
        title={title}
        subtitle={model.navSubtitle}
        onBack={closeSettings}
        backLabel="Close settings"
        bodyClassName={
          user ? 'gap-3.5 pt-3.5 pb-[calc(12px+var(--safe-bottom,0px))]' : 'gap-[22px]'
        }
      >
        <SettingsList
          model={model}
          onSelect={setSettingsSection}
          inline={inline}
          header={
            user ? (
              <SettingsProfile
                onOpen={() => setSettingsSection('account')}
                onStatus={model.onStatus}
              />
            ) : undefined
          }
        />
      </PushedScreen>
      {kept?.page && (
        <SettingsScreen
          id={kept.id}
          page={kept.page}
          open={pageOpen}
          subtitle={user ? title : model.navSubtitle}
          onBack={toList}
          backLabel={`Back to ${title}`}
        />
      )}
    </>
  )
}

/**
 * One screen with the sections as tabs on the window (M52). A null section shows the first
 * visible tab. The red action ends the first tab.
 */
function TabbedSettings({
  model,
  section,
  open
}: {
  model: SettingsModel
  section: string | null
  open: boolean
}): React.JSX.Element {
  const idBase = useId()
  const tabs = model.groups.flatMap((g) => g.items).filter(isVisible)
  const item = resolveSection(model.groups, section)
  const panel = useRef<HTMLDivElement>(null)

  // A new tab starts at the top of the scrolling body (the panel's parent).
  useLayoutEffect(() => {
    panel.current?.parentElement?.scrollTo({ top: 0 })
  }, [item?.id])

  return (
    <PushedScreen
      open={open}
      title={model.navTitle ?? model.label}
      subtitle={model.navSubtitle}
      onBack={closeSettings}
      backLabel="Close settings"
      toolbar={
        <SectionTabs
          label={model.label}
          tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))}
          value={item?.id}
          onValueChange={setSettingsSection}
          idBase={idBase}
        />
      }
    >
      {item?.page && (
        <div
          ref={panel}
          key={item.id}
          role="tabpanel"
          id={`${idBase}-panel`}
          aria-labelledby={`${idBase}-${item.id}`}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2.5">
            <SettingsPageBody page={item.page} />
          </div>
          {item.id === tabs[0]?.id && model.danger && <SettingsDangerGroup danger={model.danger} />}
        </div>
      )}
    </PushedScreen>
  )
}
