'use client'

/**
 * Aufgaben tab root — the project's delegated work, refreshed while visible.
 *
 * ONE list in two shapes: recurring schedules on top, single runs below
 * (`TaskList`). The panel owns both requests — tasks polled on the job-history
 * cadence, jobs loaded alongside — and the names. Two create gestures, split
 * by capability: Delegieren links into the project chat, where one-shot
 * delegation happens for every editor, and renders disabled with the locked
 * composer's own reason for a reader without `project:chat`; Zeitplan
 * erstellen opens the schedule flow (the job builder, re-homed here) and is
 * mirrored on the same `project:skills:manage` gate the Jobs tab uses —
 * hidden here, enforced by the server there.
 *
 * A row opens its detail in a drawer, and a `?task=` / `?schedule=` deep link
 * opens it directly — that is the half the inbox needs: its payload already
 * carries the task id beside the filed document, so a knock can land on the
 * result instead of on a chat history.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, MessageSquare, Plus } from 'lucide-react'

import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { listJobs, type Job } from '@/adapters/api/jobs-client'
import { JobBuilder } from '@/features/jobs/components/job-builder'
import { TaskDetail, type TaskSelection } from './task-detail'
import { TaskList } from './task-list'
import { normalizeTaskStatus, type TaskWireRow } from '../lib/task-view'

/** Gap between re-asks while the panel is visible (cf. `JOB_STATUS_POLL_MS`). */
export const TASKS_POLL_MS = 10_000

interface TasksPanelProps {
  projectId: string
  /**
   * Qdrant collection of this project — scopes the template detail's live run
   * statuses. Null disables the join; rows keep their recorded state.
   */
  projectCollection: string | null
  /** Whether this member may create/pause schedules (`project:skills:manage`). */
  canManageJobs: boolean
  /**
   * Whether this member may use the agent in this project (`project:chat`).
   * Mirrors the chat surface's own gate: without it the composer is locked,
   * so Delegieren is disabled with the locked composer's reason instead of
   * linking into a dead end. Fail-open until the section threads the server
   * decision through; the server still enforces on send.
   */
  canChatInProject?: boolean
}

type Mode = 'list' | 'schedule'

/** A drawer deep link off the URL — `?task=` for a run, `?schedule=` for one. */
function readSelectionFromUrl(): TaskSelection | null {
  try {
    if (typeof window === 'undefined') return null
    const params = new URL(window.location.href).searchParams
    const task = params.get('task')
    if (task) return { kind: 'task', id: task }
    const schedule = params.get('schedule')
    if (schedule) return { kind: 'job', id: schedule }
    return null
  } catch {
    return null
  }
}

/** Keep the deep link on the URL while the drawer is open, drop it on close. */
function syncSelectionToUrl(selection: TaskSelection | null): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('task')
    url.searchParams.delete('schedule')
    if (selection?.kind === 'task') url.searchParams.set('task', selection.id)
    if (selection?.kind === 'job') url.searchParams.set('schedule', selection.id)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // History unavailable (embedded preview) — the drawer still works.
  }
}

