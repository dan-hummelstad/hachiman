import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, AtSign, Check, GripVertical, Lock, Plus, Trash2 } from 'lucide-react'
import { Permissions, type Role } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { HoistRow } from '@/components/settings/hoist-row'
import { PERMISSION_LABELS } from '@/components/settings/permission-labels'
import { SaveBar } from '@/components/settings/save-bar'
import { useAction } from '@/hooks/use-action'
import { trimName, useDraft } from '@/hooks/use-draft'
import { useRoleCeiling } from '@/hooks/use-hachiman'
import { hexColor, rolesByPositionDesc } from '@/lib/model'
import { cn } from '@/lib/utils'
import { adminActionService } from '@/services/AdminActionService'
import { useGuildStore } from '@/stores/guildStore'

/** The colour row of the role editor (0 = no colour). */
const SWATCHES = [
  0xffc36b, 0xff8fc4, 0xff6b6b, 0xc9a2ff, 0x8b7bff, 0x7fd3ff, 0x5ee6d0, 0x5ed98a
] as const

/**
 * Guild settings → Roles (G2): the role list (highest first, @everyone last; drag or the arrows to
 * reorder) and the editor of the picked role. Gated MANAGE_ROLES.
 */
export function GuildRolesTab({ guildId }: { guildId: string }): React.JSX.Element {
  const roleMap = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const ceiling = useRoleCeiling(guildId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const { run, error } = useAction()

  const roles = useMemo(() => rolesByPositionDesc(roleMap?.values() ?? []), [roleMap])
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0]
  // @everyone (id === guildId) is pinned at position 0 and never moves.
  const movable = roles.filter((r) => r.id !== guildId)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const member of members?.values() ?? [])
      for (const id of member.roles) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }, [members])

  const create = async (): Promise<void> => {
    const created = await run('create the role', () =>
      adminActionService.createRole(guildId, { name: 'new role' })
    )
    if (created.ok) setSelectedId(created.value.id)
  }

  /**
   * Moves `role` to index `to` of the movable list. Only the roles between the two places change
   * position, and each of them must be below my ceiling, so a non-admin never sends a role above
   * it. They take the same set of positions in the new order. Duplicate positions (legacy data)
   * fall back to renumbering n..1.
   */
  const moveTo = (role: Role, to: number): void => {
    const from = movable.indexOf(role)
    if (from < 0 || to < 0 || to >= movable.length || to === from) return
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const span = movable.slice(lo, hi + 1)
    if (span.some((r) => r.position >= ceiling)) return
    const order = [...movable]
    order.splice(from, 1)
    order.splice(to, 0, role)
    const positions = span.map((r) => r.position)
    let body: { id: string; position: number }[]
    if (new Set(positions).size === positions.length) {
      body = order
        .slice(lo, hi + 1)
        .map((r, k) => ({ id: r.id, position: positions[k] }))
        .filter((r) => roleMap?.get(r.id)?.position !== r.position)
    } else {
      body = order
        .map((r, k) => ({ id: r.id, position: order.length - k }))
        .filter((r, k) => r.position !== order[k].position)
    }
    void run('reorder roles', () => adminActionService.reorderRoles(guildId, body))
  }

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
                className={cn(
                  'group rounded-control flex h-9 items-center gap-1 pr-1 pl-1 text-sm font-semibold',
                  isSelected
                    ? 'bg-surface-selected text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  dragging === r.id && 'opacity-50'
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
                  onClick={() => setSelectedId(r.id)}
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
                      disabled={!editable || i === 0 || movable[i - 1].position >= ceiling}
                      onClick={() => moveTo(r, i - 1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Move ${r.name} down`}
                      disabled={!editable || i === movable.length - 1}
                      onClick={() => moveTo(r, i + 1)}
                    >
                      <ArrowDown />
                    </IconButton>
                  </span>
                )}
                <span className="text-meta text-text-tertiary w-6 shrink-0 text-right tabular-nums group-focus-within:hidden group-hover:hidden">
                  {isEveryone ? (members?.size ?? 0) : (counts.get(r.id) ?? 0)}
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
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

function RoleSwatch({ color }: { color: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="rounded-check size-2.5 shrink-0"
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
  const draft = useDraft(
    { name: role.name, color: role.color, permissions: role.permissions },
    trimName
  )
  const { name, color, permissions } = draft.value
  const { run, busy, error } = useAction()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const admin = (permissions & Permissions.ADMINISTRATOR) !== 0
  const custom = color !== 0 && !(SWATCHES as readonly number[]).includes(color)

  const save = (): Promise<unknown> =>
    run('save the role', () =>
      adminActionService.updateRole(role.guildId, role.id, {
        name: isEveryone ? undefined : name.trim(),
        color,
        // A permissions change is a signed admin action (§12.16); send it only when it changed.
        permissions: permissions !== role.permissions ? permissions : undefined
      })
    )

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
          <div
            role="radiogroup"
            aria-labelledby="role-color"
            className="flex h-10 items-center gap-1.5"
          >
            <ColourSwatch
              label="No colour"
              value={0}
              checked={color === 0}
              disabled={!editable}
              onPick={() => draft.set({ color: 0 })}
            />
            {SWATCHES.map((c) => (
              <ColourSwatch
                key={c}
                label={hexColor(c)}
                value={c}
                checked={color === c}
                disabled={!editable}
                onPick={() => draft.set({ color: c })}
              />
            ))}
            <label
              title="Custom colour"
              className={cn(
                'rounded-pill relative size-7 shrink-0 cursor-pointer border-2 bg-[conic-gradient(#ff6b6b,#ffc36b,#5ed98a,#7fd3ff,#8b7bff,#ff8fc4,#ff6b6b)]',
                custom ? 'border-text-primary' : 'border-transparent',
                !editable && 'pointer-events-none opacity-50'
              )}
              style={custom ? { background: hexColor(color) } : undefined}
            >
              <span className="sr-only">Custom colour</span>
              <input
                type="color"
                className="absolute inset-0 cursor-pointer opacity-0"
                value={color ? hexColor(color) : '#99a0ac'}
                disabled={!editable}
                onChange={(e) => draft.set({ color: parseInt(e.target.value.slice(1), 16) })}
              />
            </label>
          </div>
        </div>
      </div>
      {!isEveryone && <HoistRow role={role} editable={editable} />}
      <section>
        <SectionHeading>Permissions</SectionHeading>
        <div className="divide-line-hairline divide-y">
          {PERMISSION_LABELS.map((p) => {
            const isAdminRow = p.bit === Permissions.ADMINISTRATOR
            const viaAdmin = admin && !isAdminRow
            return (
              <div
                key={p.name}
                className={cn('flex items-center gap-4 py-2.5', viaAdmin && 'opacity-55')}
              >
                <label htmlFor={`perm-${p.name}`} className="grid min-w-0 flex-1 cursor-pointer">
                  <span className="text-label flex items-center gap-2">
                    {p.label}
                    {viaAdmin && (
                      <span className="rounded-check bg-feature-event/15 text-feature-event-text px-1.5 text-[10px] leading-4 font-extrabold tracking-[0.6px]">
                        VIA ADMINISTRATOR
                      </span>
                    )}
                  </span>
                  <span className="text-meta text-text-tertiary">{p.hint}</span>
                </label>
                <Switch
                  id={`perm-${p.name}`}
                  checked={viaAdmin || (permissions & p.bit) === p.bit}
                  disabled={!editable || viaAdmin}
                  onCheckedChange={(v) =>
                    draft.set({ permissions: v ? permissions | p.bit : permissions & ~p.bit })
                  }
                />
              </div>
            )
          })}
        </div>
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
