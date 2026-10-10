/**
 * What the composer says while a chat is narrowed by other projects (ADR-0094):
 * a small chip, „2 andere Projekte", whose popover names them and says what
 * that closes. The list is the server's CURRENT record of the projects that
 * restrict the chat (`restrictingOtherProjects` on the conversation), not what
 * the answers' citations said when they were written: a project closed since
 * restricts nobody and is gone from it, one reopened is back, and a closed
 * project whose restricted folder the chat drew on is named.
 *
 * A chip, not an alert: the answers already name the projects they cite, so
 * the reader needs no second banner saying so. What the answers do NOT say is
 * the consequence — the chat stays with the people who may open them, and
 * nothing from it reaches what the whole project reads (memory, tasks, deep
 * research, filing) — and that is one click away, at the place the reader is
 * about to act, rather than first in a refused share. A closed project's open
 * folders restrict nobody, so a chat that only drew on those shows nothing.
 *
 * A molecule over the `Chip` and `Popover` atoms; the composer decides when it shows.
 */

import { useId, type FC } from 'react'
import { FolderSymlink } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLocale, useTranslations } from '@/i18n'
import type { RestrictingOtherProject } from '@/adapters/api/conversations-client'

export interface OtherProjectsNoticeProps {
  projects: readonly RestrictingOtherProject[]
}

export const OtherProjectsNotice: FC<OtherProjectsNoticeProps> = ({ projects }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const titleId = useId()
  const bodyId = useId()
  if (projects.length === 0) return null
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    projects.map((project) => project.name ?? t('otherProjects.gone'))
  )
  return (
    <div className="mt-2 flex" data-testid="other-projects-notice">
      <Popover>
        <PopoverTrigger asChild>
          <Chip asChild variant="muted" size="sm" interactive aria-label={t('otherProjects.title', { projects: names })}>
            <button type="button">
              <FolderSymlink aria-hidden="true" />
              {t('otherProjects.chip', { count: projects.length })}
            </button>
          </Chip>
        </PopoverTrigger>
        {/* Radix's dialog role, named and described by the two lines it shows. */}
        <PopoverContent
          align="start"
          className="w-80 space-y-1.5 p-4"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
        >
          <p id={titleId} className="text-sm font-medium text-foreground">
            {t('otherProjects.title', { projects: names })}
          </p>
          <p id={bodyId} className="text-xs leading-relaxed text-muted-foreground">
            {t('otherProjects.body')}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
}
