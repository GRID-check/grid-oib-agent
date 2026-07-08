'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TypeToConfirmDialog } from '@/components/ui/type-to-confirm-dialog'
import { useTranslations } from '@/i18n'

export interface ProjectDangerZoneProps {
  projectId: string
  projectName: string
}

export function ProjectDangerZone({ projectId, projectName }: ProjectDangerZoneProps) {
  const t = useTranslations('projects')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: projectName }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? t('dangerZone.deleteError'))
      }
      toast.success(t('dangerZone.deleteSuccess'))
      router.push('/app/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dangerZone.deleteError'))
      setPending(false)
      setOpen(false)
    }
  }

  return (
    <section className="rounded-lg border border-destructive/40 p-4">
      <h3 className="text-sm font-semibold text-destructive">{t('dangerZone.heading')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('dangerZone.description')}</p>
      <Button
        variant="destructive"
        className="mt-3"
        onClick={() => setOpen(true)}
      >
        {t('dangerZone.deleteButton')}
      </Button>
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
        onConfirm={handleConfirm}
        pending={pending}
      />
    </section>
  )
}
