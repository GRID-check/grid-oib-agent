'use client'

/**
 * A sortable column header for the platform directory tables: the label as a
 * button, an arrow for the active direction, and `aria-sort` on the cell so a
 * screen reader hears the order rather than inferring it from a glyph.
 */

import type { FC } from 'react'
import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type SortDirection = 'asc' | 'desc'

export const SortableHead: FC<{
  label: string
  ariaLabel: string
  active: boolean
  direction: SortDirection
  onSort: () => void
  className?: string
}> = ({ label, ariaLabel, active, direction, onSort, className }) => {
  const Icon = active ? (direction === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
  return (
    <TableHead
      className={className}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={onSort}
        aria-label={ariaLabel}
        className={cn(
          // A column header is text-height by design; `touch-target` makes it
          // tappable without turning the header row into a row of buttons.
          'hover:text-foreground focus-visible:ring-ring/60 touch-target inline-flex items-center gap-1 text-balance rounded-sm uppercase focus-visible:outline-none focus-visible:ring-2',
          active && 'text-foreground'
        )}
      >
        {label}
        <Icon className={cn('size-3 shrink-0', !active && 'opacity-50')} aria-hidden />
      </button>
    </TableHead>
  )
}
