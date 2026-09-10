'use client'

/**
 * Aufgaben tab root — the project's delegated work, fetched once per mount.
 *
 * A shell, exactly as `JobsPanel` is: the list is presentational
 * (`TaskList`), this owns the request and the names. There is no create verb —
 * a task is delegated from a chat („@Piloti prüf das bis Freitag") or opened by
 * a reviewer's „Piloti überarbeiten lassen", and inventing a form here would be
 * a third way to ask for work that the two existing ones already say better.
 */

import { useEffect, useState } from 'react'

import { useTranslations } from '@/i18n'
import { TaskList } from './task-list'
import type { TaskWireRow } from '../lib/task-view'

interface TasksPanelProps {
  projectId: string
}

export function TasksPanel({ projectId }: TasksPanelProps): JSX.Element {
  const t = useTranslations('tasks')
  const [tasks, setTasks] = useState<readonly TaskWireRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setFailed(false)
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
      .then((response) => {
        if (!response.ok) throw new Error(`tasks ${response.status}`)
        return response.json() as Promise<{ tasks?: TaskWireRow[] }>
      })
      .then((body) => {
        if (!live) return
        setTasks(body.tasks ?? [])
      })
      .catch(() => {
        if (live) setFailed(true)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [projectId])

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
