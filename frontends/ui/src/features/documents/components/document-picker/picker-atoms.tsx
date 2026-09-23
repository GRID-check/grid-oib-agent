'use client'

/**
 * The document picker's atom kit: the pieces of an open panel, one decision
 * each. `DocumentPickerDialog` composes them and reaches for no Tailwind of
 * its own.
 *
 * The material is the design language's: ink and paper, hairlines, one
 * surface step for the sidebar. Selection is the one strong mark — an ink
 * square with a check drawn into it — and it is contrast, never chroma. A file
 * is drawn by what it is (`DocumentKindThumbnail`, the Files page's own
 * sketches), so a floor plan in the picker looks like the floor plan on the
 * Files page.
 *
 * Motion, and the reason for each (`docs/design/run-block.md`, *The document
 * picker*):
 *
 * - The sidebar's highlight TRAVELS to the place chosen (`springGlide`: its
 *   distance is the reader's route, not knowable in advance).
 * - The documents of a place arrive from the side the reader went: into a
 *   folder or forward from the right, back from the left, a new place in the
 *   sidebar as a plain crossfade. Rows cascade in, capped.
 * - The mark fills on a tween and its check DRAWS itself (`motionSnap`, the
 *   checkbox-tick duration). Nothing in a list of thirty springs.
 * - The preview crossfades to the document in focus, without an exit, so
 *   holding an arrow key never queues animations behind the reader.
 */

import { forwardRef, type CSSProperties, type FC, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Folder, type LucideIcon } from 'lucide-react'
import {
  AnimatePresence,
  motion,
  motionEntrance,
  motionQuick,
  motionQuickExit,
  motionSnap,
  springGlide,
  staggerMaxSteps,
  staggerStepSeconds,
  type Variants,
} from '@/components/motion'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { DocumentKindThumbnail } from '@/features/documents/components/document-kind-thumbnail'
import { inferDocumentKind } from '@/features/documents/document-kind'
import { cn } from '@/lib/utils'

/* ── Sidebar ─────────────────────────────────────────────────────────── */

export const PickerSidebar: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <nav
    className="bg-muted/40 border-border flex min-h-0 flex-col gap-5 overflow-y-auto border-r px-2.5 py-3 max-md:hidden"
    aria-label={label}
    data-testid="picker-sidebar"
  >
    {children}
  </nav>
)

export const PickerSidebarGroup: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-px">
    <span className="text-muted-foreground px-2 pb-1.5 text-[10.5px] font-medium uppercase tracking-wider">{label}</span>
    {children}
  </div>
)

/**
 * A place in the sidebar. The highlight is ONE element per sidebar
 * (`pillId`), so choosing a place moves it there rather than switching one
 * off and another on.
 */
export const PickerSidebarItem: FC<{
  icon: LucideIcon
  label: string
  count?: number
  active: boolean
  /** The sidebar's shared-layout id; one per mounted picker. */
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
      'relative isolate flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] pointer-coarse:h-11',
      'transition-colors duration-quick ease-out motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      active ? 'text-foreground font-medium' : 'text-foreground/75 hover:bg-foreground/[0.04] hover:text-foreground'
    )}
  >
    {active && (
      <motion.span
        layoutId={pillId}
        data-pill-id={pillId}
        className="bg-foreground/[0.08] absolute inset-0 -z-10 rounded-md"
        transition={springGlide}
        aria-hidden
      />
    )}
    <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} aria-hidden />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {count !== undefined && count > 0 && (
      <span className="text-muted-foreground text-[11px] tabular-nums">{count}</span>
    )}
  </button>
)

/** The places as a row, on a phone, where the sidebar has no room. */
export const PickerPlaceStrip: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="border-border flex gap-1 overflow-x-auto border-b px-2 py-1.5 scrollbar-hide md:hidden [&>button]:w-auto [&>button]:shrink-0">
    {children}
  </div>
)

/* ── Header and toolbar ──────────────────────────────────────────────── */

export const PickerHeader: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="border-border flex flex-col gap-0.5 border-b px-5 pb-3 pt-4 pr-12">{children}</div>
)

export const PickerToolbar: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="border-border flex min-h-12 flex-wrap items-center gap-2 border-b px-3 py-2">{children}</div>
)

/** Back and forward, joined into one control the way an open panel draws them. */
export const PickerNavGroup: FC<{ children: ReactNode; label: string }> = ({ children, label }) => (
  <div className="border-border bg-card flex shrink-0 items-center rounded-md border p-px shadow-2xs" role="group" aria-label={label}>
    {children}
  </div>
)

