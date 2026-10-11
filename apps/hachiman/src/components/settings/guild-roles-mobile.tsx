import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AtSign, Ban, Lock, Plus, Trash2 } from 'lucide-react'
import type { Role } from '@hachiman/client'
import { revealScrollLeft } from '@/components/mobile/chip-scroller'
import { MobileField } from '@/components/mobile/field'
import { FilterChip } from '@/components/mobile/filter-chips'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetHoldTrigger,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetSeparator
} from '@/components/mobile/menu-sheet'
import { NavAction, NavActionButton } from '@/components/mobile/nav-bar'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PermissionList } from '@/components/ui/permission-row'
import { DockedFoot } from '@/components/mobile/foot'
import { HoistRow } from '@/components/settings/hoist-row'
import { PERMISSION_LABELS } from '@/components/settings/permission-labels'
import { SaveBar } from '@/components/settings/save-bar'
import {
  SWATCHES,
  SWATCH_NAMES,
  colourFromHex,
  isCustomColour,
  useRoleDraft,
  useRoleList,
  type RoleList
} from '@/components/settings/use-role-list'
import { useLatched } from '@/hooks/use-latched'
import { hexColor } from '@/lib/model'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { usePlatform } from '@/shared/PlatformContext'

/** The fill of a role's dot: its colour, or grey for no colour. */
const dotColour = (color: number): string => (color ? hexColor(color) : 'var(--text-tertiary)')

/**
 * Guild settings → Roles on the mobile layout (M53): the roles as a strip of chips pinned over the
 * editor of the picked one. "+ Create role" is the Nav Bar action. A hold on a chip opens Move
 * higher, Move lower and Delete. The Save foot docks under the screen while the draft has changes.
 */
