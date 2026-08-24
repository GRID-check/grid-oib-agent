'use client'

import { type ReactNode } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { cn } from '@/lib/utils'

/**
 * The control row above a data list: search, filters, and — once rows are
 * selected — the actions that apply to them.
 *
 * Previously each admin surface scattered these: a search box here, a row of
 * filter chips there, per-row action buttons repeated on every line. Selection
 * and bulk actions did not exist at all, so reclassifying twenty documents
 * meant twenty dropdowns.
 *
 * When a selection is active the toolbar swaps to a selection bar. The two
 * states are mutually exclusive on purpose: filtering and acting on a
 * selection are different jobs, and showing both invites acting on rows you
 * can no longer see.
 */

export interface DataToolbarProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  /** Accessible name for the search field. */
  searchLabel: string
  clearLabel: string
  /** Filter/sort controls, rendered beside the search field. */
  filters?: ReactNode
  /** Rendered at the far end (a primary action). */
  actions?: ReactNode
  /** Number of selected rows; > 0 swaps the toolbar for the selection bar. */
  selectedCount?: number
  /** Rendered in the selection bar. */
  selectionActions?: ReactNode
  selectionLabel?: (count: number) => string
  onClearSelection?: () => void
  clearSelectionLabel?: string
  className?: string
}

export function DataToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchLabel,
  clearLabel,
  filters,
  actions,
  selectedCount = 0,
  selectionActions,
  selectionLabel,
  onClearSelection,
  clearSelectionLabel,
  className,
}: DataToolbarProps): JSX.Element {
  if (selectedCount > 0 && selectionLabel) {
    return (
      <div
        className={cn('flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2', className)}
        data-testid="data-toolbar-selection"
      >
        <p className="text-sm font-medium tabular-nums">{selectionLabel(selectedCount)}</p>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {selectionActions}
          {onClearSelection ? (
            <Button variant="ghost" size="sm" onClick={onClearSelection}>
              <X className="size-3.5" aria-hidden />
              {clearSelectionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} data-testid="data-toolbar">
      <SearchField
        className="min-w-48 flex-1"
        value={searchValue}
        onChange={onSearchChange}
        placeholder={searchPlaceholder}
        label={searchLabel}
        clearLabel={clearLabel}
      />
      {filters}
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
