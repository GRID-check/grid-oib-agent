'use client'

/**
 * The card that slides in from the right when something is selected.
 *
 * Selection-scoped, and that is the point. The old page kept a permanent
 * properties column that was empty most of the time, so the reader paid for it
 * on every visit and got something back on some of them. Here the panel does
 * not exist until there is something for it to describe, which means the
 * default state of the viewport is the building, full width.
 *
 * Nothing in this atom knows what a BIM element is — it is a titled, closable,
 * scrollable card. What goes inside is the inspector's problem.
 */

import { X } from 'lucide-react'
import { type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'

/**
 * The floating section pattern: one sticky solid header bar plus a body, the
 * shape the rail's groups and any future floating group share so a new
 * section cannot introduce a fifth kind of list header.
 *
 * The header is sticky with a SOLID `bg-card` fill (never the surface's own
 * translucent blur — a `backdrop-filter` nested inside the mask that draws a
 * scroll fade has no backdrop to sample, and Chromium paints the undefined
 * result as a solid bar across the heading).
 */
export function ViewerSectionHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      className={cn('sticky top-0 z-10 flex items-center gap-2 bg-card px-3 py-2.5', className)}
      {...props}
    />
  )
}

/** The section body: the panel/section scale padding, nothing else. */
export function ViewerSectionBody({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('p-3', className)} {...props} />
}

export interface ViewerSectionProps extends Omit<ComponentProps<'section'>, 'title'> {
  /** The section's heading — visible, and the group's accessible name. */
  label: string
  /** A control belonging to the heading row, e.g. "show all levels". */
  action?: ReactNode
  children: ReactNode
  /** Overrides the `p-3` body (the rail's rows keep their own tight inset). */
  bodyClassName?: string
}

/**
 * One titled group: sticky header over a padded body. The rail's sections
 * render through this (with their row inset); the panel composes the header
 * and body atoms directly, since its heading carries title + subtitle + close
 * rather than label + action.
 */
export function ViewerSection({
  label,
  action,
  children,
  bodyClassName,
  className,
  ...rest
}: ViewerSectionProps): JSX.Element {
  return (
    <section aria-label={label} className={cn('shrink-0 border-b border-border last:border-b-0', className)} {...rest}>
      <ViewerSectionHeader className="justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{label}</h3>
        {action}
      </ViewerSectionHeader>
      <ViewerSectionBody className={bodyClassName}>{children}</ViewerSectionBody>
    </section>
  )
}

export interface ViewerPanelProps {
  title: string
  /** One line under the title: what kind of thing this is, where it sits. */
  subtitle?: ReactNode
  closeLabel: string
  onClose: () => void
  children: ReactNode
  /** Pinned below the scroll area, so the primary action never scrolls away. */
  footer?: ReactNode
  className?: string
}

export function ViewerPanel({
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
  footer,
  className,
}: ViewerPanelProps): JSX.Element {
  return (
    <ViewerSurface
      // Labelled by its own heading, so a screen reader announces WHAT was
      // selected on arrival rather than "complementary landmark".
      aria-label={title}
      role="complementary"
      className={cn(
        'flex max-h-[calc(100%-1.5rem)] w-72 flex-col overflow-hidden',
        // Enters from the edge it lives on: a panel that fades in place reads
        // as a layer appearing, one that slides reads as a drawer opening.
        'animate-in fade-in-0 slide-in-from-right-2 duration-base ease-entrance motion-reduce:animate-none',
        className
      )}
    >
      <ViewerSectionHeader className="items-start border-b border-border">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground" title={title}>
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mt-1 -mr-1 size-7 shrink-0 rounded-md"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </ViewerSectionHeader>
      <ViewerSectionBody className="min-h-0 flex-1 overflow-y-auto">{children}</ViewerSectionBody>
      {/* Footer keeps the panel scale (`p-3` like header and body) — a tighter
          `p-2` here was a second padding hiding in the same card. */}
      {footer && <div className="border-t border-border p-3">{footer}</div>}
    </ViewerSurface>
  )
}

export interface ViewerFieldProps {
  label: string
  children: ReactNode
}

/**
 * One label/value row.
 *
 * A `<div>` inside a `<dl>` — the grouping wrapper is what lets a term and its
 * definition sit on one line without breaking the list's semantics. Values
 * wrap rather than truncate: a material name or a classification code that
 * ends in an ellipsis is a value the reader has to click somewhere else to
 * finish reading, which is exactly the trip this panel exists to save.
 */
export function ViewerField({ label, children }: ViewerFieldProps): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium break-words text-foreground">{children}</dd>
    </div>
  )
}

/** A titled block of fields inside the panel. */
export function ViewerFieldGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mb-3 last:mb-0">
      {/*
        Not uppercased. Half of these headings are exporter-authored set names
        — `Qto_WallBaseQuantities` — and `text-transform` turns those into
        QTO_WALLBASEQUANTITIES, which is louder than anything under it and
        shreds the only casing that made the name readable.
      */}
      <h3 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide">{label}</h3>
      <dl>{children}</dl>
    </div>
  )
}
