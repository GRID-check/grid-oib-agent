'use client'

import { type ReactNode } from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { FileSearchState } from '../hooks/use-file-search'
import { FileSearchField } from './file-search'

/** Presentation of the Files listing. Mirrors the workspace's own `FileView`. */
export type FileWorkspaceView = 'cards' | 'list'

/**
 * The Files search field with this surface's labels on it.
 *
 * Its own export because the field is rendered in TWO places and must be the
 * same control in both: in the header row from `lg` up, and full width at the
 * top of the listing below that. Only one of the two is ever displayed —
 * `display:none` keeps the other out of the accessibility tree as well as out
 * of the layout — so a reader never meets two search boxes.
 */
export function FileWorkspaceSearchField({
  search,
  className,
}: {
  search: FileSearchState
  className?: string
}) {
  const t = useTranslations('files')
  return (
    <FileSearchField
      className={className}
      value={search.query}
      onChange={search.setQuery}
      onSubmit={search.submit}
      onClear={search.clear}
      placeholder={t('browser.searchPlaceholder')}
      searchLabel={t('browser.searchLabel')}
      resetLabel={t('browser.resetSearch')}
      canSearch={search.canSearch}
      runLabel={t('browser.semantic.run')}
      isSearching={search.semantic.isSearching}
    />
  )
}

export interface FileWorkspaceActionsProps {
  search: FileSearchState
  view: FileWorkspaceView
  onViewChange: (view: FileWorkspaceView) => void
  /** Faces, Unvergeben, Zuweisen — behind the collaboration flag. Absent = no filter. */
  assignmentFilter?: 'all' | 'mine' | 'unassigned'
  onAssignmentFilterChange?: (filter: 'all' | 'mine' | 'unassigned') => void
  /** The upload control, which needs the project and folder the workspace holds. */
  upload?: ReactNode
}

/**
 * Everything that acts on the Files page, in the page's own header.
 *
 * Its own component so the `/dev/file-browser` fixture can render the REAL row
 * inside a real `PageHeader` — the wrap below is the thing most likely to be
 * wrong, and a hand-rolled lookalike in the fixture would be evidence for the
 * lookalike rather than for the page.
 *
 * Two things keep it inside the page on a narrow window, because `PageHeader`
 * puts its action slot in a `shrink-0` box: a slot sized by its content is laid
 * out as if the line were infinite, so nothing ever moves to a second row and
 * the whole row simply runs off the side.
 *
 * First, the SEARCH FIELD is not here below `lg` — a field, two toggle groups
 * and an upload button do not share a line with a page title on a phone, and
 * squeezing them until they do would leave the title a word wide. Below `lg`
 * the listing renders the same field full width at its top instead, which is
 * where it used to live anyway.
 *
 * Second, the row is clamped and allowed to wrap, so what remains can still
 * take a second line rather than pushing the title out of the header.
 */
export function FileWorkspaceActions({
  search,
  view,
  onViewChange,
  assignmentFilter,
  onAssignmentFilterChange,
  upload,
}: FileWorkspaceActionsProps) {
  const t = useTranslations('files')

  return (
    <div className="flex max-w-[60vw] flex-wrap items-center justify-end gap-2 lg:max-w-none">
      <FileWorkspaceSearchField search={search} className="hidden lg:flex" />
      <ToggleGroup
        type="single"
        value={view}
        onValueChange={(value) => {
          if (value === 'cards' || value === 'list') onViewChange(value)
        }}
        segmented
        size="icon-sm"
        aria-label={t('workspace.view.label')}
      >
        <ToggleGroupItem
          value="cards"
          aria-label={t('workspace.view.cards')}
          title={t('workspace.view.cards')}
        >
          <LayoutGrid />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="list"
          aria-label={t('workspace.view.list')}
          title={t('workspace.view.list')}
        >
          <List />
        </ToggleGroupItem>
      </ToggleGroup>
      {assignmentFilter && onAssignmentFilterChange && (
        <ToggleGroup
          type="single"
          value={assignmentFilter}
          onValueChange={(value) => {
            if (value === 'all' || value === 'mine' || value === 'unassigned')
              onAssignmentFilterChange(value)
          }}
          size="sm"
          aria-label={t('assignment.responsible')}
        >
          {(['all', 'mine', 'unassigned'] as const).map((key) => (
            <ToggleGroupItem key={key} value={key} className="px-2 text-xs">
              {t(
                key === 'all'
                  ? 'assignment.filterAll'
                  : key === 'mine'
                    ? 'assignment.filterMine'
                    : 'assignment.filterUnassigned'
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {upload}
    </div>
  )
}
