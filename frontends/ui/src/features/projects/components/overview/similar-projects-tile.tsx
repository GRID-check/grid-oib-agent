'use client'

/**
 * The closed projects most like this one, as a tile: the first three, each
 * with its period, what it shares with this project and how much it left
 * behind. The decisions and permit conditions themselves are reading, so they
 * stay in the hub's Similar projects section the footer opens.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { GitCompareArrows } from 'lucide-react'
import { BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import type { SimilarProject } from '@/lib/references/types'
import { periodYears } from '@/features/references/components/reference-atoms'

/** Projects named in the tile; the section lists every one the reader may open. */
const SHOWN = 3
/** Shared traits per project; the section names them all. */
const TRAITS_SHOWN = 3

export function SimilarProjectsTile({
  projects,
  href,
  span = 'wide',
}: {
  projects: readonly SimilarProject[]
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const tRefs = useTranslations('references')

  return (
    <BentoTile
      label={t('project.overview.similar.label')}
      icon={GitCompareArrows}
      span={span}
      href={projects.length > 0 ? href : undefined}
      linkLabel={t('project.overview.similar.open', { count: projects.length })}
      data-testid="overview-similar"
    >
      {projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('project.overview.similar.empty')}</p>
      ) : (
        <ul className="grid gap-x-6 gap-y-4 md:grid-cols-3">
          {projects.slice(0, SHOWN).map((project) => (
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
                {tRefs('summary', {
                  decisions: project.decisions.length,
                  permits: project.permits.length,
                })}
              </p>
              {project.sharedTraits.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                  {project.sharedTraits.slice(0, TRAITS_SHOWN).map((trait) => (
                    <li key={trait}>
                      <Chip variant="secondary" size="sm">
                        {trait}
                      </Chip>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </BentoTile>
  )
}
