'use client'

import { GlobeIcon, InfoIcon, KeySquareIcon, LaptopIcon, LinkIcon, MonitorIcon, type LucideIcon } from 'lucide-react'

import type { AdminOidcClient } from '@/lib/admin'
import { redirectUriKind, type RedirectUriKind } from '@/lib/oidc-consent'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tag } from '@/components/ui/badge'
import { Panel } from '@/components/ui/card'
import { useAdminData } from '@/components/admin/data'
import { CopyButton } from '@/components/ui/copy-button'
import { formatDate, plural } from '@/lib/format'
import { ListFrame } from './kit'

const URI_KINDS: Record<RedirectUriKind, { label: string; icon: LucideIcon }> = {
  desktop: { label: 'Desktop app', icon: LaptopIcon },
  desktop_bridge: { label: 'Desktop bridge', icon: MonitorIcon },
  web: { label: 'Web client', icon: GlobeIcon },
  other: { label: 'Other', icon: LinkIcon },
}

/** lib/oidc-adapter.ts gives every client these; only the auth method depends on isPublic. */
const GRANT_TYPES = 'authorization_code · refresh_token'
const clientAuth = (c: AdminOidcClient): string =>
  c.isPublic ? 'none · public client with PKCE (S256)' : 'client_secret_basic'

function RedirectUri({ uri }: { uri: string }): React.JSX.Element {
  const kind = URI_KINDS[redirectUriKind(uri)]
  const Icon = kind.icon
  return (
    <li className="flex h-11 items-center gap-2.5 border border-line-hairline bg-surface-sunken pr-1.5 pl-3">
      <Icon aria-hidden className="size-[15px] shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-primary" title={uri}>
        {uri}
      </span>
      <span className="shrink-0 text-xs text-text-tertiary max-sm:hidden">{kind.label}</span>
      <CopyButton value={uri} label={`Copy ${uri}`} />
    </li>
  )
}

function ClientCard({ client: c }: { client: AdminOidcClient }): React.JSX.Element {
  return (
    <Panel aria-label={c.clientId}>
      <div className="flex flex-wrap items-center gap-4 border-b border-line-hairline p-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-mono text-lg leading-6 font-semibold text-text-primary">{c.clientId}</h2>
            <Tag tone="neutral">{c.isPublic ? 'Public' : 'Confidential'}</Tag>
            <Tag tone="info">PKCE</Tag>
          </div>
          <p className="text-[13px] text-text-tertiary">Created {formatDate(c.createdAt)}</p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-lg leading-6 font-extrabold text-text-primary tabular-nums">
            {plural(c.activeUsers, 'person', 'people')}
          </span>
          <span className="text-[12.5px] text-text-tertiary tabular-nums">
            signed in now · {plural(c.activeSessions, 'session')}
          </span>
        </div>
      </div>
      <div className="flex flex-col md:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-5 max-md:border-b md:border-r border-line-hairline">
          <h3 className="section-label">Redirect URIs</h3>
          <ul className="flex flex-col gap-2.5">
            {c.redirectUris.map((u) => (
              <RedirectUri key={u} uri={u} />
            ))}
          </ul>
        </div>
        <dl className="flex shrink-0 flex-col gap-[18px] p-5 md:w-[340px]">
          <div className="flex flex-col gap-2.5">
            <dt>
              <h3 className="section-label">Scopes</h3>
            </dt>
            <dd className="flex flex-wrap gap-1.5">
              {c.scopes.map((s) => (
                <span
                  key={s}
                  className="inline-flex h-6 items-center border border-line-hairline bg-surface-raised px-2 font-mono text-xs text-text-secondary"
                >
                  {s}
                </span>
              ))}
            </dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt>
              <h3 className="section-label">Grant types</h3>
            </dt>
            <dd className="font-mono text-[12.5px] text-text-secondary">{GRANT_TYPES}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt>
              <h3 className="section-label">Client auth</h3>
            </dt>
            <dd className="font-mono text-[12.5px] text-text-secondary">{clientAuth(c)}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  )
}

export function AdminOidcClientsView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminOidcClient[]>('/oidc-clients')
  const clients = data ?? []
  return (
    <>
      <Alert role="note" className="border-l-feature-thread [&>svg]:text-feature-thread-text">
        <InfoIcon />
        <AlertTitle>Managed by db:seed</AlertTitle>
        <AlertDescription>Clients are read only here. Change the seed and redeploy to add or edit one.</AlertDescription>
      </Alert>
      <ListFrame
        error={error}
        onRetry={reload}
        loading={data === null && !error}
        isEmpty={clients.length === 0}
        empty="No OIDC clients."
        emptyBody="`pnpm -F @hachiman/takusen db:seed` adds the Hachiman client."
        emptyIcon={KeySquareIcon}
      >
        <div className="flex flex-col gap-7">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      </ListFrame>
    </>
  )
}
