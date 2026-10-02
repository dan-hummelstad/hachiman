import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Lock, Plus } from 'lucide-react'
import type { Role } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { PermissionRow } from '@/components/ui/permission-row'
import { selectableRowClass } from '@/components/ui/selectable-row'
import { Switch } from '@/components/ui/switch'
import { PERMISSION_LABELS } from '@/components/settings/permission-labels'
import { SideList, SidePaneHeader } from '@/components/settings/side-list'
import { useAction } from '@/hooks/use-action'
import { trimName, useDraft } from '@/hooks/use-draft'
import { useRoleCeiling } from '@/hooks/use-hachiman'
import { hexColor, rolesByPositionDesc } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { useGuildStore } from '@/stores/guildStore'

/** Discord-style two panes: role list (highest first, @everyone last) | editor. Gated MANAGE_ROLES. */
export function GuildRolesTab({ guildId }: { guildId: string }): React.JSX.Element {
  const roleMap = useGuildStore((s) => s.roles.get(guildId))
  const ceiling = useRoleCeiling(guildId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { run, error } = useAction()

  const roles = useMemo(() => rolesByPositionDesc(roleMap?.values() ?? []), [roleMap])
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0]
  // @everyone (id === guildId) is pinned at position 0 and never moves.
  const movable = roles.filter((r) => r.id !== guildId)

  const create = async (): Promise<void> => {
    const created = await run('create the role', () =>
      hachiman.rest.createRole(guildId, { name: 'new role' })
    )
    if (created.ok) setSelectedId(created.value.id)
  }

  /**
   * Swap positions with the neighbour — touches only those two roles, so a non-admin never sends a
   * role above their ceiling. Duplicate positions (legacy data) fall back to renumbering n..1.
   */
  const move = (role: Role, dir: -1 | 1): void => {
    const i = movable.indexOf(role)
    const other = movable[i + dir]
    if (!other) return
    let body = [
      { id: role.id, position: other.position },
      { id: other.id, position: role.position }
    ]
    if (role.position === other.position) {
      const order = [...movable]
      ;[order[i], order[i + dir]] = [other, role]
      body = order
        .map((r, k) => ({ id: r.id, position: order.length - k }))
        .filter((r, k) => r.position !== order[k].position)
    }
    void run('reorder roles', () => hachiman.rest.reorderRoles(guildId, body))
  }

  return (
    <SideList
      aside={
        <>
          <Button size="sm" variant="outline" onClick={() => void create()}>
            <Plus /> Create role
          </Button>
          <ErrorText>{error}</ErrorText>
          <p className="text-muted-foreground text-xs leading-4">
            Members use the colour of their highest role.
          </p>
          <ul className="flex flex-col">
            {roles.map((r) => {
              const editable = r.position < ceiling
              const i = movable.indexOf(r)
              const isSelected = r.id === selected?.id
              return (
                <li key={r.id} className={selectableRowClass(isSelected, 'group gap-1 pr-1 pl-0')}>
                  <button
                    type="button"
                    aria-current={isSelected || undefined}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left"
                    onClick={() => setSelectedId(r.id)}
                  >
                    <RoleSwatch color={r.color} />
                    <span className="truncate">{r.id === guildId ? '@everyone' : r.name}</span>
                    {!editable && (
                      <Lock
                        aria-label="Above your highest role"
                        className="text-muted-foreground size-3 shrink-0"
                      />
                    )}
                  </button>
                  {i >= 0 && (
                    <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      {/* Moving up needs the role above to be editable too, or we'd jump past our ceiling. */}
                      <IconButton
                        size="sm"
                        label={`Move ${r.name} up`}
                        disabled={!editable || i === 0 || movable[i - 1].position >= ceiling}
                        onClick={() => move(r, -1)}
                      >
                        <ArrowUp />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={`Move ${r.name} down`}
                        disabled={!editable || i === movable.length - 1}
                        onClick={() => move(r, 1)}
                      >
                        <ArrowDown />
                      </IconButton>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      }
    >
      {selected && (
        <RoleEditor
          key={selected.id}
          role={selected}
          isEveryone={selected.id === guildId}
          editable={selected.position < ceiling}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </SideList>
  )
}

function RoleSwatch({ color }: { color: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="border-border size-3 shrink-0 border"
      style={{ background: color ? hexColor(color) : undefined }}
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

  const save = (): Promise<unknown> =>
    run('save the role', () =>
      hachiman.rest.updateRole(role.guildId, role.id, {
        name: isEveryone ? undefined : name.trim(),
        color,
        permissions
      })
    )

  return (
    <div className="flex flex-col gap-6">
      <SidePaneHeader>
        <RoleSwatch color={color} />
        <span className="truncate">{isEveryone ? '@everyone' : name.trim() || role.name}</span>
      </SidePaneHeader>
      {!editable && (
        <p className="text-muted-foreground bg-card border px-3 py-2 text-xs leading-4">
          This role is at or above your highest role, so you can’t edit it.
        </p>
      )}
      {isEveryone && (
        <p className="text-muted-foreground text-xs leading-4">
          @everyone applies to every member of the guild. Its name and position can’t change.
        </p>
      )}
      <div className="flex items-end gap-4">
        <Field id="role-name" label="Role name" className="flex-1">
          <Input
            id="role-name"
            value={isEveryone ? '@everyone' : name}
            maxLength={100}
            disabled={!editable || isEveryone}
            onChange={(e) => draft.set({ name: e.target.value })}
          />
        </Field>
        <Field id="role-color" label="Colour">
          <div className="flex items-center gap-1">
            <input
              id="role-color"
              type="color"
              className="border-input bg-card h-8 w-10 cursor-pointer border p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              value={color ? hexColor(color) : '#99a0ac'}
              disabled={!editable}
              onChange={(e) => draft.set({ color: parseInt(e.target.value.slice(1), 16) })}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={!editable || color === 0}
              onClick={() => draft.set({ color: 0 })}
            >
              No colour
            </Button>
          </div>
        </Field>
      </div>
      <section>
        <SectionHeading>Permissions</SectionHeading>
        <div className="divide-border divide-y border-y">
          {PERMISSION_LABELS.map((p) => (
            <PermissionRow key={p.name} label={p.label} hint={p.hint} htmlFor={`perm-${p.name}`}>
              <Switch
                id={`perm-${p.name}`}
                checked={(permissions & p.bit) === p.bit}
                disabled={!editable}
                onCheckedChange={(v) =>
                  draft.set({ permissions: v ? permissions | p.bit : permissions & ~p.bit })
                }
              />
            </PermissionRow>
          ))}
        </div>
      </section>
      {!isEveryone && (
        <div>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={!editable || busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete role
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {editable && draft.dirty && (
        <div className="bg-popover sticky bottom-4 flex items-center gap-2 border px-3 py-2 shadow-lg">
          <span className="flex-1 text-sm">You have unsaved changes.</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={draft.reset}>
            Reset
          </Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
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
          await hachiman.rest.deleteRole(role.guildId, role.id)
          props.onDeleted()
        }}
      />
    </div>
  )
}
