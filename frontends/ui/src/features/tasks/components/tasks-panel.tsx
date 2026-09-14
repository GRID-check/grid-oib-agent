'use client'

/**
 * Aufgaben tab root — the project's delegated work, refreshed while visible.
 *
 * ONE list in two shapes: definitions on top (schedules and manual-only ones),
 * single runs below (`TaskList`). The panel owns both requests - tasks AND jobs
 * polled on the job-history cadence while visible - and the names. Two create
 * gestures, split by capability: Delegieren links into the project chat, where
 * one-shot delegation happens for every editor, and renders disabled with the
 * locked composer's own reason for a reader without `project:chat`; Zeitplan
 * erstellen opens the schedule flow (the job builder, re-homed here) and is
 * mirrored on the same `project:skills:manage` gate the server enforces.
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
  /**
   * The mount deep link settled: called once, when the first load of BOTH
   * lists lands while the drawer still holds the `?task=` / `?schedule=` the
   * URL carried on mount. `true` is "it matched a row here", `false` is "it
   * never did" — the caller owns the tab that forced open and decides whether
   * the reader is stranded on it. Never called without a mount deep link, and
   * never when the reader moved on (another selection, or none) before the
   * lists landed.
   */
  onDeepLinkSettled?: (resolved: boolean) => void
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

/**
 * Why an unmatched selection reads the way it does.
 *
 * A selection the drawer SAW resolve and that a later poll dropped was
 * deleted under it — the existing gone copy, which is exactly that claim. A
 * deep link that never matched was never here: it names another project's
 * row, or nothing at all. `undefined` is "matched or shut" — no gone branch.
 */
function goneReasonFor(
  selectionResolved: boolean,
  everResolved: boolean,
): 'deleted' | 'unresolved' | undefined {
  if (selectionResolved) return undefined
  return everResolved ? 'deleted' : 'unresolved'
}

