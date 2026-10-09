'use client'

/**
 * Settings → General: what the project is called, how big it is, and, at the
 * bottom, how it is deleted.
 *
 * The name is a plain field with Save rather than a pencil that opens a dialog:
 * on a settings page the field IS the affordance, and a dialog for one input
 * was a second place to look. Readers without `project:manage` see the same
 * field disabled with the reason beside it, never a control the API refuses.
 */

import type { FormEvent, JSX } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CalendarDays, FileText, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { StatCard } from '@/components/ui/stat-card'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes, formatDate } from '@/lib/format'
import { ProjectDangerZone } from '../project-danger-zone'
import { SettingsPanel } from './settings-panel'

export interface GeneralSettingsProps {
  projectId: string
  projectName: string
  /** ISO timestamp. */
  createdAt: string
  documentCount: number
  totalFileSize: number
  /** Rename and delete (`project:manage`). */
  canManage: boolean
}

export function GeneralSettings({
  projectId,
  projectName,
  createdAt,
  documentCount,
  totalFileSize,
  canManage,
}: GeneralSettingsProps): JSX.Element {
  const t = useTranslations('settings')
  const { locale } = useLocale()

  return (
    <div className="flex flex-col gap-6">
      <SettingsPanel
        title={t('project.general.identityTitle')}
        description={t('project.general.identityDescription')}
      >
        <ProjectNameForm projectId={projectId} projectName={projectName} canManage={canManage} />
      </SettingsPanel>

      <section aria-label={t('project.general.factsTitle')} className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<CalendarDays />}
          label={t('project.general.created')}
          value={formatDate(createdAt, locale)}
        />
        <StatCard
          icon={<FileText />}
          label={t('project.general.documents')}
          value={documentCount.toLocaleString(locale)}
          hint={
            <Link
              href={`/app/projects/${encodeURIComponent(projectId)}/files`}
              className="hover:text-foreground underline-offset-4 hover:underline"
            >
              {t('project.general.openFiles')}
            </Link>
          }
        />
        <StatCard
          icon={<HardDrive />}
          label={t('project.general.storage')}
          value={formatBytes(totalFileSize, locale)}
        />
      </section>

      {canManage && <ProjectDangerZone projectId={projectId} projectName={projectName} />}
    </div>
  )
}

function ProjectNameForm({
  projectId,
  projectName,
  canManage,
}: {
  projectId: string
  projectName: string
  canManage: boolean
}): JSX.Element {
  const t = useTranslations('settings')
  const router = useRouter()
  const [name, setName] = useState(projectName)
  // The name the server last confirmed. The prop only changes after the
  // refresh lands, so without this the form reads as dirty for that interval.
  const [saved, setSaved] = useState(projectName)
  const [pending, setPending] = useState(false)

  const trimmed = name.trim()
  const empty = trimmed.length === 0
  const dirty = trimmed !== saved

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (empty || !dirty || pending) return
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setSaved(trimmed)
      setName(trimmed)
      toast.success(t('project.general.saved'))
      // The name also lives in the switcher, the trail and the tab title.
      router.refresh()
    } catch {
      toast.error(t('project.general.saveError'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-start gap-3">
      <Field className="w-full sm:max-w-md">
        <FieldLabel htmlFor="project-name">{t('project.general.nameLabel')}</FieldLabel>
        <Input
          id="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={255}
          disabled={!canManage || pending}
          aria-invalid={empty || undefined}
          autoComplete="off"
        />
        {empty ? (
          <FieldError>{t('project.general.nameRequired')}</FieldError>
        ) : !canManage ? (
          <FieldDescription>{t('project.general.readOnlyHint')}</FieldDescription>
        ) : null}
      </Field>
      {canManage && (
        <Button type="submit" disabled={empty || !dirty || pending}>
          {pending && <Spinner className="size-4" aria-hidden />}
          {t('project.general.save')}
        </Button>
      )}
    </form>
  )
}