export const PickerIconButton: FC<{
  icon: LucideIcon
  label: string
  disabled?: boolean
  onClick: () => void
  testId?: string
}> = ({ icon: Icon, label, disabled = false, onClick, testId }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    data-testid={testId}
    className={cn(
      'text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-[5px] pointer-coarse:size-11',
      // Colour on hover, and a press that gives a little under the finger — both tweens, one declaration.
      'hover:bg-accent hover:text-foreground transition-[color,background-color,transform] duration-snap ease-out motion-reduce:transition-none',
      'active:scale-[0.94] motion-reduce:active:scale-100',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      'disabled:pointer-events-none disabled:opacity-30'
    )}
  >
    <Icon className="size-4" aria-hidden />
  </button>
)

/** Where the panel is: the location, then each folder, the last one bold. */
export const PickerPath: FC<{ segments: readonly { label: string; onClick?: () => void }[]; label: string }> = ({
  segments,
  label,
}) => (
  <nav className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]" aria-label={label} data-testid="picker-path">
    {segments.map((segment, index) => {
      const last = index === segments.length - 1
      return (
        <span
          key={`${index}-${segment.label}`}
          className={cn('flex items-center gap-0.5', last ? 'min-w-0 max-w-[60%] shrink-0' : 'min-w-[2.5rem] shrink')}
        >
          {index > 0 && <ChevronRight className="text-muted-foreground/70 size-3.5 shrink-0" aria-hidden />}
          {segment.onClick && !last ? (
            <button
              type="button"
              onClick={segment.onClick}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 truncate rounded px-1 transition-colors duration-quick focus-visible:outline-none focus-visible:ring-2"
            >
              {segment.label}
            </button>
          ) : (
            <span
              className={cn('truncate px-1', last ? 'text-foreground font-semibold' : 'text-muted-foreground')}
              aria-current={last ? 'location' : undefined}
            >
              {segment.label}
            </span>
          )}
        </span>
      )
    })}
  </nav>
)

/* ── Items ───────────────────────────────────────────────────────────── */

/** A file drawn by its kind, in a quiet well; a folder by the folder glyph. */
export const KindGlyph: FC<{
  name: string
  contentType?: string | null
  tags?: readonly string[] | null
  folder?: boolean
  size?: 'sm' | 'lg' | 'tile'
}> = ({ name, contentType, tags, folder = false, size = 'sm' }) => {
  const box =
    size === 'lg' ? 'aspect-[4/3] w-full rounded-lg' : size === 'tile' ? 'aspect-[4/3] w-full rounded-lg' : 'size-8 rounded-md'
  if (folder) {
    return (
      <span className={cn('bg-muted text-muted-foreground flex shrink-0 items-center justify-center', box)} aria-hidden>
        <Folder className={size === 'sm' ? 'size-4' : 'size-10'} fill="currentColor" fillOpacity={0.15} strokeWidth={1.5} />
      </span>
    )
  }
  const kind = inferDocumentKind({ filename: name, contentType, tags: tags ? [...tags] : null })
  return (
    <span className={cn('bg-muted text-foreground/70 flex shrink-0 items-center justify-center overflow-hidden', box)} aria-hidden>
      <DocumentKindThumbnail kind={kind} className={size === 'sm' ? 'h-6 w-8' : 'h-3/5 w-3/5'} />
    </span>
  )
}

/**
 * The selection mark: a rounded square, empty or ink with a check drawn into
 * it. The fill is a tween (a colour never springs); the check draws on the
 * checkbox-tick duration, so it reads as the mark being MADE rather than
 * appearing.
 */
export const SelectMark: FC<{ checked: boolean; disabled?: boolean; className?: string }> = ({
  checked,
  disabled = false,
  className,
}) => (
  <span
    className={cn(
      'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border',
      'transition-[background-color,border-color,box-shadow] duration-snap ease-out motion-reduce:transition-none',
      checked
        ? 'bg-foreground border-foreground text-background shadow-xs'
        : 'border-muted-foreground/45 bg-card group-hover/item:border-muted-foreground/80',
      disabled && 'opacity-40',
      className
    )}
    aria-hidden
    data-checked={checked || undefined}
  >
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <motion.path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        initial={false}
        animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
        transition={motionSnap}
      />
    </svg>
  </span>
)

