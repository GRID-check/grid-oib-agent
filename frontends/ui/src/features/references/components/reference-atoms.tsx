'use client'

/**
 * The parts of a similar-project card, one decision each: the stretched link
 * to the project, a labelled fact, the mark that a value came from the
 * documents and is not yet confirmed, the origin of a decision, and the decision
 * and permit items. The organism composes these and the card primitives
 * (`RaisedCard`); none of them draws a shape of its own beyond its material.
 */

import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type {
  ReferenceDecision,
  ReferenceFact,
  ReferenceOrigin,
  ReferencePeriod,
  ReferencePermit,
} from '@/lib/references/types'

/**
 * The project's name as the card's one link, stretched over the whole card.
 * Its own route is the project root, which opens the project's chat.
 */
export function ReferenceProjectLink({ project }: { project: { id: string; name: string } }): JSX.Element {
  return (
    <Link
      href={`/app/projects/${project.id}`}
      className={cn(
        'after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/60',
      )}
    >
      {project.name}
    </Link>
  )
}

/** A labelled fact on one line: the label at the start, the value at the end. */
export function ReferenceRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  )
}

/** The mark beside a value that came from the documents and that no person has checked. */
export function UnconfirmedMark(): JSX.Element {
  const t = useTranslations('references')
  return (
    <Chip variant="warning" size="sm">
      {t('fields.unconfirmed')}
    </Chip>
  )
}

/** A fact's value, with the unconfirmed mark beside it when it is one. */
export function ReferenceFactText({
  fact,
  children,
}: {
  fact: Pick<ReferenceFact<unknown>, 'confirmed'>
  children: ReactNode
}): JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {children}
      {!fact.confirmed && <UnconfirmedMark />}
    </span>
  )
}

/** Where a decision came from, as a chip. A person's word is the strongest; a note of Piloti's the weakest. */
export function OriginChip({ origin }: { origin: ReferenceOrigin }): JSX.Element {
  const t = useTranslations('references')
  const variant = origin === 'person' ? 'success' : origin === 'documents' ? 'info' : 'muted'
  return (
    <Chip variant={variant} size="sm">
      {t(`decisions.origin.${origin}`)}
    </Chip>
  )
}

/**
 * A period as its years: „2019–2021", one year when it began and ended in it,
 * and „2019–" while it has no end, as the agent's catalog writes it.
 */
export function periodYears(period: ReferencePeriod): string {
  const from = period.start.slice(0, 4)
  const to = period.end?.slice(0, 4)
  if (!to) return `${from}–`
  return to !== from ? `${from}–${to}` : from
}

/** A section of the card: its eyebrow, then what it holds. */
export function ReferenceSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="grid min-w-0 gap-2">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  )
}

/** One recorded decision or constraint, its origin and the files it was read from. */
export function ReferenceDecisionItem({ decision }: { decision: ReferenceDecision }): JSX.Element {
  const t = useTranslations('references')
  return (
    <li className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip variant="outline" size="sm">
          {t(`decisions.kind.${decision.kind}`)}
        </Chip>
        <OriginChip origin={decision.origin} />
      </div>
      <p className="line-clamp-3 text-sm text-foreground">{decision.content}</p>
      {decision.sources.length > 0 && (
        <p className="truncate text-xs text-muted-foreground">
          {decision.sources
            .map((source) =>
              source.page
                ? t('decisions.source', { file: source.fileName, page: source.page })
                : t('decisions.sourceWithoutPage', { file: source.fileName }),
            )
            .join(' · ')}
        </p>
      )}
    </li>
  )
}

/** One permit record: its kind, issuer and day, and the requirements it sets. */
export function ReferencePermitItem({ permit }: { permit: ReferencePermit }): JSX.Element {
  const t = useTranslations('references')
  const { locale } = useLocale()
  const issuer = [permit.authority, permit.issuedOn ? t('permits.issuedOn', { date: formatCalendarDate(permit.issuedOn, locale) }) : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip variant="outline" size="sm">
          {t(`permits.kind.${permit.kind}`)}
        </Chip>
        {issuer && <span className="min-w-0 truncate text-xs text-muted-foreground">{issuer}</span>}
      </div>
      {permit.requirements.length > 0 && (
        <ul className="grid gap-1">
          {permit.requirements.map((requirement, index) => (
            <li key={index} className="flex min-w-0 items-start gap-2 text-sm">
              <Chip variant="muted" size="sm" className="mt-0.5">
                {t(`permits.requirementKind.${requirement.kind}`)}
              </Chip>
              <span className="line-clamp-2 min-w-0 text-foreground">{requirement.content}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
