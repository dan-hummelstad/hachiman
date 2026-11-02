import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  GripVertical,
  Lock,
  Plus,
  Trash2
} from 'lucide-react'
import type { Role } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field } from '@/components/ui/field'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { PermissionList } from '@/components/ui/permission-row'
import { GuildRolesMobile } from '@/components/settings/guild-roles-mobile'
import { HoistRow } from '@/components/settings/hoist-row'
import { PERMISSION_GROUPS, PERMISSION_LABELS } from '@/components/settings/permission-labels'
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
import { displayName, hexColor } from '@/lib/model'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'

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
    <div className="grid grid-cols-[276px_minmax(0,1fr)] items-start gap-[30px]">
      <div className="sticky top-0 grid gap-3">
        <Button variant="secondary" size="sm" className="w-full" onClick={() => void create()}>
          <Plus /> New role
        </Button>
        <ErrorText>{error}</ErrorText>
        <div className="flex h-3 items-center">
          <span className="cap text-text-disabled text-[9px] tracking-[1.5px]">
            Roles · {roles.length}
          </span>
          <span className="cap-sm ml-auto text-[8.5px]">Drag to reorder</span>
        </div>
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
                className={cn(
                  'rounded-control group relative flex h-[46px] items-center gap-2.5 pr-3 pl-2.5',
                  isSelected ? 'bg-surface-selected' : 'hover:bg-surface-hover',
                  dragging === r.id && 'opacity-50'
                )}
              >
                {isSelected && (
                  <span
                    aria-hidden
                    className="bg-here absolute top-1/2 left-0 h-6 w-0.5 -translate-y-1/2"
                  />
                )}
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
                  className={cn(
                    'flex h-full min-w-0 flex-1 items-center gap-2 text-left text-[13.5px]',
                    isSelected ? 'text-text-primary font-semibold' : 'text-text-secondary'
                  )}
                  onClick={() => list.select(r.id)}
                >
                  {isEveryone && (
                    <AtSign aria-hidden className="text-text-tertiary size-3.5 shrink-0" />
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
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 group-focus-within:hidden group-hover:hidden',
                    isSelected ? 'text-text-tertiary' : 'text-text-disabled'
                  )}
                >
                  <span className="font-mono text-[9.5px] tracking-[0.8px] tabular-nums">
                    {list.count(r)}
                  </span>
                  <ChevronRight aria-hidden className="text-text-disabled size-[13px]" />
                </span>
              </li>
            )
          })}
        </ul>
        <div className="rounded-control bg-surface-sunken mt-1.5 grid gap-1.5 p-3.5">
          <span className="cap-sm text-text-tertiary text-[8.5px] tracking-[1.2px]">
            How order works
          </span>
          <span className="text-text-disabled text-[11.5px] leading-[1.45]">
            A role can edit only the roles below it. Members show under their highest hoisted role.
          </span>
        </div>
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

/** "Who has it": the first three holders of a role and their names. */
function WhoHasIt({ role }: { role: Role }): React.JSX.Element {
  const members = useGuildStore((s) => s.members.get(role.guildId))
  const holders = useMemo(
    () => [...(members?.values() ?? [])].filter((m) => m.roles.includes(role.id)),
    [members, role.id]
  )
  const names = holders.slice(0, 2).map((m) => displayName(m))
  const text =
    holders.length === 0
      ? 'Nobody yet'
      : holders.length === 1
        ? names[0]
        : holders.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names[0]}, ${names[1]} and ${holders.length - 2} ${holders.length === 3 ? 'other' : 'others'}`
  return (
    <div className="rounded-control bg-surface-sunken mt-3 flex h-[46px] items-center gap-[11px] px-3.5">
      <span className="cap-sm text-text-tertiary text-[8.5px] tracking-[1.2px]">Who has it</span>
      {holders.length > 0 && (
        <span className="flex">
          {holders.slice(0, 3).map((m) => (
            <UserAvatar
              key={m.user.id}
              name={displayName(m)}
              avatar={m.user.avatar}
              size={22}
              className="ring-surface-sunken -ml-1.5 rounded-[6px] ring-2 first:ml-0"
            />
          ))}
        </span>
      )}
      <span className="text-text-secondary truncate text-[12.5px]">{text}</span>
    </div>
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
  const count = useGuildStore((s) => s.members.get(role.guildId)?.size ?? 0)

  return (
    <div className="grid gap-5">
      <div>
        <div className="flex items-start gap-3">
          <div className="grid flex-1 gap-1">
            <span className="text-text-primary text-[19px] font-semibold tracking-[-0.4px]">
              {isEveryone ? '@everyone' : role.name}
            </span>
            {isEveryone && <span className="cap-sm text-[8.5px]">{count} members</span>}
          </div>
          {editable && !isEveryone && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 /> Delete role
            </Button>
          )}
        </div>
        {!isEveryone && <WhoHasIt role={role} />}
      </div>
      {!editable && (
        <p className="bg-surface-raised rounded-control text-text-secondary px-3 py-2 text-[12.5px]">
          This role is at or above your highest role, so you can’t edit it.
        </p>
      )}
      {isEveryone && (
        <p className="text-text-tertiary text-[12px]">
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
          <span id="role-color" className="text-label text-text-secondary">
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
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.id}>
            <h3 className="cap text-text-disabled mt-4 mb-2 text-[9px] tracking-[1.5px]">
              {g.label}
            </h3>
            <PermissionList
              items={PERMISSION_LABELS.filter((l) => l.group === g.id)}
              value={permissions}
              disabled={!editable}
              onChange={(p) => draft.set({ permissions: p })}
            />
          </div>
        ))}
      </section>
      <ErrorText>{error}</ErrorText>
      {editable && (
        <div className="bg-surface-content border-line-hairline sticky bottom-0 flex h-14 items-center gap-3 border-t">
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