export interface PickerColumn {
  key: string
  label: string
  /** The column's grid track, e.g. `minmax(0,1fr)` or `6.5rem`. */
  width: string
  align?: 'start' | 'end'
  /** Hidden below `sm`: the name carries the row on a phone. */
  wide?: boolean
}

/**
 * The list's grid tracks: every column from `sm` up, the mark and the name
 * alone on a phone. A hidden cell still owns its track, so the narrow form has
 * to leave the track out, not just the cell.
 */
const trackStyle = (columns: readonly PickerColumn[]): CSSProperties =>
  ({
    '--picker-cols': `1.25rem ${columns.map((column) => column.width).join(' ')}`,
    '--picker-cols-narrow': `1.25rem ${columns
      .filter((column) => !column.wide)
      .map((column) => column.width)
      .join(' ')}`,
  }) as CSSProperties

const tracks = '[grid-template-columns:var(--picker-cols-narrow)] sm:[grid-template-columns:var(--picker-cols)]'

export const PickerListHeader: FC<{
  columns: readonly PickerColumn[]
  sort: { key: string; direction: 'asc' | 'desc' }
  onSort: (key: string) => void
}> = ({ columns, sort, onSort }) => (
  <div
    className={cn(
      'border-border text-muted-foreground bg-popover/95 sticky top-0 z-10 mx-1.5 grid items-center gap-3 border-b px-2.5 py-1.5 text-[11px] font-medium backdrop-blur-sm',
      tracks
    )}
    style={trackStyle(columns)}
    role="presentation"
  >
    <span />
    {columns.map((column) => {
      const active = sort.key === column.key
      const Arrow = sort.direction === 'asc' ? ChevronUp : ChevronDown
      return (
        <button
          key={column.key}
          type="button"
          onClick={() => onSort(column.key)}
          className={cn(
            'hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-0.5 rounded transition-colors duration-quick focus-visible:outline-none focus-visible:ring-2',
            column.align === 'end' && 'justify-end',
            column.wide && 'max-sm:hidden',
            active && 'text-foreground'
          )}
          aria-label={column.label}
          aria-pressed={active}
        >
          {column.label}
          <Arrow className={cn('size-3 transition-opacity duration-quick', active ? 'opacity-100' : 'opacity-0')} aria-hidden />
        </button>
      )
    })}
  </div>
)

interface ItemProps {
  selected: boolean
  focused: boolean
  /** Why it cannot be chosen, shown in place of the meta line. */
  disabledReason?: string | null
  onClick: () => void
  onDoubleClick: () => void
  testId?: string
}

/** A row or tile arriving with its place: the cascade's child. */
const itemVariants: Variants = {
  enter: { opacity: 0, y: 4 },
  center: { opacity: 1, y: 0, transition: motionEntrance },
}

/** One row of the list view: mark, glyph and name, then the columns. Finder's inset, rounded rows. */
export const PickerRow: FC<
  ItemProps & {
    columns: readonly PickerColumn[]
    glyph: ReactNode
    name: string
    meta?: string
    cells: Record<string, ReactNode>
    folder?: boolean
  }
> = ({ columns, glyph, name, meta, cells, folder = false, selected, focused, disabledReason, onClick, onDoubleClick, testId }) => (
  <motion.div
    variants={itemVariants}
    role="option"
    aria-selected={folder ? undefined : selected}
    aria-disabled={disabledReason ? true : undefined}
    data-testid={testId}
    data-selected={selected || undefined}
    data-focused={focused || undefined}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    className={cn(
      'group/item mx-1.5 grid min-h-11 cursor-default select-none items-center gap-3 rounded-md px-2.5 py-1.5',
      'transition-colors duration-snap ease-out motion-reduce:transition-none',
      tracks,
      selected ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.035]',
      // The focus ring is for the keyboard: it shows only while the list itself has keyboard focus.
      'data-[focused]:group-focus-visible/list:ring-ring/70 data-[focused]:group-focus-visible/list:ring-2 data-[focused]:group-focus-visible/list:ring-inset',
      disabledReason && 'cursor-not-allowed opacity-55 hover:bg-transparent'
    )}
    style={trackStyle(columns)}
  >
    {folder ? <span /> : <SelectMark checked={selected} disabled={Boolean(disabledReason)} />}
    <span className="flex min-w-0 items-center gap-2.5">
      {glyph}
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground truncate text-[13px] leading-snug">{name}</span>
        {(disabledReason || meta) && (
          <span className="text-muted-foreground truncate text-[11px] leading-snug">{disabledReason ?? meta}</span>
        )}
      </span>
      {folder && (
        <ChevronRight
          className="text-muted-foreground/70 group-hover/item:text-foreground ml-auto size-3.5 shrink-0 transition-colors duration-quick"
          aria-hidden
        />
      )}
    </span>
    {columns.slice(1).map((column) => (
      <span
        key={column.key}
        className={cn(
          'text-muted-foreground truncate text-xs tabular-nums',
          column.align === 'end' && 'text-right',
          column.wide && 'max-sm:hidden'
        )}
      >
        {cells[column.key]}
      </span>
    ))}
  </motion.div>
)

