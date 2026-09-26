'use client'

/**
 * The document picker's own atoms — only what a picker adds to the Files
 * browser it wraps: the places on the left, the toolbar's frame, and the
 * choice at the bottom. Everything inside the listing (cards, rows, folders,
 * thumbnails, empty states) is the Files browser's own, composed by
 * `DocumentPickerDialog` through `FileBrowserPane`.
 *
 * Motion: the places' highlight is one element per picker (`pillId`) that
 * travels to the place chosen on `springGlide` — its distance is the reader's
 * route, unknowable in advance — exactly as the app rail's does. The listing
 * moves as the Files browser moves.
 */

import { forwardRef, type FC, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion, motionQuick, motionQuickExit, springGlide } from '@/components/motion'
import { Checkbox } from '@/components/ui/checkbox'
import { CountPill } from '@/components/ui/count-pill'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Places beside the listing: a column from `md` up; below it the strip takes over. */
export const PickerBody: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="grid min-h-0 flex-1 md:grid-cols-[13rem_minmax(0,1fr)]">{children}</div>
)

export const PickerSidebar: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <nav
    className="bg-muted/60 dark:bg-muted/30 flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r p-3 max-md:hidden"
    aria-label={label}
    data-testid="picker-sidebar"
  >
    {children}
  </nav>
)

/** One place. The highlight is shared by every place in one sidebar, so choosing one moves it there. */
export const PickerSidebarItem: FC<{
  icon: LucideIcon
  label: string
  count?: number
  active: boolean
  /** The sidebar's shared-layout id; one per mounted place list. */
  pillId: string
  onClick: () => void
  testId?: string
}> = ({ icon: Icon, label, count, active, pillId, onClick, testId }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    data-testid={testId}
    className={cn(
      'relative isolate flex h-9 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm pointer-coarse:h-11',
      'transition-colors duration-quick ease-out motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      active ? 'text-foreground font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    )}
  >
    {active && (
      <motion.span
        layoutId={pillId}
        data-pill-id={pillId}
        className="bg-card absolute inset-0 -z-10 rounded-md shadow-xs"
        transition={springGlide}
        aria-hidden
      />
    )}
    <Icon className="size-4 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {count !== undefined && count > 0 && <CountPill>{count}</CountPill>}
  </button>
)

/** The places as a row, on a phone, where the sidebar has no room. */
export const PickerPlaceStrip: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="flex gap-1 overflow-x-auto border-b px-3 py-2 scrollbar-hide md:hidden [&>button]:w-auto">
    {children}
  </div>
)

/** The listing column: its toolbar on top, the Files browser scrolling beneath. */
export const PickerListing: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="flex min-h-0 min-w-0 flex-col [&>*:last-child]:min-h-0 [&>*:last-child]:flex-1 [&>*:last-child]:overflow-y-auto">
    {children}
  </div>
)

export const PickerToolbar: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-2 border-b px-4 py-2.5">{children}</div>
)

export const PickerFooter: FC<{ start: ReactNode; end: ReactNode }> = ({ start, end }) => (
  <div className="bg-muted/30 flex flex-wrap items-center gap-3 border-t px-5 py-3">
    {/* On a phone the choice takes a row of its own and the buttons the next,
        right-aligned; side by side the summary would wrap word by word. */}
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:basis-auto sm:flex-1">{start}</div>
    <div className="ml-auto flex shrink-0 items-center gap-2">{end}</div>
  </div>
)

/** How much is chosen, said to a screen reader as it changes. */
export const PickerSummary: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-foreground whitespace-nowrap text-sm font-medium tabular-nums" data-testid="picker-summary" aria-live="polite">
    {children}
  </span>
)

/**
 * A caller's own switch beside the summary, about the choice as a whole —
 * „Nur diese verwenden". A checkbox, because it qualifies the choice rather
 * than acting on it.
 */
export const PickerFooterCheck: FC<{
  id: string
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  testId?: string
}> = ({ id, label, checked, onCheckedChange, testId }) => (
  <span className="flex items-center gap-2">
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      data-testid={testId}
    />
    <Label htmlFor={id} className="text-sm font-normal">
      {label}
    </Label>
  </span>
)

/** A small action beside the summary („Auswahl aufheben"): arrives with a selection, leaves with it. */
export const PickerFooterAction = forwardRef<HTMLButtonElement, { label: string; onClick: () => void }>(
  ({ label, onClick }, ref) => (
    <motion.button
      ref={ref}
      type="button"
      onClick={onClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: motionQuick }}
      exit={{ opacity: 0, transition: motionQuickExit }}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 rounded text-sm underline-offset-2 transition-colors duration-quick hover:underline focus-visible:outline-none focus-visible:ring-2"
    >
      {label}
    </motion.button>
  )
)
PickerFooterAction.displayName = 'PickerFooterAction'
