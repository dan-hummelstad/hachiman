import { useEffect, useState } from 'react'
import { ExternalLink, Globe, RotateCw } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import type { DocHandle } from '@/services/docs/types'
import { hostPlatform } from '@/services/hachiman'
import type { LinkResource } from '@/shared/IPlatformService'

/**
 * The address that a web tab may show: https only, never the app's own origin (a sandboxed frame
 * with scripts and the same origin could lift its sandbox). A bare host gets https://. Null for
 * anything else.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function webTabUrl(input: string, appOrigin: string): string | null {
  const text = input.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.origin === appOrigin || url.username || url.password)
    return null
  return url.href
}

/**
 * The embed form of a video link, which allows framing where the watch page does not. Null for
 * any other address.
 */
// ponytail: YouTube, Vimeo and Loom only; add a site here when its share link refuses framing.
function embedForm(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m)\./, '')
  const path = url.pathname.split('/').filter(Boolean)
  const youtube = (id: string | null | undefined): string | null =>
    id && /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null
  if (host === 'youtube.com')
    return path[0] === 'watch'
      ? youtube(url.searchParams.get('v'))
      : path[0] === 'shorts'
        ? youtube(path[1])
        : null
  if (host === 'youtu.be') return youtube(path[0])
  if (host === 'vimeo.com' && /^\d+$/.test(path[0] ?? ''))
    return `https://player.vimeo.com/video/${path[0]}`
  if (host === 'loom.com' && path[0] === 'share' && path[1])
    return `https://www.loom.com/embed/${path[1]}`
  return null
}

/** The address that the frame loads: the embed form of a known video link, else `url`. */
// eslint-disable-next-line react-refresh/only-export-components
export function frameUrl(url: string): string {
  return embedForm(new URL(url)) ?? url
}

/**
 * True when the page's headers refuse a frame in `appOrigin`. A CSP `frame-ancestors` decides when
 * one is present (browsers then ignore X-Frame-Options); else X-Frame-Options DENY or SAMEORIGIN
 * refuses (a web tab is never of the app origin).
 */
// ponytail: host-source paths and the http→https upgrade are not matched; a site that lists the app origin that way shows a warning wrongly.
// eslint-disable-next-line react-refresh/only-export-components
export function frameRefused(
  page: Pick<LinkResource, 'frameOptions' | 'csp'>,
  appOrigin: string
): boolean {
  const app = new URL(appOrigin)
  const ancestors = page.csp
    .split(',')
    .flatMap((policy) => policy.split(';'))
    .map((d) => d.trim().split(/\s+/))
    .filter(([name]) => name?.toLowerCase() === 'frame-ancestors')
  if (ancestors.length > 0)
    return ancestors.some(([, ...sources]) => !sources.some((src) => sourceMatches(src, app)))
  return page.frameOptions
    .split(',')
    .some((v) => ['deny', 'sameorigin'].includes(v.trim().toLowerCase()))
}

function sourceMatches(source: string, app: URL): boolean {
  const network = app.protocol === 'https:' || app.protocol === 'http:'
  if (source === '*') return network
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return source.toLowerCase() === app.protocol
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^:/]+)(?::(\d+|\*))?/i.exec(source)
  if (!m || source.startsWith("'")) return false
  const [, scheme, host, port] = m
  if (scheme ? `${scheme.toLowerCase()}:` !== app.protocol : !network) return false
  const h = host!.toLowerCase()
  const hostOk =
    h === '*' || (h.startsWith('*.') ? app.hostname.endsWith(h.slice(1)) : h === app.hostname)
  return hostOk && (port === '*' || (port ?? '') === app.port)
}

/** The page refuses to show in a frame, by its headers. False while unknown and on a host that cannot fetch (browser). */
function useFrameRefused(src: string | null): boolean {
  const [refused, setRefused] = useState<string | null>(null)
  useEffect(() => {
    const fetchPage = hostPlatform()?.fetchLinkResource
    if (!src || !fetchPage) return
    let live = true
    // The frame loads the page from this device anyway: this GET (no cookies) tells the site nothing more.
    fetchPage(src, FRAME_CHECK_MAX_BYTES)
      .then((page) => {
        if (live && page && frameRefused(page, window.location.origin)) setRefused(src)
      })
      .catch((e: unknown) =>
        // The name only: the address is channel content.
        console.warn('[web-tab] frame check failed', e instanceof Error ? e.name : typeof e)
      )
    return () => {
      live = false
    }
  }, [src])
  return src !== null && refused === src
}

