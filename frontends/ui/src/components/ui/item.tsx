import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

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
        'flex items-center gap-3 px-5 py-3 text-left transition-colors duration-200 ease-out hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none motion-reduce:transition-none',
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

function ItemList({
  className,
  as: Comp = 'div',
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'ul' }): React.JSX.Element {
  return (
    <Comp
      data-slot="item-list"
      className={cn('overflow-hidden rounded-lg border divide-y', className)}
      {...props}
    />
  )
}

export { Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions, ItemList }
