'use client'

/**
 * Jobs tab root. List mode shows the project's jobs; the builder replaces it
 * while creating/editing one. Opening an existing job passes its full row
 * directly (the list already carries the pinned skill snapshot — no extra
 * fetch). Returning to the list remounts it, so it refetches and reflects any
 * create/edit.
 *
 * SHELL. The tab fills its pane as a full-height flex column — list or builder
 * in a scrolling body. New job / back-to-list portal into the shared section
 * header so this panel does not invent a second title bar.
 *
 * Managing jobs is `project:skills:manage`; without it the tab is read-only.
 * Authoring SKILLS is a different permission on a different tab.
 */

import { useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSectionActions>
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
      </ProjectSectionActions>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div
          key={isList ? 'list' : 'builder'}
          className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none"
        >
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
    </div>
  )
}
