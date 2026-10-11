import { useId } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PresenceStatus } from '@hachiman/client'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import type { SettingsDanger, SettingsModel } from '@/components/settings/settings-model'
import { SettingsPageBody } from '@/components/settings/settings-screen'
import { UserAvatar } from '@/components/shell/user-avatar'
import { OWN_STATUS_LABEL, PresenceDot } from '@/components/ui/presence'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { isVisible, listedGroups } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'
import { useTakusenStore } from '@/stores/takusenStore'
import { useUserStore } from '@/stores/userStore'

/** The status word in its colour, readable in both themes. */
const STATUS_TEXT: Record<PresenceStatus, string> = {
  online: 'text-feature-voice-text',
  idle: 'text-feature-event-text',
  dnd: 'text-feature-danger-text',
  offline: 'text-text-secondary'
}

/**
 * The status chip of the profile header (M29): 28 high, r8, the dot, the status word in its
 * colour and the custom status. With `onStatus` it is a button with a chevron.
 */
function StatusChip({ onStatus }: { onStatus?: () => void }): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const custom = useCustomStatus(me?.id ?? '')
  const word = OWN_STATUS_LABEL[status]
  const className =
    'rounded-control bg-surface-hover border-line-strong flex h-7 max-w-full min-w-0 items-center gap-1.5 border pr-2 pl-[9px] text-[12.5px] leading-4'
  const content = (
    <>
      <span aria-hidden className="flex">
        <PresenceDot status={status} />
      </span>
      <span className={cn('shrink-0 font-bold', STATUS_TEXT[status])}>{word}</span>
      {custom && (
        <span className="text-text-secondary truncate font-semibold">· {custom.text}</span>
      )}
      {onStatus && <ChevronDown aria-hidden className="text-text-tertiary size-3.5 shrink-0" />}
    </>
  )
  if (!onStatus) return <span className={className}>{content}</span>
  return (
    <button
      type="button"
      onClick={onStatus}
      aria-label={`Status: ${word}${custom ? `, ${custom.text}` : ''}`}
      className={cn(
        className,
        'active:bg-surface-selected focus-visible:outline-line-focus relative z-10 outline-none focus-visible:outline-2',
        // A 36 hit height around the 28 chip, so a near miss does not open My account.
        'after:absolute after:-inset-x-1 after:-inset-y-1'
      )}
    >
      {content}
    </button>
  )
}

/**
 * The profile header of the user settings list (M29): 76 high on an accent wash, avatar 52 with my
 * status, name 19/800 and the status chip. The whole row opens `onOpen` (my account); the chip
 * stays its own button.
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
  return (
    <div className="from-accent-primary/18 relative flex h-[76px] items-center gap-3.5 bg-linear-to-r to-transparent px-3.5">
      <span className="relative flex shrink-0">
        <UserAvatar name={name} avatar={me?.avatar} size={52} />
        <span
          aria-hidden
          className="ring-surface-content absolute right-0 bottom-0 flex rounded-full ring-3"
        >
          <PresenceDot status={status} className="size-3.5" />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${name}, My account`}
          className="text-text-primary focus-visible:after:outline-line-focus active:after:bg-surface-hover max-w-full truncate text-left text-[19px] leading-6 font-extrabold outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2"
        >
          {name}
        </button>
        <StatusChip onStatus={onStatus} />
      </div>
      <ChevronRight aria-hidden className="text-text-disabled size-[17px] shrink-0" />
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
    <ListGroup tone="danger" className={className}>
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
      {header !== undefined && lead === -1 && <ListGroup>{header}</ListGroup>}
      {groups.map((g, i) => {
        const headingId = `${baseId}-${i}`
        return (
          <section
            key={g.heading ?? `group-${i}`}
            aria-labelledby={g.heading ? headingId : undefined}
            className="flex flex-col gap-1.5"
          >
            {g.heading && <SectionLabel id={headingId}>{g.heading}</SectionLabel>}
            <ListGroup>
              {i === lead && header}
              {g.items.map((s) => (
                <ListRow
                  key={s.id}
                  icon={s.icon}
                  tile={s.tint}
                  label={s.label}
                  detail={s.detail}
                  value={s.value ?? (s.count ? String(s.count) : undefined)}
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
