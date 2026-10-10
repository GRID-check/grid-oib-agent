'use client'

/**
 * The line every page of a closed project opens with (ADR-0090): closed, since
 * when, and what that means — read-only, chat still open. Someone who reads the
 * project only because it is closed is told why they see it, and that folders
 * with their own access list stay hidden from them.
 *
 * Renders nothing for an active project, so the layout mounts it everywhere.
 */

import type { JSX } from 'react'
import { Lock } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useLocale, useTranslations } from '@/i18n'
import { useCurrentProject } from '../lib/current-project'

export function ClosedProjectBanner(): JSX.Element | null {
  const project = useCurrentProject()
  const t = useTranslations('projects')
  const { locale } = useLocale()
  if (!project || project.status !== 'closed') return null

  const closedAt = project.closedAt ? new Date(project.closedAt) : null
  const date =
    closedAt && !Number.isNaN(closedAt.getTime())
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(closedAt)
      : null

  return (
    <Alert variant="info" className="rounded-none border-x-0 border-t-0 px-4 py-2.5 md:px-8" data-testid="closed-project-banner">
      <Lock aria-hidden />
      <AlertTitle>{t('lifecycle.banner.title')}</AlertTitle>
      <AlertDescription>
        {date ? `${t('lifecycle.banner.closedOn', { date })} ` : ''}
        {t('lifecycle.banner.body')}
        {project.readsBecauseClosed ? ` ${t('lifecycle.banner.outsider')}` : ''}
      </AlertDescription>
    </Alert>
  )
}
