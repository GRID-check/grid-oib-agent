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
import { type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'

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
        'animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none',
        className
      )}
    >
      <div className="flex items-start gap-2 border-b border-border p-3">
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
          className="-mt-1 -mr-1 size-7 shrink-0 rounded-lg"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      {footer && <div className="border-t border-border p-2">{footer}</div>}
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
      <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      <dl>{children}</dl>
    </div>
  )
}
