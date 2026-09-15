'use client'

/**
 * Tasks tab root — the project's delegated work, refreshed while visible.
 *
 * Task-first: there is exactly ONE thing a reader makes here, a task
 * (`task_definitions`), and being on a schedule is a property of it, not a
 * second thing. "Aufgabe erstellen" opens the wizard, whose third step asks
 * WHEN — answered with a rhythm it becomes a scheduled task, unanswered a
 * manual one. The week timetable is a VIEW of the same tasks (`?view=`), not
 * a destination: the list answers "what happened" newest-first, the timetable
 * "what will happen, and when".
 *
 * Two fetches, one cadence: the runs (`/tasks`, the timeline) and the
 * standing definitions (`/jobs`, cards + timetable). Both poll while visible;
 * a schedule paused elsewhere, or a `next_run_at` the scheduler advanced,
 * reaches this surface without a reload.
 *
 * A card opens its detail in a drawer, and deep links open it directly —
 * `?task=` for a run, `?schedule=` for a standing task. That is the half the
 * inbox needs: its payload already carries the ids beside the filed document,
 * so a knock can land on the result instead of on a chat history.
 *
 * Only the ACTIVE tab mounts (see `automation-panel.tsx`): this panel portals
 * its primary actions into the shared section header, a single slot two
 * mounted panels would fight over.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarRange, ListChecks, MessageSquare, Plus } from 'lucide-react'

import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { SeriesPaletteStyle, SERIES_SLOT_COUNT } from '@/components/charts/palette'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { listJobs, type Job } from '@/adapters/api/jobs-client'
import type { ScheduleDraft } from '@/features/jobs/lib/schedule-draft'
import { ScheduleCard } from '@/features/jobs/components/schedule-card'
import { ScheduleDetail } from '@/features/jobs/components/schedule-detail'
import { ScheduleTimetable } from '@/features/jobs/components/schedule-timetable'
import { ScheduleWizard } from '@/features/jobs/components/schedule-wizard'
import { TaskDetail } from './task-detail'
import { TaskList } from './task-list'
import { normalizeTaskStatus, type TaskFilter, type TaskWireRow } from '../lib/task-view'
import { type TasksView } from '../lib/tasks-view'

/** Gap between re-asks while the panel is visible. */
export const TASKS_POLL_MS = 10_000

interface TasksPanelProps {
  projectId: string
  /**
   * Qdrant collection of this project — scopes the schedule drawer's run
   * history to the project's live job statuses. Null disables the join; rows
   * keep their recorded state.
   */
  projectCollection: string | null
  /** Whether this member may create/edit/run/delete tasks (`project:skills:manage`). */
  canManageJobs: boolean
  /**
   * Whether this member may use the agent in this project (`project:chat`).
   * Mirrors the chat surface's own gate: without it the composer is locked, so
   * Delegieren is disabled with the locked composer's reason instead of linking
   * into a dead end. The server still enforces on send.
   */
  canChatInProject?: boolean
  /** The view to open with — from `?view=`, or the timetable for a legacy `?tab=schedule` link. */
  initialView?: TasksView
}

/** The `?task=` on the URL, if any. */
function readTaskSelectionFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return new URL(window.location.href).searchParams.get('task')
  } catch {
    return null
  }
}

/** The `?schedule=` on the URL, if any. */
function readScheduleSelectionFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return new URL(window.location.href).searchParams.get('schedule')
  } catch {
    return null
  }
}

/** The `?view=` on the URL, if any — the server-passed initial view wins on mount. */
function readViewFromUrl(): TasksView | null {
  try {
    if (typeof window === 'undefined') return null
    const value = new URL(window.location.href).searchParams.get('view')
    return value === 'list' || value === 'timetable' ? value : null
  } catch {
    return null
  }
}

/** Keep the deep links and the view on the URL while open, drop them on close. */
function syncStateToUrl(taskId: string | null, scheduleId: string | null, view: TasksView): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('task')
    url.searchParams.delete('schedule')
    if (taskId) url.searchParams.set('task', taskId)
    if (scheduleId) url.searchParams.set('schedule', scheduleId)
    url.searchParams.set('view', view)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // History unavailable (embedded preview) — panels still work.
  }
}

