'use client'

import { KeyRoundIcon, LogOutIcon, ShieldMinusIcon, ShieldPlusIcon, Trash2Icon, UsersRoundIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { EntityAvatar } from '@/components/ui/avatar'
import { Tag } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fileUrl } from '@/lib/file-url'
import type { AdminCounts, AdminUser } from '@/lib/admin'
import { adminFetch, useAdminData, useCursorPages, withParams } from '@/components/admin/data'
import { Dot } from '@/components/ui/meter'
import { formatDate, plural } from '@/lib/format'
import {
  FilterChips,
  IdentityCell,
  ListFrame,
  Pagination,
  RowMenu,
  useFilterParam,
  useSearchParamState,
  type RowMenuItem,
} from './kit'

const FILTERS = ['all', 'admins', 'signed_in', 'unverified'] as const
type Filter = (typeof FILTERS)[number]

const PAGE_SIZE = 25
/** Admins are few; they come first on page one in a single request. */
const ADMINS_MAX = 100
const NO_USERS: AdminUser[] = []

const EMPTY_COPY: Record<Filter, string> = {
  all: 'No users yet.',
  admins: 'No admins.',
  signed_in: 'Nobody is signed in to Hachiman right now.',
  unverified: 'Every account has a verified email.',
}

/**
 * F2: every account, admins first. Search (`?query=`) lives in the page head; the chips set
 * `?filter=`. The API pages newest first by keyset, so admins come from their own request and
 * the users after them page with Previous / Next.
 */
export function AdminUsersView({
  meId,
  counts,
}: {
  meId: string
  counts: Pick<AdminCounts, 'users' | 'admins' | 'signedInUsers' | 'unverifiedUsers'>
}): React.JSX.Element {
  const router = useRouter()
  const [query] = useSearchParamState('query')
  const [filter, setFilter] = useFilterParam(FILTERS)
  const apiFilter = filter === 'signed_in' || filter === 'unverified' ? filter : undefined

  const users = useCursorPages<AdminUser>('/users', {
    query,
    filter: apiFilter,
    role: filter === 'admins' ? 'admin' : 'user',
    limit: PAGE_SIZE,
  })
  // On "Admins" the paged list already is the admins.
  const admins = useAdminData<{ items: AdminUser[] }>(
    filter === 'admins' || users.page > 1
      ? null
      : withParams('/users', { query, filter: apiFilter, role: 'admin', limit: ADMINS_MAX }),
  )
  const adminRows = filter === 'admins' || users.page > 1 ? NO_USERS : (admins.data?.items ?? NO_USERS)
  const rows = [...adminRows, ...users.items]
  const loading = users.loading || admins.loading

  const changed = (): void => {
    users.reload()
    admins.reload()
    // Chip counts and sidebar badges come from the server page.
    router.refresh()
  }

  const total = { all: counts.users, admins: counts.admins, signed_in: counts.signedInUsers, unverified: counts.unverifiedUsers }[filter]
  const shown = adminRows.length + (users.page - 1) * PAGE_SIZE + users.items.length
  const summary = rows.length === 0 ? null : (
    <>
      Showing {shown}
      {!query && ` of ${total}`}
      {filter !== 'admins' && ' · admins first'}
    </>
  )

  return (
    <div className="flex flex-col gap-3.5">
      <FilterChips
        label="Filter users"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All', count: counts.users },
          { value: 'admins', label: 'Admins', count: counts.admins },
          { value: 'signed_in', label: 'Signed in now', count: counts.signedInUsers },
          { value: 'unverified', label: 'Unverified', count: counts.unverifiedUsers },
        ]}
      />
      <ListFrame
        error={users.error ?? admins.error}
        onRetry={changed}
        empty={query ? `No users match “${query}”.` : EMPTY_COPY[filter]}
        emptyIcon={UsersRoundIcon}
        isEmpty={rows.length === 0}
        loading={loading}
        footer={
          <Pagination
            summary={summary}
            page={users.page}
            hasPrev={users.hasPrev}
            hasNext={users.hasNext}
            onPrev={users.prev}
            onNext={users.next}
          />
        }
      >
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="w-[146px] max-md:hidden">Role</TableHead>
              <TableHead className="w-[124px] sm:w-[166px]">Sessions</TableHead>
              <TableHead className="w-[156px] max-lg:hidden">Joined</TableHead>
              <TableHead className="w-[56px] sm:w-[64px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => (
              <UserRow key={u.id} user={u} self={u.id === meId} onChange={changed} />
            ))}
          </TableBody>
        </Table>
      </ListFrame>
    </div>
  )
}