/**
 * One tile of the icon view: the sketch large, the name under it. Chosen, the
 * sketch takes an ink ring and the name an ink label, the way an open panel
 * marks an icon; the mark sits in the corner and shows on hover.
 */
export const PickerTile: FC<ItemProps & { glyph: ReactNode; name: string; meta?: string; folder?: boolean }> = ({
  glyph,
  name,
  meta,
  folder = false,
  selected,
  focused,
  disabledReason,
  onClick,
  onDoubleClick,
  testId,
}) => (
  <motion.div
    variants={itemVariants}
    role="option"
    aria-selected={folder ? undefined : selected}
    aria-disabled={disabledReason ? true : undefined}
    data-testid={testId}
    data-selected={selected || undefined}
    data-focused={focused || undefined}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    className={cn(
      'group/item relative flex cursor-default select-none flex-col items-center gap-2 rounded-lg p-2',
      'data-[focused]:group-focus-visible/list:ring-ring/70 data-[focused]:group-focus-visible/list:ring-2',
      disabledReason && 'cursor-not-allowed opacity-55'
    )}
  >
    <span
      className={cn(
        'relative w-full rounded-lg transition-[box-shadow] duration-snap ease-out motion-reduce:transition-none',
        selected
          ? 'ring-foreground ring-offset-popover ring-2 ring-offset-2'
          : 'group-hover/item:ring-border group-hover/item:ring-1'
      )}
    >
      {glyph}
      {!folder && (
        <SelectMark
          checked={selected}
          disabled={Boolean(disabledReason)}
          className={cn(
            'absolute right-2 top-2 transition-opacity duration-quick',
            selected ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-100'
          )}
        />
      )}
    </span>
    <span
      className={cn(
        'line-clamp-2 max-w-full rounded-[5px] px-1.5 py-px text-center text-xs leading-snug transition-colors duration-snap ease-out',
        selected ? 'bg-foreground text-background' : 'text-foreground'
      )}
    >
      {name}
    </span>
    {(disabledReason || meta) && (
      <span className="text-muted-foreground -mt-1 max-w-full truncate text-center text-[10.5px]">{disabledReason ?? meta}</span>
    )}
  </motion.div>
)

/**
 * The place's documents, arriving from the side the reader went. `direction`
 * is +1 deeper or forward, −1 back, 0 a new place: the trajectory says where
 * the reader now is relative to where they were, which is information the
 * endpoint alone does not carry. 16px, on tweens; the cascade inside is capped.
 */
const placeVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 16 }),
  center: {
    opacity: 1,
    x: 0,
    transition: {
      ...motionEntrance,
      delayChildren: (index: number) => Math.min(index, staggerMaxSteps) * staggerStepSeconds,
    },
  },
  // A place that is leaving takes no clicks: the reader is already looking at the next one.
  exit: (direction: number) => ({ opacity: 0, x: direction * -16, pointerEvents: 'none', transition: motionQuickExit }),
}

/** The item area: a list box the arrow keys walk, its place sliding in from the side the reader went. */
export const PickerItems: FC<{
  label: string
  view: 'list' | 'grid'
  multiple: boolean
  /** Identity of what is shown: the place and the view. A change slides the content. */
  placeKey: string
  direction: number
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  header?: ReactNode
  children: ReactNode
}> = ({ label, view, multiple, placeKey, direction, onKeyDown, header, children }) => (
  <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden scroll-fade-bottom" data-testid="picker-items">
    {header}
    <AnimatePresence mode="popLayout" initial={false} custom={direction}>
      <motion.div
        key={placeKey}
        custom={direction}
        variants={placeVariants}
        initial="enter"
        animate="center"
        exit="exit"
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn(
          'group/list min-h-0 flex-1 focus-visible:outline-none',
          view === 'grid'
            ? 'grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(8.75rem,1fr))] gap-1 p-3'
            : 'flex flex-col gap-px py-1.5'
        )}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  </div>
)