export function TasksPanel({
  projectId,
  projectCollection,
  canManageJobs,
  canChatInProject = true,
  initialView = 'list',
}: TasksPanelProps): JSX.Element {
  const t = useTranslations('tasks')
  const tJobs = useTranslations('jobs')
  const tChat = useTranslations('chat')
  const [tasks, setTasks] = useState<readonly TaskWireRow[]>([])
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [jobsFailed, setJobsFailed] = useState(false)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [view, setView] = useState<TasksView>(() => readViewFromUrl() ?? initialView)
  const [mode, setMode] = useState<'list' | 'wizard'>('list')
  /** The standing task the wizard is editing, or null when it is creating one. */
  const [editing, setEditing] = useState<Job | null>(null)
  /** A pre-filled draft — a run the reader asked to keep as a standing task. */
  const [wizardDraft, setWizardDraft] = useState<ScheduleDraft | null>(null)
  const [selectedTask, setSelectedTask] = useState<string | null>(() => readTaskSelectionFromUrl())
  const [selectedSchedule, setSelectedSchedule] = useState<string | null>(() =>
    readScheduleSelectionFromUrl(),
  )

  // Whether this is still the first load, which owns the skeleton and the error
  // state. A later poll must never flash either over a list the reader is
  // already reading — it updates silently, or not at all.
  const firstLoadRef = useRef(true)
  // Single-flight guard for the chained poll and the out-of-chain `onFocus`
  // refresh: a focus landing mid-poll would otherwise start a second load, and
  // the two could settle out of order. A skipped refresh is delayed, never
  // lost — the chain re-asks on its cadence anyway.
  const inFlightRef = useRef(false)
  // Project generation: a slow response for the previous project must not
  // overwrite the new project's lists after a project switch.
  const generationRef = useRef(0)
  // The project this panel's selections belong to — a drawer selection names
  // rows of ONE project.
  const projectIdRef = useRef(projectId)
  // Whether the CURRENT selections ever resolved against a loaded list. A
  // card-clicked selection that a later poll drops was deleted; a deep link
  // that never matched was never here.
  const taskEverResolvedRef = useRef(false)
  const scheduleEverResolvedRef = useRef(false)

  const loadTasks = useCallback(
    async (quiet: boolean, startedFor: number): Promise<void> => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
        if (!response.ok) throw new Error(`tasks ${response.status}`)
        const body = (await response.json()) as { tasks?: TaskWireRow[] }
        const rows = (body.tasks ?? []).map((row) => ({
          ...row,
          status: normalizeTaskStatus(row.status),
        }))
        if (startedFor !== generationRef.current) return
        setTasks(rows)
        setFailed(false)
      } catch {
        if (startedFor !== generationRef.current) return
        if (!quiet) setFailed(true)
      }
    },
    [projectId],
  )

  const loadJobs = useCallback(
    async (quiet: boolean, startedFor: number): Promise<void> => {
      try {
        const next = await listJobs(projectId)
        if (startedFor !== generationRef.current) return
        setJobs(next)
        setJobsFailed(false)
      } catch {
        if (startedFor !== generationRef.current) return
        if (!quiet) setJobsFailed(true)
      }
    },
    [projectId],
  )

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      const startedFor = generationRef.current
      try {
        await loadTasks(quiet, startedFor)
        await loadJobs(quiet, startedFor)
      } finally {
        if (startedFor === generationRef.current) {
          inFlightRef.current = false
          if (firstLoadRef.current) {
            firstLoadRef.current = false
            setLoading(false)
          }
        }
      }
    },
    [loadTasks, loadJobs],
  )

  useEffect(() => {
    generationRef.current += 1
    // Drawer selections name rows of ONE project: switching projects drops them
    // — and their URL params — rather than reading the new project's lists as
    // "gone". On mount the ref equals the prop, so deep links survive.
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId
      setSelectedTask(null)
      setSelectedSchedule(null)
      syncStateToUrl(null, null, view)
    }
    firstLoadRef.current = true
    inFlightRef.current = false
    setLoading(true)
    setFailed(false)
    setJobsFailed(false)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    // The ONE place a poll timer is armed: clears any prior timer first, so
    // every reschedule replaces rather than chains.
    const reschedule = () => {
      clearTimer()
      if (cancelled || document.visibilityState !== 'visible') return
      timer = setTimeout(tick, TASKS_POLL_MS)
    }

    const tick = () => {
      if (cancelled) return
      void load(true).finally(() => {
        if (cancelled) return
        if (document.visibilityState === 'visible') reschedule()
        else clearTimer()
      })
    }

    const onVisibilityChange = () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        clearTimer()
        return
      }
      // Becoming visible resumes with an immediate refresh — without
      // double-chaining the poll. A load already in flight will reschedule when
      // it lands; starting another here would skip on the single-flight guard
      // yet still arm a second timer in its `finally`.
      if (inFlightRef.current) return
      clearTimer()
      void load(true).finally(() => {
        if (!cancelled) reschedule()
      })
    }

    const onFocus = () => {
      if (!cancelled) void load(true)
    }

    void load(false).finally(() => {
      if (!cancelled) reschedule()
    })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
    // `view` is read inside only to keep the URL honest on a project switch —
    // it must not restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, load])

  const selectView = useCallback(
    (next: TasksView) => {
      setView(next)
      syncStateToUrl(selectedTask, selectedSchedule, next)
    },
    [selectedTask, selectedSchedule],
  )

  const openTaskDetail = useCallback((task: TaskWireRow) => {
    setSelectedTask(task.id)
    setSelectedSchedule(null)
  }, [])

  const closeTaskDetail = useCallback(() => {
    setSelectedTask(null)
  }, [])

  const openScheduleDetail = useCallback((job: Job) => {
    setSelectedSchedule(job.id)
    setSelectedTask(null)
  }, [])

  const closeScheduleDetail = useCallback(() => {
    setSelectedSchedule(null)
  }, [])

  // The URL mirrors the open drawers and the view, so a copied link re-opens
  // exactly this arrangement.
  useEffect(() => {
    syncStateToUrl(selectedTask, selectedSchedule, view)
  }, [selectedTask, selectedSchedule, view])

  const openCreate = useCallback(() => {
    setEditing(null)
    setWizardDraft(null)
    setMode('wizard')
  }, [])

  const openEdit = useCallback((job: Job) => {
    // The wizard replaces the list, so the drawer that opened it closes and its
    // `?schedule=` deep link goes with it; the URL then names no draft.
    setSelectedSchedule(null)
    setWizardDraft(null)
    setEditing(job)
    setMode('wizard')
  }, [])

  const backToList = useCallback(() => {
    setEditing(null)
    setWizardDraft(null)
    setMode('list')
  }, [])

  const handleSaved = useCallback(() => {
    void load(true)
    backToList()
  }, [load, backToList])

  const handleJobChanged = useCallback((next: Job) => {
    setJobs((prev) => prev.map((job) => (job.id === next.id ? next : job)))
  }, [])

  const handleJobDeleted = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((job) => job.id !== jobId))
    setSelectedSchedule(null)
  }, [])

  /** A run the reader asked to keep as a standing task — opens the wizard pre-filled. */
  const handlePromoteToTask = useCallback(
    (draft: ScheduleDraft) => {
      setSelectedTask(null)
      setWizardDraft(draft)
      setEditing(null)
      setMode('wizard')
    },
    [],
  )

  const resolvedTask = selectedTask === null ? null : (tasks.find((row) => row.id === selectedTask) ?? null)
  const resolvedSchedule =
    selectedSchedule === null ? null : (jobs.find((job) => job.id === selectedSchedule) ?? null)

  useEffect(() => {
    taskEverResolvedRef.current = false
  }, [selectedTask])

  useEffect(() => {
    if (resolvedTask !== null) taskEverResolvedRef.current = true
  }, [resolvedTask])

  useEffect(() => {
    scheduleEverResolvedRef.current = false
  }, [selectedSchedule])

  useEffect(() => {
    if (resolvedSchedule !== null) scheduleEverResolvedRef.current = true
  }, [resolvedSchedule])

  // A selection the drawer SAW resolve and that a later poll dropped was
  // deleted under it. One that never matched was never here: it names another
  // project's row, or nothing at all.
  const taskGoneReason = taskEverResolvedRef.current ? 'deleted' : 'unresolved'
  const scheduleGoneReason = scheduleEverResolvedRef.current ? 'deleted' : 'unresolved'
  const chatHref = `/app/projects/${encodeURIComponent(projectId)}/chat`

  /**
   * The colour each scheduled task wears on the grid, so a card and its blocks
   * are recognisably the same thing. Derived from the SAME ordering the
   * timetable uses (id-sorted, placeable only), because two independent
   * orderings is how a legend and a grid end up disagreeing.
   */
  const accentOf = useMemo(() => {
    const placeable = jobs
      .filter((job) => job.scheduleCron && job.enabled)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    const slots = new Map<string, string>()
    placeable.forEach((job, index) => {
      slots.set(
        job.id,
        index < SERIES_SLOT_COUNT ? `var(--grid-series-${index + 1})` : 'var(--grid-series-other)',
      )
    })
    return (jobId: string): string | undefined => slots.get(jobId)
  }, [jobs])

  const isList = mode === 'list'
  const isTimetableView = view === 'timetable'

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-panel">
      <ProjectSectionActions>
        {isList ? (
          <>
            {/* ONE create gesture: a task, whose third wizard step asks WHEN —
                answered with a rhythm it becomes a scheduled task, unanswered a
                manual one. There is no separate thing called a Zeitplan to
                create. Without `project:skills:manage` the reader gets no
                button rather than a dead end; the server enforces again. */}
            {canManageJobs ? (
              <Button size="sm" onClick={openCreate} data-testid="tasks-new">
                <Plus className="size-4" aria-hidden />
                {t('create.task')}
              </Button>
            ) : null}
            {/* One-shot delegation happens IN the chat — this only links there.
                Without `project:chat` the composer is locked for this reader, so
                the link is disabled with the locked composer's own reason instead
                of landing them in a dead end. A mirrored affordance, not a gate:
                the server still enforces on send. The title rides the wrapping span
                because a disabled button takes no pointer events. */}
            {canChatInProject ? (
              <Button size="sm" variant="outline" asChild title={t('create.delegateHint')}>
                <Link href={chatHref} data-testid="tasks-delegate">
                  <MessageSquare className="size-4" aria-hidden />
                  {t('create.delegate')}
                </Link>
              </Button>
            ) : (
              <span title={tChat('composer.noProjectChatPermission')}>
                <Button size="sm" variant="outline" disabled data-testid="tasks-delegate">
                  <MessageSquare className="size-4" aria-hidden />
                  {t('create.delegate')}
                </Button>
              </span>
            )}
          </>
        ) : (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={backToList}>
            <ArrowLeft className="size-4" aria-hidden />
            {tJobs('backToList')}
          </Button>
        )}
      </ProjectSectionActions>

      {isList ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Liste and Zeitplan read the same tasks: the toggle is a preference
              that rides `?view=`, never a destination. */}
          <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-6">
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(value) => {
                if (value === 'list' || value === 'timetable') selectView(value)
              }}
              segmented
              size="sm"
              aria-label={t('view.label')}
              data-testid="tasks-view-toggle"
            >
              <ToggleGroupItem value="list" data-testid="tasks-view-list">
                <ListChecks className="size-4" aria-hidden />
                {t('view.list')}
              </ToggleGroupItem>
              <ToggleGroupItem value="timetable" data-testid="tasks-view-timetable">
                <CalendarRange className="size-4" aria-hidden />
                {t('view.timetable')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {isTimetableView ? (
            <div className="grid-usage-viz mx-auto w-full max-w-5xl p-4 md:p-6">
              <SeriesPaletteStyle />
              <ScheduleTimetable
                schedules={jobs}
                loading={loading}
                onSelect={openScheduleDetail}
              />
              <StandingTasksSection
                jobs={jobs}
                loading={loading}
                failed={jobsFailed}
                canManageJobs={canManageJobs}
                accentOf={accentOf}
                onChanged={handleJobChanged}
                onSelect={openScheduleDetail}
                onCreate={openCreate}
                onRetry={() => void load(false)}
              />
            </div>
          ) : (
            <>
              <TaskList
                projectId={projectId}
                tasks={tasks}
                loading={loading}
                failed={failed}
                filter={filter}
                onFilterChange={setFilter}
                onSelectTask={openTaskDetail}
                onRetry={() => {
                  firstLoadRef.current = true
                  setLoading(true)
                  void load(false)
                }}
              />
              <StandingTasksSection
                jobs={jobs}
                loading={loading}
                failed={jobsFailed}
                canManageJobs={canManageJobs}
                accentOf={accentOf}
                onChanged={handleJobChanged}
                onSelect={openScheduleDetail}
                onCreate={openCreate}
                onRetry={() => void load(false)}
              />
            </>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <ScheduleWizard
            projectId={projectId}
            job={editing}
            draft={wizardDraft}
            onSaved={handleSaved}
            onCancel={backToList}
          />
        </div>
      )}

      <TaskDetail
        projectId={projectId}
        task={resolvedTask}
        open={selectedTask !== null}
        goneReason={taskGoneReason}
        resolving={selectedTask !== null && resolvedTask === null && loading}
        canManageJobs={canManageJobs}
        onPromoteToTask={handlePromoteToTask}
        onClose={closeTaskDetail}
      />
      <ScheduleDetail
        projectId={projectId}
        projectCollection={projectCollection}
        job={resolvedSchedule}
        open={selectedSchedule !== null}
        canManage={canManageJobs}
        goneReason={scheduleGoneReason}
        resolving={selectedSchedule !== null && resolvedSchedule === null && loading}
        onChanged={handleJobChanged}
        onDeleted={handleJobDeleted}
        onEdit={openEdit}
        onClose={closeScheduleDetail}
      />
    </div>
  )
}

