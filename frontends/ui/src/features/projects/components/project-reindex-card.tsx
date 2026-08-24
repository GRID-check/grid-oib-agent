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
      const result = (await response.json()) as {
        queued: number
        skipped: number
        failed: string[]
      }

      if (result.queued === 0 && result.failed.length === 0) {
        toast.info(t('project.reindexNothing'))
      } else if (result.queued > 0) {
        toast.success(t('project.reindexDone', { count: result.queued }))
      }
      // Reported separately and never folded into the success count: these are the
      // documents whose old chunks could not be removed, so they were deliberately
      // left alone rather than re-dispatched into a duplicate.
      if (result.failed.length > 0) {
        toast.error(t('project.reindexPartial', { count: result.failed.length }))
      }
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
          <h2 className="text-sm font-semibold text-foreground">{t('project.sections.reindex')}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t('project.reindexDescription')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleReindex}
          disabled={isReindexing}
          className="shrink-0"
        >
          <RefreshCw className={isReindexing ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
          {isReindexing ? t('project.reindexBusy') : t('project.reindexAction')}
        </Button>
      </RaisedCardBody>
    </RaisedCard>
  )
}
