'use client'

/**
 * Similar projects: the closed projects most like this one that the person may
 * open, one card each (the project hub's Similar projects section,
 * `/app/projects/{id}/settings/references`). The data is the
 * service's (`getSimilarProjects`); this draws it from the reference atoms and
 * the raised-card shape, and says so when there is none.
 *
 * The page says what it compared before what it found: this project's
 * fingerprint, the facts still open in its briefing, and, for each reference,
 * what the two share. A closed project that shares nothing is still listed,
 * below the alike ones and apart from them, so „ähnlich" never means „neu".
 * Each card offers „Piloti fragen": a new chat in THIS project, its question
 * prefilled, where the agent reads the reference with `project_lookup`.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { FingerprintKey } from '@/lib/cross-project/fingerprint'
import type { ReferenceBasis, SimilarProject, SimilarProjectsPage } from '@/lib/references/types'
import {
  ReferenceDecisionItem,
  ReferenceFactText,
  ReferencePermitItem,
  ReferenceProjectLink,
  ReferenceRow,
  ReferenceSection,
  UnconfirmedMark,
  periodYears,
} from './reference-atoms'

/** The composer prefill the project chat consumes (`?new=1&ask=`): a fresh chat about one reference. */
export function askHref(projectId: string, question: string): string {
  return `/app/projects/${projectId}/chat?new=1&ask=${encodeURIComponent(question)}`
}

/** What the ranking compared: this project's fingerprint, open facts named, and where to add them. */
function ComparedBy({ projectId, basis }: { projectId: string; basis: ReferenceBasis }): JSX.Element {
  const t = useTranslations('references')
  const tp = useTranslations('projects')
  const facts = basis.facts.filter((fact) => fact.applies)
  return (
    <section aria-labelledby="references-basis" className="grid max-w-prose gap-2">
      <SectionLabel as="h2" id="references-basis">
        {t('basis.title')}
      </SectionLabel>
      <ul className="flex flex-wrap gap-1.5">
        {facts.map((fact) => {
          const label = tp(`lifecycle.debrief.fingerprint.labels.${fact.key satisfies FingerprintKey}`)
          return (
            <li key={fact.key} className="inline-flex items-center gap-1">
              <Chip variant={fact.value === null ? 'muted' : 'secondary'} size="sm">
                {fact.value === null ? t('basis.open', { label }) : t('basis.fact', { label, value: fact.value })}
              </Chip>
              {fact.suggested && <UnconfirmedMark />}
            </li>
          )
        })}
      </ul>
      {basis.missing > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('basis.missing', { count: basis.missing })}
          {/* A closed project's briefing is read-only, and so is it for a reader without `project:edit`. */}
          {basis.editable && (
            <>
              {' '}
              <Link href={`/app/projects/${projectId}/intake`} className="text-foreground underline underline-offset-2">
                {tp('lifecycle.debrief.fingerprint.edit')}
              </Link>
            </>
          )}
        </p>
      )}
    </section>
  )
}

function SimilarProjectCard({ projectId, project }: { projectId: string; project: SimilarProject }): JSX.Element {
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
                <li key={trait.value} className="inline-flex items-center gap-1">
                  <Chip variant="secondary" size="sm">
                    {trait.value}
                  </Chip>
                  {!trait.confirmed && <UnconfirmedMark />}
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
      <RaisedCardFooter className="justify-between">
        <span>{t('summary', project.counts)}</span>
        {/* Above the stretched project link, so it is its own target. */}
        <Link
          href={askHref(projectId, t('ask.question', { name: project.name }))}
          className="relative z-10 font-medium text-foreground underline-offset-2 hover:underline"
        >
          {t('ask.action')}
        </Link>
      </RaisedCardFooter>
    </RaisedCard>
  )
}

function ProjectGrid({ projectId, projects }: { projectId: string; projects: readonly SimilarProject[] }): JSX.Element {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <li key={project.id} className="min-w-0">
          <SimilarProjectCard projectId={projectId} project={project} />
        </li>
      ))}
    </ul>
  )
}

export function SimilarProjects({ projectId, page }: { projectId: string; page: SimilarProjectsPage }): JSX.Element {
  const t = useTranslations('references')
  const alike = page.projects.filter((project) => project.alike)
  const others = page.projects.filter((project) => !project.alike)
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
      <ComparedBy projectId={projectId} basis={page.basis} />
      {page.projects.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <>
          {alike.length > 0 ? (
            <ProjectGrid projectId={projectId} projects={alike} />
          ) : (
            <p className="max-w-prose text-sm text-muted-foreground">{t('noneAlike')}</p>
          )}
          {others.length > 0 && (
            <section aria-labelledby="references-others" className="grid gap-3">
              <div className="grid max-w-prose gap-1">
                <SectionLabel as="h2" id="references-others">
                  {t('others.title')}
                </SectionLabel>
                <p className="text-sm text-muted-foreground">{t('others.description')}</p>
              </div>
              <ProjectGrid projectId={projectId} projects={others} />
            </section>
          )}
          {page.more > 0 && <p className="text-sm text-muted-foreground">{t('more', { count: page.more })}</p>}
        </>
      )}
    </div>
  )
}
