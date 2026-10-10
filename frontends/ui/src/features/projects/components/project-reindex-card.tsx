'use client'

/**
 * Rebuild every document's chunks in this project.
 *
 * Lives in Settings → Documents & index, not in a danger zone: this destroys no
 * document and loses no upload, it replaces derived data the pipeline can always
 * rebuild. But it is not free either (every chunk is cut and embedded again), so
 * it is a deliberate button behind a confirmation rather than something a stray
 * click can start.
 *
 * The case it exists for is a change to how chunks are BUILT rather than to what
 * they are built from. A chunker change alters no file, so nothing in the ordinary
 * upload path notices and every document keeps serving chunks cut by the old rules.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import { SettingsPanel } from './settings/settings-panel'

interface ProjectReindexCardProps {
  projectId: string
}

export function ProjectReindexCard({ projectId }: ProjectReindexCardProps): JSX.Element {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const [confirming, setConfirming] = useState(false)
  const [isReindexing, setIsReindexing] = useState(false)

  const handleReindex = async (): Promise<void> => {
    setIsReindexing(true)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/reindex`, {
        method: 'POST',
      })
      if (!response.ok) throw new Error(String(response.status))
      // 202: the job is queued and runs on its own, so there is no count to
      // show. The documents' own status is where each one reports.
      toast.success(t('project.documents.reindexStarted'))
    } catch {
      toast.error(t('project.documents.reindexFailed'))
    } finally {
      setIsReindexing(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <SettingsPanel
        title={t('project.documents.indexTitle')}
        description={t('project.documents.indexDescription')}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={isReindexing}
          >
            <RefreshCw
              className={isReindexing ? 'size-4 animate-spin' : 'size-4'}
              aria-hidden="true"
            />
            {isReindexing
              ? t('project.documents.reindexBusy')
              : t('project.documents.reindexAction')}
          </Button>
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="warning"
        title={t('project.documents.reindexConfirmTitle')}
        description={t('project.documents.indexDescription')}
        confirmLabel={t('project.documents.reindexAction')}
        cancelLabel={tCommon('actions.cancel')}
        onConfirm={handleReindex}
        pending={isReindexing}
      />
    </>
  )
}
