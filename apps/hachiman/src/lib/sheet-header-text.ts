import * as React from 'react'

/** The title and subtitle of a dialog header in its Sheet Header form. */
export interface SheetHeaderText {
  title: React.ReactNode
  subtitle?: React.ReactNode
}

/**
 * The title and subtitle of a header that the Sheet Header can show: one `title` element and at
 * most one `description` element (the dialog's DialogTitle and DialogDescription), and nothing
 * else. Null for any other children.
 */
export function sheetHeaderText(
  children: React.ReactNode,
  title: React.ElementType,
  description: React.ElementType
): SheetHeaderText | null {
  let text: React.ReactNode | undefined
  let subtitle: React.ReactNode | undefined
  for (const child of React.Children.toArray(children)) {
    // `{subtitle && …}` with an empty subtitle.
    if (child === '') continue
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return null
    if (child.type === title && text === undefined) text = child.props.children
    else if (child.type === description && subtitle === undefined) subtitle = child.props.children
    else return null
  }
  return text === undefined ? null : { title: text, subtitle }
}
