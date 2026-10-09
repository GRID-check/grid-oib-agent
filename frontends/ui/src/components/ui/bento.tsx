'use client'

/**
 * Bento: a dashboard grid of tiles of different sizes, each a summary that
 * opens something.
 *
 * A tile is the product's raised card (`raised-card.tsx`) with a fixed
 * anatomy: an eyebrow naming what it measures, the content, and the footer tab
 * carrying the one way into the detail. The tray footer is what lines a row of
 * unequal tiles up, so the grid reads as a grid however much each one holds.
 *
 * The grid is six columns from `lg`, two from `md`, one below. Tiles say how
 * wide and tall they are with `span`; `grid-flow-dense` lets a tile a reader
 * may not see (a permission-gated one) leave no hole behind.
 */

import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'

export function BentoGrid({
  className,
  children,
  ...rest
}: {
  className?: string
  children: ReactNode
  'data-testid'?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'grid grid-flow-dense auto-rows-[minmax(9rem,auto)] grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * How much of the grid a tile takes. Spelled out rather than computed, because
 * Tailwind only ships classes it can see written down.
 */
const SPANS = {
  /** A third of the row on desktop. */
  small: 'lg:col-span-2',
  /** Half the row. */
  half: 'lg:col-span-3',
  /** Two thirds, two rows tall: the hero. */
  hero: 'md:col-span-2 lg:col-span-4 lg:row-span-2',
  /** A third, two rows tall. */
  tall: 'lg:col-span-2 lg:row-span-2',
  /** The whole row. */
  wide: 'md:col-span-2 lg:col-span-6',
} as const

export type BentoSpan = keyof typeof SPANS

export interface BentoTileProps {
  /** What the tile measures, as its eyebrow. Also its accessible name. */
  label: string
  icon?: LucideIcon
  span?: BentoSpan
  /** A control in the eyebrow row, right-aligned (a menu, a toggle). */
  action?: ReactNode
  /** The detail this tile summarizes; rendered as the footer link. */
  href?: string
  linkLabel?: string
  /** Footer content beside or instead of the link. */
  footer?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
  'data-testid'?: string
}

export function BentoTile({
  label,
  icon,
  span = 'small',
  action,
  href,
  linkLabel,
  footer,
  className,
  bodyClassName,
  children,
  'data-testid': testId,
}: BentoTileProps): JSX.Element {
  const hasFooter = Boolean(footer || (href && linkLabel))
  return (
    <RaisedCard
      role="region"
      aria-label={label}
      className={cn(SPANS[span], className)}
      data-testid={testId}
    >
      <RaisedCardBody className={cn('flex flex-1 flex-col gap-3 p-5', bodyClassName)}>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <SectionLabel as="h2" icon={icon}>
            {label}
          </SectionLabel>
          {action}
        </div>
        {children}
      </RaisedCardBody>
      {hasFooter && (
        <RaisedCardFooter className="justify-between">
          <span className="min-w-0 truncate">{footer}</span>
          {href && linkLabel && (
            <Link
              href={href}
              className="hover:text-foreground duration-quick inline-flex shrink-0 items-center gap-1 font-medium transition-colors ease-out motion-reduce:transition-none"
            >
              {linkLabel}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </RaisedCardFooter>
      )}
    </RaisedCard>
  )
}

/**
 * The headline figure of a tile, with an optional line under it. Stat-tile
 * rule: the number is the content, so it is large and wears text ink, never a
 * series colour.
 */
export function BentoFigure({
  value,
  caption,
  className,
}: {
  value: ReactNode
  caption?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {caption ? <p className="text-muted-foreground mt-1 text-sm">{caption}</p> : null}
    </div>
  )
}