function UserRow({
  user: u,
  self,
  onChange,
}: {
  user: AdminUser
  self: boolean
  onChange: () => void
}): React.JSX.Element {
  return (
    <TableRow>
      <TableCell>
        <IdentityCell
          avatar={<EntityAvatar src={fileUrl(u.avatar)} name={u.displayName} email={u.email} />}
          name={u.displayName}
          tags={
            <>
              {self && <Tag>You</Tag>}
              {!u.emailVerified && <Tag>Unverified</Tag>}
            </>
          }
          sub={u.email}
        />
      </TableCell>
      <TableCell className="max-md:hidden">
        {u.role === 'admin' ? <Tag tone="gold">Admin</Tag> : <span className="text-text-tertiary">User</span>}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2.5">
          <Dot tone={u.activeSessions > 0 ? 'online' : 'offline'} />
          {u.activeSessions > 0 ? (
            <span className="text-text-secondary">{u.activeSessions} active</span>
          ) : (
            <span className="text-text-tertiary">Signed out</span>
          )}
        </span>
      </TableCell>
      <TableCell className="text-[13.5px] text-text-tertiary tabular-nums max-lg:hidden">
        {formatDate(u.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <RowMenu label={`Actions for ${u.displayName}`} items={userActions(u, self, onChange)} />
      </TableCell>
    </TableRow>
  )
}

/** The API refuses self-demotion, self-delete and removing the last admin (409); the menu hides the first two. */
function userActions(u: AdminUser, self: boolean, onChange: () => void): RowMenuItem[] {
  const items: RowMenuItem[] = []
  if (!self) {
    const promote = u.role !== 'admin'
    items.push({
      label: promote ? 'Make admin' : 'Remove admin',
      icon: promote ? ShieldPlusIcon : ShieldMinusIcon,
      confirm: {
        title: promote ? `Make ${u.displayName} an admin?` : `Remove admin from ${u.displayName}?`,
        body: promote
          ? 'Admins can manage every user, guild and media node in this deployment.'
          : 'They keep their account but lose access to the admin pages.',
        confirmLabel: promote ? 'Make admin' : 'Remove admin',
        done: 'Role changed.',
        action: () =>
          adminFetch(`/users/${u.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ role: promote ? 'admin' : 'user' }),
          }),
        onDone: onChange,
      },
    })
  }
  items.push(
    {
      label: u.activeSessions > 0 ? `Sign out of ${plural(u.activeSessions, 'session')}` : 'Sign out',
      icon: LogOutIcon,
      confirm: {
        title: `Sign ${u.displayName} out?`,
        body: 'Ends their dashboard session and every app sign-in. Open app connections stay up until they reconnect.',
        confirmLabel: 'Sign out',
        done: `${u.displayName} is signed out.`,
        action: () => adminFetch(`/users/${u.id}/sign-out`, { method: 'POST' }),
        onDone: onChange,
      },
    },
    {
      label: 'Reset encryption keys',
      icon: KeyRoundIcon,
      confirm: {
        title: `Reset the encryption keys of ${u.displayName}?`,
        body: 'For a user who has no device to link from and no recovery key. This signs out and removes all of their devices. At the next sign-in they restore with the recovery key or make new keys. With new keys, they cannot read their old messages. The account and its guilds stay.',
        confirmLabel: 'Reset keys',
        confirmIcon: KeyRoundIcon,
        destructive: true,
        done: `The keys of ${u.displayName} are reset.`,
        action: () => adminFetch(`/users/${u.id}/reset-keys`, { method: 'POST' }),
        onDone: onChange,
      },
    },
  )
  if (!self) {
    items.push({
      label: 'Delete account',
      icon: Trash2Icon,
      destructive: true,
      confirm: {
        title: `Delete ${u.displayName}?`,
        body: (
          <>
            This deletes the account <span className="font-mono text-text-primary">{u.email}</span>, the guilds
            they own, their messages and their uploads. There is no undo.
          </>
        ),
        confirmLabel: 'Delete account',
        confirmIcon: Trash2Icon,
        destructive: true,
        done: 'Account deleted.',
        action: () => adminFetch(`/users/${u.id}`, { method: 'DELETE' }),
        onDone: onChange,
      },
    })
  }
  return items
}
