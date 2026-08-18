'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { DocumentStatusBadge } from './document-status'
import { extChipTint, fileExtensionLabel } from '../document-kind'
import { nextSort, sortFiles, type FileSort, type FileSortKey } from '../lib/file-sort'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatBytes, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { documentDisplayName } from '@/lib/documents/display-name'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/**
 * The explorer's detail view — the one a person reaches for when the corpus has
 * grown past what a card grid can hold.
 *
 * Cards are a browsing surface: they answer "what is in here" for twelve
 * documents and stop scaling somewhere around forty, because each one costs a
 * thumbnail's worth of vertical space and the only orderable property is
 * whatever the API returned. A set of Einreichunterlagen is a hundred files
 * whose names are their index, and the questions asked of it are ordering
 * questions — which failed, what is the newest, which is the 200 MB one. This
 * view answers those: a dense sortable list, numeric-aware name ordering so
 * `Plan_2` precedes `Plan_10`, and full keyboard navigation.
 *
 * It is a THIRD view, not a replacement. The card grid stays the default.
 */

interface FileListViewProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  /** Per-row file operations. Clicks here must not select the row. */
  renderActions?: (file: FileItem) => ReactNode
}

const DEFAULT_SORT: FileSort = { key: 'added', direction: 'desc' }

/** Dense explorer cells — tighter than the admin Table default. */
const CELL = 'px-2 py-1.5 pointer-coarse:py-3'

export function FileListView({ files, selectedFileId, onSelectFile, renderActions }: FileListViewProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [sort, setSort] = useState<FileSort>(DEFAULT_SORT)
  const bodyRef = useRef<HTMLTableSectionElement>(null)

  const rows = useMemo(() => sortFiles(files, sort, locale), [files, sort, locale])

  /**
   * Roving focus down the list. A file list that cannot be walked with the
   * arrow keys is a list you have to aim at, and aiming at a 28px row is the
   * difference between skimming a hundred documents and hunting through them.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>, index: number) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (step !== 0) {
        event.preventDefault()
        const next = Math.min(rows.length - 1, Math.max(0, index + step))
        const target = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-file-row]')[next]
        target?.focus()
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelectFile(rows[index].id)
      }
    },
    [rows, onSelectFile]
  )

  return (
    <div className="px-4 pb-4 pt-1">
      <Table
        role="grid"
        className="border-separate border-spacing-0 text-left"
        data-testid="file-list-view"
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHeader
              label={t('list.columns.name')}
              column="name"
              sort={sort}
              onSort={setSort}
              className="w-auto"
            />
            <SortHeader
              label={t('list.columns.status')}
              column="status"
              sort={sort}
              onSort={setSort}
              className="w-[104px]"
            />
            {/* Below `sm` the row keeps only what identifies and what acts:
                name and status. Pages, size and date are reference columns. */}
            <TableHead
              scope="col"
              className="hidden h-auto w-[76px] px-2 py-1.5 text-right text-[10.5px] font-medium tracking-wider lg:table-cell"
            >
              {t('list.columns.pages')}
            </TableHead>
            <SortHeader
              label={t('list.columns.size')}
              column="size"
              sort={sort}
              onSort={setSort}
              align="right"
              className="hidden w-[104px] sm:table-cell"
            />
            <SortHeader
              label={t('list.columns.added')}
              column="added"
              sort={sort}
              onSort={setSort}
              align="right"
              className="hidden w-[120px] md:table-cell"
            />
            {renderActions && <TableHead scope="col" className="h-auto w-10 p-0" />}
          </TableRow>
        </TableHeader>
        <TableBody ref={bodyRef}>
          {rows.map((file, index) => {
            const ext = fileExtensionLabel(file.filename)
            const isSelected = selectedFileId === file.id
            return (
              <TableRow
                key={file.id}
                data-file-row
                data-testid="file-list-row"
                data-state={isSelected ? 'selected' : undefined}
                // Roving tabindex: one stop for the whole list, then arrows.
                tabIndex={index === 0 ? 0 : -1}
                aria-selected={isSelected}
                onClick={() => onSelectFile(file.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={cn(
                  'cursor-pointer focus-visible:outline-none',
                  'transition-colors duration-snap ease-out motion-reduce:transition-none',
                  isSelected ? 'bg-accent hover:bg-accent data-[state=selected]:bg-accent' : 'hover:bg-muted',
                  'focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'
                )}
              >
                <TableCell className={CELL}>
                  <div className="flex min-h-8 min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden
                      // 8.5px is load-bearing and stays: this glyph holds a four-letter
                      // extension ("DOCX") inside a 24px square, and the ramp's next
                      // step overflows it.
                      className="flex size-6 shrink-0 items-center justify-center rounded-sm text-[8.5px] font-bold uppercase leading-none"
                      style={extChipTint(ext)}
                    >
                      {ext || '—'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs font-medium leading-[1.4] text-foreground"
                        title={documentDisplayName(file)}
                      >
                        {documentDisplayName(file)}
                      </span>
                      {/* The summary earns its line here in a way it cannot on
                          a card: the row is already one line tall, so a second
                          one doubles the information without doubling the
                          scroll the way a taller card would. */}
                      {file.summary && (
                        <span className="block truncate text-xs leading-tight text-muted-foreground">
                          {file.summary}
                        </span>
                      )}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={CELL}>
                  {file.status && <DocumentStatusBadge status={file.status} />}
                </TableCell>
                <TableCell
                  className={cn(
                    'hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums lg:table-cell',
                    CELL
                  )}
                >
                  {file.pageCount ?? '—'}
                </TableCell>
                <TableCell
                  className={cn(
                    'hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums sm:table-cell',
                    CELL
                  )}
                >
                  {formatBytes(file.fileSize, locale)}
                </TableCell>
                <TableCell
                  className={cn(
                    'hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums md:table-cell',
                    CELL
                  )}
                >
                  <time
                    dateTime={file.createdAt}
                    title={formatAbsoluteTime(file.createdAt, locale)}
                    suppressHydrationWarning
                  >
                    {formatRelativeTime(file.createdAt, locale)}
                  </time>
                </TableCell>
                {renderActions && (
                  <TableCell
                    className="px-1 py-1.5 text-right"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {renderActions(file)}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * A sortable column header.
 *
 * `aria-sort` is the whole point of using a real table here: the direction is
 * announced rather than being carried only by an arrow glyph.
 */
function SortHeader({
  label,
  column,
  sort,
  onSort,
  align = 'left',
  className,
}: {
  label: string
  column: FileSortKey
  sort: FileSort
  onSort: (sort: FileSort) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const isActive = sort.key === column
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown

  return (
    <TableHead
      scope="col"
      aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('h-auto p-0', className)}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        className={cn(
          'flex w-full items-center gap-1 px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wider transition-colors duration-snap ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 motion-reduce:transition-none',
          align === 'right' && 'justify-end',
          isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {label}
        {/* The arrow is reserved space on every header, so activating a sort
            does not shift the row it lives in. */}
        <Arrow
          className={cn(
            'size-3 shrink-0 transition-opacity duration-snap ease-out motion-reduce:transition-none',
            isActive ? 'opacity-100' : 'opacity-0'
          )}
          aria-hidden
        />
      </button>
    </TableHead>
  )
}
