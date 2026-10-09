'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { TypeToConfirmDialog } from '@/components/ui/type-to-confirm-dialog'
import { useLocale, useTranslations } from '@/i18n'

export interface ProjectDeleteDialogProps {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Soft-delete the project behind a type-the-name confirmation, opened from the
 * Overview hero's menu. It used to be a red "danger zone" box at the foot of
 * Settings; on a dashboard a destructive control belongs one deliberate click
 * away, not in the reading flow. The grace-period restore is unchanged.
 */
export function ProjectDeleteDialog({
  projectId,
  projectName,
  open,
  onOpenChange: setOpen,
}: ProjectDeleteDialogProps) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const router = useRouter()
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: projectName }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error ?? t('dangerZone.deleteError'))
      }
      // The DELETE response carries the grace deadline (purgeAfter); surface it
      // as a concrete, locale-formatted date so the toast is honest about how
      // long the project can still be restored.
      const purgeAfter = data?.purgeAfter ? new Date(data.purgeAfter) : null
      toast.success(
        purgeAfter && !Number.isNaN(purgeAfter.getTime())
          ? t('dangerZone.deleteSuccess', {
              date: purgeAfter.toLocaleDateString(locale, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }),
            })
          : t('dangerZone.deleteSuccessNoDate')
      )
      setPending(false)
      setOpen(false)
      router.push('/app/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dangerZone.deleteError'))
      setPending(false)
      setOpen(false)
    }
  }

  return (
    <TypeToConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t('dangerZone.dialogTitle')}
      description={
        <p>
          {t('dangerZone.dialogDescriptionBefore')}
          <span className="font-semibold">{projectName}</span>
          {t('dangerZone.dialogDescriptionAfter')}
        </p>
      }
      confirmName={projectName}
      confirmLabel={t('dangerZone.confirmLabel')}
      typeToConfirmLabel={t('dangerZone.typeToConfirm')}
      cancelLabel={tCommon('actions.cancel')}
      onConfirm={handleConfirm}
      pending={pending}
    />
  )
}
