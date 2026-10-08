'use client'

/**
 * The raised card: a white content block sitting PROUD of a subtler outer
 * surface, with a footer tab on that outer surface carrying quiet metadata.
 *
 * This shape is the product's card, and this file is its one copy.
 * `projects/project-card.tsx` renders on it (the projects-home surfaces,
 * `docs/design/project-surfaces.md`). Three other surfaces still carry their own
 * copy of `rounded-b-[10px] bg-card shadow-xs` over `rounded-xl border
 * bg-muted/50` — `documents/file-card.tsx`, `documents/file-grid.tsx` and
 * `grid-cards/DocumentGridCard.tsx` — and each is free to drift from the others
 * by a pixel or a shadow.
 *
 * A card moves onto this primitive when it has to change anyway, which is the
 * cheap moment. A new surface uses this primitive rather than a fresh copy.
 *
 * The two-surface trick is the whole point and the easiest thing to get subtly
 * wrong: the inner block is rounded only at the BOTTOM (`rounded-b-lg`)
 * and the outer container clips it, so the block reads as a sheet laid into a
 * tray rather than a box inside a box. The footer is not a bordered section —
 * it is the tray showing beneath the sheet, which is why it needs no divider.
 *
 * Adoption is deliberately incremental: each remaining copy stays hand-rolled
 * until it is moved over separately, because they differ in padding, in what
 * they wrap (button, article, anchor) and in their hover behaviour, and
 * collapsing those differences blind is how a refactor breaks several surfaces
 * at once.
 */

import type { JSX } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { motion, motionQuick, springPress } from '@/components/motion'
import { cn } from '@/lib/utils'

export interface RaisedCardProps extends Omit<ComponentProps<'div'>, 'ref'> {
  /**
   * Lift on hover. On for anything that opens something; off for a card that
   * is a container rather than a target, where a lift promises a click that
   * does not exist.
   */
  interactive?: boolean
  children: ReactNode
}

/** The outer tray. Clips the body's bottom radius and owns the hover shadow. */
export function RaisedCard({
  interactive = false,
  className,
  children,
  ...rest
}: RaisedCardProps): JSX.Element {
  const card = (
    <div
      className={cn(
        'border-border bg-muted/50 shadow-sm relative flex h-full min-w-0 flex-col overflow-hidden rounded-lg border',
        'transition-shadow duration-quick ease-out motion-reduce:transition-none',
        interactive && 'hover:shadow-md',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )

  if (!interactive) return card
  return (
    <motion.div
      className="h-full min-w-0 will-change-transform"
      // HOVER IS A TWEEN, THE PRESS IS A SPRING — and they are not the same
      // motion wearing one transition.
      //
      // The 2px lift is ambient: it fires on every pointer crossing, dozens of
      // times per screenful of a file grid, and its trajectory carries nothing
      // the endpoint does not already say ("this is a target"). The design
      // language's third veto — anything appearing more than ~5× per screenful
      // is tween-only — lands squarely on it, so it is `motionQuick`, the same
      // 180ms ease-out the card's own `transition-shadow` runs on. Sharing that
      // number is the point: lift and shadow are one gesture.
      //
      // The tap is direct manipulation and must be REVERSIBLE mid-flight —
      // release before the dip completes and the card has to come back from
      // wherever it is, carrying its velocity. That is the one thing a tween
      // cannot do (it restarts from zero velocity and stutters), and it is why
      // `springPress` exists. ζ = 1.00, so the overshoot is 0px at any travel;
      // the spring is bought for interruptibility, not for bounce.
      whileHover={{ y: -2, transition: motionQuick }}
      whileTap={{ scale: 0.99, transition: springPress }}
    >
      {card}
    </motion.div>
  )
}

/**
 * Flush media well at the top of the raised block (file thumbnails). Sits
 * inside {@link RaisedCardBody} with the body's padding stripped.
 */
export function RaisedCardMedia({
  className,
  children,
  ...rest
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      className={cn('relative w-full overflow-hidden border-b bg-card', className)}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * The raised white block. Rounded at the bottom only — the top edge is flush
 * with the tray, which is what makes it read as laid in rather than floating.
 *
 * No shadow of its own: the tray owns elevation (including the hover lift), so
 * a shadow here only double-darkens the body's edge against the footer.
 * box-shadow is paint-only, so dropping it cannot move layout.
 */
export function RaisedCardBody({
  className,
  children,
  ...rest
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      className={cn(
        'bg-card w-full overflow-hidden rounded-b-lg px-4 pb-3 pt-3.5',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * The footer tab: the tray showing beneath the block.
 *
 * `mt-auto` so it sits at the bottom however tall the body is — which is what
 * keeps footers aligned across a row of cards of differing content height, the
 * thing that makes a grid look like a grid.
 *
 * No top border by design. The separation is the surface change, and adding a
 * divider on top of it reads as two stacked boxes.
 */
export function RaisedCardFooter({
  className,
  children,
  ...rest
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      className={cn(
        'text-muted-foreground mt-auto flex w-full items-center gap-2 px-4 py-2.5 text-xs',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
