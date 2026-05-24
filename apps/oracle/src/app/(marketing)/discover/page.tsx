import { ShieldCheckIcon } from 'lucide-react'

import { listPublicServers } from '@/lib/servers'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TakusenLogo } from '@/components/takusen-logo'

import { SearchForm } from './_components/search-form'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>
}

const PAGE_SIZE = 24

export default async function PublicServersPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const { q, page } = await searchParams
  const pageNum = Math.max(Number.parseInt(page ?? '1', 10) || 1, 1)
  const offset = (pageNum - 1) * PAGE_SIZE

  const { servers, total } = await listPublicServers({
    search: q,
    limit: PAGE_SIZE,
    offset,
  })

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1)

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-2">
        <TakusenLogo />
        <h1 className="text-3xl font-semibold tracking-tight">Public servers</h1>
        <p className="text-sm text-muted-foreground">
          Verified Mumble servers registered with Takusen. Browse or search by
          name.
        </p>
      </header>

      <SearchForm initialQuery={q ?? ''} />

      {servers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No matches</CardTitle>
            <CardDescription>
              {q
                ? `No verified servers matched "${q}".`
                : 'No verified servers are registered yet.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => (
            <Card key={server.slug}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {server.name}
                  <Badge variant="secondary">
                    <ShieldCheckIcon /> Verified
                  </Badge>
                </CardTitle>
                <CardDescription>
                  <code className="font-mono text-xs text-muted-foreground">
                    /{server.slug}
                  </code>
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {server.description ? (
                  <p className="line-clamp-3 text-sm text-foreground/80">
                    {server.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No description.
                  </p>
                )}
                <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {server.host}:{server.port}
                </code>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <p className="text-center text-xs text-muted-foreground">
          Page {pageNum} of {totalPages} · {total} verified server
          {total === 1 ? '' : 's'}
        </p>
      ) : null}
    </main>
  )
}
