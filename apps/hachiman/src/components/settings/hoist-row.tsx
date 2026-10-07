import type { Role } from '@hachiman/client'
import { ErrorText } from '@/components/ui/field'
import { PermissionRow } from '@/components/ui/permission-row'
import { Switch } from '@/components/ui/switch'
import { useAction } from '@/hooks/use-action'
import { adminActionService } from '@/services/AdminActionService'

/**
 * "Show as its own group in the member list" (G2, feature plan N15). Saves at once with a
 * role PATCH of `hoist` only: no signed admin action (§12.16). The role event updates the store.
 */
export function HoistRow({ role, editable }: { role: Role; editable: boolean }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <div>
      <PermissionRow
        label="Show as its own group in the member list"
        hint="Online members with this role are listed under its name."
        htmlFor="role-hoist"
      >
        <Switch
          id="role-hoist"
          checked={role.hoist}
          disabled={!editable || busy}
          onCheckedChange={(hoist) =>
            void run('change the member list group', () =>
              adminActionService.updateRole(role.guildId, role.id, { hoist })
            )
          }
        />
      </PermissionRow>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
