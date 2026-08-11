'use client'

/**
 * Jobs tab root. List mode shows the project's jobs; the builder replaces it
 * while creating/editing one. Opening an existing job passes its full row
 * directly (the list already carries the pinned skill snapshot — no extra
 * fetch). Returning to the list remounts it, so it refetches and reflects any
 * create/edit.
 *
 * SHELL. The tab fills its pane the way the Files workspace does — a compact
 * bordered bar (title, one-line subtitle, the one primary action) over a
 * scrolling body — rather than a short centred column with a stacked header.
 * Both modes share it, so switching between the list and the builder moves the
 * content and nothing else: the bar keeps its place and only its title and its
 * action change (New job ⇄ back to the list).
 *
 * Managing jobs is `project:skills:manage`; without it the tab is read-only.
 * Authoring SKILLS is a different permission on a different tab.
 */

import { useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { Job } from '@/adapters/api/jobs-client'
import { JobBuilder } from './job-builder'
import { JobList } from './job-list'

interface JobsPanelProps {
  projectId: string
  /**
   * Qdrant collection of this project. The run history joins it against the
   * backend's research runs to show each run's live job status.
   */
  projectCollection: string | null
  /** Whether this member may create/edit/delete/run jobs (project:skills:manage). */
  canManage: boolean
}

type Mode = 'list' | 'create' | 'edit'

export function JobsPanel({
  projectId,
  projectCollection,
  canManage,
}: JobsPanelProps): JSX.Element {
  const t = useTranslations('jobs')
  const [mode, setMode] = useState<Mode>('list')
  const [editJob, setEditJob] = useState<Job | null>(null)

  const openCreate = () => {
    setEditJob(null)
    setMode('create')
  }

  const openEdit = (job: Job) => {
    setEditJob(job)
    setMode('edit')
  }

  const backToList = () => {
    setEditJob(null)
    setMode('list')
  }

  const isList = mode === 'list'
  const title = isList
    ? t('title')
    : mode === 'edit'
      ? t('builder.editTitle')
      : t('builder.createTitle')
  const subtitle = isList
    ? t('subtitle')
    : mode === 'edit'
      ? t('builder.editSubtitle')
      : t('builder.createSubtitle')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar — one row at every width: the subtitle is the first thing to
          go, because a wrapped sentence would push the action off the line. */}
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isList ? (
            canManage && (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" aria-hidden />
                {t('list.empty.action')}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={backToList}
            >
              <ArrowLeft className="size-4" aria-hidden />
              {t('backToList')}
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {isList ? (
          <JobList
            projectId={projectId}
            projectCollection={projectCollection}
            canManage={canManage}
            onCreate={openCreate}
            onEdit={openEdit}
          />
        ) : (
          <JobBuilder
            projectId={projectId}
            job={editJob}
            onSaved={backToList}
            onCancel={backToList}
          />
        )}
      </div>
    </div>
  )
}
