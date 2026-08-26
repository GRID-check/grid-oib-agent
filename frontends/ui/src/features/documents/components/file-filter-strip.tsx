'use client'

import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'

/** Who is on the hook — `Alle · Meine · Unvergeben`, one at a time. */
export type AssignmentFilter = 'all' | 'mine' | 'unassigned'

const ASSIGNMENT_FILTERS: readonly AssignmentFilter[] = ['all', 'mine', 'unassigned']

const ASSIGNMENT_LABEL_KEY: Record<AssignmentFilter, string> = {
  all: 'assignment.filterAll',
  mine: 'assignment.filterMine',
  unassigned: 'assignment.filterUnassigned',
}

export interface FileFilterStripProps {
  /** Assignment is behind the collaboration flag; authorship is not. */
  canCollaborate: boolean
  assignmentFilter: AssignmentFilter
  onAssignmentFilterChange: (next: AssignmentFilter) => void
  agentAuthoredOnly: boolean
  onAgentAuthoredOnlyChange: (next: boolean) => void
}

/**
 * The Files filter strip: the assignment segment plus the `Von Piloti` chip.
 *
 * Two filters, deliberately NOT one control. `Alle · Meine · Unvergeben` are
 * mutually exclusive answers to "who is responsible for this file"; `Von
 * Piloti` answers "who wrote it", which is a different question and ANDs with
 * the first one — the lead who wants the reports nobody has taken on yet needs
 * `Unvergeben` AND `Von Piloti` at the same time, and a fourth segment in the
 * group would have made that unaskable. It also keeps the two vocabularies
 * apart on screen, which the file-native design requires of provenance and
 * responsibility everywhere else.
 *
 * The chip is not behind the collaboration flag: authorship exists whether or
 * not a project assigns work, and a project with collaboration off still needs
 * to find what Piloti wrote.
 */
export function FileFilterStrip({
  canCollaborate,
  assignmentFilter,
  onAssignmentFilterChange,
  agentAuthoredOnly,
  onAgentAuthoredOnlyChange,
}: FileFilterStripProps) {
  const t = useTranslations('files')

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="file-filter-strip">
      {canCollaborate && (
        <ToggleGroup
          type="single"
          value={assignmentFilter}
          onValueChange={(value) => {
            // Radix answers '' when the pressed item is pressed again; a filter
            // strip has no "nothing selected" state, so that is ignored rather
            // than turned into an empty listing.
            if (value === 'all' || value === 'mine' || value === 'unassigned') onAssignmentFilterChange(value)
          }}
          size="sm"
          aria-label={t('assignment.responsible')}
        >
          {ASSIGNMENT_FILTERS.map((key) => (
            <ToggleGroupItem key={key} value={key} className="px-2 text-xs">
              {t(ASSIGNMENT_LABEL_KEY[key])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {/* Same height, same padding, same type as the segments beside it — it is
          another filter, not a feature announcement. */}
      <Toggle
        pressed={agentAuthoredOnly}
        onPressedChange={onAgentAuthoredOnlyChange}
        size="sm"
        className="px-2 text-xs"
        data-testid="filter-agent-authored"
      >
        {t('authorship.filter')}
      </Toggle>
    </div>
  )
}
