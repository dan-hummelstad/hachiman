/** One permission line in a settings list: label + hint on the left, the control on the right. */
export function PermissionRow({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint: string
  /** The control's id; makes the label text clickable (e.g. for a Switch). */
  htmlFor?: string
  /** The control (Switch, tri-state toggle…). */
  children: React.ReactNode
}): React.JSX.Element {
  const text = (
    <>
      <span className="text-sm">{label}</span>
      <span className="text-muted-foreground text-xs leading-4">{hint}</span>
    </>
  )
  return (
    <div className="flex items-center gap-4 py-2.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="grid flex-1 cursor-pointer">
          {text}
        </label>
      ) : (
        <span className="grid flex-1">{text}</span>
      )}
      {children}
    </div>
  )
}
