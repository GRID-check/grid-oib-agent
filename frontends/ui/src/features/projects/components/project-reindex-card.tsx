'use client'

/**
 * Rebuild every document's chunks in this project.
 *
 * Sits beside the danger zone rather than inside it: this destroys no document
 * and loses no upload — it replaces derived data the pipeline can always rebuild.
 * But it is not free either, so it is a deliberate button behind a confirmation
 * rather than something reachable by a stray click.
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
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'

interface ProjectReindexCardProps {
  projectId: string
}

export function ProjectReindexCard({ projectId }: ProjectReindexCardProps): JSX.Element {
  // `settings`, not `projects`: this card renders inside the project Settings page,
  // whose copy lives under `settings.project.*` alongside every sibling section.
  const t = useTranslations('settings')
  const [isReindexing, setIsReindexing] = useState(false)

  const handleReindex = async (): Promise<void> => {
    setIsReindexing(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/reindex`, { method: 'POST' })
      if (!response.ok) throw new Error(String(response.status))
      // 202: the job is queued and runs on its own, so there is no count to
      // show. The documents' own status is where each one reports.
      toast.success(t('project.reindexStarted'))
    } catch {
      toast.error(t('project.reindexFailed'))
    } finally {
      setIsReindexing(false)
    }
  }

  return (
    <RaisedCard aria-label={t('project.sections.reindex')}>
      <RaisedCardBody className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-foreground text-sm font-semibold">{t('project.sections.reindex')}</h2>
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
            {t('project.reindexDescription')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleReindex}
          disabled={isReindexing}
          className="shrink-0"
        >
          <RefreshCw
            className={isReindexing ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden="true"
          />
          {isReindexing ? t('project.reindexBusy') : t('project.reindexAction')}
        </Button>
      </RaisedCardBody>
    </RaisedCard>
  )
}