export function TasksPanel({
  projectId,
  projectCollection,
  canManageJobs,
  canChatInProject = true,
  onDeepLinkSettled,
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
  // A jobs reload asked for while a jobs fetch is in flight (notably the
  // post-save reload) is queued, never lost — the in-flight fetch resolves
  // with stale data by construction, so dropping the second read would leave
  // the just-saved schedule out of the list until the next focus.
  const jobsPendingRef = useRef(false)
  // Project generation: a slow response for the previous project must not
  // overwrite the new project's list after a project switch. Shared by both
  // loads — tasks and schedules belong to the same project.
  const generationRef = useRef(0)
  // The project this panel's selection belongs to. Compared inside the
  // project effect below — a drawer selection names rows of ONE project.
  const projectIdRef = useRef(projectId)
  // The `?task=` / `?schedule=` the URL carried on mount, if any. Settles
  // once, when the first load of both lists lands (the effect at the bottom):
  // matched is a deep link home, unmatched is one the drawer explains.
  const mountSelectionRef = useRef<TaskSelection | null>(selection)
  const settledRef = useRef(false)
  // Whether the CURRENT selection id ever resolved against a loaded list. A
  // row-clicked selection that a later poll drops was deleted; a mount deep
  // link that never matched was never here. Reset whenever the selection
  // itself changes.
  const everResolvedRef = useRef(false)

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      const startedFor = generationRef.current
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
        if (!quiet && firstLoadRef.current) setFailed(true)
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
    [projectId]
  )

  const loadJobs = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (jobsInFlightRef.current) {
        jobsPendingRef.current = true
        return
      }
      jobsInFlightRef.current = true
      const startedFor = generationRef.current
      try {
        const next = await listJobs(projectId)
        if (startedFor !== generationRef.current) return
        setJobs(next)
        setJobsFailed(false)
      } catch {
        // Like the tasks poll: a quiet refresh keeps the stale schedules, only
        // the first load reports.
        if (startedFor !== generationRef.current) return
        if (!quiet) setJobsFailed(true)
      } finally {
        if (startedFor !== generationRef.current) return
        jobsInFlightRef.current = false
        setJobsLoading(false)
        if (jobsPendingRef.current) {
          jobsPendingRef.current = false
          void loadJobs(true)
        }
      }
    },
    [projectId]
  )

  useEffect(() => {
    generationRef.current += 1
    // A drawer selection names rows of ONE project: switching projects drops
    // it — and its URL params, which name the old project's rows — rather
    // than reading the new project's lists as "gone". On mount the ref equals
    // the prop, so a deep link survives. Stale in-flight responses are already
    // losers — the generation guard in each load drops them — so there is
    // nothing new to say here and no new copy for it.
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId
      setSelection(null)
      syncSelectionToUrl(null)
    }
    firstLoadRef.current = true
    inFlightRef.current = false
    jobsInFlightRef.current = false
    jobsPendingRef.current = false
    setLoading(true)
    setFailed(false)
    setJobsLoading(true)
    setJobsFailed(false)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    // The ONE place a poll timer is armed: clears any prior timer first, so
    // every reschedule replaces rather than chains. All three reschedule
    // sites (chain, resume, mount) go through here — a second `setTimeout`
    // anywhere else is a second chain.
    const reschedule = () => {
      clearTimer()
      if (cancelled || document.visibilityState !== 'visible') return
      timer = setTimeout(tick, TASKS_POLL_MS)
    }

    const tick = () => {
      if (cancelled) return
      // The cadence re-asks BOTH lists: a pause flipped in the drawer (or in
      // a second tab) must reach the templates group without a focus event,
      // the same way a finished run reaches the instances. `loadJobs` arms no
      // timer of its own, so the one chain below stays one chain.
      void loadJobs(true)
      void load(true).finally(() => {
        if (cancelled) return
        if (document.visibilityState === 'visible') {
          reschedule()
        } else {
          clearTimer()
        }
      })
    }

    const onVisibilityChange = () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        clearTimer()
        return
      }
      // Becoming visible resumes with an immediate refresh — without
      // double-chaining the poll. A load already in flight will reschedule
      // when it lands; starting another here would skip on the single-flight
      // guard yet still arm a second timer in its `finally`.
      void loadJobs(true)
      if (inFlightRef.current) return
      clearTimer()
      void load(true).finally(() => {
        if (!cancelled) reschedule()
      })
    }

    const onFocus = () => {
      if (!cancelled) void load(true)
      if (!cancelled) void loadJobs(true)
    }

    void load(false).finally(() => {
      if (!cancelled) reschedule()
    })
    void loadJobs(false)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimer()
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
  const selectionResolved = selection === null || selectedTask !== null || selectedJob !== null
  // Still on the first load of either list: an unmatched deep link is
  // unchecked, not gone — the drawer waits rather than claiming anything.
  const selectionResolving =
    selection !== null && !selectionResolved && (loading || jobsLoading)
  const selectionKey = selection === null ? null : `${selection.kind}:${selection.id}`

  useEffect(() => {
    everResolvedRef.current = false
  }, [selectionKey])

  useEffect(() => {
    if (selection !== null && (selectedTask !== null || selectedJob !== null)) {
      everResolvedRef.current = true
    }
  }, [selection, selectedTask, selectedJob])

  // The mount deep link settles once, when the first load of BOTH lists has
  // landed. Matched is a deep link home; unmatched drops its dead params and
  // reports `false` so the caller can restore the tab it forced open. The
  // drawer itself stays open on the unresolved copy either way.
  useEffect(() => {
    const mountSelection = mountSelectionRef.current
    if (settledRef.current || mountSelection === null) return
    if (loading || jobsLoading) return
    // The reader moved on before the lists landed — a row of their own, or a
    // closed drawer. The mount link is abandoned, and the forced tab is that
    // drawer's home: nothing to settle, nothing to report.
    if (selection?.kind !== mountSelection.kind || selection?.id !== mountSelection.id) {
      settledRef.current = true
      return
    }
    settledRef.current = true
    const found =
      mountSelection.kind === 'task'
        ? tasks.some((row) => row.id === mountSelection.id)
        : jobs.some((row) => row.id === mountSelection.id)
    if (found) {
      onDeepLinkSettled?.(true)
      return
    }
    syncSelectionToUrl(null)
    onDeepLinkSettled?.(false)
  }, [loading, jobsLoading, selection, tasks, jobs, onDeepLinkSettled])
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
            {/* The schedule flow: hidden without `project:skills:manage`,
                enforced by the server. The templates group carries the same
                action for a reader who is already looking at the schedules. */}
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

      {/* The section frame above already renders the title and its subtitle;
          a second description strip here stacked a third full-width bar under
          the tab row and said the same thing twice. The panel starts at the
          list. */}
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
            onCreateSchedule={openScheduleCreate}
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
        goneReason={goneReasonFor(selectionResolved, everResolvedRef.current)}
        resolving={selectionResolving}
        onJobChanged={handleJobChanged}
        onClose={closeDetail}
      />
    </div>
  )
}
