import { useId } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import type { SettingsDanger, SettingsModel } from '@/components/settings/settings-model'
import { SettingsPageBody } from '@/components/settings/settings-screen'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UnreadMark } from '@/components/ui/unread-mark'
import { OWN_STATUS_LABEL, PresenceDot } from '@/components/ui/presence'
import { isVisible, listedGroups } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/**
 * The profile header of the user settings list (C1): 92 high, avatar 56 with my presence, name
 * 19/600 and "@handle · STATUS" in mono caps. The whole row opens `onOpen` (my profile); the
 * status stays its own button.
 */
export function SettingsProfile({
  onOpen,
  onStatus
}: {
  onOpen: () => void
  onStatus?: () => void
}): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const handle = useTakusenStore((s) => s.session?.user.handle)
  const name = me?.username ?? handle ?? 'You'
  const line = `@${name} · ${OWN_STATUS_LABEL[status]}`
  const lineClass =
    'text-text-disabled max-w-full truncate text-left font-mono text-[8.5px] tracking-[0.9px] uppercase'
  return (
    <div className="border-line-hairline relative flex h-[92px] items-center gap-3.5 border-b px-4">
      <span className="relative flex shrink-0">
        <UserAvatar name={name} avatar={me?.avatar} size={56} />
        <span
          aria-hidden
          className="ring-surface-content absolute right-0 bottom-0 flex rounded-full ring-3"
        >
          <PresenceDot status={status} className="size-4" />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${name}, Your profile`}
          className="text-text-primary focus-visible:after:outline-line-focus active:after:bg-surface-hover max-w-full truncate text-left text-[19px] leading-6 font-semibold outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2"
        >
          {name}
        </button>
        {onStatus ? (
          <button
            type="button"
            onClick={onStatus}
            aria-label={`Status: ${OWN_STATUS_LABEL[status]}`}
            className={cn(
              lineClass,
              'focus-visible:outline-line-focus relative z-10 flex items-center gap-1 outline-none after:absolute after:-inset-x-[5px] after:-inset-y-[10px] focus-visible:outline-2'
            )}
          >
            <span className="truncate">{line}</span>
            <ChevronDown aria-hidden className="text-text-disabled size-3 shrink-0" />
          </button>
        ) : (
          <span className={lineClass}>{line}</span>
        )}
      </div>
      <ChevronRight aria-hidden className="text-text-disabled size-[18px] shrink-0" />
    </div>
  )
}

/** The red group set apart at the end of a settings screen ("Sign out", "Delete channel"). */
export function SettingsDangerGroup({
  danger,
  className
}: {
  danger: SettingsDanger
  className?: string
}): React.JSX.Element {
  return (
    <ListGroup
      tone="danger"
      className={cn('border-line-hairline mt-3.5 border-x-0 bg-transparent', className)}
    >
      <ListRow
        tone="danger"
        icon={danger.icon}
        label={danger.label}
        detail={danger.detail}
        disabled={danger.disabled}
        onClick={danger.onClick}
      />
    </ListGroup>
  )
}

/**
 * The settings list on the mobile layout (M29, M48): square groups of List Rows under their
 * Section Labels, then the red action. A row pushes its page (`onSelect`). `header` sits on top
 * of the first group (the profile of M29), which then pins the red action to the foot. `inline`
 * names a section whose body shows above the groups instead of as a row (the channel overview of
 * M48).
 */
export function SettingsList({
  model,
  onSelect,
  header,
  inline
}: {
  model: SettingsModel
  onSelect: (section: string) => void
  header?: React.ReactNode
  inline?: string
}): React.JSX.Element {
  const baseId = useId()
  const inlineItem = model.groups
    .flatMap((g) => g.items)
    .find((s) => s.id === inline && isVisible(s))
  const groups = listedGroups(model.groups, inline)
  // The header joins the first group when it has no label; else it gets its own box.
  const lead = header !== undefined && groups[0] && !groups[0].heading ? 0 : -1

  return (
    <>
      {inlineItem?.page && (
        <section aria-labelledby={`${baseId}-inline`} className="flex flex-col gap-2.5">
          <SectionLabel id={`${baseId}-inline`}>{inlineItem.label}</SectionLabel>
          <SettingsPageBody page={inlineItem.page} />
        </section>
      )}
      {header !== undefined && lead === -1 && (
        <ListGroup className="border-x-0 bg-transparent">{header}</ListGroup>
      )}
      {groups.map((g, i) => {
        const headingId = `${baseId}-${i}`
        return (
          <section
            key={g.heading ?? `group-${i}`}
            aria-labelledby={g.heading ? headingId : undefined}
            className="flex flex-col gap-1.5"
          >
            {g.heading && (
              <SectionLabel
                id={headingId}
                className="text-text-disabled px-4 pt-[21px] pb-2 font-mono text-[8px] tracking-[1.3px]"
              >
                {g.heading}
              </SectionLabel>
            )}
            <ListGroup className="border-x-0 bg-transparent">
              {i === lead && header}
              {g.items.filter((s) => !s.unlisted).map((s) => (
                <ListRow
                  key={s.id}
                  icon={s.icon}
                  tile="plain"
                  label={s.label}
                  detail={s.detail}
                  value={
                    s.value ??
                    (s.alert ? (
                      <UnreadMark badge={{ mentions: s.alert, unread: false }} count />
                    ) : s.count ? (
                      String(s.count)
                    ) : undefined)
                  }
                  disabled={!s.page}
                  onClick={() => onSelect(s.id)}
                />
              ))}
            </ListGroup>
          </section>
        )
      })}
      {model.danger && (
        <SettingsDangerGroup
          danger={model.danger}
          className={header !== undefined ? 'mt-auto' : undefined}
        />
      )}
    </>
  )
}
