'use client'

/**
 * Close a project, or reopen it (ADR-0090) — the settings card for whoever
 * holds `project:manage`. Both directions ask once; neither deletes anything.
 * The server decides and audits (`PUT /api/projects/[id]/status`); this card
 * only asks and then refreshes the page, whose every section reads the new
 * status from the server.
 */

import { useState, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, LockOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { ProjectStatusChip } from '@/components/projects/project-status'
import { useLocale, useTranslations } from '@/i18n'
import { CloseProjectDialog } from './close-project-dialog'
import type { ProjectStatus } from '@/lib/projects/project-status'

export interface ProjectLifecycleCardProps {
  projectId: string
  status: ProjectStatus
  /** ISO timestamp; set when closed. */
  closedAt: string | null
}

export function ProjectLifecycleCard({ projectId, status, closedAt }: ProjectLifecycleCardProps): JSX.Element {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const closed = status === 'closed'
  const target: ProjectStatus = closed ? 'active' : 'closed'

  const closedOn = closedAt
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(closedAt))
    : null

  const submit = async (): Promise<boolean> => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/status`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: target }),
      })
      if (!res.ok) throw new Error(t('lifecycle.toast.error'))
      toast.success(closed ? t('lifecycle.toast.reopened') : t('lifecycle.toast.closed'))
      setOpen(false)
      router.refresh()
      return true
    } catch {
      toast.error(t('lifecycle.toast.error'))
      return false
    } finally {
      setPending(false)
    }
  }

  return (
    <RaisedCard aria-label={t('lifecycle.card.heading')}>
      <RaisedCardBody className="space-y-3 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold">{t('lifecycle.card.heading')}</h2>
          <ProjectStatusChip status={status} size="sm" />
        </div>
        {closed && closedOn && <p className="text-muted-foreground text-sm">{t('lifecycle.card.closedOn', { date: closedOn })}</p>}
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          {closed ? t('lifecycle.card.closedDescription') : t('lifecycle.card.activeDescription')}
        </p>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {closed ? <LockOpen className="size-4" aria-hidden /> : <Lock className="size-4" aria-hidden />}
          {closed ? t('lifecycle.card.reopen') : t('lifecycle.card.close')}
        </Button>
        {/* Closing goes through „Ausmisten" first (ADR-0092); reopening asks once. */}
        {!closed && <CloseProjectDialog projectId={projectId} open={open} onOpenChange={setOpen} onClose={submit} />}
        <ConfirmDialog
          open={closed && open}
          onOpenChange={setOpen}
          tone="default"
          title={t('lifecycle.reopenDialog.title')}
          description={t('lifecycle.reopenDialog.description')}
          confirmLabel={t('lifecycle.reopenDialog.confirm')}
          cancelLabel={tCommon('actions.cancel')}
          onConfirm={async () => {
            await submit()
          }}
          pending={pending}
        />
      </RaisedCardBody>
    </RaisedCard>
  )
}
