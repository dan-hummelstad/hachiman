import { useState } from 'react'
import type { SettingsGroup, SettingsSection } from '@/components/settings/settings-layout'

export const isVisible = <S extends string>(s: SettingsSection<S>): boolean => s.visible !== false

/**
 * The selected section of `groups`, remembered per `scope` (e.g. the guild id): switching scope,
 * or losing the permission behind the picked section, falls back to the first visible one.
 */
export function useSettingsSection<S extends string>(
  groups: SettingsGroup<S>[],
  scope: string | null
): [S, (id: S) => void] {
  const [picked, setPicked] = useState<{ scope: string | null; id: S } | null>(null)
  const visible = groups.flatMap((g) => g.sections).filter(isVisible)
  const section =
    picked && picked.scope === scope && visible.some((s) => s.id === picked.id)
      ? picked.id
      : visible[0].id
  return [section, (id) => setPicked({ scope, id })]
}