export function GuildRolesMobile({ guildId }: { guildId: string }): React.JSX.Element {
  const list = useRoleList(guildId)
  const { selected, ceiling } = list
  const [deleting, setDeleting] = useState<Role | null>(null)
  // The dialog keeps its title while it closes.
  const shownDelete = useLatched(deleting)

  return (
    <div className="flex flex-col gap-3">
      <NavAction>
        <NavActionButton label="Create role" tone="accent" onClick={() => void list.create()}>
          <Plus />
        </NavActionButton>
      </NavAction>
      <RoleStrip list={list} guildId={guildId} onDelete={setDeleting} />
      <ErrorText>{list.error}</ErrorText>
      {selected && (
        <RoleEditorMobile
          key={selected.id}
          role={selected}
          isEveryone={selected.id === guildId}
          editable={selected.position < ceiling}
          onDelete={() => setDeleting(selected)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${shownDelete?.name ?? 'role'}?`}
        body="Members with this role lose it and its permissions. You can’t undo this."
        confirmLabel="Delete role"
        what="delete the role"
        tone="danger"
        icon={<Trash2 />}
        onConfirm={async () => {
          if (!deleting) return
          await adminActionService.deleteRole(guildId, deleting.id)
          if (deleting.id === selected?.id) list.select(null)
        }}
      />
    </div>
  )
}

/**
 * The role chips (M53 Role Strip): 36 high, a 9 dot (an @ for @everyone), the name and the member
 * count, a lock on a role at or above my highest. One choice, so a radio group with one tab stop.
 * It sticks to the top of the scrolling body and scrolls sideways; the picked chip scrolls into
 * view. The hold menu has an sr-only button path for VoiceOver.
 */
function RoleStrip({
  list,
  guildId,
  onDelete
}: {
  list: RoleList
  guildId: string
  onDelete: (role: Role) => void
}): React.JSX.Element {
  const { roles, selected, ceiling } = list
  const row = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const current = Math.max(
    roles.findIndex((r) => r.id === selected?.id),
    0
  )

  // The picked chip scrolls into view: after a pick, a create (the new chip) or a move.
  useLayoutEffect(() => {
    const box = row.current
    const chip = box?.querySelectorAll<HTMLElement>('[role="radio"]')[current]
    if (!box || !chip) return
    const first = !mounted.current
    mounted.current = true
    const boxLeft = box.getBoundingClientRect().left + box.clientLeft
    const rect = chip.getBoundingClientRect()
    const start = rect.left - boxLeft + box.scrollLeft
    const left = revealScrollLeft(
      { scrollLeft: box.scrollLeft, width: box.clientWidth },
      { start, end: start + rect.width },
      parseFloat(getComputedStyle(box).paddingLeft) || 0
    )
    if (left !== null) box.scrollTo({ left, behavior: first ? 'instant' : 'auto' })
  }, [current, roles])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = radioStep(current, roles.length, e.key)
    if (next === null) return
    e.preventDefault()
    list.select(roles[next].id)
    row.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  const held = selected && selected.id !== guildId && selected.position < ceiling

  return (
    // -top-4: the body's 16 padding insets where a sticky child sticks. The row is `relative`, so
    // the sr-only counts of its chips scroll with it and do not widen the body.
    <div className="bg-surface-content sticky -top-4 z-10 -mx-4 -mt-4 pt-3.5 pb-0.5">
      <div
        ref={row}
        role="radiogroup"
        aria-label="Roles"
        data-swipe-ignore=""
        onKeyDown={onKeyDown}
        className="relative flex gap-2 overflow-x-auto overscroll-x-contain scroll-smooth px-4 [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
      >
        {roles.map((r, i) => {
          const isEveryone = r.id === guildId
          const editable = r.position < ceiling
          const on = i === current
          const count = list.count(r)
          const chip = (
            <FilterChip
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              active={on}
              onClick={() => !on && list.select(r.id)}
              className={cn(
                'gap-[7px] text-[14px] leading-[17px]',
                on ? 'border-accent-primary/40 font-extrabold' : 'font-semibold'
              )}
            >
              {isEveryone ? (
                <AtSign aria-hidden className="text-text-tertiary size-3.5" />
              ) : (
                <span
                  aria-hidden
                  className="size-[9px] shrink-0"
                  style={{ background: dotColour(r.color) }}
                />
              )}
              <span className="max-w-40 truncate">{isEveryone ? 'everyone' : r.name}</span>
              {!editable && (
                <Lock aria-label="Above your highest role" className="text-text-tertiary size-3" />
              )}
              <span
                className={cn(
                  'text-[12px] leading-[14px] font-bold tabular-nums',
                  on ? 'text-accent-text' : 'text-text-tertiary'
                )}
              >
                <span className="sr-only">, </span>
                {count}
                <span className="sr-only">{count === 1 ? ' member' : ' members'}</span>
              </span>
            </FilterChip>
          )
          if (isEveryone || !editable) return <Fragment key={r.id}>{chip}</Fragment>
          const at = list.movable.indexOf(r)
          return (
            <MenuSheet
              key={r.id}
              open={menuFor === r.id}
              onOpenChange={(open) => setMenuFor(open ? r.id : null)}
            >
              <MenuSheetHoldTrigger asChild>{chip}</MenuSheetHoldTrigger>
              <MenuSheetContent title={`${r.name} actions`}>
                <MenuSheetLabel>{r.name}</MenuSheetLabel>
                <MenuSheetItem
                  disabled={!list.canMoveHigher(r)}
                  onSelect={() => list.moveTo(r, at - 1)}
                >
                  <ArrowUp /> Move higher
                </MenuSheetItem>
                <MenuSheetItem
                  disabled={!list.canMoveLower(r)}
                  onSelect={() => list.moveTo(r, at + 1)}
                >
                  <ArrowDown /> Move lower
                </MenuSheetItem>
                <MenuSheetSeparator />
                <MenuSheetItem variant="destructive" onSelect={() => onDelete(r)}>
                  <Trash2 /> Delete role
                </MenuSheetItem>
              </MenuSheetContent>
            </MenuSheet>
          )
        })}
      </div>
      {held && (
        <button type="button" className="sr-only" onClick={() => setMenuFor(selected.id)}>
          Actions for {selected.name}
        </button>
      )}
    </div>
  )
}

/**
 * The editor of one role (M53): name with a colour lead, swatches, the member-list group, the
 * permissions (Administrator lights every row below it), and Delete role. Keyed on the role id.
 */
function RoleEditorMobile({
  role,
  isEveryone,
  editable,
  onDelete
}: {
  role: Role
  isEveryone: boolean
  editable: boolean
  onDelete: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const { draft, busy, error, save } = useRoleDraft(role, isEveryone)
  const { name, color, permissions } = draft.value
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const errorBox = useRef<HTMLDivElement>(null)

  // Save sits in the foot, far from the error line: bring the line into view.
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: 'nearest' })
  }, [error])

  const onSave = async (): Promise<void> => {
    if ((await save()).ok) platform.haptic('success')
  }

  return (
    <div ref={setRoot} className="flex flex-col gap-3.5">
      {!editable && (
        <Callout size="touch" icon={<Lock />}>
          This role is at or above your highest role, so you can’t edit it.
        </Callout>
      )}
      <MobileField
        id="role-name"
        label="Role name"
        hint={
          isEveryone
            ? '@everyone applies to every member of the guild. Its name and position can’t change.'
            : 'Members take the colour of their highest role.'
        }
      >
        <Input
          size="touch"
          lead={
            isEveryone ? (
              <AtSign />
            ) : (
              <span className="size-3" style={{ background: dotColour(color) }} />
            )
          }
          className="pl-9"
          value={isEveryone ? '@everyone' : name}
          maxLength={100}
          enterKeyHint="done"
          disabled={!editable || isEveryone}
          onChange={(e) => draft.set({ name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </MobileField>
      <SwatchPicker value={color} disabled={!editable} onChange={(c) => draft.set({ color: c })} />
      {!isEveryone && <HoistRow role={role} editable={editable} size="touch" />}
      <section aria-labelledby="role-permissions" className="flex flex-col gap-3.5">
        <SectionLabel id="role-permissions">Permissions</SectionLabel>
        <PermissionList
          size="touch"
          items={PERMISSION_LABELS}
          value={permissions}
          disabled={!editable}
          onChange={(p) => draft.set({ permissions: p })}
        />
      </section>
      <div ref={errorBox} className="empty:hidden">
        <ErrorText>{error}</ErrorText>
      </div>
      {editable && !isEveryone && (
        <ListGroup tone="danger" className="mt-1.5">
          <ListRow
            tone="danger"
            icon={<Trash2 />}
            label="Delete role"
            detail="Members with this role lose it and its permissions."
            onClick={onDelete}
          />
        </ListGroup>
      )}
      {editable && (draft.dirty || busy) && (
        <DockedFoot anchor={root}>
          <SaveBar
            layout="foot"
            dirty={draft.dirty}
            busy={busy}
            disabled={!name.trim()}
            onReset={draft.reset}
            onSave={() => void onSave()}
          />
        </DockedFoot>
      )}
    </div>
  )
}

/** The look of a 36 chip (`FilterChip`) for the Custom choice, which is a label, not a button. */
const CUSTOM_CHIP =
  'rounded-control relative inline-flex h-9 shrink-0 items-center gap-1.5 border px-2.5 text-[13.5px] leading-4 font-bold whitespace-nowrap transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-line-focus'

/**
 * The colour choice (M53): the eight swatches across the width (30, a 36 hit area each, a ring
 * on the picked one), then No colour and Custom as chips under them, so ten 36 targets fit the
 * iPhone SE. Custom is an `<input type="color">`, which WebKit shows as the iOS colour picker.
 */
function SwatchPicker({
  value,
  disabled,
  onChange
}: {
  value: number
  disabled: boolean
  onChange: (color: number) => void
}): React.JSX.Element {
  const custom = isCustomColour(value)
  return (
    <div className="flex flex-col gap-1.5">
      <span id="role-colour" className="text-text-secondary text-[13px] leading-4 font-bold">
        Colour
      </span>
      <div role="radiogroup" aria-labelledby="role-colour" className="flex flex-col gap-2">
        <div className="flex h-11 items-center justify-between">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={value === c}
              aria-label={SWATCH_NAMES.get(c) ?? hexColor(c)}
              disabled={disabled}
              onClick={() => onChange(c)}
              className="focus-visible:outline-line-focus flex size-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:outline-2 disabled:opacity-50"
            >
              <span
                aria-hidden
                className={cn(
                  'size-[30px] rounded-full',
                  value === c && 'ring-text-primary ring-[2.5px]'
                )}
                style={{ background: hexColor(c) }}
              />
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <FilterChip
            role="radio"
            aria-checked={value === 0}
            active={value === 0}
            icon={<Ban />}
            disabled={disabled}
            onClick={() => onChange(0)}
          >
            No colour
          </FilterChip>
          <label
            className={cn(
              CUSTOM_CHIP,
              custom
                ? 'bg-accent-tint border-accent-primary/50 text-text-primary'
                : 'border-line-hairline text-text-secondary active:bg-surface-hover bg-(--fill-control)',
              disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'
            )}
          >
            <span
              aria-hidden
              className="size-[15px] rounded-full bg-[conic-gradient(#ff6b6b,#ffc36b,#5ed98a,#7fd3ff,#8b7bff,#ff8fc4,#ff6b6b)]"
              style={custom ? { background: hexColor(value) } : undefined}
            />
            Custom
            <input
              type="color"
              aria-label={custom ? `Custom colour, ${hexColor(value)}, selected` : 'Custom colour'}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              value={value ? hexColor(value) : '#99a0ac'}
              disabled={disabled}
              onChange={(e) => onChange(colourFromHex(e.target.value))}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
