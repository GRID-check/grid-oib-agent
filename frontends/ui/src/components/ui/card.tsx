import * as React from 'react'

import { cn } from '@/lib/utils'

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card"
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-lg border py-6 shadow-sm',
        className
      )}
      {...props}
    />
  )
)
Card.displayName = 'Card'

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 [.border-b]:pb-6',
        // A header with an action is TWO COLUMNS ONLY WHEN THERE IS ROOM FOR TWO.
        //
        // It used to be `grid-cols-[1fr_auto]` at every width, and a grid item's
        // default `min-width: auto` means the `1fr` title column cannot shrink
        // below its own min-content. So on a phone the title held its ground, the
        // `auto` column held the buttons, and the header simply grew wider than
        // the card — measured with its right edge at 418px inside a 390px
        // viewport, i.e. the buttons were off the screen. Every card in the app
        // that uses `CardAction` carried that; it surfaced on the answer-feedback
        // console first only because that one has two long button labels.
        //
        // Below `sm` the action drops under the title, which is the only honest
        // layout at phone width. At or above it the previous arrangement returns
        // — except that the title column is now `minmax(0,1fr)`, so it gives
        // ground instead of pushing when the action is wide.
        //
        // A VIEWPORT breakpoint and not the `@container/card-header` above it,
        // which would be the obvious reach and does not work: an element with
        // `container-type` establishes a query container for its DESCENDANTS,
        // never for itself, so `@sm/card-header:` on this element matches
        // nothing and every header would silently stay single-column. The
        // container is still there and still correct for `CardContent` and
        // anything else inside.
        'has-data-[slot=card-action]:grid-cols-1',
        'sm:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]',
        className
      )}
      {...props}
    />
  )
)
CardHeader.displayName = 'CardHeader'

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-title"
      className={cn('text-sm leading-none font-semibold', className)}
      {...props}
    />
  )
)
CardTitle.displayName = 'CardTitle'

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
)
CardDescription.displayName = 'CardDescription'

const CardAction = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-action"
      // Stacked under the title below `sm`; back in its own right-hand column
      // above it. The grid placement has to move with the column count on the
      // same breakpoint CardHeader uses, or a single-column header would still
      // be told to put this in column 2.
      className={cn(
        'min-w-0 justify-self-start',
        'sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:self-start sm:justify-self-end',
        className,
      )}
      {...props}
    />
  )
)
CardAction.displayName = 'CardAction'

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="card-content" className={cn('px-6', className)} {...props} />
  )
)
CardContent.displayName = 'CardContent'

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-footer"
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  )
)
CardFooter.displayName = 'CardFooter'

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
