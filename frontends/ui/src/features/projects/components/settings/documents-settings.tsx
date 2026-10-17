'use client'

/**
 * Settings → Documents & index: who brought which files into the project, how
 * else they can come in, and whether the index answers are grounded on is
 * current.
 *
 * The upload history is the reference record (ADR-0086); the project's mail
 * address is the other way in (ADR-0075), so it sits beside it; the index
 * controls act on what those uploads became. All three used to sit between the
 * roster and the memory on one long page.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { BookOpenCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UploadHistory } from '@/features/uploads/components/upload-history'
import { useTranslations } from '@/i18n'
import { ProjectInboundMailCard } from '../project-inbound-mail-card'
import { ProjectReindexCard } from '../project-reindex-card'
import { SettingsPanel } from './settings-panel'

export interface DocumentsSettingsProps {
  projectId: string
  /** Links the reader's own uploads to their summaries (the summary is its uploader's only). */
  currentUserId: string | null
  /**
   * Write documents (`project:documents:write`, or the `project:edit`
   * umbrella): rebuild the index, and see the project's mail address, since
   * mailing files in is uploading them.
   */
  canWriteDocuments: boolean
  /** The flagged knowledge-base page, linked from here rather than the rail. */
  showKnowledgeLink: boolean
}

export function DocumentsSettings({
  projectId,
  currentUserId,
  canWriteDocuments,
  showKnowledgeLink,
}: DocumentsSettingsProps): JSX.Element {
  const t = useTranslations('settings')
  const tUploads = useTranslations('uploadBatches')

  return (
    <div className="flex flex-col gap-6">
      <SettingsPanel
        title={t('project.documents.uploadsTitle')}
        description={tUploads('history.description')}
      >
        <UploadHistory projectId={projectId} currentUserId={currentUserId} />
      </SettingsPanel>

      {/* Renders nothing when the deployment has no inbound mail domain or the
          organization has not switched the inbox on. */}
      {canWriteDocuments && <ProjectInboundMailCard projectId={projectId} />}

      {canWriteDocuments && <ProjectReindexCard projectId={projectId} />}

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
