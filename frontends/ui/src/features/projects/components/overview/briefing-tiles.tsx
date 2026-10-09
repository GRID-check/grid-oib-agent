'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { BookCheck, ClipboardList } from 'lucide-react'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Progress } from '@/components/ui/progress'
import { useLocale, useTranslations } from '@/i18n'
import type { ApplicableStandard } from '@/lib/oib/applicable-standards'
import { buildProjectBriefView } from '@/lib/project-profile/brief-view'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { ApplicabilityChip, OibCodeChip } from '../standard-chips'

/** At most this many still-unknown facts are named; the section lists them all. */
const UNKNOWN_SHOWN = 4

/**
 * How complete the briefing Piloti answers from is: facts captured of the
 * facts the intake asks for, the assumptions waiting for a person, and what is
 * still unknown. The brief itself lives one click away.
 */
export function BriefingTile({
  projectId,
  profile,
  briefStarted,
  canEdit,
  href,
}: {
  projectId: string
  profile: ProjectProfile | null
  briefStarted: boolean
  canEdit: boolean
  href: string
}): JSX.Element {
  const t = useTranslations('settings')
  const tProjects = useTranslations('projects')
  const view = buildProjectBriefView(profile)
  const percent = view.totalCount > 0 ? Math.round((view.answeredCount / view.totalCount) * 100) : 0

  return (
    <BentoTile
      label={t('project.overview.profile.label')}
      icon={ClipboardList}
      span="tall"
      href={href}
      linkLabel={t('project.overview.profile.open')}
      data-testid="overview-briefing"
    >
      {!briefStarted ? (
        <div className="flex flex-1 flex-col items-start justify-between gap-4">
          <p className="text-muted-foreground text-sm">
            {tProjects('overview.brief.emptyDescription')}
          </p>
          {canEdit && (
            <Button asChild size="sm">
              <Link href={`/app/projects/${encodeURIComponent(projectId)}/intake`}>
                {t('project.overview.setUpBrief')}
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <BentoFigure
            value={`${percent}%`}
            caption={t('project.overview.profile.captured', {
              answered: view.answeredCount,
              total: view.totalCount,
            })}
          />
          <Progress value={percent} aria-label={t('project.overview.profile.label')} />
          {view.assumptions.length > 0 && (
            <Chip variant="warning" size="sm" className="self-start">
              {t('project.overview.profile.toConfirm', { count: view.assumptions.length })}
            </Chip>
          )}
          {view.missing.length > 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                {t('project.overview.profile.unknown')}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {view.missing.slice(0, UNKNOWN_SHOWN).map((item) => (
                  <li key={item.key}>
                    <Chip variant="outline" size="sm">
                      {item.label}
                    </Chip>
                  </li>
                ))}
                {view.missing.length > UNKNOWN_SHOWN && (
                  <li>
                    <Chip variant="muted" size="sm">
                      +{view.missing.length - UNKNOWN_SHOWN}
                    </Chip>
                  </li>
                )}
              </ul>
            </div>
          ) : (
            view.assumptions.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t('project.overview.profile.complete')}
              </p>
            )
          )}
        </>
      )}
    </BentoTile>
  )
}

/**
 * Which OIB-Richtlinien the briefing makes relevant, as code chips with their
 * verdict. The reasons and the "ask Piloti" actions are in the profile section.
 */
export function StandardsTile({
  standards,
  href,
  span = 'half',
}: {
  standards: readonly ApplicableStandard[]
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const tProjects = useTranslations('projects')
  const { locale } = useLocale()
  const required = standards.filter((s) => s.status === 'required').length
  const check = standards.length - required

  return (
    <BentoTile
      label={t('project.overview.standards.label')}
      icon={BookCheck}
      span={span}
      href={href}
      linkLabel={t('project.overview.standards.open')}
      footer={
        standards.length > 0
          ? [
              t('project.overview.standards.required', { count: required }),
              check > 0 ? t('project.overview.standards.check', { count: check }) : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      data-testid="overview-standards"
    >
      {standards.length > 0 ? (
        <ul
          className={
            span === 'wide' ? 'grid gap-x-8 gap-y-2.5 md:grid-cols-2' : 'flex flex-col gap-2.5'
          }
        >
          {standards.map((standard) => (
            <li key={standard.code} className="flex min-w-0 items-center gap-2.5">
              <OibCodeChip code={standard.code} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {locale === 'de' ? standard.titleDe : standard.titleEn}
              </span>
              {standard.status !== 'required' && (
                <ApplicabilityChip
                  status={standard.status}
                  label={tProjects(`applicableStandards.status.${standard.status}`)}
                  className="shrink-0"
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t('project.overview.standards.empty')}</p>
      )}
    </BentoTile>
  )
}
