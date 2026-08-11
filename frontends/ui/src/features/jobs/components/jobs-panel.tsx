'use client'

/**
 * Jobs tab root. List mode shows the project's jobs; the builder replaces it
 * while creating/editing one. Opening an existing job passes its full row
 * directly (the list already carries the pinned skill snapshot — no extra
 * fetch). Returning to the list remounts it, so it refetches and reflects any
 * create/edit.
 *
 * Managing jobs is `project:skills:manage`; without it the tab is read-only.
 * Authoring SKILLS is a different permission on a different tab.
 */

import { useState } from 'react'
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

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-6 md:px-10 md:pt-[34px]">
      {mode === 'list' ? (
        <>
          <header className="mb-7 space-y-1.5">
            <h1 className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
              {t('title')}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
          </header>
          <JobList
            projectId={projectId}
            projectCollection={projectCollection}
            canManage={canManage}
            onCreate={openCreate}
            onEdit={openEdit}
          />
        </>
      ) : (
        <JobBuilder
          projectId={projectId}
          job={editJob}
          onSaved={backToList}
          onCancel={backToList}
        />
      )}
    </div>
  )
}
