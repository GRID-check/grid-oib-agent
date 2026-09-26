'use client'

/**
 * The project's delegated work — one column of cards, grouped by when it was
 * asked for, with a filter row above it.
 *
 * This list is the runs half of the Tasks tab: things that HAPPENED, read
 * newest-first. The standing tasks behind them — scheduled or manual — render
 * below it as their own section, and the timetable VIEW reads the same set as
 * a week. One set of tasks, three readings; the view toggle above them is a
 * preference, not a destination.
 *
 * ONE COLUMN, not a grid. A grid is right for things that are peers in space —
 * files, projects, schedules — and wrong for things that are peers in TIME: a
 * reader scanning for "the one from this morning" reads a column down, and a
 * two-up grid makes them read in a boustrophedon. The recency headings are the
 * other half of that: they turn "47 rows" into "3 today, 2 yesterday, the
 * rest", which is a shape a person can hold.
 *
 * The filter row is not a convenience. `unreviewed` is the surface's real job —
 * a finished task nobody judged is an open loop, and an invisible open loop
 * never closes — and its count is the number a person should want at zero.
 */

import type { JSX } from 'react'
import { CircleDashed, Inbox } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import {
  TASK_FILTERS,
  filterCounts,
  groupByRecency,
  matchesFilter,
  type TaskFilter,
  type TaskWireRow,
} from '../lib/task-view'
import { TaskCard } from './task-card'

export interface TaskListProps {
  projectId: string
  tasks: readonly TaskWireRow[]
  loading?: boolean
  failed?: boolean
  filter: TaskFilter
  onFilterChange: (filter: TaskFilter) => void
  onSelectTask: (task: TaskWireRow) => void
  /** Retries the tasks load after a failure. */
  onRetry?: () => void
}

export function TaskList({
  projectId,
  tasks,
  loading,
  failed,
  filter,
  onFilterChange,
  onSelectTask,
  onRetry,
}: TaskListProps): JSX.Element {
  const t = useTranslations('tasks')
  const counts = filterCounts(tasks)
  const visible = tasks.filter((task) => matchesFilter(task, filter))
  const groups = groupByRecency(visible)

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4 md:p-6" data-testid="task-list-loading">
        <div className="flex flex-col gap-3" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="bg-muted/50 rounded-lg border p-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2.5 h-3.5 w-full" />
              <Skeleton className="mt-1.5 h-3.5 w-3/5" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (failed) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
        <EmptyState
          icon={CircleDashed}
          tone="destructive"
          title={t('list.errorTitle')}
          description={t('list.errorDescription')}
          action={
            onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t('list.retry')}
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6" data-testid="task-list">
      {/* Counts on the chips, not only in the list: the number is the point of
          `unreviewed`, and a filter a reader has to click to discover is empty
          costs them a click to learn nothing. A zero count still renders — an
          absent number reads as "unknown", which is a different claim. */}
      <ToggleGroup
        type="single"
        value={filter}
        onValueChange={(value) => {
          if ((TASK_FILTERS as readonly string[]).includes(value)) onFilterChange(value as TaskFilter)
        }}
        segmented
        size="sm"
        aria-label={t('filters.label')}
        className="mb-4"
        data-testid="task-filters"
      >
        {TASK_FILTERS.map((option) => (
          <ToggleGroupItem key={option} value={option} data-testid={`task-filter-${option}`}>
            {t(`filters.${option}`)}
            <CountPill
              tone={option === 'unreviewed' && counts.unreviewed > 0 ? 'attention' : 'muted'}
            >
              {counts[option]}
            </CountPill>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={filter === 'all' ? t('list.emptyTitle') : t(`list.emptyFiltered.${filter}`)}
          description={filter === 'all' ? t('list.emptyDescription') : undefined}
          action={
            filter === 'all' ? undefined : (
              <Button variant="outline" size="sm" onClick={() => onFilterChange('all')}>
                {t('filters.showAll')}
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-6" data-testid="task-groups">
          {groups.map((group) => (
            <section key={group.bucket} aria-label={t(`buckets.${group.bucket}`)}>
              <SectionLabel as="h2" className="mb-2">
                {t(`buckets.${group.bucket}`)}
              </SectionLabel>
              <div className="flex flex-col gap-3">
                {group.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    projectId={projectId}
                    task={task}
                    onSelect={onSelectTask}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
