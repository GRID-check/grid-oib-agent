import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Table primitives.
 *
 * The admin surfaces each hand-rolled their own `divide-y` list of flex rows,
 * so every one drifted on padding, alignment, hover and header treatment — and
 * none of them could be sorted or scanned column-wise. These give them one
 * shape.
 *
 * `Table` wraps itself in an `overflow-x-auto` container: a wide admin table
 * scrolls inside its own box rather than making the page body scroll
 * horizontally.
 *
 * Deliberately NOT `min-w-max`. A `width: 100%` table already cannot render
 * below its min-content width, so a genuinely too-wide column set overflows and
 * the wrapper scrolls on its own. Adding a max-content floor instead pins every
 * table to its unwrapped width, which defeats column sharing and forces
 * horizontal scrolling on tables that fit today — measured on the workflow
 * templates table, it clipped the publish state and pushed the row actions off
 * the edge. Cells that need a ceiling get `max-w-*` at the call site.
 */

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-x-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
)
Table.displayName = 'Table'

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />,
)
TableHeader.displayName = 'TableHeader'

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
)
TableBody.displayName = 'TableBody'

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted/60',
        className,
      )}
      {...props}
    />
  ),
)
TableRow.displayName = 'TableRow'

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        // Recessive header: the data is the content, the header is the label.
        'h-9 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground [&:has([role=checkbox])]:w-10 [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  ),
)
TableHead.displayName = 'TableHead'

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      // `tabular-nums`: a column of figures is only comparable if the figures
      // are the same width. It affects digits only, so text cells are untouched.
      className={cn(
        'px-3 py-2.5 align-middle tabular-nums [&:has([role=checkbox])]:w-10 [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  ),
)
TableCell.displayName = 'TableCell'

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn('mt-3 text-xs text-muted-foreground', className)} {...props} />
  ),
)
TableCaption.displayName = 'TableCaption'

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption }
