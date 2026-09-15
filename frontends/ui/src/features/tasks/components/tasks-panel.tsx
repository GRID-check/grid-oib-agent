'use client'

/**
 * Tasks tab root — the project's delegated work, refreshed while visible.
 *
 * ONE list now. The schedules that used to sit above it moved to the Zeitplan
 * tab, and with them went the second fetch, the second loading state, the
 * second failure state and the cross-list deep-link settling this panel used
 * to run — `?task=` has exactly one home tab, so an unmatched one strands
 * nobody and there is no tab to restore.
 *
 * A card opens its detail in a drawer, and a `?task=` deep link opens it
 * directly — that is the half the inbox needs: its payload already carries the
 * task id beside the filed document, so a knock can land on the result instead
 * of on a chat history.
 *
 * The one create gesture here is Delegieren, which links into the project chat:
 * one-shot delegation happens in a conversation, for every editor, and the link
 * renders disabled with the locked composer's own reason for a reader without
 * `project:chat`. Creating a SCHEDULE is the Zeitplan tab's action — and the
 * way a task becomes one is „Als Zeitplan speichern" in the drawer, which hands
 * the wizard the prompt already written.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { MessageSquare } from 'lucide-react'

import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { ScheduleDraft } from '@/features/jobs/lib/schedule-draft'
import { TaskDetail } from './task-detail'
import { TaskList } from './task-list'
import { normalizeTaskStatus, type TaskFilter, type TaskWireRow } from '../lib/task-view'

/** Gap between re-asks while the panel is visible. */
export const TASKS_POLL_MS = 10_000

interface TasksPanelProps {
  projectId: string
  /** Whether this member may create schedules (`project:skills:manage`). */
  canManageJobs: boolean
  /**
   * Whether this member may use the agent in this project (`project:chat`).
   * Mirrors the chat surface's own gate: without it the composer is locked, so
   * Delegieren is disabled with the locked composer's reason instead of linking
   * into a dead end. The server still enforces on send.
   */
  canChatInProject?: boolean
  /** Hands a pre-filled schedule to the Zeitplan tab and switches to it. */
  onPromoteToSchedule?: (draft: ScheduleDraft) => void
}

/** The `?task=` on the URL, if any. */
function readSelectionFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return new URL(window.location.href).searchParams.get('task')
  } catch {
    return null
  }
}

/** Keep the deep link on the URL while the drawer is open, drop it on close. */
function syncSelectionToUrl(taskId: string | null): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('task')
    if (taskId) url.searchParams.set('task', taskId)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // History unavailable (embedded preview) — the drawer still works.
  }
}

export function TasksPanel({
  projectId,
  canManageJobs,
  canChatInProject = true,
  onPromoteToSchedule,
}: TasksPanelProps): JSX.Element {
  const t = useTranslations('tasks')
  const tChat = useTranslations('chat')
  const [tasks, setTasks] = useState<readonly TaskWireRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selected, setSelected] = useState<string | null>(() => readSelectionFromUrl())

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
  // overwrite the new project's list after a project switch.
  const generationRef = useRef(0)
  // The project this panel's selection belongs to — a drawer selection names
  // rows of ONE project.
  const projectIdRef = useRef(projectId)
  // Whether the CURRENT selection ever resolved against a loaded list. A
  // card-clicked selection that a later poll drops was deleted; a deep link
  // that never matched was never here.
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
        if (!quiet) setFailed(true)
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

  useEffect(() => {
    generationRef.current += 1
    // A drawer selection names rows of ONE project: switching projects drops it
    // — and its URL param, which names the old project's row — rather than
    // reading the new project's list as "gone". On mount the ref equals the
    // prop, so a deep link survives.
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId
      setSelected(null)
      syncSelectionToUrl(null)
    }
    firstLoadRef.current = true
    inFlightRef.current = false
    setLoading(true)
    setFailed(false)
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
  }, [projectId, load])

  const openDetail = useCallback((task: TaskWireRow) => {
    setSelected(task.id)
    syncSelectionToUrl(task.id)
  }, [])

  const closeDetail = useCallback(() => {
    setSelected(null)
    syncSelectionToUrl(null)
  }, [])

  const selectedTask = selected === null ? null : (tasks.find((row) => row.id === selected) ?? null)

  useEffect(() => {
    everResolvedRef.current = false
  }, [selected])

  useEffect(() => {
    if (selectedTask !== null) everResolvedRef.current = true
  }, [selectedTask])

  // A selection the drawer SAW resolve and that a later poll dropped was
  // deleted under it. One that never matched was never here: it names another
  // project's row, or nothing at all.
  const goneReason = everResolvedRef.current ? 'deleted' : 'unresolved'
  const chatHref = `/app/projects/${encodeURIComponent(projectId)}/chat`

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-panel">
      <ProjectSectionActions>
        {/* One-shot delegation happens IN the chat — this only links there.
            Without `project:chat` the composer is locked for this reader, so
            the link is disabled with the locked composer's own reason instead
            of landing them in a dead end. A mirrored affordance, not a gate:
            the server still enforces on send. The title rides the wrapping span
            because a disabled button takes no pointer events. */}
        {canChatInProject ? (
          <Button size="sm" asChild title={t('create.delegateHint')}>
            <Link href={chatHref} data-testid="tasks-delegate">
              <MessageSquare className="size-4" aria-hidden />
              {t('create.delegate')}
            </Link>
          </Button>
        ) : (
          <span title={tChat('composer.noProjectChatPermission')}>
            <Button size="sm" disabled data-testid="tasks-delegate">
              <MessageSquare className="size-4" aria-hidden />
              {t('create.delegate')}
            </Button>
          </span>
        )}
      </ProjectSectionActions>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskList
          projectId={projectId}
          tasks={tasks}
          loading={loading}
          failed={failed}
          filter={filter}
          onFilterChange={setFilter}
          onSelectTask={openDetail}
          onRetry={() => {
            firstLoadRef.current = true
            setLoading(true)
            void load(false)
          }}
        />
      </div>

      <TaskDetail
        projectId={projectId}
        task={selectedTask}
        open={selected !== null}
        goneReason={goneReason}
        resolving={selected !== null && selectedTask === null && loading}
        canManageJobs={canManageJobs}
        onPromoteToSchedule={onPromoteToSchedule}
        onClose={closeDetail}
      />
    </div>
  )
}
