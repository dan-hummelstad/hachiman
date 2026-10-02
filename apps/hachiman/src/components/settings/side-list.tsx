/**
 * Two-pane settings body (roles, permission overrides): a sticky 192px list column on the left,
 * the editor for the selected entry on the right.
 */
export function SideList({
  aside,
  children
}: {
  /** The list column: its action button, notes and the list itself. */
  aside: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex gap-6">
      <div className="sticky top-12 flex w-48 shrink-0 flex-col gap-2 self-start">{aside}</div>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** The editor pane's heading row: title on the left, optional actions on the right. */
export function SidePaneHeader({
  children,
  actions
}: {
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-between gap-2 border-b pb-3">
      <h2 className="flex min-w-0 items-center gap-2 truncate text-[15px] leading-5 font-semibold">
        {children}
      </h2>
      {actions}
    </div>
  )
}
