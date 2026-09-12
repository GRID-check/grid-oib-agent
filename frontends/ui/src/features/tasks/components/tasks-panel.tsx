'use client'

/**
 * Aufgaben tab root — the project's delegated work, refreshed while visible.
 *
 * A shell, exactly as `JobsPanel` is: the list is presentational
 * (`TaskList`), this owns the request and the names. There is no create verb —
 * a task is delegated from a chat („@Piloti prüf das bis Freitag") or opened by
 * a reviewer's „Piloti überarbeiten lassen", and inventing a form here would be
 * a third way to ask for work that the two existing ones already say better.
 *
 * The list is polled while the tab is visible: a task is work somebody handed
 * over and walked away from, and its worker (or a colleague's review) moves it
 * with no socket open in this tab — a fetch-once list would wear a stale
 * "Läuft" until someone reloaded. The cadence matches the job run history's
 * `JOB_STATUS_POLL_MS`: the same kind of slow-moving work, the same budget.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useTranslations } from '@/i18n'
import { TaskList } from './task-list'
import { normalizeTaskStatus, type TaskWireRow } from '../lib/task-view'

/** Gap between re-asks while the panel is visible (cf. `JOB_STATUS_POLL_MS`). */
export const TASKS_POLL_MS = 10_000

interface TasksPanelProps {
  projectId: string
}

export function TasksPanel({ projectId }: TasksPanelProps): JSX.Element {
  const t = useTranslations('tasks')
  const [tasks, setTasks] = useState<readonly TaskWireRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // Whether this is still the first load, which owns the skeleton and the
  // error state. A later poll must never flash either over a list the reader
  // is already reading — it updates silently, or not at all.
  const firstLoadRef = useRef(true)
  // Single-flight guard for the chained poll and the out-of-chain `onFocus`
  // refresh: a focus landing mid-poll would otherwise start a second load,
  // and the two could settle out of order. A skipped refresh is delayed,
  // never lost — the chain re-asks on its cadence anyway.
  const inFlightRef = useRef(false)

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

  useEffect(() => {
    firstLoadRef.current = true
    setLoading(true)
    setFailed(false)
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
    }

    const onFocus = () => {
      // Returning from another window: re-ask once, outside the chain, so a
      // review decided elsewhere is visible without waiting for the interval.
      if (!cancelled) void load(true)
    }

    void load(false).finally(() => {
      if (!cancelled && document.visibilityState === 'visible') {
        timer = setTimeout(tick, TASKS_POLL_MS)
      }
    })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, load])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-panel">
      <p className="text-muted-foreground border-border shrink-0 border-b px-4 py-2.5 text-xs md:px-6">
        {t('panel.description')}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskList tasks={tasks} loading={loading} failed={failed} />
      </div>
    </div>
  )
}
