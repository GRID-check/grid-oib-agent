/**
 * What the composer says once a chat's answers drew on another project still
 * running (ADR-0094): which projects, and what that closes. A closed project is
 * read by the whole office and closes nothing, so it is not listed, and a chat
 * that drew only on closed projects shows no notice: its sources name them. The chat stays with the
 * people who may open them, and nothing from it reaches what the whole project
 * reads (memory, tasks, deep research, filing). Said here, at the place the
 * reader is about to act, rather than first in a refused share.
 *
 * A molecule over the `Alert` atom; the composer decides when it shows.
 */

import type { FC } from 'react'
import { FolderSymlink } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useLocale, useTranslations } from '@/i18n'
import type { CitationProject } from '../types'

export interface OtherProjectsNoticeProps {
  projects: readonly CitationProject[]
}

export const OtherProjectsNotice: FC<OtherProjectsNoticeProps> = ({ projects }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const running = projects.filter((project) => project.status !== 'closed')
  if (running.length === 0) return null
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    running.map((project) => project.name)
  )
  return (
    <Alert variant="info" className="mt-2" role="status" data-testid="other-projects-notice">
      <FolderSymlink aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{t('otherProjects.title', { projects: names })}</AlertTitle>
      <AlertDescription>{t('otherProjects.body')}</AlertDescription>
    </Alert>
  )
}
