'use client'

/**
 * Workflows tab root. Switches between the list view and the create/edit
 * builder. Opening an existing workflow fetches its full definition first
 * (the list only carries a summary projection). Returning to the list remounts
 * it, so it refetches and reflects any create/edit.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { getWorkflow, type WorkflowDetail } from '@/adapters/api/workflows-client'
import { WorkflowList } from './workflow-list'
import { WorkflowBuilder } from './workflow-builder'

interface WorkflowsPanelProps {
  projectId: string
}

type Mode = 'list' | 'create' | 'edit'

export function WorkflowsPanel({ projectId }: WorkflowsPanelProps): JSX.Element {
  const t = useTranslations('workflows')
  const [mode, setMode] = useState<Mode>('list')
  const [editWorkflow, setEditWorkflow] = useState<WorkflowDetail | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  const openCreate = useCallback(() => {
    setEditWorkflow(null)
    setMode('create')
  }, [])

  const openEdit = useCallback(
    async (workflowId: string) => {
      setOpeningId(workflowId)
      try {
        const detail = await getWorkflow(projectId, workflowId)
        setEditWorkflow(detail)
        setMode('edit')
      } catch {
        toast.error(t('loadError'))
      } finally {
        setOpeningId(null)
      }
    },
    [projectId, t],
  )

  const backToList = useCallback(() => {
    setEditWorkflow(null)
    setMode('list')
  }, [])

  if (mode === 'list') {
    return (
      <WorkflowList
        projectId={projectId}
        onCreate={openCreate}
        onEdit={openEdit}
        openingId={openingId}
      />
    )
  }

  return (
    <WorkflowBuilder
      projectId={projectId}
      workflow={editWorkflow}
      onSaved={backToList}
      onCancel={backToList}
    />
  )
}
