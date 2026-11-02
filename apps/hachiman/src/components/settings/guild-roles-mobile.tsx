import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AtSign, Ban, ChevronRight, Lock, Plus, Trash2 } from 'lucide-react'
import type { Role } from '@hachiman/client'
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
import { PERMISSION_GROUPS, PERMISSION_LABELS } from '@/components/settings/permission-labels'
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
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Guild settings → Roles on the mobile layout (D4): the roles as a card over the editor of the
 * picked one. "+ Create role" is the Nav Bar action. A hold on a row opens Move
 * higher, Move lower and Delete. The Save foot docks under the screen while the draft has changes.
 */
export function GuildRolesMobile({ guildId }: { guildId: string }): React.JSX.Element {
  const list = useRoleList(guildId)
  const { selected, ceiling } = list
  const [deleting, setDeleting] = useState<Role | null>(null)
  // The dialog keeps its title while it closes.
  const shownDelete = useLatched(deleting)
  const root = useRef<HTMLDivElement>(null)
  const firstPick = useRef(true)
  const editor = useRef<HTMLDivElement>(null)

  // Another role (a pick, or a new role after a create): its editor starts at the top, at the
  // Role name field. No focus: the keyboard rises when the user taps the field (spec §2.8).
  const selectedId = selected?.id
  useLayoutEffect(() => {
    if (firstPick.current) {
      firstPick.current = false
      return
    }
    scrollParent(root.current)?.scrollTo({ top: 0 })
  }, [selectedId])

  return (
    <div ref={root} className="flex flex-col gap-3">
      <NavAction>
        <NavActionButton label="Create role" tone="accent" onClick={() => void list.create()}>
          <Plus />
        </NavActionButton>
      </NavAction>
      <RoleCard
        list={list}
        guildId={guildId}
        onDelete={setDeleting}
        onPick={() => editor.current?.scrollIntoView({ block: 'start' })}
      />
      <ErrorText>{list.error}</ErrorText>
      <div ref={editor} className="scroll-mt-4">
        {selected && (
          <RoleEditorMobile
            key={selected.id}
            role={selected}
            isEveryone={selected.id === guildId}
            editable={selected.position < ceiling}
            onDelete={() => setDeleting(selected)}
          />
        )}
      </div>
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

/** The nearest ancestor that scrolls vertically (the pushed screen's body). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

/**
 * The roles as one vertical card (D4): name and member count, a lock on a role at or above my
 * highest, a chevron. The picked row is marked with `here`. A hold on an editable row opens Move
 * higher, Move lower and Delete; the sr-only button is the path for VoiceOver. A tap picks the
 * role and scrolls its editor into view.
 */
function RoleCard({
  list,
  guildId,
  onDelete,
  onPick
}: {
  list: RoleList
  guildId: string
  onDelete: (role: Role) => void
  onPick: () => void
}): React.JSX.Element {
  const { roles, selected, ceiling } = list
  const [menuFor, setMenuFor] = useState<string | null>(null)

  return (
    <div className="bg-surface-panel divide-line-hairline divide-y overflow-hidden rounded-[14px]">
      {roles.map((r) => {
        const isEveryone = r.id === guildId
        const editable = r.position < ceiling
        const on = r.id === selected?.id
        const count = list.count(r)
        const held = !isEveryone && editable
        const row = (
          <button
            type="button"
            aria-current={on || undefined}
            onClick={() => {
              list.select(r.id)
              onPick()
            }}
            className={cn(
              'flex min-h-[58px] w-full items-center gap-3 px-4 text-left active:bg-surface-hover',
              on && 'bg-surface-selected'
            )}
          >
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-[14.5px] font-semibold tracking-[-0.2px]',
                  on ? 'text-here-text' : 'text-text-primary'
                )}
              >
                {isEveryone && <AtSign aria-hidden className="text-text-tertiary size-3.5" />}
                <span className="truncate">{isEveryone ? 'everyone' : r.name}</span>
              </span>
              <span className="cap-sm text-[8.5px] tracking-[0.9px]">
                {count} {count === 1 ? 'person' : 'people'}
              </span>
            </span>
            {!editable && (
              <Lock aria-label="Above your highest role" className="text-text-tertiary size-3" />
            )}
            <ChevronRight
              aria-hidden
              className={cn('size-[17px] shrink-0', on ? 'text-here' : 'text-text-disabled')}
            />
          </button>
        )
        if (!held) return <Fragment key={r.id}>{row}</Fragment>
        const at = list.movable.indexOf(r)
        return (
          <MenuSheet
            key={r.id}
            open={menuFor === r.id}
            onOpenChange={(open) => setMenuFor(open ? r.id : null)}
          >
            <MenuSheetHoldTrigger asChild>{row}</MenuSheetHoldTrigger>
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
      {selected && selected.id !== guildId && selected.position < ceiling && (
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
            : 'Members show under their highest hoisted role.'
        }
      >
        <Input
          size="touch"
          lead={isEveryone ? <AtSign /> : undefined}
          className={isEveryone ? 'pl-9' : undefined}
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
        <SectionLabel id="role-permissions">
          A {(isEveryone ? 'everyone' : name || role.name).toUpperCase()} can
        </SectionLabel>
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.id} className="flex flex-col gap-2">
            <h3 className="cap text-text-disabled px-1 text-[9px] tracking-[1.2px]">{g.label}</h3>
            <PermissionList
              size="touch"
              items={PERMISSION_LABELS.filter((l) => l.group === g.id)}
              value={permissions}
              disabled={!editable}
              onChange={(p) => draft.set({ permissions: p })}
            />
          </div>
        ))}
        <p className="text-text-disabled px-1 text-[11.5px] leading-[1.45]">
          An owner always has every permission. Roles can edit only the roles below them.
        </p>
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
  'rounded-control relative inline-flex h-9 shrink-0 items-center gap-1.5 border px-2.5 text-[13.5px] leading-4 font-semibold whitespace-nowrap transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-line-focus'

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
      <span id="role-colour" className="text-text-secondary text-[13px] leading-4 font-semibold">
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
                ? 'bg-surface-selected border-line-strong text-text-primary'
                : 'border-line-hairline text-text-secondary active:bg-surface-hover bg-surface-raised',
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
