'use client'

/**
 * `/join` landing page for signed-payload invite URLs.
 *
 * Both the dashboard's short `/i/<code>` invite (after preview redirects
 * here) and direct `https://<oracle>/join#<payload>` paste land on this
 * page. The signed payload lives in the URL fragment, so the server never
 * sees it — we read it client-side, attempt to wake an installed Hachiman
 * via the legacy `takusen://join#<hash>` deep link, and surface manual
 * fallbacks for users who don't have the app installed.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface JoinPayload {
  v: 1
  serverId: string
  host: string
  port: number
  name: string
  slug: string
  verifiedAt: string | null
  sig: string
}

type ParseResult =
  | { ok: true; payload: JoinPayload; hash: string }
  | { ok: false; reason: string }

function base64UrlDecodeToString(s: string): string | null {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  try {
    const binary = atob(padded + padding)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function isJoinPayload(value: unknown): value is JoinPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    typeof v.serverId === 'string' &&
    typeof v.host === 'string' &&
    typeof v.port === 'number' &&
    typeof v.name === 'string' &&
    typeof v.slug === 'string' &&
    (v.verifiedAt === null || typeof v.verifiedAt === 'string') &&
    typeof v.sig === 'string'
  )
}

function parseHash(rawHash: string): ParseResult {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  if (!hash) return { ok: false, reason: 'Missing invite payload in URL fragment' }
  const json = base64UrlDecodeToString(hash)
  if (json === null) return { ok: false, reason: 'Malformed invite payload (bad base64url)' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'Malformed invite payload (not JSON)' }
  }
  if (!isJoinPayload(parsed)) {
    return { ok: false, reason: 'Invite payload does not match the v1 shape' }
  }
  return { ok: true, payload: parsed, hash }
}

export default function JoinPage(): React.JSX.Element {
  // Start in a loading state — we can't read the fragment until the browser
  // has mounted. The server-render path therefore always sees this state,
  // which is fine because the hash never reaches the server anyway.
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [deepLinkTriggered, setDeepLinkTriggered] = useState(false)

  useEffect(() => {
    setParsed(parseHash(window.location.hash))
  }, [])

  // Auto-attempt the deep link once on mount AFTER we've successfully
  // parsed the payload. On a system with Hachiman installed this hands off
  // immediately; on one without, the browser silently swallows the
  // `takusen://` navigation and we stay on this page showing the manual
  // fallbacks.
  useEffect(() => {
    if (!parsed?.ok || deepLinkTriggered) return
    setDeepLinkTriggered(true)
    window.location.href = `takusen://join#${parsed.hash}`
  }, [parsed, deepLinkTriggered])

  const deepLinkHref = useMemo(
    () => (parsed?.ok ? `takusen://join#${parsed.hash}` : null),
    [parsed],
  )

  if (parsed === null) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Loading invite…</CardTitle>
          </CardHeader>
        </Card>
      </main>
    )
  }

  if (!parsed.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invite link is invalid</CardTitle>
            <CardDescription>{parsed.reason}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="outline">
              <Link href="/">Back to Takusen</Link>
            </Button>
          </CardFooter>
        </Card>
      </main>
    )
  }

  const { payload } = parsed
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {payload.name}
            {payload.verifiedAt ? (
              <Badge variant="secondary">Verified</Badge>
            ) : (
              <Badge variant="outline">Unverified</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Opening Hachiman… if nothing happens, use the buttons below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Server</span>
            <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {payload.host}:{payload.port}
            </code>
          </div>
          {!payload.verifiedAt ? (
            <Alert variant="destructive">
              <AlertTitle>Domain not verified</AlertTitle>
              <AlertDescription>
                The owner of this server hasn&apos;t proven control of the host
                domain. Proceed only if you trust the source of this invite.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-col gap-2">
          {deepLinkHref ? (
            <Button asChild className="w-full">
              <a href={deepLinkHref}>Open in Hachiman</a>
            </Button>
          ) : null}
          <Button asChild variant="outline" className="w-full">
            <Link href="/">Don&apos;t have Hachiman yet?</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
