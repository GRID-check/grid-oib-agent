'use client'

import type { ReactNode } from 'react'
import { ArrowDownNarrowWide, ArrowUpNarrowWide, SlidersHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CountPill } from '@/components/ui/count-pill'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionLabel } from '@/components/ui/section-label'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { DocumentKind } from '../document-kind'
import {
  FILE_KIND_FILTERS,
  FILE_STATUS_GROUPS,
  activeFilterCount,
  toggleIn,
  type AssignmentFilter,
  type FileFilters,
  type FileStatusGroup,
} from '../lib/file-filters'
import { defaultDirectionFor, type FileSort, type FileSortKey } from '../lib/file-sort'

/**
 * Every way of narrowing and ordering the Dateien listing, behind one button.
 *
 * ## Why this replaced the strip
 *
 * The filters used to sit open in the section header: a three-segment assignment
 * group plus a `Von Piloti` toggle, beside a view switch, a `lg:w-72` search
 * field and an upload button. That row wants about 1100px and gets ~900 inside
 * the sidebar, so it took its width out of the page title — the Dateien subtitle
 * rendered as a one-to-two-word column. The header fix in `PageHeader` stops the
 * title paying for it, but the row was still the busiest thing on the page and
 * had no room left for the filters people actually asked for.
 *
 * Folding them into a popover buys that room. It costs one click to reach a
 * filter, and the count badge is what pays it back: the state a strip carried by
 * showing a pressed chip is carried here by a number, so a reader can still see
 * at a glance that the listing is narrowed — which is the one thing a hidden
 * filter must never take away.
 *
 * ## Why sorting is in here too
 *
 * Ordering was a property of the DETAIL view: `FileListView` held its own sort
 * state and the card grid had none, so switching to Kacheln silently discarded
 * the order you had chosen and the answer to "what is the newest" was only
 * available in one of the two views. Sorting is a question about the listing,
 * not about how the listing is drawn, so it lives with the filters and both
 * views read it. The list's column headers still set it — they write to the same
 * state.
 */
export interface FileFilterMenuProps {
  /** Assignment is behind the collaboration flag; nothing else here is. */
  canCollaborate: boolean
  filters: FileFilters
  onFiltersChange: (next: FileFilters) => void
  sort: FileSort
  onSortChange: (next: FileSort) => void
  /**
   * Ordering is the ranking's own and must not be offered.
   *
   * A semantic result set is ranked, and re-sorting it by upload date throws
   * that ranking away without saying so — the same rule `FileListView` already
   * keeps. The section is hidden rather than disabled: there is nothing the
   * reader could do to enable it short of clearing a search they meant.
   */
  sortDisabled?: boolean
  /** Fixture escape hatch: renders the popover open for the visual registry. */
  defaultOpen?: boolean
}

/** The columns worth offering as an explicit order. `relevance` is not one — it is a search's own. */
const SORT_KEYS: readonly FileSortKey[] = ['added', 'name', 'status', 'size']

const ASSIGNMENT_FILTERS: readonly AssignmentFilter[] = ['all', 'mine', 'unassigned']

const ASSIGNMENT_LABEL_KEY: Record<AssignmentFilter, string> = {
  all: 'assignment.filterAll',
  mine: 'assignment.filterMine',
  unassigned: 'assignment.filterUnassigned',
}

