import { useState } from 'react'
import { ArrowDown, ArrowUp, AtSign, Check, GripVertical, Lock, Plus, Trash2 } from 'lucide-react'
import type { Role } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { PermissionList } from '@/components/ui/permission-row'
import { GuildRolesMobile } from '@/components/settings/guild-roles-mobile'
import { HoistRow } from '@/components/settings/hoist-row'
import { PERMISSION_LABELS } from '@/components/settings/permission-labels'
import { SaveBar } from '@/components/settings/save-bar'
import {
  SWATCHES,
  SWATCH_NAMES,
  colourFromHex,
  isCustomColour,
  useRoleDraft,
  useRoleList
} from '@/components/settings/use-role-list'
import { useLayout } from '@/hooks/use-layout'
import { hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { selectableRowClass } from '@/components/ui/selectable-row'

/**
 * Guild settings → Roles (G2). Gated MANAGE_ROLES. The mobile layout has its own page (M53,
 * `GuildRolesMobile`); both use `useRoleList` and `useRoleDraft`.
 */
export function GuildRolesTab({ guildId }: { guildId: string }): React.JSX.Element {
  return useLayout() === 'mobile' ? (
    <GuildRolesMobile guildId={guildId} />
  ) : (
    <GuildRolesDesktop guildId={guildId} />
  )
}

/**
 * The desktop page: the role list (highest first, @everyone last; drag or the arrows to reorder)
 * and the editor of the picked role.
 */
function GuildRolesDesktop({ guildId }: { guildId: string }): React.JSX.Element {
  const list = useRoleList(guildId)
  const { roles, selected, movable, ceiling, moveTo, create, error } = list
  const [dragging, setDragging] = useState<string | null>(null)

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-6">
      <div className="sticky top-0 grid gap-3">
        <Button variant="secondary" size="lg" className="w-full" onClick={() => void create()}>
          <Plus /> Create role
        </Button>
        <ErrorText>{error}</ErrorText>
        <ul className="grid gap-0.5" aria-label="Roles">
          {roles.map((r) => {
            const editable = r.position < ceiling
            const i = movable.indexOf(r)
            const isSelected = r.id === selected?.id
            const isEveryone = r.id === guildId
            const draggable = i >= 0 && editable
            return (
              <li
                key={r.id}
                draggable={draggable}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDragging(r.id)
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (dragging && i >= 0) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const role = movable.find((m) => m.id === dragging)
                  if (role) moveTo(role, i)
                  setDragging(null)
                }}
                className={selectableRowClass(
                  isSelected,
                  cn(
                    'group flex h-9 items-center gap-1 pr-1 pl-1 text-sm font-semibold',
                    dragging === r.id && 'opacity-50'
                  )
                )}
              >
                <GripVertical
                  aria-hidden
                  className={cn(
                    'text-text-disabled size-3.5 shrink-0',
                    draggable ? 'cursor-grab' : 'invisible'
                  )}
                />
                <button
                  type="button"
                  aria-current={isSelected || undefined}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => list.select(r.id)}
                >
                  {isEveryone ? (
                    <AtSign aria-hidden className="text-text-tertiary size-3.5 shrink-0" />
                  ) : (
                    <RoleSwatch color={r.color} />
                  )}
                  <span className="truncate">{isEveryone ? 'everyone' : r.name}</span>
                  {!editable && (
                    <Lock
                      aria-label="Above your highest role"
                      className="text-text-tertiary size-3 shrink-0"
                    />
                  )}
                </button>
                {i >= 0 && (
                  <span className="hidden group-focus-within:flex group-hover:flex">
                    {/* Moving up needs the role above to be editable too, or we'd jump past our ceiling. */}
                    <IconButton
                      size="sm"
                      label={`Move ${r.name} up`}
                      disabled={!list.canMoveHigher(r)}
                      onClick={() => moveTo(r, i - 1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Move ${r.name} down`}
                      disabled={!list.canMoveLower(r)}
                      onClick={() => moveTo(r, i + 1)}
                    >
                      <ArrowDown />
                    </IconButton>
                  </span>
                )}
                <span className="text-meta text-text-tertiary w-6 shrink-0 text-right tabular-nums group-focus-within:hidden group-hover:hidden">
                  {list.count(r)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      {selected && (
        <RoleEditor
          key={selected.id}
          role={selected}
          isEveryone={selected.id === guildId}
          editable={selected.position < ceiling}
          onDeleted={() => list.select(null)}
        />
      )}
    </div>
  )
}

function RoleSwatch({ color }: { color: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0"
      style={{ background: color ? hexColor(color) : 'var(--text-tertiary)' }}
    />
  )
}

function RoleEditor(props: {
  role: Role
  isEveryone: boolean
  editable: boolean
  onDeleted: () => void
}): React.JSX.Element {
  const { role, isEveryone, editable } = props
  // Reset per role via the parent's `key`. Gateway updates to *other* fields don't clobber it.
  const { draft, busy, error, save } = useRoleDraft(role, isEveryone)
  const { name, color, permissions } = draft.value
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="grid gap-5">
      {!editable && (
        <p className="bg-surface-raised text-meta text-text-secondary px-3 py-2">
          This role is at or above your highest role, so you can’t edit it.
        </p>
      )}
      {isEveryone && (
        <p className="text-meta text-text-tertiary">
          @everyone applies to every member of the guild. Its name and position can’t change.
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
        <Field id="role-name" label="Role name">
          <Input
            id="role-name"
            className="h-10"
            value={isEveryone ? '@everyone' : name}
            maxLength={100}
            disabled={!editable || isEveryone}
            onChange={(e) => draft.set({ name: e.target.value })}
          />
        </Field>
        <div className="grid gap-1.5">
          <span id="role-color" className="text-xs leading-4 font-semibold">
            Colour
          </span>
          <ColourSwatches
            value={color}
            disabled={!editable}
            onChange={(c) => draft.set({ color: c })}
          />
        </div>
      </div>
      {!isEveryone && <HoistRow role={role} editable={editable} />}
      <section>
        <SectionHeading>Permissions</SectionHeading>
        <PermissionList
          items={PERMISSION_LABELS}
          value={permissions}
          disabled={!editable}
          onChange={(p) => draft.set({ permissions: p })}
        />
      </section>
      <ErrorText>{error}</ErrorText>
      {editable && (
        <div className="bg-surface-content sticky bottom-0 flex items-center gap-2 py-3">
          {!isEveryone && (
            <Button variant="danger-outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete role
            </Button>
          )}
          <div className="flex-1">
            <SaveBar
              dirty={draft.dirty}
              busy={busy}
              disabled={!name.trim()}
              onReset={draft.reset}
              onSave={() => void save()}
            />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${role.name}?`}
        body="Members with this role lose it and its permissions. You can’t undo this."
        confirmLabel="Delete role"
        what="delete the role"
        tone="danger"
        onConfirm={async () => {
          await adminActionService.deleteRole(role.guildId, role.id)
          props.onDeleted()
        }}
      />
    </div>
  )
}

/** The colour row: No colour, the swatches, then Custom (the system colour picker). */
function ColourSwatches({
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
    <div role="radiogroup" aria-labelledby="role-color" className="flex h-10 items-center gap-1.5">
      <ColourSwatch
        label="No colour"
        value={0}
        checked={value === 0}
        disabled={disabled}
        onPick={() => onChange(0)}
      />
      {SWATCHES.map((c) => (
        <ColourSwatch
          key={c}
          label={SWATCH_NAMES.get(c) ?? hexColor(c)}
          value={c}
          checked={value === c}
          disabled={disabled}
          onPick={() => onChange(c)}
        />
      ))}
      <label
        title="Custom colour"
        className={cn(
          'rounded-pill relative size-7 shrink-0 cursor-pointer border-2 bg-[conic-gradient(#ff6b6b,#ffc36b,#5ed98a,#7fd3ff,#8b7bff,#ff8fc4,#ff6b6b)]',
          custom ? 'border-text-primary' : 'border-transparent',
          disabled && 'pointer-events-none opacity-50'
        )}
        style={custom ? { background: hexColor(value) } : undefined}
      >
        <span className="sr-only">Custom colour</span>
        <input
          type="color"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value ? hexColor(value) : '#99a0ac'}
          disabled={disabled}
          onChange={(e) => onChange(colourFromHex(e.target.value))}
        />
      </label>
    </div>
  )
}

function ColourSwatch({
  label,
  value,
  checked,
  disabled,
  onPick
}: {
  label: string
  value: number
  checked: boolean
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        'rounded-pill flex size-7 shrink-0 items-center justify-center border-2 disabled:opacity-50',
        checked ? 'border-text-primary' : value === 0 ? 'border-line-strong' : 'border-transparent',
        value === 0 && 'bg-surface-raised'
      )}
      style={value ? { background: hexColor(value) } : undefined}
    >
      {checked && (
        <Check
          aria-hidden
          className={cn('size-3.5', value ? 'text-black/70' : 'text-text-primary')}
        />
      )}
    </button>
  )
}
