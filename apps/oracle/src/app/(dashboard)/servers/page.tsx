import Link from 'next/link'
import { ArrowRightIcon, PlusIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'

import { requireUser } from '@/lib/auth-helpers'
import { listRegions, listServersByOwner } from '@/lib/servers'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { NewServerDialog } from './_components/new-server-dialog'

export const dynamic = 'force-dynamic'

export default async function ServersPage(): Promise<React.JSX.Element> {
  const session = await requireUser()
  const [servers, regions] = await Promise.all([
    listServersByOwner(session.user.id),
    listRegions(),
  ])
  const regionOptions = regions.map((r) => ({ code: r.code, displayName: r.displayName }))
  const regionLabel = (code: string | null): string =>
    code ? (regions.find((r) => r.code === code)?.displayName ?? code) : '—'

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your servers</h1>
          <p className="text-sm text-muted-foreground">
            Mumble servers you have registered with Takusen.
          </p>
        </div>
        <NewServerDialog regions={regionOptions} />
      </div>

      {servers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No servers yet</CardTitle>
            <CardDescription>
              Register a Mumble server to make it discoverable on Takusen.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewServerDialog
              regions={regionOptions}
              trigger={
                <Button>
                  <PlusIcon /> Register your first server
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell className="pl-6 font-medium">{server.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {server.slug}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {server.host}:{server.port}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {regionLabel(server.region)}
                    </TableCell>
                    <TableCell>
                      {server.verifiedAt ? (
                        <Badge variant="secondary">
                          <ShieldCheckIcon /> Verified
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          <ShieldOffIcon /> Unverified
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/servers/${server.id}`}>
                          Manage <ArrowRightIcon />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
