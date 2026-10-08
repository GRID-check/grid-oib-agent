/**
 * What the composer says while a chat is narrowed by other projects (ADR-0093):
 * which projects, and what that closes. The list is the server's CURRENT record
 * of the projects that restrict the chat (`restrictingOtherProjects` on the
 * conversation), not what the answers' citations said when they were written: a
 * project closed since restricts nobody and is gone from it, one reopened is
 * back, and a closed project whose restricted folder the chat drew on is named.
 * The chat stays with the people who may open them, and nothing from it reaches
 * what the whole project reads (memory, tasks, deep research, filing). Said
 * here, at the place the reader is about to act, rather than first in a refused
 * share.
 *
 * A molecule over the `Alert` atom; the composer decides when it shows.
 */

import type { FC } from 'react'
import { FolderSymlink } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useLocale, useTranslations } from '@/i18n'
import type { RestrictingOtherProject } from '@/adapters/api/conversations-client'

export interface OtherProjectsNoticeProps {
  projects: readonly RestrictingOtherProject[]
}

export const OtherProjectsNotice: FC<OtherProjectsNoticeProps> = ({ projects }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  if (projects.length === 0) return null
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    projects.map((project) => project.name ?? t('otherProjects.gone'))
  )
  return (
    <Alert variant="info" className="mt-2" role="status" data-testid="other-projects-notice">
      <FolderSymlink aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{t('otherProjects.title', { projects: names })}</AlertTitle>
      <AlertDescription>{t('otherProjects.body')}</AlertDescription>
    </Alert>
  )
}
