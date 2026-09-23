'use client'

/**
 * The document picker's atom kit: the pieces of an open panel, one decision
 * each. `DocumentPickerDialog` composes them and reaches for no Tailwind of
 * its own.
 *
 * The material is the design language's: ink and paper, hairlines, one
 * surface step for the sidebar. Selection is the one strong mark — an ink
 * disc with a check, as an open panel draws it — and it is contrast, never
 * chroma. A file is drawn by what it is (`DocumentKindThumbnail`, the Files
 * page's own sketches), so a floor plan in the picker looks like the floor
 * plan on the Files page.
 */

import type { CSSProperties, FC, KeyboardEvent, ReactNode } from 'react'
import { Check, ChevronRight, Folder, type LucideIcon } from 'lucide-react'
import { DocumentKindThumbnail } from '@/features/documents/components/document-kind-thumbnail'
import { inferDocumentKind } from '@/features/documents/document-kind'
import { cn } from '@/lib/utils'

/* ── Sidebar ─────────────────────────────────────────────────────────── */

export const PickerSidebar: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <nav
    className="bg-muted/50 border-border flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-2.5 max-md:hidden"
    aria-label={label}
    data-testid="picker-sidebar"
  >
    {children}
  </nav>
)

export const PickerSidebarGroup: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-muted-foreground px-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider">{label}</span>
    {children}
  </div>
)

export const PickerSidebarItem: FC<{
  icon: LucideIcon
  label: string
  count?: number
  active: boolean
  /** Indent for a folder under its location. */
  depth?: number
  onClick: () => void
  testId?: string
}> = ({ icon: Icon, label, count, active, depth = 0, onClick, testId }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    data-testid={testId}
    style={depth > 0 ? { paddingLeft: `${0.5 + depth * 0.875}rem` } : undefined}
    className={cn(
      'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] pointer-coarse:h-11',
      'transition-colors duration-quick motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      active ? 'bg-foreground/10 text-foreground font-medium' : 'text-foreground/80 hover:bg-foreground/5'
    )}
  >
    <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} aria-hidden />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {count !== undefined && count > 0 && (
      <span className="text-muted-foreground text-[11px] tabular-nums">{count}</span>
    )}
  </button>
)

/** The places as a row, on a phone, where the sidebar has no room. */
export const PickerPlaceStrip: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="border-border flex gap-1 overflow-x-auto border-b px-2 py-1.5 md:hidden [&>button]:w-auto [&>button]:shrink-0">
    {children}
  </div>
)

/* ── Toolbar ─────────────────────────────────────────────────────────── */

export const PickerToolbar: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="border-border flex min-h-11 flex-wrap items-center gap-2 border-b px-3 py-1.5">{children}</div>
)

