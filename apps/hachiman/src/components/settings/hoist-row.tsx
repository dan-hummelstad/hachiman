import type { Role } from '@hachiman/client'
import { ErrorText } from '@/components/ui/field'
import { PermissionRow } from '@/components/ui/permission-row'
import { Switch } from '@/components/ui/switch'
import { useAction } from '@/hooks/use-action'
import { adminActionService } from '@/services/AdminActionService'

/**
 * "Show as its own group in the member list" (G2, feature plan N15). Saves at once with a
 * role PATCH of `hoist` only: no signed admin action (§12.16). The role event updates the store.
 * `size="touch"`: the M53 box, with the role's name in the hint.
 */
export function HoistRow({
  role,
  editable,
  size = 'default'
}: {
  role: Role
  editable: boolean
  size?: 'default' | 'touch'
}): React.JSX.Element {
  const { run, busy, error } = useAction()
  const toggle = (
    <Switch
      id="role-hoist"
      size={size}
      checked={role.hoist}
      disabled={!editable || busy}
      onCheckedChange={(hoist) =>
        void run('change the member list group', () =>
          adminActionService.updateRole(role.guildId, role.id, { hoist })
        )
      }
    />
  )
  if (size === 'touch') {
    return (
      <div className="grid gap-1.5">
        <div className="border-line-hairline border bg-white/2">
          <PermissionRow
            size="touch"
            label="Show as its own group"
            hint={`Online members with this role appear under ${role.name.toUpperCase()} in the member list.`}
            htmlFor="role-hoist"
            className="py-3"
          >
            {toggle}
          </PermissionRow>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    )
  }
  return (
    <div className="border-line-hairline bg-surface-raised/50 border px-3.5">
      <PermissionRow
        label="Show as its own group in the member list"
        hint="Online members with this role are listed under its name."
        htmlFor="role-hoist"
      >
        {toggle}
      </PermissionRow>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
