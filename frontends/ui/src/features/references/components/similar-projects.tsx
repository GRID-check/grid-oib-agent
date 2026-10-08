'use client'

/**
 * Similar projects: the closed projects most like this one that the person may
 * open, one card each (`/app/projects/{id}/referenzen`). The data is the
 * service's (`getSimilarProjects`); this draws it from the reference atoms and
 * the raised-card shape, and says so when there is none.
 */

import type { JSX } from 'react'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { SimilarProject } from '@/lib/references/types'
import {
  ReferenceDecisionItem,
  ReferenceFactText,
  ReferencePermitItem,
  ReferenceProjectLink,
  ReferenceRow,
  ReferenceSection,
  periodYears,
} from './reference-atoms'

function SimilarProjectCard({ project }: { project: SimilarProject }): JSX.Element {
  const t = useTranslations('references')
  return (
    <RaisedCard interactive className="h-full">
      {/* The body takes the row's height: cards of one row differ a lot, and a short one would leave an empty tray. */}
      <RaisedCardBody className="grid flex-1 content-start gap-4">
        <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
          <ReferenceProjectLink project={project} />
        </h3>
        <dl className="grid gap-1.5">
          <ReferenceRow label={t('fields.period')}>{periodYears(project.period)}</ReferenceRow>
          <ReferenceRow label={t('fields.bundesland')}>
            {project.bundesland ? (
              <ReferenceFactText fact={project.bundesland}>{project.bundesland.value}</ReferenceFactText>
            ) : (
              t('fields.notRecorded')
            )}
          </ReferenceRow>
          <ReferenceRow label={t('fields.oibEdition')}>
            {project.oibEdition ? (
              <ReferenceFactText fact={project.oibEdition}>
                {t('fields.oibEditionValue', { edition: project.oibEdition.value })}
              </ReferenceFactText>
            ) : (
              t('fields.notRecorded')
            )}
          </ReferenceRow>
        </dl>
        <ReferenceSection title={t('fields.sharedTraits')}>
          {project.sharedTraits.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {project.sharedTraits.map((trait) => (
                <li key={trait}>
                  <Chip variant="secondary" size="sm">
                    {trait}
                  </Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('fields.noSharedTraits')}</p>
          )}
        </ReferenceSection>
        <ReferenceSection title={t('decisions.title')}>
          {project.decisions.length > 0 ? (
            <ul className="grid gap-3">
              {project.decisions.map((decision) => (
                <ReferenceDecisionItem key={decision.id} decision={decision} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('decisions.empty')}</p>
          )}
        </ReferenceSection>
        <ReferenceSection title={t('permits.title')}>
          {project.permits.length > 0 ? (
            <ul className="grid gap-3">
              {project.permits.map((permit) => (
                <ReferencePermitItem key={permit.id} permit={permit} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('permits.empty')}</p>
          )}
        </ReferenceSection>
      </RaisedCardBody>
      <RaisedCardFooter>
        {t('summary', { decisions: project.decisions.length, permits: project.permits.length })}
      </RaisedCardFooter>
    </RaisedCard>
  )
}

export function SimilarProjects({ projects }: { projects: readonly SimilarProject[] }): JSX.Element {
  const t = useTranslations('references')
  return (
    <div className="flex flex-col gap-6 px-4 py-4 md:px-8">
      <p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
      {projects.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id} className="min-w-0">
              <SimilarProjectCard project={project} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
