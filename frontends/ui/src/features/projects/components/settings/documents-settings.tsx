'use client'

/**
 * Settings → Documents & index: who brought which files into the project, and
 * whether the index answers are grounded on is current.
 *
 * The upload history is the reference record (ADR-0086); the index controls
 * act on what those uploads became. Both used to sit between the roster and
 * the memory on one long page.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { BookOpenCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UploadHistory } from '@/features/uploads/components/upload-history'
import { useTranslations } from '@/i18n'
import type { FolderWithoutRole } from '../../types'
import { FoldersWithoutRole } from '../folders-without-role'
import { ProjectReindexCard } from '../project-reindex-card'
import { SettingsPanel } from './settings-panel'

export interface DocumentsSettingsProps {
  projectId: string
  /** Links the reader's own uploads to their summaries (the summary is its uploader's only). */
  currentUserId: string | null
  /** Rebuild the index (`project:documents:write`). */
  canReindex: boolean
  /** The flagged knowledge-base page, linked from here rather than the rail. */
  showKnowledgeLink: boolean
  /** Folders whose roles were deleted since (ADR-0088), for a project manager. */
  foldersWithoutRole?: readonly FolderWithoutRole[]
}

export function DocumentsSettings({
  projectId,
  currentUserId,
  canReindex,
  showKnowledgeLink,
  foldersWithoutRole = [],
}: DocumentsSettingsProps): JSX.Element {
  const t = useTranslations('settings')
  const tUploads = useTranslations('uploadBatches')

  return (
    <div className="flex flex-col gap-6">
      <FoldersWithoutRole projectId={projectId} folders={foldersWithoutRole} />
      <SettingsPanel
        title={t('project.documents.uploadsTitle')}
        description={tUploads('history.description')}
      >
        <UploadHistory projectId={projectId} currentUserId={currentUserId} />
      </SettingsPanel>

      {canReindex && <ProjectReindexCard projectId={projectId} />}

      {showKnowledgeLink && (
        <SettingsPanel
          title={t('project.documents.knowledgeTitle')}
          description={t('project.documents.knowledgeDescription')}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href={`/app/projects/${encodeURIComponent(projectId)}/knowledge`}>
                <BookOpenCheck className="size-4" aria-hidden />
                {t('project.documents.knowledgeLink')}
              </Link>
            </Button>
          }
        />
      )}
    </div>
  )
}
