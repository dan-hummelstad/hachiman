'use client'

import { CornerDownLeftIcon, LoaderCircleIcon, SearchIcon, type LucideIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import { adminFetch } from '@/components/admin/kit'
import { navGroup, navGroupsFor } from '@/components/dashboard-nav-items'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { AdminSearchResult } from '@/lib/admin'
import { cn } from '@/lib/utils'

interface Entry {
  key: string
  group: string
  label: string
  detail?: string
  /** Node ids and region codes are set in the mono face. */
  mono?: boolean
  icon: LucideIcon
  href: string
}

const ADMIN = navGroup('admin').items
const iconOf = (href: string): LucideIcon => ADMIN.find((i) => i.href === href)!.icon

/**
 * Admin search results link to the list page filtered by `?query=`; the list pages read
 * that parameter as their initial search.
 */
function searchEntries(r: AdminSearchResult): Entry[] {
  const q = (href: string, v: string): string => `${href}?query=${encodeURIComponent(v)}`
  return [
    ...r.users.map((u) => ({
      key: `u:${u.id}`,
      group: 'Users',
      label: u.displayName || u.email,
      detail: u.email,
      icon: iconOf('/admin/users'),
      href: q('/admin/users', u.email),
    })),
    ...r.guilds.map((g) => ({
      key: `g:${g.id}`,
      group: 'Guilds',
      label: g.name,
      detail: `${g.memberCount} members · ${g.owner.displayName || g.owner.email}`,
      icon: iconOf('/admin/guilds'),
      href: q('/admin/guilds', g.name),
    })),
    ...r.mediaNodes.map((n) => ({
      key: `n:${n.nodeId}`,
      group: 'Media nodes',
      label: n.nodeId,
      detail: n.region,
      mono: true,
      icon: iconOf('/admin/media-nodes'),
      href: q('/admin/media-nodes', n.nodeId),
    })),
    ...r.regions.map((g) => ({
      key: `r:${g.code}`,
      group: 'Regions',
      label: g.code,
      detail: g.displayName,
      mono: true,
      icon: iconOf('/admin/regions'),
      href: q('/admin/regions', g.code),
    })),
  ]
}

const EMPTY: Entry[] = []

/** ⌘K "Jump to": the dashboard pages for everyone; users, guilds, nodes and regions for admins. */
export function CommandPalette({
  open,
  onOpenChange,
  admin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  admin: boolean
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12vh] translate-y-0 gap-0 p-0 sm:max-w-[560px]"
      >
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <PaletteBody admin={admin} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/** Mounted only while the palette is open, so every open starts with an empty query. */
function PaletteBody({ admin, close }: { admin: boolean; close: () => void }): React.JSX.Element {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; entries: Entry[] } | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const term = query.trim()

  useEffect(() => {
    if (!admin || !term) return
    let live = true
    const timer = setTimeout(() => {
      adminFetch<AdminSearchResult>(`/search?query=${encodeURIComponent(term)}`).then(
        (r) => live && setFound({ query: term, entries: searchEntries(r) }),
        () => live && setFound({ query: term, entries: EMPTY }),
      )
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [admin, term])

  const entries = useMemo(() => {
    const needle = term.toLowerCase()
    const pages: Entry[] = navGroupsFor(admin ? 'admin' : 'user').flatMap((g) =>
      g.items
        .filter((i) => !needle || `${g.heading} ${i.label}`.toLowerCase().includes(needle))
        .map((i) => ({
          key: `p:${i.href}`,
          group: 'Pages',
          label: i.label,
          detail: g.heading,
          icon: i.icon,
          href: i.href,
        })),
    )
    const results = term && found?.query === term ? found.entries : EMPTY
    return [...pages, ...results]
  }, [admin, term, found])

  const loading = admin && term !== '' && found?.query !== term

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (entry: Entry | undefined): void => {
    if (!entry) return
    close()
    router.push(entry.href)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (entries.length ? (i + step + entries.length) % entries.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(entries[active])
    }
  }

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex h-[52px] items-center gap-2.5 border-b border-line-hairline px-4">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          placeholder={admin ? 'Jump to user, guild, node…' : 'Jump to…'}
          aria-label="Jump to"
          aria-controls="command-palette-list"
          aria-activedescendant={entries[active] ? `cmd-${entries[active].key}` : undefined}
          role="combobox"
          aria-expanded
          className="min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:text-text-tertiary"
        />
        {loading && <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-text-tertiary" />}
      </div>
      <div
        ref={listRef}
        id="command-palette-list"
        role="listbox"
        aria-label="Results"
        className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
      >
        {entries.length === 0 && !loading && (
          <p className="px-3 py-6 text-center text-sm text-text-tertiary">Nothing matches “{term}”.</p>
        )}
        {entries.map((entry, i) => {
          const Icon = entry.icon
          return (
            <div key={entry.key}>
              {entry.group !== entries[i - 1]?.group && (
                <div className="section-label px-3 pt-2.5 pb-1">{entry.group}</div>
              )}
              <div
                id={`cmd-${entry.key}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => go(entry)}
                className={cn(
                  'flex h-10 cursor-pointer items-center gap-2.5 rounded-option px-3 text-sm',
                  i === active ? 'bg-surface-hover text-text-primary' : 'text-text-secondary',
                )}
              >
                <Icon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
                <span className={cn('truncate font-bold', entry.mono && 'font-mono text-[13px]')}>
                  {entry.label}
                </span>
                {entry.detail && (
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-tertiary">
                    {entry.detail}
                  </span>
                )}
                {i === active && (
                  <CornerDownLeftIcon aria-hidden className="ml-auto size-3.5 shrink-0 text-text-tertiary" />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
