import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'

function Item({
  className,
  asChild = false,
  as: CompProp = 'div',
  ...props
}: React.HTMLAttributes<HTMLElement> & { asChild?: boolean; as?: 'div' | 'li' }): React.JSX.Element {
  const Comp = asChild ? Slot : CompProp
  return (
    <Comp
      data-slot="item"
      className={cn(
        // A row is `px-4 py-3` — the design language's list-row padding.
        'flex items-center gap-3 px-4 py-3 text-left transition-colors duration-snap ease-out hover:bg-accent/40 motion-reduce:transition-none',
        // Keyboard focus must not be the same pixel as hover. It used to be
        // exactly that — `outline-none` plus the hover background — so a
        // keyboard reader could not tell which row they were on when the
        // pointer happened to rest on another. The ring is inset because
        // `ItemList` clips (`overflow-hidden`) and an offset ring on the first
        // or last row would be sliced off by its rounded edge.
        'outline-none',
        FOCUS_RING_INSET,
        // A row is routinely `asChild` an anchor, and an anchor cannot take
        // `disabled` — so the aria mirror carries the same treatment.
        'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function ItemMedia({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="item-media"
      className={cn('flex size-8 shrink-0 items-center justify-center', className)}
      {...props}
    />
  )
}

function ItemContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="item-content" className={cn('min-w-0 flex-1', className)} {...props} />
}

function ItemTitle({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      data-slot="item-title"
      className={cn('truncate text-sm font-medium text-foreground', className)}
      {...props}
    />
  )
}

function ItemDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      data-slot="item-description"
      className={cn('truncate text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="item-actions"
      className={cn('ml-auto flex shrink-0 items-center gap-2', className)}
      {...props}
    />
  )
}

/**
 * `ol` is here because a version history is an ordered list and the list is the
 * order: the document-lifecycle panel renders its versions newest-first, and
 * rendering that as a `ul` would drop the ordinality from the accessibility
 * tree while the eye still reads it off the page.
 */
function ItemList({
  className,
  as: Comp = 'div',
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'ul' | 'ol' }): React.JSX.Element {
  return (
    <Comp
      data-slot="item-list"
      className={cn('overflow-hidden rounded-lg border divide-y', className)}
      {...props}
    />
  )
}

export { Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions, ItemList }
