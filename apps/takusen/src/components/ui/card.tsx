import * as React from "react"

import { cn } from "@/lib/utils"

// Containers are square: hairline border, no radius. A Card is a small content block
// (kit "Card"); a Panel is a page section with a 52px head row and an optional footer band
// (F1 "Needs attention", E1 panels). The auth card lives in components/auth-frame.tsx.

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-3 border border-line-hairline bg-surface-content p-5 text-text-primary",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-[15px] leading-5 font-extrabold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-[13.5px] leading-normal text-text-secondary", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={className} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  )
}

function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="panel"
      className={cn(
        "flex min-w-0 flex-col border border-line-hairline bg-surface-panel text-text-primary",
        className
      )}
      {...props}
    />
  )
}

/** Head row: title (15/800), optional meta (13, tertiary) after it, actions on the right. */
function PanelHeader({
  title,
  meta,
  actions,
  as: Heading = "h2",
  className,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  as?: "h2" | "h3"
  className?: string
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex min-h-[52px] items-center gap-2.5 border-b border-line-hairline py-2 pr-3 pl-[18px]",
        className
      )}
    >
      <Heading className="text-[15px] leading-5 font-extrabold">{title}</Heading>
      {meta != null && <span className="text-[13px] text-text-tertiary">{meta}</span>}
      {actions != null && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-body" className={cn("p-[18px]", className)} {...props} />
}

/** A list inside a panel: 6px inset so hovered rows (rounded) don't touch the border. */
function PanelList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul data-slot="panel-list" className={cn("flex flex-col gap-0.5 p-1.5", className)} {...props} />
  )
}

/** Footer band: panel fill, hairline top (dialog and auth card footers use the same band). */
function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        "flex items-center gap-2.5 border-t border-line-hairline bg-surface-panel px-4 py-3.5",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  Panel,
  PanelHeader,
  PanelBody,
  PanelList,
  PanelFooter,
}
