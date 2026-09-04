'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { DocumentStatusBadge } from './document-status'
import { extChipTint, fileExtensionLabel } from '../document-kind'
import { DEFAULT_FILE_SORT, RELEVANCE_SORT, nextSort, sortFiles, type FileSort, type FileSortKey } from '../lib/file-sort'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatBytes, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { documentDisplayName } from '@/lib/documents/display-name'
import { Skeleton } from '@/components/ui/skeleton'
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

/** A listing row, optionally carrying the evidence for a semantic match. */
export type FileListRow = FileItem & { snippet?: string; page?: number | null; score?: number }

interface FileListViewProps {
  files: FileListRow[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  /** Per-row file operations. Clicks here must not select the row. */
  renderActions?: (file: FileItem) => ReactNode
  /**
   * These rows are RANKED semantic results, not a plain listing.
   *
   * Relevance becomes a column and the default order, and each row shows the
   * passage that matched in place of the document's summary. Without this the
   * list would re-sort a ranked answer by upload date and throw the ranking
   * away without saying so.
   */
  semantic?: boolean
  /**
   * The listing's order, when somebody outside owns it.
   *
   * The workspace does, so its filter menu and these column headers set the
   * same thing and switching to the card grid keeps the order. Left out — by
   * the semantic branches, and by fixtures — the view falls back to holding it
   * itself, which is what it did before the order was lifted.
   */
  sort?: FileSort
  onSortChange?: (next: FileSort) => void
}

/** A 0..1 backend score as the whole percent the reader sees. */
const percentOf = (score: number | undefined): number =>
  Math.max(0, Math.min(100, Math.round((score ?? 0) * 100)))

/** Dense explorer cells — tighter than the admin Table default. */
const CELL = 'px-2 py-1.5 pointer-coarse:py-3'

export function FileListView({
  files,
  selectedFileId,
  onSelectFile,
  renderActions,
  semantic = false,
  sort: controlledSort,
  onSortChange,
}: FileListViewProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [uncontrolledSort, setUncontrolledSort] = useState<FileSort>(
    semantic ? RELEVANCE_SORT : DEFAULT_FILE_SORT
  )
  // A ranked result set keeps its own relevance order whatever the workspace
  // holds — the same rule as the menu, which hides the sort section while a
  // semantic search is active.
  const sort = semantic || !controlledSort ? uncontrolledSort : controlledSort
  const setSort = semantic || !onSortChange ? setUncontrolledSort : onSortChange
  const bodyRef = useRef<HTMLTableSectionElement>(null)

  const rows = useMemo(() => sortFiles(files, sort, locale), [files, sort, locale])

  /**
   * Which row owns the list's single tab stop.
   *
   * A roving tabindex that never roves is worse than none: the stop stayed
   * pinned to row 0, so tabbing out of row 30 and back landed the reader at the
   * top of a hundred-row list, and shift-tabbing out of a row's action menu
   * skipped every row to reach the header. Clamped, because the set shrinks
   * under the cursor when a filter narrows it.
   */
  const [focusedIndex, setFocusedIndex] = useState(0)
  const tabStop = Math.min(focusedIndex, Math.max(0, rows.length - 1))

  /**
   * Roving focus down the list. A file list that cannot be walked with the
   * arrow keys is a list you have to aim at, and aiming at a 28px row is the
   * difference between skimming a hundred documents and hunting through them.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>, index: number) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      // Home/End are what a hundred-row list is actually walked with; arrowing
      // from the last row to the first is thirty keystrokes nobody presses.
      const absolute = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null
      if (step !== 0 || absolute !== null) {
        event.preventDefault()
        const next = absolute ?? Math.min(rows.length - 1, Math.max(0, index + step))
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
      {/* `table-fixed` IS THE TRUNCATION. Every filename cell below already
          carries `truncate`, and under the browser's default `table-layout: auto`
          that class did nothing at all: auto layout sizes a column to its
          content's minimum, a filename does not wrap, so the minimum IS the whole
          name. Measured on a 390px phone the Name column came out 437px inside a
          308px wrapper — the `overflow-x-auto` on the Table primitive caught it,
          so nothing looked broken, and the reader simply had to drag the list
          sideways to find out what any of their documents were called.
          Dropping columns at `sm`/`md`/`lg` (below) never touched this: it
          removes the columns that were not the problem.

          Fixed layout makes the declared widths mean what they say and hands the
          rest to the one `w-auto` column, so the name gets whatever the viewport
          has left and the ellipsis finally engages. Desktop is unchanged in
          practice — there the name column was already taking the remainder. */}
      <Table
        role="grid"
        className="table-fixed border-separate border-spacing-0 text-left"
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
            {semantic && (
              <SortHeader
                label={t('list.columns.relevance')}
                column="relevance"
                sort={sort}
                onSort={setSort}
                align="right"
                // Relevance is a reference column too, and it was the one that
                // never said so: `pages`, `size` and `added` all step out below
                // their breakpoints and this stayed at every width, taking 92px
                // out of the Name column on the narrowest screen there is. In a
                // ranked list the rows already ARRIVE in relevance order and each
                // one carries the matched passage under its name — the percentage
                // refines that, it does not carry it.
                className="hidden w-[92px] sm:table-cell"
              />
            )}
            <SortHeader
              label={t('list.columns.status')}
              column="status"
              sort={sort}
              onSort={setSort}
              // 104px at every width, and NOT the 84px this briefly narrowed to.
              // The badge is `whitespace-nowrap w-fit`, so a cell too small for
              // it does not clip — the badge simply renders over its neighbour.
              // Sized in English that looked fine; German is where it showed:
              // "Wird hochgeladen" and "Wird verarbeitet" are ~122px at
              // `text-xs` + `px-2.5`, against the 68px an 84px cell leaves after
              // its own padding. The cell is the containing box, so the width has
              // to be one the badge can be made to fit inside — see the `truncate`
              // on the badge below, which is the other half of this.
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
                tabIndex={index === tabStop ? 0 : -1}
                aria-selected={isSelected}
                onClick={() => onSelectFile(file.id)}
                onFocus={() => setFocusedIndex(index)}
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
                      {/* In a ranked result the second line is WHY this row is
                          here. The summary describes the document; the snippet
                          answers the query, and a search result that hides it
                          asks the reader to take the ranking on trust. */}
                      {semantic ? (
                        (file.snippet ?? '') !== '' && (
                          <span
                            className="block truncate text-xs leading-tight text-muted-foreground"
                            title={file.snippet}
                            data-testid="file-list-snippet"
                          >
                            {file.page !== null && file.page !== undefined && (
                              <span className="mr-1 font-medium tabular-nums text-primary/80">
                                {t('browser.semantic.page', { page: String(file.page) })}
                              </span>
                            )}
                            {file.snippet}
                          </span>
                        )
                      ) : (
                        file.summary && (
                          <span className="block truncate text-xs leading-tight text-muted-foreground">
                            {file.summary}
                          </span>
                        )
                      )}
                    </span>
                  </div>
                </TableCell>
                {semantic && (
                  <TableCell
                    className={cn(
                      'hidden whitespace-nowrap text-right text-xs tabular-nums sm:table-cell',
                      CELL,
                    )}
                  >
                    <span
                      className="font-medium text-foreground"
                      title={t('browser.semantic.relevance', { percent: String(percentOf(file.score)) })}
                      data-testid="file-list-relevance"
                    >
                      {percentOf(file.score)}%
                    </span>
                  </TableCell>
                )}
                <TableCell className={CELL}>
                  {/* `max-w-full truncate` is what keeps a long localized status
                      inside its column. The badge is `w-fit whitespace-nowrap`,
                      so without a ceiling it renders at whatever width its label
                      needs and simply overlaps the cell beside it — invisible in
                      English ("Citable"), plainly wrong in German ("Wird
                      hochgeladen"). `title` carries the full label for the states
                      that do get clipped, which are the transient ones. */}
                  {file.status && (
                    <DocumentStatusBadge status={file.status} className="max-w-full truncate" />
                  )}
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
          // Sorting is how you find a document in a long list, and on a phone it
          // is the only way — there is no second pane to scan. The header sat at
          // 26px. Padding rather than a catchment: these are adjacent cells in one
          // row, so an overhang would put each header's target on top of its
          // neighbour's.
          // `min-h-11` rather than more padding: the label is 10.5px, so reaching
          // 44 by padding alone means guessing at the leading and landing near it
          // (`py-3.5` measured 42). The `<th>` above is `h-auto p-0`, so the
          // button owns the whole cell and a min-height is exact.
          'flex w-full items-center gap-1 px-2 py-1.5 pointer-coarse:min-h-11 text-[10.5px] font-medium uppercase tracking-wider transition-colors duration-snap ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 motion-reduce:transition-none',
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

/**
 * The detail view, waiting.
 *
 * A card grid was drawn here whatever the reader had chosen, so running a search
 * from the list showed a wall of card skeletons and then snapped to a table —
 * a layout flash announcing a change that was never going to happen. Shaped like
 * the rows it stands in for, so what arrives lands where the placeholder was.
 */
export function FileListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1 px-4 pb-4 pt-6" data-testid="file-list-skeleton">
      {/*
        THE COLUMN HEADINGS ARE PART OF THE SHAPE.
        This drew rows and no header, so the detail view's first frame was six
        grey lines that then jumped down by a header's height the moment the
        answer arrived — on the one view a reader chooses precisely because it
        is dense and stable. The headings are real words, not grey bars: they
        are known before the listing is, and they tell a reader what they are
        about to be looking at while they wait for it.
      */}
      <FileListSkeletonHeader />
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-2.5 px-2 py-1.5">
          <Skeleton className="size-6 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
          <Skeleton className="hidden h-3 w-12 shrink-0 sm:block" />
          <Skeleton className="hidden h-3 w-16 shrink-0 md:block" />
        </div>
      ))}
    </div>
  )
}

/** The heading strip above the placeholder rows — same widths as the real columns. */
function FileListSkeletonHeader(): JSX.Element {
  const t = useTranslations('files')
  return (
    <div className="text-muted-foreground flex items-center gap-2.5 border-b px-2 pb-1.5 text-[10.5px] font-medium tracking-wider">
      <span className="min-w-0 flex-1">{t('list.columns.name')}</span>
      <span className="w-[104px] shrink-0">{t('list.columns.status')}</span>
      <span className="hidden w-[76px] shrink-0 text-right lg:block">{t('list.columns.pages')}</span>
      <span className="hidden w-[104px] shrink-0 text-right sm:block">{t('list.columns.size')}</span>
      <span className="hidden w-[104px] shrink-0 text-right sm:block">{t('list.columns.added')}</span>
    </div>
  )
}
