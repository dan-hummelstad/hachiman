import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/auth-helpers'

export const dynamic = 'force-dynamic'

// The admin landing today is the islands overview; redirect there. As more
// admin surfaces are added this can become a real index page.
export default async function AdminPage(): Promise<never> {
  await requireUser({ role: 'admin' })
  redirect('/admin/islands')
}
