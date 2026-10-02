'use client'

import type { AdminOidcClient } from '@/lib/admin'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, ListFrame, useAdminData } from './kit'

export function AdminOidcClientsView(): React.JSX.Element {
  const { data, error } = useAdminData<AdminOidcClient[]>('/oidc-clients')
  const clients = data ?? []
  return (
    <ListFrame
      error={error}
      empty="No OIDC clients. `pnpm -F @hachiman/takusen db:seed` adds the Hachiman client."
      isEmpty={clients.length === 0}
      loading={data === null && !error}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client ID</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Redirect URIs</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono text-[13px] align-top">{c.clientId}</TableCell>
              <TableCell className="align-top">{c.isPublic ? 'Public (PKCE)' : 'Confidential'}</TableCell>
              <TableCell className="align-top">
                <ul className="font-mono text-xs leading-5">
                  {c.redirectUris.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </TableCell>
              <TableCell className="align-top text-xs">{c.scopes.join(' ')}</TableCell>
              <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                {formatDate(c.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ListFrame>
  )
}
