import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { ForbiddenError, requireAdmin, UnauthorizedError } from '@/lib/auth-helpers'

/**
 * Guards every admin page: dashboard cookie and role admin, the same rule as /api/admin.
 * The parent layout already sends signed-out users to /login; anyone else gets a 404, so the
 * admin pages do not reveal that they exist.
 */
export default async function AdminLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  try {
    await requireAdmin()
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) notFound()
    throw err
  }
  return children
}