export function FileFilterMenu({
  canCollaborate,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  sortDisabled = false,
  defaultOpen,
}: FileFilterMenuProps): JSX.Element {
  const t = useTranslations('files')
  const count = activeFilterCount(filters, canCollaborate)

  const setKinds = (kind: DocumentKind) =>
    onFiltersChange({ ...filters, kinds: toggleIn(filters.kinds, kind, FILE_KIND_FILTERS) })
  const setStatuses = (group: FileStatusGroup) =>
    onFiltersChange({
      ...filters,
      statuses: toggleIn(filters.statuses, group, FILE_STATUS_GROUPS),
    })

  const DirectionIcon = sort.direction === 'asc' ? ArrowUpNarrowWide : ArrowDownNarrowWide

  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          data-testid="file-filter-menu-trigger"
          // The count is IN the accessible name, not only in the pill: a badge a
          // screen reader does not read is a state change nobody announced.
          aria-label={count > 0 ? t('filters.labelActive', { count }) : t('filters.label')}
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          {t('filters.label')}
          {count > 0 && (
            <CountPill tone="attention" aria-hidden data-testid="file-filter-count">
              {count}
            </CountPill>
          )}
        </Button>
      </PopoverTrigger>
      {/* Five sections is taller than a short laptop's viewport with the
          header above it, and a popover that runs off the bottom of the screen
          hides the reset. It scrolls inside itself rather than growing. */}
      <PopoverContent
        align="end"
        className="max-h-[min(70vh,34rem)] w-72 space-y-4 overflow-y-auto p-4"
        data-testid="file-filter-menu"
      >
        {!sortDisabled && (
          <FilterSection label={t('filters.sortLabel')}>
            <div className="flex items-center gap-1.5">
              <ToggleGroup
                type="single"
                value={sort.key}
                onValueChange={(value) => {
                  // Radix answers '' when the pressed item is pressed again.
                  // There is no "unordered" listing, so that is ignored rather
                  // than turned into an arbitrary order.
                  if (SORT_KEYS.includes(value as FileSortKey)) {
                    const key = value as FileSortKey
                    // A new column takes ITS OWN default direction — names read
                    // forwards, everything else newest/biggest first — instead
                    // of inheriting the direction of the column before it.
                    onSortChange({ key, direction: defaultDirectionFor(key) })
                  }
                }}
                size="sm"
                className="flex-wrap justify-start"
                aria-label={t('filters.sortLabel')}
              >
                {SORT_KEYS.map((key) => (
                  <ToggleGroupItem key={key} value={key} className="px-2 text-xs">
                    {t(`list.columns.${key}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1.5 w-full justify-start gap-2 px-2 text-xs font-normal"
              onClick={() =>
                onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
              }
              data-testid="file-filter-direction"
            >
              <DirectionIcon className="size-3.5" aria-hidden />
              {t(sort.direction === 'asc' ? 'filters.ascending' : 'filters.descending')}
            </Button>
          </FilterSection>
        )}

        {canCollaborate && (
          <>
            <Separator />
            <FilterSection label={t('assignment.responsible')}>
              <ToggleGroup
                type="single"
                value={filters.assignment}
                onValueChange={(value) => {
                  if (value === 'all' || value === 'mine' || value === 'unassigned') {
                    onFiltersChange({ ...filters, assignment: value })
                  }
                }}
                size="sm"
                className="flex-wrap justify-start"
                aria-label={t('assignment.responsible')}
              >
                {ASSIGNMENT_FILTERS.map((key) => (
                  <ToggleGroupItem key={key} value={key} className="px-2 text-xs">
                    {t(ASSIGNMENT_LABEL_KEY[key])}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FilterSection>
          </>
        )}

        <Separator />
        {/* Provenance, and deliberately its own section rather than an eighth
            Dateityp. „Von Piloti" answers who WROTE the file, which ANDs with
            every other filter here — the lead looking for the reports nobody
            has taken on yet needs `Unvergeben` and `Von Piloti` at once, and a
            value inside the kind list would have made that unaskable. */}
        <FilterSection label={t('filters.originLabel')}>
          <CheckRow
            id="file-filter-agent-authored"
            checked={filters.agentAuthoredOnly}
            onChange={() =>
              onFiltersChange({ ...filters, agentAuthoredOnly: !filters.agentAuthoredOnly })
            }
            label={t('authorship.filter')}
          />
        </FilterSection>

        <Separator />
        <FilterSection label={t('filters.statusLabel')}>
          {FILE_STATUS_GROUPS.map((group) => (
            <CheckRow
              key={group}
              id={`file-filter-status-${group}`}
              checked={filters.statuses.includes(group)}
              onChange={() => setStatuses(group)}
              label={t(`filters.status.${group}`)}
            />
          ))}
        </FilterSection>

        <Separator />
        <FilterSection label={t('filters.kindLabel')}>
          {FILE_KIND_FILTERS.map((kind) => (
            <CheckRow
              key={kind}
              id={`file-filter-kind-${kind}`}
              checked={filters.kinds.includes(kind)}
              onChange={() => setKinds(kind)}
              label={t(`filters.kind.${kind}`)}
            />
          ))}
        </FilterSection>

        <Separator />
        {/* Disabled, not hidden: a reset that appears only once something is on
            moves the other controls under the cursor the moment a filter is
            pressed. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={count === 0}
          onClick={() =>
            onFiltersChange({ assignment: 'all', agentAuthoredOnly: false, kinds: [], statuses: [] })
          }
          data-testid="file-filter-reset"
        >
          {t('filters.reset')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function FilterSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <SectionLabel as="h3">{label}</SectionLabel>
      {children}
    </div>
  )
}

/**
 * A checkbox and its label as one hit target.
 *
 * `htmlFor` rather than nesting, because Radix's checkbox is a button and a
 * button may not contain the label that activates it.
 */
function CheckRow({
  id,
  checked,
  onChange,
  label,
}: {
  id: string
  checked: boolean
  onChange: () => void
  label: string
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id} className="cursor-pointer text-sm leading-none">
        {label}
      </label>
    </div>
  )
}
