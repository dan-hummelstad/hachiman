import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeftIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'

import { requireUser } from '@/lib/auth-helpers'
import {
  assertOwner,
  getServerById,
  listInvitesForServer,
} from '@/lib/servers'
import { getActiveVerification, dnsVerificationHostname } from '@/lib/dns-verify'
import { getOidcClientForServer } from '@/lib/oidc-client-admin'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { EditServerForm } from './_components/edit-server-form'
import { VerifyDomainPanel } from './_components/verify-domain-panel'
import { InvitesPanel } from './_components/invites-panel'
import { OidcClientPanel } from './_components/oidc-client-panel'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ServerDetailPage({ params }: PageProps): Promise<React.JSX.Element> {
  const session = await requireUser()
  const { id } = await params

  try {
    await assertOwner(id, session.user.id)
  } catch {
    notFound()
  }

  const [server, verification, invites, oidcClient] = await Promise.all([
    getServerById(id),
    getActiveVerification(id),
    listInvitesForServer(id),
    getOidcClientForServer(id),
  ])

  if (!server) notFound()

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2">
          <Link href="/servers">
            <ArrowLeftIcon /> Back to servers
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
          {server.verifiedAt ? (
            <Badge variant="secondary">
              <ShieldCheckIcon /> Verified
            </Badge>
          ) : (
            <Badge variant="outline">
              <ShieldOffIcon /> Unverified
            </Badge>
          )}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {server.host}:{server.port} · slug <span className="text-foreground">{server.slug}</span>
        </p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="verify">Domain</TabsTrigger>
          <TabsTrigger value="invites">Invites</TabsTrigger>
          <TabsTrigger value="oidc">OIDC client</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
              <CardDescription>
                Edit the name and description. Host and slug are immutable once
                created.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EditServerForm
                serverId={server.id}
                name={server.name}
                description={server.description}
                host={server.host}
                port={server.port}
                slug={server.slug}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="verify">
          <VerifyDomainPanel
            serverId={server.id}
            host={server.host}
            initialVerification={
              verification
                ? {
                    txtRecord: dnsVerificationHostname(verification.domain),
                    txtValue: verification.txtToken,
                    verifiedAt: verification.verifiedAt?.toISOString() ?? null,
                    lastCheckedAt: verification.lastCheckedAt?.toISOString() ?? null,
                  }
                : null
            }
          />
        </TabsContent>

        <TabsContent value="invites">
          <InvitesPanel
            serverId={server.id}
            initialInvites={invites.map((i) => ({
              id: i.id,
              code: i.code,
              createdAt: i.createdAt.toISOString(),
              expiresAt: i.expiresAt?.toISOString() ?? null,
              maxUses: i.maxUses,
              useCount: i.useCount,
              revoked: i.revoked,
            }))}
          />
        </TabsContent>

        <TabsContent value="oidc">
          <OidcClientPanel
            serverId={server.id}
            initialClient={
              oidcClient
                ? {
                    clientId: oidcClient.clientId,
                    redirectUris: oidcClient.redirectUris,
                    scopes: oidcClient.scopes,
                  }
                : null
            }
          />
        </TabsContent>
      </Tabs>
    </main>
  )
}