interface StandingTasksSectionProps {
  jobs: readonly Job[]
  loading: boolean
  failed: boolean
  canManageJobs: boolean
  accentOf: (jobId: string) => string | undefined
  onChanged: (next: Job) => void
  onSelect: (job: Job) => void
  onCreate: () => void
  onRetry: () => void
}

/**
 * The standing tasks — every arrangement, scheduled or manual, in cards.
 *
 * Runs say what happened; these say what WILL happen (or would, on demand):
 * cadence, skill, paused or not. Rendered under the runs timeline in the list
 * view and under the week grid in the timetable view — the same cards, because
 * it is the same set either way.
 */
function StandingTasksSection({
  jobs,
  loading,
  failed,
  canManageJobs,
  accentOf,
  onChanged,
  onSelect,
  onCreate,
  onRetry,
}: StandingTasksSectionProps): JSX.Element {
  const t = useTranslations('tasks')
  const tJobs = useTranslations('jobs')

  return (
    <section
      className="mx-auto w-full max-w-3xl p-4 pt-2 md:px-6"
      aria-label={t('standing.heading')}
    >
      <SectionLabel as="h2" className="mb-2">
        {t('standing.heading')}
      </SectionLabel>
      {loading ? (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="standing-loading" aria-hidden="true">
          {[0, 1].map((row) => (
            <div key={row} className="bg-muted/50 rounded-lg border p-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2.5 h-3.5 w-3/5" />
              <Skeleton className="mt-1.5 h-3.5 w-2/5" />
            </div>
          ))}
        </div>
      ) : failed ? (
        <EmptyState
          icon={CalendarRange}
          tone="destructive"
          title={tJobs('loadError')}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              {tJobs('tryAgain')}
            </Button>
          }
        />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title={t('standing.emptyTitle')}
          description={t('standing.emptyDescription')}
          action={
            canManageJobs ? (
              <Button size="sm" onClick={onCreate}>
                <Plus className="size-4" aria-hidden />
                {t('create.task')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="standing-cards">
          {jobs.map((job) => (
            <ScheduleCard
              key={job.id}
              job={job}
              canManage={canManageJobs}
              accent={accentOf(job.id)}
              onChanged={onChanged}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  )
}
