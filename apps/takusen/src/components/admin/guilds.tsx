'use client'

import { useState } from 'react'

import type { AdminGuild } from '@/lib/admin'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { adminFetch, ConfirmAction, formatDate, ListFrame, SearchBox, usePagedList } from './kit'

export function AdminGuildsView(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const list = usePagedList<AdminGuild>('/guilds', query)

  return (
    <div className="flex flex-col gap-4">
      <SearchBox label="Search by guild name" onSearch={setQuery} />
      <ListFrame
        error={list.error}
        empty={query ? 'No guilds match.' : 'No guilds yet.'}
        isEmpty={list.items.length === 0}
        loading={list.loading}
        more={list.more}
        onMore={list.loadMore}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Guild</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((g) => (
              <TableRow key={g.id}>
                <TableCell className="font-medium">{g.name}</TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{g.owner.displayName}</span>
                    <span className="text-xs text-muted-foreground">{g.owner.email}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{g.memberCount}</TableCell>
                <TableCell className="text-muted-foreground">{g.region ?? 'Automatic'}</TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(g.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <ConfirmAction
                    destructive
                    label="Delete"
                    title={`Delete ${g.name}?`}
                    body={`This deletes the guild for all ${g.memberCount} members: its channels, messages and uploads. You cannot undo this.`}
                    confirmLabel="Delete guild"
                    done="Guild deleted."
                    action={() => adminFetch(`/guilds/${g.id}`, { method: 'DELETE' })}
                    onDone={list.reload}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListFrame>
    </div>
  )
}
