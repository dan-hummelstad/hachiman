import Link from 'next/link'
import { ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'

import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  redeemInviteToUri,
} from '@/lib/invite-signing'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

interface PageProps {
  params: Promise<{ code: string }>
}

export const dynamic = 'force-dynamic'

type RedemptionResult =
  | {
      ok: true
      joinUri: string
      server: {
        slug: string
        name: string
        verifiedAt: Date | null
        host: string
        port: number
      }
    }
  | { ok: false; status: 'not-found' | 'expired' | 'exhausted' | 'revoked'; message: string }

async function redeem(code: string): Promise<RedemptionResult> {
  try {
    const { joinUri, server } = await redeemInviteToUri(code)
    return {
      ok: true,
      joinUri,
      server: {
        slug: server.slug,
        name: server.name,
        verifiedAt: server.verifiedAt,
        host: server.host,
        port: server.port,
      },
    }
  } catch (err) {
    if (err instanceof InviteNotFoundError) {
      return { ok: false, status: 'not-found', message: 'Invite not found.' }
    }
    if (err instanceof InviteExpiredError) {
      return { ok: false, status: 'expired', message: 'This invite has expired.' }
    }
    if (err instanceof InviteRevokedError) {
      return { ok: false, status: 'revoked', message: 'This invite has been revoked.' }
    }
    if (err instanceof InviteExhaustedError) {
      return {
        ok: false,
        status: 'exhausted',
        message: 'This invite has reached its maximum number of uses.',
      }
    }
    throw err
  }
}

export default async function InvitePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { code } = await params
  const result = await redeem(code)

  if (!result.ok) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invite unavailable</CardTitle>
            <CardDescription>
              We couldn&apos;t redeem the code{' '}
              <code className="font-mono">{code}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>{titleFor(result.status)}</AlertTitle>
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter>
            <Button asChild variant="outline">
              <Link href="/">Back to Takusen</Link>
            </Button>
          </CardFooter>
        </Card>
      </main>
    )
  }

  const { server, joinUri } = result

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {server.name}
            {server.verifiedAt ? (
              <Badge variant="secondary">
                <ShieldCheckIcon /> Verified
              </Badge>
            ) : (
              <Badge variant="outline">
                <ShieldOffIcon /> Unverified
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            You&apos;ve been invited to join this Mumble server.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Host</span>
            <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {server.host}:{server.port}
            </code>
          </div>
          {!server.verifiedAt ? (
            <Alert variant="destructive">
              <AlertTitle>Domain not verified</AlertTitle>
              <AlertDescription>
                The owner of this server hasn&apos;t proven control of the host
                domain. Proceed only if you trust the source of this invite.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-col gap-3 sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link href="/">Cancel</Link>
          </Button>
          <Button asChild>
            <a href={joinUri}>Join {server.name}</a>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}

function titleFor(status: 'not-found' | 'expired' | 'exhausted' | 'revoked'): string {
  switch (status) {
    case 'not-found':
      return 'Not found'
    case 'expired':
      return 'Expired'
    case 'exhausted':
      return 'Out of uses'
    case 'revoked':
      return 'Revoked'
  }
}
