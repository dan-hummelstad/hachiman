'use client'

import { useState } from 'react'

import type { AdminUser } from '@/lib/admin'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { adminFetch, ConfirmAction, formatDate, ListFrame, SearchBox, usePagedList } from './kit'

export function AdminUsersView({ meId }: { meId: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const list = usePagedList<AdminUser>('/users', query)

  return (
    <div className="flex flex-col gap-4">
      <SearchBox label="Search by email or name" onSearch={setQuery} />
      <ListFrame
        error={list.error}
        empty={query ? 'No users match.' : 'No users yet.'}
        isEmpty={list.items.length === 0}
        loading={list.loading}
        more={list.more}
        onMore={list.loadMore}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((u) => (
              <UserRow key={u.id} user={u} self={u.id === meId} onChange={list.reload} />
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
  const nextRole = u.role === 'admin' ? 'user' : 'admin'
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">
            {u.displayName}
            {self && <span className="text-muted-foreground"> (you)</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {u.email}
            {!u.emailVerified && ' · unverified'}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {u.role === 'admin' ? <span className="font-medium text-primary">Admin</span> : 'User'}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        {formatDate(u.createdAt)}
      </TableCell>
      <TableCell>
        {/* The API refuses self-demotion, self-delete and removing the last admin (409). */}
        <div className="flex justify-end gap-1.5">
          {!self && (
            <ConfirmAction
              label={nextRole === 'admin' ? 'Make admin' : 'Remove admin'}
              title={nextRole === 'admin' ? `Make ${u.displayName} an admin?` : `Remove admin from ${u.displayName}?`}
              body={
                nextRole === 'admin'
                  ? 'Admins can manage every user, guild and media node in this deployment.'
                  : 'They keep their account but lose access to the admin pages.'
              }
              confirmLabel={nextRole === 'admin' ? 'Make admin' : 'Remove admin'}
              done="Role changed."
              action={() =>
                adminFetch(`/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) })
              }
              onDone={onChange}
            />
          )}
          <ConfirmAction
            label="Sign out"
            title={`Sign ${u.displayName} out?`}
            body="Ends their dashboard session and every app sign-in. Open app connections stay up until they reconnect."
            confirmLabel="Sign out"
            done={`${u.displayName} is signed out.`}
            action={() => adminFetch(`/users/${u.id}/sign-out`, { method: 'POST' })}
          />
          <ConfirmAction
            destructive
            label="Reset keys"
            title={`Reset the security keys of ${u.displayName}?`}
            body="For a user who has no device to link from and no recovery key. This signs out and removes all of their devices. At the next sign-in they restore with the recovery key or make new keys. With new keys, they cannot read their old messages. The account and its guilds stay."
            confirmLabel="Reset keys"
            done={`The keys of ${u.displayName} are reset.`}
            action={() => adminFetch(`/users/${u.id}/reset-keys`, { method: 'POST' })}
          />
          {!self && (
            <ConfirmAction
              destructive
              label="Delete"
              title={`Delete ${u.displayName}?`}
              body={
                <>
                  This deletes the account <span className="font-mono">{u.email}</span>, the
                  guilds they own, their messages and their uploads. You cannot undo this.
                </>
              }
              confirmLabel="Delete user"
              done="User deleted."
              action={() => adminFetch(`/users/${u.id}`, { method: 'DELETE' })}
              onDone={onChange}
            />
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}
