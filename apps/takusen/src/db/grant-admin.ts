/**
 * Makes an existing user a deployment admin. Use it to bootstrap the first
 * admin; after that, admins manage roles with PATCH /api/admin/users/:id.
 * The role applies on the user's next dashboard request (no sign-out needed).
 *
 * Invoked by `pnpm -F @hachiman/takusen admin:grant <email>`.
 */
import { eq } from 'drizzle-orm'

import { db } from './client'
import { users } from './schema'

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  if (!email) throw new Error('usage: admin:grant <email>')
  const [row] = await db
    .update(users)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id })
  if (!row) throw new Error(`no user with email ${email}; sign up first`)
  console.log(`[admin] ${email} (${row.id}) is now an admin`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[admin] grant failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
