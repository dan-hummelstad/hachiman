"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Colours come from the theme tokens (which follow the `dark` class on <html>), so the
// toaster itself stays theme-agnostic. Square corners + hard shadow: see globals.css.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-status-online" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-gold" />,
        error: <OctagonXIcon className="size-4 text-feature-danger" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--surface-raised)",
          "--normal-text": "var(--text-primary)",
          "--normal-border": "var(--line-hairline)",
          "--border-radius": "0",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
