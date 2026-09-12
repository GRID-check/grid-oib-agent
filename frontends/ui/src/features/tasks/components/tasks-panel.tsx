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
  const firstLoadRef = useRef(true)
  const inFlightRef = useRef(false)
  const generationRef = useRef(0)

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

  useEffect(() => {
    generationRef.current += 1
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

    const schedule = () => {
      clearTimer()
      if (cancelled || document.visibilityState !== 'visible') return
      timer = setTimeout(tick, TASKS_POLL_MS)
    }

    const tick = () => {
      if (cancelled) return
      void load(true).finally(() => {
        if (cancelled) return
        if (document.visibilityState === 'visible') {
          schedule()
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
      clearTimer()
      void load(true).finally(() => {
        if (!cancelled) schedule()
      })
    }

    const onFocus = () => {
      if (!cancelled) void load(true)
    }

    void load(false).finally(() => {
      if (!cancelled) schedule()
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