/** The host stops an HTML read after `</head>`, so this only bounds a page with a huge head. */
const FRAME_CHECK_MAX_BYTES = 2 * 1024 * 1024

/**
 * One tab of a web channel: the address bar and the page in a sandboxed frame. The address is the
 * `web` Y.Map of the tab's encrypted doc, so every viewer loads the same page in their own frame:
 * nothing loads it on a server. A known link loads in its embed form (frameUrl). A navigation inside the frame stays local (the frame is of another
 * origin, so the app cannot read it): set the address to move everyone.
 */
// ponytail: the address syncs, not the scroll or clicks inside the frame; a viewer can share their screen in voice for that.
export function WebView({
  handle,
  canEdit
}: {
  handle: DocHandle
  canEdit: boolean
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const url = useWebUrl(handle)
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [reloads, setReloads] = useState(0)
  const src = url && frameUrl(url)
  const refused = useFrameRefused(src)

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const next = webTabUrl(draft ?? '', window.location.origin)
    if (next === null) return setInvalid(true)
    handle.doc.getMap<string>('web').set('url', next)
    setDraft(null)
    setInvalid(false)
  }

  return (
    <div data-swipe-ignore className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Input
          size={mobile ? 'touch' : 'default'}
          aria-label="Address"
          aria-invalid={invalid}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={canEdit ? 'Type an https address for everyone' : 'No page yet'}
          readOnly={!canEdit}
          value={draft ?? url ?? ''}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={() => setDraft(null)}
          className={cn('min-w-0 flex-1', invalid && 'border-you-text')}
        />
        {url && (
          <>
            <IconButton
              label="Reload"
              tooltipSide="bottom"
              onClick={() => setReloads((n) => n + 1)}
            >
              <RotateCw />
            </IconButton>
            <IconButton
              label="Open in browser"
              tooltipSide="bottom"
              onClick={() => openExternal(url)}
            >
              <ExternalLink />
            </IconButton>
          </>
        )}
      </form>
      {url && refused && (
        <Callout
          tone="caution"
          className="mx-2 mb-1.5 shrink-0"
          title="This site does not allow other apps to show it"
          action={{ label: 'Open in browser', onClick: () => openExternal(url) }}
        >
          It shows only in a browser.
        </Callout>
      )}
      {url ? (
        <iframe
          key={`${url} ${reloads}`}
          title="Shared web page"
          src={src ?? undefined}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
          allow="fullscreen; autoplay; encrypted-media; picture-in-picture"
          // The video players refuse to play without a referrer (YouTube error 153): they get the
          // app origin only. Any other page gets none.
          referrerPolicy={src === url ? 'no-referrer' : 'strict-origin'}
        />
      ) : (
        <div className="text-text-tertiary flex flex-1 flex-col items-center justify-center gap-2 text-sm">
          <Globe className="size-8" aria-hidden />
          {canEdit ? 'Type an address above. Everyone here sees the same page.' : 'No page yet.'}
        </div>
      )}
      {url && !refused && !hostPlatform()?.fetchLinkResource && (
        <p className="text-text-tertiary shrink-0 px-3 py-1 text-xs">
          Some sites do not allow other apps to show them. Use Open in browser for those.
        </p>
      )}
    </div>
  )
}

const openExternal = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** The address of the tab, live from its doc. A value that is not a valid address shows nothing. */
function useWebUrl(handle: DocHandle): string | null {
  const read = (): string | null => {
    const v = handle.doc.getMap<unknown>('web').get('url')
    return typeof v === 'string' ? webTabUrl(v, window.location.origin) : null
  }
  const [url, setUrl] = useState(read)
  useEffect(() => {
    const map = handle.doc.getMap<unknown>('web')
    const update = (): void => setUrl(read())
    map.observe(update)
    update()
    return () => map.unobserve(update)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle])
  return url
}