/** Rows standing in for a listing that has not arrived: the shape of what is coming. */
export const PickerSkeletonRows: FC<{ count?: number }> = ({ count = 6 }) => (
  <div className="flex flex-col gap-px py-1.5" aria-hidden data-testid="picker-skeleton">
    {Array.from({ length: count }, (_, index) => (
      <div key={index} className="mx-1.5 flex min-h-11 items-center gap-3 px-2.5">
        <Skeleton className="size-[18px] rounded-[5px]" />
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-3 flex-1 rounded" style={{ maxWidth: `${60 - (index % 3) * 12}%` }} />
      </div>
    ))}
  </div>
)

export const PickerEmpty: FC<{ icon: LucideIcon; children: ReactNode }> = ({ icon: Icon, children }) => (
  <motion.div
    variants={itemVariants}
    className="text-muted-foreground col-span-full flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-sm"
  >
    <Icon className="size-8 opacity-40" strokeWidth={1.5} aria-hidden />
    {children}
  </motion.div>
)

/* ── Preview ─────────────────────────────────────────────────────────── */

export const PickerPreviewPane: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <aside
    className="border-border bg-muted/20 flex min-h-0 flex-col overflow-y-auto border-l p-4 max-lg:hidden"
    aria-label={label}
    data-testid="picker-preview"
  >
    {children}
  </aside>
)

/**
 * The preview's content for one thing in focus. Keyed by it, it fades in
 * without an exit: holding an arrow key walks through the list, and a queue
 * of exits behind the reader would make the preview lag the focus.
 */
export const PickerPreviewBody: FC<{ focusKey: string; children: ReactNode }> = ({ focusKey, children }) => (
  <motion.div
    key={focusKey}
    className="flex flex-col gap-4"
    initial={{ opacity: 0 }}
    animate={{ opacity: 1, transition: motionQuick }}
  >
    {children}
  </motion.div>
)

export const PickerPreviewTitle: FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <div className="flex flex-col gap-1">
    <p className="text-foreground break-words text-sm font-semibold leading-snug">{title}</p>
    {subtitle && <p className="text-muted-foreground break-all text-[11px] leading-snug">{subtitle}</p>}
  </div>
)

export const PickerFacts: FC<{ facts: readonly { label: string; value: ReactNode }[] }> = ({ facts }) => (
  <dl className="divide-border border-border divide-y border-y text-xs">
    {facts.map((fact) => (
      <div key={fact.label} className="flex items-center justify-between gap-3 py-1.5">
        <dt className="text-muted-foreground">{fact.label}</dt>
        <dd className="text-foreground truncate text-right tabular-nums">{fact.value}</dd>
      </div>
    ))}
  </dl>
)

export const PickerPreviewNote: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
)

/* ── Footer ──────────────────────────────────────────────────────────── */

export const PickerFooter: FC<{ start: ReactNode; end: ReactNode }> = ({ start, end }) => (
  <div className="border-border bg-muted/30 flex flex-wrap items-center gap-3 border-t px-4 py-3">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">{start}</div>
    <div className="flex shrink-0 items-center gap-2">{end}</div>
  </div>
)

/** How much is chosen, said to a screen reader as it changes. */
export const PickerSummary: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-foreground text-xs font-medium tabular-nums" data-testid="picker-summary" aria-live="polite">
    {children}
  </span>
)

/** The keys the panel answers to, for a reader who would rather not reach for the mouse. */
export const PickerKeyHints: FC<{ hints: readonly { keys: string; label: string }[] }> = ({ hints }) => (
  <span className="text-muted-foreground hidden items-center gap-3 text-[11px] lg:flex" aria-hidden>
    {hints.map((hint) => (
      <span key={hint.label} className="inline-flex items-center gap-1.5">
        <Kbd className="h-5 min-w-5 text-[10px]">{hint.keys}</Kbd>
        {hint.label}
      </span>
    ))}
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
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 rounded text-xs underline-offset-2 transition-colors duration-quick hover:underline focus-visible:outline-none focus-visible:ring-2"
    >
      {label}
    </motion.button>
  )
)
PickerFooterAction.displayName = 'PickerFooterAction'
