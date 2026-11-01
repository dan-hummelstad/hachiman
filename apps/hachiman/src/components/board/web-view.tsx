import { useEffect, useState } from 'react'
import { ExternalLink, Globe, RotateCw } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import type { DocHandle } from '@/services/docs/types'

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
          className={cn('min-w-0 flex-1', invalid && 'border-feature-danger-text')}
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
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink />
            </IconButton>
          </>
        )}
      </form>
      {url ? (
        <iframe
          key={`${url} ${reloads}`}
          title="Shared web page"
          src={frameUrl(url)}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
          allow="fullscreen; autoplay; encrypted-media; picture-in-picture"
          // The video players refuse to play without a referrer (YouTube error 153): they get the
          // app origin only. Any other page gets none.
          referrerPolicy={frameUrl(url) === url ? 'no-referrer' : 'strict-origin'}
        />
      ) : (
        <div className="text-text-tertiary flex flex-1 flex-col items-center justify-center gap-2 text-sm">
          <Globe className="size-8" aria-hidden />
          {canEdit ? 'Type an address above. Everyone here sees the same page.' : 'No page yet.'}
        </div>
      )}
      {url && (
        <p className="text-text-tertiary shrink-0 px-3 py-1 text-xs">
          Some sites do not allow other apps to show them. Use Open in browser for those.
        </p>
      )}
    </div>
  )
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
