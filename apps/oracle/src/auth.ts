/**
 * Auth.js v5 entry point.
 *
 * Wires the Drizzle adapter + a Credentials provider that verifies an email
 * and password against `users.passwordHash` (bcrypt).
 *
 * The actual sign-up / sign-in pages are NOT implemented here — that's the
 * next phase. This file just configures the session machinery.
 */
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import bcrypt from 'bcryptjs'
import NextAuth, { type DefaultSession } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { accounts, sessions, users, verificationTokens } from '@/db/schema'
import { isSessionLive } from '@/lib/session-revocation'

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: 'user' | 'admin'
    } & DefaultSession['user']
  }
  interface User {
    role?: 'user' | 'admin'
  }
}

// We intentionally do not augment `@auth/core/jwt`'s JWT interface: the
// `role` claim is read via a narrow type cast inside the `session` callback
// so the rest of the module doesn't depend on the (transitively-installed)
// `@auth/core` package's module identity.

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt' },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const row = await db.query.users.findFirst({
          where: eq(users.email, email),
        })
        if (!row || !row.passwordHash) return null

        const ok = await bcrypt.compare(password, row.passwordHash)
        if (!ok) return null

        return {
          id: row.id,
          email: row.email,
          name: row.displayName,
          role: row.role,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const claims = token as { role?: 'user' | 'admin'; authTime?: number }
      if (user) {
        token.sub = user.id
        claims.role = user.role ?? 'user'
        claims.authTime = Date.now()
        return token
      }
      // Returning null clears the cookie (session-revocation.ts).
      if (!token.sub || !(await isSessionLive(token.sub, claims.authTime ?? 0))) return null
      return token
    },
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub
      }
      const role = (token as { role?: 'user' | 'admin' }).role
      session.user.role = role ?? 'user'
      return session
    },
  },
})
