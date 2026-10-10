'use client'

/**
 * The closed projects most like this one, as a tile: the first three that share
 * something with it, each with its period, what it shares (a trait only read
 * from documents marked) and how much it left behind. The decisions and permit
 * conditions themselves are reading, so they stay in the hub's Similar projects
 * section the footer opens.
 *
 * Only projects the ranking found alike are named: a tile titled „Ähnliche
 * Projekte" that showed the newest unrelated ones would say they were. When
 * the office has closed projects but none alike, the tile says so and still
 * opens the section, which lists them apart and says what the comparison
 * would need.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { GitCompareArrows } from 'lucide-react'
import { BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import type { SimilarProjectsPage } from '@/lib/references/types'
import { periodYears } from '@/features/references/components/reference-atoms'

/** Projects named in the tile; the section lists every one the reader may open. */
const SHOWN = 3
/** Shared traits per project; the section names them all. */
const TRAITS_SHOWN = 3

export function SimilarProjectsTile({
  page,
  href,
  span = 'wide',
}: {
  page: SimilarProjectsPage
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const tRefs = useTranslations('references')
  const alike = page.projects.filter((project) => project.alike)
  const anyClosed = page.projects.length > 0
  // The ranking is by score, so a listed project that is not alike means none
  // beyond the cap is; only a list alike to the last, with more left out, may
  // be short of the true count.
  const counted = page.more === 0 || alike.length < page.projects.length

  return (
    <BentoTile
      label={t('project.overview.similar.label')}
      icon={GitCompareArrows}
      span={span}
      href={anyClosed ? href : undefined}
      linkLabel={
        alike.length === 0
          ? t('project.overview.similar.openOthers')
          : counted
            ? t('project.overview.similar.open', { count: alike.length })
            : t('project.overview.similar.openMore')
      }
      data-testid="overview-similar"
    >
      {alike.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {anyClosed ? tRefs('noneAlike') : t('project.overview.similar.empty')}
        </p>
      ) : (
        <ul className="grid gap-x-6 gap-y-4 md:grid-cols-3">
          {alike.slice(0, SHOWN).map((project) => (
            <li key={project.id} className="flex min-w-0 flex-col gap-1.5">
              <Link
                href={`/app/projects/${encodeURIComponent(project.id)}`}
                className="hover:text-foreground min-w-0 truncate text-sm font-semibold tracking-tight underline-offset-4 hover:underline"
              >
                {project.name}
              </Link>
              <p className="text-muted-foreground text-xs tabular-nums">
                {periodYears(project.period)}
                {' · '}
                {tRefs('summary', project.counts)}
              </p>
              <ul className="flex flex-wrap gap-1">
                {project.sharedTraits.slice(0, TRAITS_SHOWN).map((trait) => (
                  <li key={trait.value}>
                    <Chip
                      variant={trait.confirmed ? 'secondary' : 'warning'}
                      size="sm"
                      title={trait.confirmed ? undefined : tRefs('fields.unconfirmed')}
                    >
                      {trait.value}
                    </Chip>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </BentoTile>
  )
}