export function TasksPanel({
  projectId,
  projectCollection,
  canManageJobs,
  canChatInProject = true,
}: TasksPanelProps): JSX.Element {
  const t = useTranslations('tasks')
  const tChat = useTranslations('chat')
  const [tasks, setTasks] = useState<readonly TaskWireRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsFailed, setJobsFailed] = useState(false)
  const [mode, setMode] = useState<Mode>('list')
  const [selection, setSelection] = useState<TaskSelection | null>(() => readSelectionFromUrl())
  // Whether this is still the first load, which owns the skeleton and the
  // error state. A later poll must never flash either over a list the reader
  // is already reading — it updates silently, or not at all.
  const firstLoadRef = useRef(true)
  // Single-flight guard for the chained poll and the out-of-chain `onFocus`
  // refresh: a focus landing mid-poll would otherwise start a second load,
  // and the two could settle out of order. A skipped refresh is delayed,
  // never lost — the chain re-asks on its cadence anyway.
  const inFlightRef = useRef(false)
  const jobsInFlightRef = useRef(false)

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
        if (!response.ok) throw new Error(`tasks ${response.status}`)
        const body = (await response.json()) as { tasks?: TaskWireRow[] }
        // Submission words never reach the row: `submitted`/`pending` are
        // folded to the planner word `queued` at this boundary, so no
        // surface below has to know the wire ever said them.
        const rows = (body.tasks ?? []).map((row) => ({
          ...row,
          status: normalizeTaskStatus(row.status),
        }))
        setTasks(rows)
        if (!quiet) setFailed(false)
      } catch {
        // A failed poll keeps the stale list rather than replacing it with
        // an error: the work is still there, only the refresh missed. Only
        // the first load — with nothing to show yet — reports the failure.
        if (!quiet && firstLoadRef.current) setFailed(true)
      } finally {
        inFlightRef.current = false
        if (firstLoadRef.current) {
          firstLoadRef.current = false
          setLoading(false)
        }
      }
    },
    [projectId]
  )

  const loadJobs = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (jobsInFlightRef.current) return
      jobsInFlightRef.current = true
      try {
        const next = await listJobs(projectId)
        setJobs(next)
        setJobsFailed(false)
      } catch {
        // Like the tasks poll: a quiet refresh keeps the stale schedules, only
        // the first load reports.
        if (!quiet) setJobsFailed(true)
      } finally {
        jobsInFlightRef.current = false
        setJobsLoading(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    firstLoadRef.current = true
    setLoading(true)
    setFailed(false)
    setJobsLoading(true)
    setJobsFailed(false)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    // Chained, not `setInterval`: an interval fires again whether or not the
    // previous refresh came back, so a slow endpoint could land an older
    // response after a newer one. Scheduling the next poll only once the
    // current one settles keeps at most one in flight, in order.
    const tick = () => {
      if (cancelled) return
      void load(true).finally(() => {
        if (!cancelled && document.visibilityState === 'visible') {
          timer = setTimeout(tick, TASKS_POLL_MS)
        } else if (!cancelled) {
          // Hidden: park until the tab is visible again rather than polling
          // a page nobody is reading.
          timer = null
        }
      })
    }

    const onVisibilityChange = () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        // Park immediately: a poll scheduled while visible must not fire
        // into a tab nobody is reading.
        if (timer) clearTimeout(timer)
        timer = null
        return
      }
      // Becoming visible resumes with an immediate refresh, so the list is
      // current when seen.
      if (timer) clearTimeout(timer)
      void load(true).finally(() => {
        if (!cancelled) timer = setTimeout(tick, TASKS_POLL_MS)
      })
      void loadJobs(true)
    }

    const onFocus = () => {
      // Returning from another window: re-ask once, outside the chain, so a
      // review decided elsewhere is visible without waiting for the interval.
      if (!cancelled) void load(true)
      if (!cancelled) void loadJobs(true)
    }

    void load(false).finally(() => {
      if (!cancelled && document.visibilityState === 'visible') {
        timer = setTimeout(tick, TASKS_POLL_MS)
      }
    })
    void loadJobs(false)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, load, loadJobs])

  const handleJobChanged = useCallback((next: Job) => {
    setJobs((prev) => prev.map((job) => (job.id === next.id ? next : job)))
  }, [])

  const openDetail = useCallback((next: TaskSelection) => {
    setSelection(next)
    syncSelectionToUrl(next)
  }, [])

  const closeDetail = useCallback(() => {
    setSelection(null)
    syncSelectionToUrl(null)
  }, [])

  const openScheduleCreate = useCallback(() => setMode('schedule'), [])
  const backToList = useCallback(() => setMode('list'), [])
  const handleScheduleSaved = useCallback(() => {
    void loadJobs(true)
    setMode('list')
  }, [loadJobs])

  const selectedTask = selection?.kind === 'task' ? (tasks.find((row) => row.id === selection.id) ?? null) : null
  const selectedJob = selection?.kind === 'job' ? (jobs.find((job) => job.id === selection.id) ?? null) : null
  const isList = mode === 'list'
  const chatHref = `/app/projects/${encodeURIComponent(projectId)}/chat`

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-panel">
      <ProjectSectionActions>
        {isList ? (
          <div className="flex items-center gap-2">
            {/* One-shot delegation happens IN the chat — this only links
                there. Without `project:chat` the composer is locked for this
                reader, so the link is disabled with the locked composer's own
                reason instead of landing them in a dead end. A mirrored
                affordance, not a gate: the server still enforces on send. The
                title rides the wrapping span because a disabled button takes
                no pointer events. */}
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
            {/* The schedule flow, mirrored on the Jobs tab's gate: hidden
                without `project:skills:manage`, enforced by the server. */}
            {canManageJobs && (
              <Button size="sm" onClick={openScheduleCreate} data-testid="tasks-new-schedule">
                <Plus className="size-4" aria-hidden />
                {t('create.schedule')}
              </Button>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={backToList}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t('create.back')}
          </Button>
        )}
      </ProjectSectionActions>

      <p className="text-muted-foreground border-border shrink-0 border-b px-4 py-2.5 text-xs md:px-6">
        {t('panel.description')}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isList ? (
          <TaskList
            projectId={projectId}
            tasks={tasks}
            jobs={jobs}
            jobsLoading={jobsLoading}
            jobsFailed={jobsFailed}
            onRetryJobs={() => void loadJobs(false)}
            loading={loading}
            failed={failed}
            canManageJobs={canManageJobs}
            onJobChanged={handleJobChanged}
            onSelectTask={(task) => openDetail({ kind: 'task', id: task.id })}
            onSelectJob={(job) => openDetail({ kind: 'job', id: job.id })}
          />
        ) : (
          <div className="p-4 md:p-6">
            <JobBuilder
              projectId={projectId}
              job={null}
              onSaved={handleScheduleSaved}
              onCancel={backToList}
            />
          </div>
        )}
      </div>

      <TaskDetail
        projectId={projectId}
        projectCollection={projectCollection}
        selection={selection}
        task={selectedTask}
        job={selectedJob}
        canManageJobs={canManageJobs}
        onJobChanged={handleJobChanged}
        onClose={closeDetail}
      />
    </div>
  )
}
