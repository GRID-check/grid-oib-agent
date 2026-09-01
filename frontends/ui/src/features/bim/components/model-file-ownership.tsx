'use client'

/**
 * Responsible + Ask on the model stage.
 *
 * Assignment lives on the DOCUMENT, same as Files. The stage already treats
 * the building as that document for rename/delete; this is the rest of that
 * chrome, dressed as viewport icon buttons so it sits in the existing pill.
 */

import type { JSX } from 'react'
import { MessageSquare, UserPlus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from '@/i18n'
import { askAboutFile } from '@/features/documents/lib/ask-about-file'
import { AssignPopover } from '@/features/documents/components/assign-popover'
import { AssignmentFaces } from '@/features/documents/components/assignment-faces'
import { useDocumentAssignees } from '@/features/documents/hooks/use-document-assignees'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import { ViewerIconButton, ViewerIconButtonBase } from './viewer'

export function ModelFileOwnership({
  projectId,
  model,
  canCollaborate,
}: {
  projectId: string
  model: BimModelHeaderView
  canCollaborate: boolean
}): JSX.Element {
  const t = useTranslations('files')
  const router = useRouter()
  const [assignees, setAssignees] = useDocumentAssignees(model.documentId, canCollaborate)
  const file = fileItemFromModel(model, assignees)
  const canAsk = model.status === 'ready' && model.projectId !== null

  return (
    <>
      {canCollaborate && (
        <>
          <span className="hidden max-w-28 px-1 sm:inline-flex" data-testid="stage-assignees">
            <AssignmentFaces assignees={assignees} />
          </span>
          <AssignPopover
            documentId={model.documentId}
            assignees={assignees}
            onChanged={setAssignees}
            trigger={
              <ViewerIconButtonBase
                label={assignees.length > 0 ? t('assignment.edit') : t('assignment.assign')}
                icon={UserPlus}
                data-testid="stage-assign"
              />
            }
          />
        </>
      )}
      {canAsk && (
        <ViewerIconButton
          label={t('assignment.ask')}
          icon={MessageSquare}
          onClick={() =>
            askAboutFile({
              projectId,
              file,
              navigate: (href) => router.push(href),
            })
          }
          side="bottom"
          data-testid="stage-ask"
        />
      )}
    </>
  )
}

function fileItemFromModel(
  model: BimModelHeaderView,
  assignees: FileItem['assignees'],
): FileItem {
  return {
    id: model.documentId,
    filename: model.filename,
    displayName: model.displayName,
    fileSize: model.summary?.fileSizeBytes ?? null,
    contentType: 'application/x-step',
    status: model.status === 'ready' ? 'ready' : model.status,
    folderId: null,
    createdAt: model.updatedAt,
    errorMessage: model.errorMessage,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees,
  }
}