export const PickerIconButton: FC<{
  icon: LucideIcon
  label: string
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  testId?: string
}> = ({ icon: Icon, label, disabled = false, pressed, onClick, testId }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    aria-pressed={pressed}
    title={label}
    data-testid={testId}
    className={cn(
      'text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md pointer-coarse:size-11',
      'hover:bg-accent hover:text-foreground transition-colors duration-quick motion-reduce:transition-none',
      'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
      'disabled:pointer-events-none disabled:opacity-35',
      pressed && 'bg-accent text-foreground'
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
          className={cn('flex items-center gap-0.5', last ? 'min-w-0 shrink-0 max-w-[60%]' : 'min-w-[2.5rem] shrink')}
        >
          {index > 0 && <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />}
          {segment.onClick && !last ? (
            <button
              type="button"
              onClick={segment.onClick}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 truncate rounded px-1 focus-visible:outline-none focus-visible:ring-2"
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
export const KindGlyph: FC<{ name: string; contentType?: string | null; tags?: readonly string[] | null; folder?: boolean; size?: 'sm' | 'lg' }> = ({
  name,
  contentType,
  tags,
  folder = false,
  size = 'sm',
}) => {
  const box = size === 'lg' ? 'h-28 w-full rounded-lg' : 'size-8 rounded-md'
  if (folder) {
    return (
      <span className={cn('bg-muted text-muted-foreground flex shrink-0 items-center justify-center', box)} aria-hidden>
        <Folder className={size === 'lg' ? 'size-10' : 'size-4'} fill="currentColor" fillOpacity={0.15} />
      </span>
    )
  }
  const kind = inferDocumentKind({ filename: name, contentType, tags: tags ? [...tags] : null })
  return (
    <span className={cn('bg-muted text-foreground/70 flex shrink-0 items-center justify-center overflow-hidden', box)} aria-hidden>
      <DocumentKindThumbnail kind={kind} className={size === 'lg' ? 'h-20 w-28' : 'h-6 w-8'} />
    </span>
  )
}

/** The selection mark: an empty ring, or an ink disc with a check. */
export const SelectMark: FC<{ checked: boolean; disabled?: boolean }> = ({ checked, disabled = false }) => (
  <span
    className={cn(
      'flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-quick motion-reduce:transition-none',
      checked ? 'bg-foreground border-foreground text-background' : 'border-muted-foreground/50 bg-card',
      disabled && 'opacity-40'
    )}
    aria-hidden
  >
    {checked && <Check className="size-3" strokeWidth={3} />}
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
    '--picker-cols-narrow': `1.25rem ${columns.filter((column) => !column.wide).map((column) => column.width).join(' ')}`,
  }) as CSSProperties

const tracks = '[grid-template-columns:var(--picker-cols-narrow)] sm:[grid-template-columns:var(--picker-cols)]'

export const PickerListHeader: FC<{
  columns: readonly PickerColumn[]
  sort: { key: string; direction: 'asc' | 'desc' }
  onSort: (key: string) => void
}> = ({ columns, sort, onSort }) => (
  <div
    className={cn(
      'border-border text-muted-foreground bg-card sticky top-0 z-10 grid items-center gap-3 border-b px-3 py-1.5 text-[11px] font-medium',
      tracks
    )}
    style={trackStyle(columns)}
    role="presentation"
  >
    <span />
    {columns.map((column) => (
      <button
        key={column.key}
        type="button"
        onClick={() => onSort(column.key)}
        className={cn(
          'hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2',
          column.align === 'end' && 'justify-end',
          column.wide && 'max-sm:hidden',
          sort.key === column.key && 'text-foreground'
        )}
        aria-label={column.label}
      >
        {column.label}
        {sort.key === column.key && <span aria-hidden>{sort.direction === 'asc' ? '↑' : '↓'}</span>}
      </button>
    ))}
  </div>
)

interface ItemProps {
  selected: boolean
  focused: boolean
  /** Why it cannot be chosen, shown in place of the mark. */
  disabledReason?: string | null
  onClick: (event: { shiftKey: boolean; metaKey: boolean }) => void
  onDoubleClick: () => void
  testId?: string
}

const itemState = (selected: boolean, focused: boolean, disabled: boolean) =>
  cn(
    'transition-colors duration-quick motion-reduce:transition-none',
    selected ? 'bg-foreground/[0.07]' : 'hover:bg-accent/60',
    focused && 'ring-foreground/40 ring-1 ring-inset',
    disabled && 'cursor-default opacity-55'
  )

/** One row of the list view: mark, glyph and name, then the columns. */
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
  <div
    role="option"
    aria-selected={folder ? undefined : selected}
    aria-disabled={disabledReason ? true : undefined}
    data-testid={testId}
    data-selected={selected || undefined}
    onClick={(event) => onClick({ shiftKey: event.shiftKey, metaKey: event.metaKey || event.ctrlKey })}
    onDoubleClick={onDoubleClick}
    className={cn(
      'grid cursor-default select-none items-center gap-3 px-3 py-1.5',
      tracks,
      itemState(selected, focused, Boolean(disabledReason))
    )}
    style={trackStyle(columns)}
  >
    {folder ? <span /> : <SelectMark checked={selected} disabled={Boolean(disabledReason)} />}
    <span className="flex min-w-0 items-center gap-2.5">
      {glyph}
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground truncate text-[13px]">{name}</span>
        {(disabledReason || meta) && (
          <span className="text-muted-foreground truncate text-[11px]">{disabledReason ?? meta}</span>
        )}
      </span>
      {folder && <ChevronRight className="text-muted-foreground ml-auto size-3.5 shrink-0" aria-hidden />}
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
  </div>
)

/** One tile of the grid view: the sketch large, the name under it, the mark in its corner. */
export const PickerTile: FC<
  ItemProps & { glyph: ReactNode; name: string; meta?: string; folder?: boolean }
> = ({ glyph, name, meta, folder = false, selected, focused, disabledReason, onClick, onDoubleClick, testId }) => (
  <div
    role="option"
    aria-selected={folder ? undefined : selected}
    aria-disabled={disabledReason ? true : undefined}
    data-testid={testId}
    data-selected={selected || undefined}
    onClick={(event) => onClick({ shiftKey: event.shiftKey, metaKey: event.metaKey || event.ctrlKey })}
    onDoubleClick={onDoubleClick}
    className={cn(
      'relative flex cursor-default select-none flex-col gap-1.5 rounded-lg p-2',
      itemState(selected, focused, Boolean(disabledReason))
    )}
  >
    {glyph}
    {!folder && (
      <span className="absolute right-3 top-3">
        <SelectMark checked={selected} disabled={Boolean(disabledReason)} />
      </span>
    )}
    <span className="text-foreground line-clamp-2 text-center text-xs leading-snug">{name}</span>
    {(disabledReason || meta) && (
      <span className="text-muted-foreground truncate text-center text-[10.5px]">{disabledReason ?? meta}</span>
    )}
  </div>
)

/** The item area: a list box the arrow keys walk. */
export const PickerItems: FC<{
  label: string
  view: 'list' | 'grid'
  multiple: boolean
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  header?: ReactNode
  children: ReactNode
}> = ({ label, view, multiple, onKeyDown, header, children }) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="picker-items">
    {header}
    <div
      role="listbox"
      aria-label={label}
      aria-multiselectable={multiple || undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        'focus-visible:ring-ring/40 min-h-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
        view === 'grid' ? 'grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1 p-2' : 'flex flex-col py-0.5'
      )}
    >
      {children}
    </div>
  </div>
)

export const PickerEmpty: FC<{ icon: LucideIcon; children: ReactNode }> = ({ icon: Icon, children }) => (
  <div className="text-muted-foreground col-span-full flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-sm">
    <Icon className="size-8 opacity-40" aria-hidden />
    {children}
  </div>
)

/* ── Preview ─────────────────────────────────────────────────────────── */

export const PickerPreviewPane: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <aside
    className="border-border flex min-h-0 flex-col gap-3 overflow-y-auto border-l p-3 max-lg:hidden"
    aria-label={label}
    data-testid="picker-preview"
  >
    {children}
  </aside>
)

export const PickerFacts: FC<{ facts: readonly { label: string; value: ReactNode }[] }> = ({ facts }) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
    {facts.map((fact) => (
      <div key={fact.label} className="contents">
        <dt className="text-muted-foreground">{fact.label}</dt>
        <dd className="text-foreground truncate text-right">{fact.value}</dd>
      </div>
    ))}
  </dl>
)

export const PickerPreviewTitle: FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <div className="flex flex-col gap-0.5">
    <p className="text-foreground break-words text-sm font-semibold leading-snug">{title}</p>
    {subtitle && <p className="text-muted-foreground break-all text-[11px]">{subtitle}</p>}
  </div>
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
  <span className="text-muted-foreground text-xs tabular-nums" data-testid="picker-summary" aria-live="polite">
    {children}
  </span>
)
