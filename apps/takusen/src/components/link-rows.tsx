import Link from 'next/link'

import type { NavItem } from '@/components/dashboard-nav-items'
import { Button } from '@/components/ui/button'

/** A bordered list of pages: label + description on the left, an "Open" button on the right. */
export function LinkRows({ items }: { items: NavItem[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col border">
      {items.map((item) => (
        <li
          key={item.href}
          className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0"
        >
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">{item.label}</span>
            {item.description && (
              <span className="text-sm text-muted-foreground">{item.description}</span>
            )}
          </div>
          <Button asChild variant="outline">
            <Link href={item.href} aria-label={`Open ${item.label.toLowerCase()}`}>
              Open
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  )
}
